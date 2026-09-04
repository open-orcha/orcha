"""Slack message-file handling for the create-issue/create-task shortcuts — download
image attachments from a Slack message so screenshots travel WITH the work: embedded as
markdown images in the filed GitHub issue, and (for the "Create Orcha task" shortcut)
landed on the created task's own attachment store so a sandboxed agent can see them the
same way it sees any other task attachment (task_message_routes' render_attachment_feed_line).

Requires the `files:read` OAuth scope (in ADDITION to `commands` + `chat:write` —
docs/slack-integration.md's scope list). Without it, Slack's file-info/download calls
403/401 and this module degrades gracefully: the issue/task is still created, just
without images, and the caller (slack_routes) reports how many were skipped and why —
never a hard failure over an attachment.

Production incident (task 394d1063, post-issue-#234 investigation): two "screenshots"
landed as Slack's own login/HTML page saved with a .png name — `url_private_download`
answered HTTP 200 with an `<!DOCTYPE html>` body instead of 401/403 when the bearer
token wasn't effectively authorizing the request (the observed trigger was a redirect
hop losing the `Authorization` header — `urllib.request`'s default redirect handling
does not guarantee a custom header survives a cross-host redirect, and Slack's
download URLs can 30x to a different host). `download_slack_file` now (a) uses an
explicit redirect handler that re-attaches the Authorization header on every hop, and
(b) never trusts a 200 status alone — it validates the response Content-Type AND the
downloaded bytes' own magic-number signature before accepting anything as image data,
so an auth failure that Slack answers with 200-and-HTML (or any other non-image body)
is treated as a download failure, not silently stored/embedded as a "screenshot."

Selection rule (spec): at most the first 5 files on the message, `image/*` mimetypes
only, each ≤ SLACK_IMAGE_MAX_BYTES. Anything past the cap, of the wrong type, or over
size is EXCLUDED from the selection (not a download error) — but never silently: see
`select_image_files_verdicts` below, whose per-file verdicts feed both the shortcut-time
instrumentation log and the confirmation card's "N screenshots skipped — too large"
honesty note, so a message whose files were all filtered out (as opposed to none
present at all) is never indistinguishable from "no screenshots on this message." Only
a DOWNLOAD failure of a file that WAS selected additionally counts as "skipped" toward
the post-fetch honesty-count the confirmation card reports.
"""

import concurrent.futures
import urllib.error
import urllib.request

# 10 MiB — matches attachment_config.MAX_ATTACHMENT_BYTES (the task-attachment store's
# own ceiling), so a screenshot that clears THIS selection filter can never then be
# rejected by the attachment-landing step it may flow into. Raised from the original
# 5 MiB after a production report (issue #234) where a shortcut on a message carrying
# screenshots produced an issue with zero embeds and no honesty note — full-resolution
# phone/desktop screen captures routinely exceed 5 MiB, and the OLD cap silently
# dropped them with no signal at all (the note itself was only emitted when at least
# one file passed selection). GitHub's Contents API (the other consumer, via
# _commit_images_to_repo) tolerates far larger payloads, so 10 MiB is bounded by the
# attachment store, not GitHub.
SLACK_IMAGE_MAX_BYTES = 10 * 1024 * 1024
SLACK_IMAGE_MAX_COUNT = 5
SLACK_FILE_TIMEOUT_SECONDS = 15
# Bounded concurrent-download pool size for fetch_selected_images — mirrors
# github_hub_routes.py's CHECKS_POOL_SIZE pattern for the same class of problem (N
# blocking network calls fanned out from a sync context). At most SLACK_IMAGE_MAX_COUNT
# (5) images are ever selected, so this cap is really just a ceiling for future-proofing
# if that constant ever grows.
SLACK_IMAGE_FETCH_POOL_SIZE = 5


class SlackFilesScopeMissing(Exception):
    """Raised by `download_slack_file` when Slack's response indicates the bot token
    lacks `files:read` (401/403 on url_private_download) — distinct from a generic
    download failure so the caller can report the SPECIFIC fix (add the scope,
    reinstall) rather than a generic 'couldn't download' line."""


def select_image_files(files: list) -> list:
    """Filter a Slack message's `files[]` array down to what we'll attempt to fetch:
    first SLACK_IMAGE_MAX_COUNT files, `image/*` mimetype (Slack's `mimetype` field),
    each ≤ SLACK_IMAGE_MAX_BYTES (Slack's `size` field, in bytes — trusted for the
    PRE-download cap; the actual downloaded byte count is re-checked in
    `download_slack_file` since a reported size is not a guarantee). Pure — no network.
    Returns the raw Slack file dicts (not yet downloaded), in message order.
    """
    out = []
    for f in files or []:
        if not isinstance(f, dict):
            continue
        mimetype = str(f.get("mimetype") or "")
        if not mimetype.startswith("image/"):
            continue
        size = f.get("size")
        if isinstance(size, int) and size > SLACK_IMAGE_MAX_BYTES:
            continue
        if not f.get("url_private_download"):
            continue
        out.append(f)
        if len(out) >= SLACK_IMAGE_MAX_COUNT:
            break
    return out


def select_image_files_verdicts(files: list) -> list:
    """The SAME selection logic as `select_image_files`, but returns a verdict per
    input file instead of just the survivors — so a caller can log/report exactly WHY
    each candidate was kept or dropped (mimetype, size, or the 5-file cap), rather than
    only seeing a final count with no visibility into "were there files that got
    silently filtered out." PHI-safe by construction: verdicts carry mimetype/size/the
    reason, never the filename or file content.

    Returns a list of {"mimetype": str, "size": int|None, "verdict": str} in message
    order (including files never reached because an earlier one already filled the
    5-file cap — verdict 'dropped:count_cap' — so the total length always equals
    len(files), a stable denominator for the shortcut-time instrumentation log).
    """
    out = []
    kept = 0
    for f in files or []:
        if not isinstance(f, dict):
            out.append({"mimetype": None, "size": None, "verdict": "dropped:malformed"})
            continue
        mimetype = str(f.get("mimetype") or "")
        size = f.get("size") if isinstance(f.get("size"), int) else None
        if kept >= SLACK_IMAGE_MAX_COUNT:
            out.append({"mimetype": mimetype, "size": size, "verdict": "dropped:count_cap"})
            continue
        if not mimetype.startswith("image/"):
            out.append({"mimetype": mimetype, "size": size, "verdict": "dropped:mimetype"})
            continue
        if size is not None and size > SLACK_IMAGE_MAX_BYTES:
            out.append({"mimetype": mimetype, "size": size, "verdict": "dropped:size"})
            continue
        if not f.get("url_private_download"):
            out.append({"mimetype": mimetype, "size": size, "verdict": "dropped:no_url"})
            continue
        out.append({"mimetype": mimetype, "size": size, "verdict": "kept"})
        kept += 1
    return out


class _AuthPreservingRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Re-attach the `Authorization` header on every redirect hop.

    Root cause (task 394d1063): `url_private_download` can 30x to a different host
    (Slack's file-serving edge); the stdlib `HTTPRedirectHandler.redirect_request`
    builds a FRESH `Request` for the target and does not carry over caller-supplied
    headers like `Authorization` by default on a cross-origin hop. The follow-up GET
    then landed unauthenticated — and Slack answered that with HTTP 200 and an HTML
    login/error page instead of a 401/403, which `download_slack_file` used to accept
    at face value (any 200 was treated as file bytes). This handler rebuilds the
    redirected `Request` exactly like the base implementation, then re-adds the same
    Authorization header the original request carried, so the bearer token survives
    however many hops Slack's download flow takes.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new_req = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new_req is not None:
            auth = req.get_header("Authorization")
            if auth:
                new_req.add_header("Authorization", auth)
        return new_req


# Magic-number signatures for the image formats this pipeline actually accepts
# downstream (attachment_storage's ATTACHMENT_TYPES allowlist covers more, but these
# four are what Slack itself produces for a pasted/uploaded screenshot). Checked
# against the FIRST bytes of the downloaded body — independent of both the
# server-reported Content-Type and Slack's own `mimetype` field, neither of which is
# trustworthy proof of what was actually served (task 394d1063: a 200-with-HTML body
# had no honest Content-Type either way an app should rely on blindly).
_IMAGE_MAGIC_SIGNATURES = (
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
    (b"RIFF", "image/webp"),  # narrowed below: RIFF....WEBP
)


def _sniff_image_mimetype(data: bytes) -> str:
    """Return the sniffed image mimetype for `data`'s magic bytes, or "" when it
    doesn't match any accepted image signature (including an HTML/text body — the
    exact shape of the task 394d1063 incident: Slack answered 200 with
    `<!DOCTYPE html>...`, which matches NONE of these signatures)."""
    for magic, mimetype in _IMAGE_MAGIC_SIGNATURES:
        if not data.startswith(magic):
            continue
        if magic == b"RIFF":
            if data[8:12] == b"WEBP":
                return mimetype
            continue
        return mimetype
    return ""


def download_slack_file(url_private_download: str, bot_token: str) -> bytes:
    """GET a Slack file's bytes via `url_private_download`, authenticated with the bot
    token (Slack's file-serving domain accepts the SAME bearer token as the Web API,
    per Slack's documented file-download flow) via an opener that re-attaches that
    Authorization header across redirects (see `_AuthPreservingRedirectHandler`).
    Raises SlackFilesScopeMissing on a 401/403 (missing `files:read`); RuntimeError on
    any other failure — timeout, 404, oversize-after-download, OR a response that came
    back HTTP 200 but is not actually image data (task 394d1063: an unauthenticated
    download that Slack answered with an HTML page, not a 401/403 — the response
    Content-Type AND the bytes' own magic-number signature are both checked before
    anything downstream is allowed to treat this as a screenshot). This is the ONE
    network leaf for file bytes; tests monkeypatch this function, never urllib
    directly.
    """
    request = urllib.request.Request(
        url_private_download,
        headers={"Authorization": f"Bearer {bot_token}", "User-Agent": "orcha-portal"},
    )
    opener = urllib.request.build_opener(_AuthPreservingRedirectHandler)
    try:
        with opener.open(request, timeout=SLACK_FILE_TIMEOUT_SECONDS) as response:
            content_type = (response.headers.get("Content-Type") or "").split(";")[0].strip()
            data = response.read(SLACK_IMAGE_MAX_BYTES + 1)
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            raise SlackFilesScopeMissing(f"slack file download forbidden ({exc.code})") from exc
        raise RuntimeError(f"slack_file_status:{exc.code}") from exc
    except Exception as exc:  # DNS, timeout, TLS — one graceful shape
        raise RuntimeError(f"slack_file_unreachable:{exc}") from exc
    if len(data) > SLACK_IMAGE_MAX_BYTES:
        raise RuntimeError("slack_file_oversize")
    if not data:
        raise RuntimeError("slack_file_empty")
    if content_type and not content_type.startswith("image/"):
        # An HTTP 200 with a non-image Content-Type (task 394d1063's exact shape: an
        # HTML page) is a download failure, not a screenshot — never accepted purely
        # because the status code was 200.
        raise RuntimeError(f"slack_file_not_image:content_type={content_type or 'missing'}")
    if not _sniff_image_mimetype(data):
        # Belt-and-suspenders beyond Content-Type (a misconfigured/absent
        # Content-Type must not be a bypass): the bytes themselves must match a real
        # image signature.
        raise RuntimeError("slack_file_not_image:magic_bytes")
    return data


def _fetch_one(f: dict, bot_token: str):
    """Download ONE selected file, returning (image_dict_or_None, skipped: bool,
    scope_missing: bool) — never raises (both failure branches of
    `download_slack_file` are caught here so `pool.map` can't propagate an exception
    from one file and abort the others)."""
    try:
        data = download_slack_file(f["url_private_download"], bot_token)
    except SlackFilesScopeMissing:
        return None, True, True
    except RuntimeError:
        return None, True, False
    image = {
        "name": f.get("name") or f.get("title") or "screenshot.png",
        "mimetype": f.get("mimetype") or "image/png",
        "data": data,
    }
    return image, False, False


def fetch_selected_images(files: list, bot_token: str) -> dict:
    """Download every image in `select_image_files(files)` CONCURRENTLY (bounded
    thread pool — mirrors github_hub_routes.py's established pattern for fanning out
    N blocking network calls from a sync context), isolating per-file failures (spec:
    "any per-file download/commit/attach failure skips that file and the confirmation
    card counts what made it"). At most SLACK_IMAGE_MAX_COUNT (5) files are ever
    selected, so worst case is ONE file's timeout, not N of them stacked serially.
    Returns {"images": [{"name": str, "mimetype": str, "data": bytes}, ...],
     "skipped": int, "scope_missing": bool} — `images` preserves the SOURCE message
    order (not completion order), since `_commit_images_to_repo` numbers files by
    that order.
    `scope_missing` is True iff AT LEAST ONE selected file failed specifically because
    of a missing files:read scope (so the caller can surface the specific "add
    files:read and reinstall" hint instead of a generic skip count).
    """
    selected = select_image_files(files)
    if not selected:
        return {"images": [], "skipped": 0, "scope_missing": False}
    with concurrent.futures.ThreadPoolExecutor(
            max_workers=min(SLACK_IMAGE_FETCH_POOL_SIZE, len(selected))) as pool:
        results = list(pool.map(lambda f: _fetch_one(f, bot_token), selected))
    images = [image for image, _skipped, _scope in results if image is not None]
    skipped = sum(1 for _image, skipped, _scope in results if skipped)
    scope_missing = any(scope for _image, _skipped, scope in results)
    return {"images": images, "skipped": skipped, "scope_missing": scope_missing}
