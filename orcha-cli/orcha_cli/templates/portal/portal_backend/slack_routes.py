"""Slack trigger seam (Feature B) — slash commands + interactive components that
TRIGGER Orcha, feature-flagged OFF unless both SLACK_SIGNING_SECRET and
SLACK_BOT_TOKEN are configured.

Security model:
  * Every request's Slack signature is verified (v0 HMAC-SHA256 over
    `v0:{timestamp}:{raw_body}` keyed by SLACK_SIGNING_SECRET) with a ±300s timestamp
    window to stop replays. A bad/absent/stale signature is 401 — before any work.
  * The Slack caller (`user_id`) is mapped to an Orcha member via agents.slack_user_id
    (mig 044). An unknown/unlinked caller gets an EPHEMERAL "link your Slack in
    Settings" reply and never acts — Slack can trigger, but only for a linked member.

Slash commands (respond within Slack's 3s contract — task creation is fast, done inline):
  * /orcha start issue <N>   → start an Orcha task from GitHub issue #N
  * /orcha start pr <N>      → start an Orcha task from GitHub PR #N
        (both call the SAME start internals the hub uses — task_start_core — so a
         Slack-started task is byte-identical to a hub-started one. Slack gives us
         only a bare number, so this seam does the SAME live GitHub fetch the hub's
         own POST /github/start ALSO does server-side now (github_hub_routes.
         _fetch_gh_item — promoted there after a hub-frontend defect where its
         POST body never actually carried title/body_excerpt/html_url despite the
         schema assuming it did; see github_hub_routes.py's docstring), reusing the
         SAME token/GET leaves so both seams hit GitHub identically and produce the
         SAME title for the SAME item.)
  * /orcha issue <title> [-- <body>]  → file a NEW GitHub issue in the container's
        connected repo (Issues:write). Everything before an optional ` -- ` separator
        is the title; the rest is the body. The reply's "Start Orcha task" button is a
        REAL interactive button (POST /api/slack/interactions), not just a hint.
  * /orcha tasks             → what needs you: up to 5 needs_verification tasks
                                (linked), open-request and ready-unassigned counts.

POST /api/slack/interactions (same signature + linked-member gate as /commands) handles
three Slack payload shapes, all delivered form-encoded as a single `payload` JSON field:
  * shortcut / message_action  → TWO message shortcuts open a views.open modal (title
        pre-filled from the message's first line, body pre-filled with the full
        message text + a provenance footer):
          - "Create GitHub issue" (callback_id create_github_issue) — files the issue
            only.
          - "Create Orcha task" (callback_id create_orcha_task) — the SAME modal plus
            an optional assignee picker; on submit it creates the Orcha TASK directly
            (task-first: raw title/body + Slack provenance, screenshots landed on the
            task's own attachment store, NO GitHub issue and NO LLM call — the task's
            DoD, task_start_core.build_slack_captured_dod, instructs the agent to
            file the polished issue itself and post its link to the task's thread).
  * view_submission            → routes on the SUBMITTED VIEW's own callback_id (see
        slack_notify.MODAL_CALLBACK_ID / MODAL_CALLBACK_ID_WITH_TASK) to either
        create the issue (issue-only), or create the Orcha task directly
        (task-first). Returns a response_action so Slack closes the modal; the
        confirmation card follows as a DM/ephemeral, not inline in the modal
        response (Slack's view_submission body has no room for a Block Kit card of
        this shape).
  * block_actions               → the "Start Orcha task" button on an issue-filed card;
        routes through the SAME task_start_core.start_task_from_github every other
        dispatch path uses.

ACK-FIRST, WORK-AFTER (Slack's HTTP response — not just "the modal visibly opens" —
must land inside its 3s window, or the client shows "We had some trouble connecting.
Try again?" even though the eventual POST would have succeeded):
  * shortcut/message_action  → the handler returns an EMPTY 200 immediately; the
        views.open call that actually opens the modal is fired in a background task
        (`asyncio.create_task`, started AFTER the ack is built, never awaited by the
        request). The modal appears a beat later — no banner, no lost work.
  * view_submission           → the handler returns `{"response_action": "clear"}`
        immediately; the WHOLE pipeline (image download, GitHub issue creation for
        the issue-only shortcut, direct task creation for the task-first shortcut)
        runs in a background task. The result (or an honest failure) is delivered
        afterward as an ephemeral `chat.postMessage` DM to the submitting user.
  * block_actions              → the handler acks immediately (an empty ephemeral
        `{"response_type": "ephemeral", ...}` with no blocks Slack renders as nothing
        new); the actual GitHub fetch + task_start_core call runs in a background
        task, delivering its card via `chat.postMessage` to the same channel/user the
        click came from.
Every background task opens its OWN `db_cursor()` (a fresh psycopg connection) — never
the request-scoped cursor/connection, which is closed the moment the ack is returned.
This mirrors slack_notify.notify_task_needs_verification's post-commit, own-connection,
non-fatal-by-construction contract; failures are surfaced to the Slack caller as an
honest-failure card (reusing the existing cards), never silently swallowed.

Every background pipeline is scheduled through the ONE seam `_schedule_background`
(production: `asyncio.create_task(asyncio.to_thread(fn))`, fired only AFTER the ack
value is already built) — tests monkeypatch that single function to run the closure
inline and deterministically, rather than racing a real asyncio task against
assertions (see tests/test_slack_routes.py's `_run_background_inline` fixture).

External systems TRIGGER and OBSERVE Orcha; the verification/merge gates stay in Orcha.
A Slack start/issue-file acts the same way the hub does — it never completes or merges.
"""

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

from fastapi import HTTPException, Request

from portal_backend import github_hub_routes as _hub
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.github_hub_routes import _excerpt
from portal_backend.guards import valid_uuid
from portal_backend.limits import MAX_NAME_LEN
from portal_backend.slack_notify import (
    ASSIGNEE_ACTION_ID,
    ASSIGNEE_BLOCK_ID,
    ASSIGNEE_UNASSIGNED_VALUE,
    MODAL_CALLBACK_ID_WITH_TASK,
    build_create_issue_modal,
    build_unlinked_user_modal,
    blocks_already_tracked,
    blocks_github_permission_error,
    blocks_github_unreachable_error,
    blocks_issue_filed,
    blocks_issue_usage_help,
    blocks_start_success,
    blocks_task_created_from_slack,
    blocks_tasks_summary,
    blocks_unlinked_user,
    blocks_usage_help,
    call_slack_api,
    portal_task_link,
)
from portal_backend.slack_files import (
    SlackFilesScopeMissing,
    fetch_selected_images,
    select_image_files,
    select_image_files_verdicts,
)
from portal_backend.task_start_core import start_task_from_github, start_task_from_slack_capture

SLACK_LOG = logging.getLogger("orcha.slack")

SIGNING_SECRET_ENV = "SLACK_SIGNING_SECRET"
BOT_TOKEN_ENV = "SLACK_BOT_TOKEN"
SIGNATURE_MAX_SKEW_SECONDS = 300

_START_RE = re.compile(r"^start\s+(issue|pr)\s+#?(\d+)\s*$", re.IGNORECASE)
_TASKS_RE = re.compile(r"^tasks\s*$", re.IGNORECASE)
# \b + \s*: "issue" alone (no title at all) must still match this branch — so it routes
# to the issue-specific usage card, not the generic /orcha commands help block — while
# the \b word boundary keeps a command like "issued" or "issuefoo" from false-matching
# as "issue" + a title.
_ISSUE_RE = re.compile(r"^issue\b\s*(.*)$", re.IGNORECASE | re.DOTALL)

# The message-shortcut callback_ids the founder configures in the Slack app's UI
# (Interactivity & Shortcuts → Create New Shortcut → On messages, one shortcut each) —
# must match exactly what's registered there; see docs/slack-integration.md's
# app-config steps. Both open the SAME modal layout (slack_notify.build_create_issue_modal);
# only the "Create Orcha task" one sets with_task=True (assignee picker + chained start).
SHORTCUT_CALLBACK_ID = "create_github_issue"
SHORTCUT_CALLBACK_ID_WITH_TASK = "create_orcha_task"
# The Start-button block_actions action_id, matching slack_notify._action_button_el's
# call in blocks_issue_filed.
START_ISSUE_ACTION_ID = "slack_start_issue"
GITHUB_API = "https://api.github.com"
GITHUB_ISSUE_TIMEOUT_SECONDS = 10
# Message-text truncation for the modal's title prefill (first line, ~80 chars — Slack
# plain_text_input has no hard character cap on initial_value but a title beyond this
# is unreadable as an issue title; MODAL builder also caps defensively).
TITLE_PREFILL_MAX = 80


def _slack_enabled() -> bool:
    """The feature flag: BOTH secrets present. Read from the environment the same way
    other secrets are (os.environ, like ORCHA_LLM_API_KEY in provider_key_routes). With
    either unset, the endpoint is dark (503) and NO Slack behavior exists."""
    return bool((os.environ.get(SIGNING_SECRET_ENV) or "").strip()
                and (os.environ.get(BOT_TOKEN_ENV) or "").strip())


def _signing_secret() -> str:
    return (os.environ.get(SIGNING_SECRET_ENV) or "").strip()


def verify_slack_signature(raw_body: bytes, timestamp: str, signature: str) -> bool:
    """Slack request signing (v0). True iff the signature matches AND the timestamp is
    within ±300s. Constant-time compare; any missing/malformed field → False.

    basestring = 'v0:{timestamp}:{raw_body}', HMAC-SHA256 keyed by the signing secret,
    hex, prefixed 'v0='. (Slack's documented scheme — docs/slack-integration.md.)
    """
    secret = _signing_secret()
    if not secret or not timestamp or not signature:
        return False
    try:
        ts = int(timestamp)
    except (TypeError, ValueError):
        return False
    if abs(time.time() - ts) > SIGNATURE_MAX_SKEW_SECONDS:
        return False
    basestring = b"v0:" + timestamp.encode() + b":" + raw_body
    digest = hmac.new(secret.encode(), basestring, hashlib.sha256).hexdigest()
    expected = "v0=" + digest
    return hmac.compare_digest(expected, signature)


def _member_for_slack_user(cur, slack_user_id: str):
    """The LIVE human member linked to this Slack user id (mig 044.slack_user_id), or
    None. Matches on the exact id (Slack ids are opaque + case-stable). A container_id
    scoping is not needed for the lookup — but the returned row carries container_id so
    the command acts in that member's project."""
    if not slack_user_id:
        return None
    cur.execute(
        """SELECT id, container_id, alias, github_login FROM agents
           WHERE kind='human' AND terminated_at IS NULL AND slack_user_id=%s
           LIMIT 1""",
        (slack_user_id,),
    )
    return cur.fetchone()


def _ephemeral(blocks: list, fallback_text: str) -> dict:
    """A private (ephemeral) Slack slash-command reply — only the caller sees it.
    `fallback_text` is Slack's plain-text notification-preview fallback (required
    whenever `blocks` is present; never rendered when the client can show blocks)."""
    return {"response_type": "ephemeral", "blocks": blocks, "text": fallback_text}


def _fetch_gh_item(cur, container_id, kind: str, number: int):
    """Live-fetch a GitHub issue/PR's {title, html_url, body_excerpt} for the Slack
    start path — Slack gives us only a bare number, unlike the hub, which now ALSO
    does this same live fetch server-side (a production defect: the hub frontend
    never actually sent title/body_excerpt/html_url despite its schema's docstring
    assuming it did — see `github_hub_routes._fetch_gh_item`'s docstring for the
    full story). Delegates to that ONE promoted implementation (through the MODULE,
    not a direct `from ... import`, so tests monkeypatching `github_hub_routes._gh_get`
    — the established convention in test_github_hub_routes.py — transparently cover
    this seam too) so both dispatch paths hit GitHub identically and can never drift.

    Returns None on ANY failure (no bound repo, no installation token, GitHub
    unreachable/rate-limited/404) — the caller degrades to the bare '#N' title rather
    than fail the whole command; Slack's 3s contract has no room for a retry loop.
    """
    return _hub._fetch_gh_item(cur, container_id, kind, number)


class GithubPermissionError(Exception):
    """Raised by `_gh_post_issue` on a 403 from GitHub — the installation lacks
    Issues:write. A distinct type (rather than a bare RuntimeError, as the read-only
    `_gh_get`/`_hub._gh_get` leaves use) so callers can route it to the friendly
    "needs the Issues write permission" card without string-sniffing an error code."""


def _gh_post_issue(repo: str, token: str, title: str, body: str) -> dict:
    """POST a new issue to `repo` via the installation token. Raises
    GithubPermissionError on a 403 (the App's Issues:write permission is missing —
    the ONE error shape this whole feature is asked to degrade gracefully on) and
    plain RuntimeError on any other GitHub/network failure. stdlib urllib, matching
    every other GitHub leaf in this codebase (_gh_get, _gh_post_comment). This is the
    ONLY network leaf for issue creation; tests monkeypatch this function.
    """
    url = f"{GITHUB_API}/repos/{repo}/issues"
    request = urllib.request.Request(
        url,
        data=json.dumps({"title": title, "body": body}).encode("utf-8"),
        headers={
            "Authorization": f"token {token}",
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": "orcha-portal",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=GITHUB_ISSUE_TIMEOUT_SECONDS) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code == 403:
            raise GithubPermissionError("github issue creation forbidden (403)") from exc
        raise RuntimeError(f"github_status:{exc.code}") from exc
    except GithubPermissionError:
        raise
    except Exception as exc:  # DNS, timeout, TLS, bad JSON — one graceful shape
        raise RuntimeError(f"github_unreachable:{exc}") from exc


def _gh_put_contents(repo: str, token: str, path: str, content_bytes: bytes, message: str) -> dict:
    """PUT a file into `repo` via the GitHub Contents API (`PUT
    /repos/{repo}/contents/{path}`) — creates it (no `sha` passed: this module never
    OVERWRITES an existing attachment, every path is uniquely named). Requires the
    App's Contents:write permission, which rides the SAME repo-write grant Issues:write
    does on a standard GitHub App installation (no separate permission to document).
    Raises GithubPermissionError on 403, RuntimeError on any other failure. stdlib
    urllib + base64, matching every other GitHub leaf in this module.
    """
    url = f"{GITHUB_API}/repos/{repo}/contents/{path}"
    payload = {
        "message": message,
        "content": base64.b64encode(content_bytes).decode("ascii"),
    }
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"token {token}",
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": "orcha-portal",
        },
        method="PUT",
    )
    try:
        with urllib.request.urlopen(request, timeout=GITHUB_ISSUE_TIMEOUT_SECONDS) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code == 403:
            raise GithubPermissionError("github contents write forbidden (403)") from exc
        raise RuntimeError(f"github_status:{exc.code}") from exc
    except GithubPermissionError:
        raise
    except Exception as exc:  # DNS, timeout, TLS, bad JSON — one graceful shape
        raise RuntimeError(f"github_unreachable:{exc}") from exc


_SLUG_RE = re.compile(r"[^a-z0-9]+")


def _issue_slug(title: str, number) -> str:
    """A short, filesystem/URL-safe slug for the attachments subdirectory: the issue
    title, lowercased and dash-joined, falling back to a numeric/timestamp form when
    the title has no alnum content at all (e.g. an emoji-only title) — the directory
    name only needs to be STABLE and collision-avoiding, not pretty."""
    slug = _SLUG_RE.sub("-", (title or "").lower()).strip("-")[:60]
    if slug:
        return slug
    if number is not None:
        return f"issue-{number}"
    return f"issue-{int(time.time())}"


def _commit_images_to_repo(repo: str, token: str, issue_slug: str, images: list) -> list:
    """Commit each downloaded Slack image to
    `.github/orcha-attachments/<issue_slug>/<NN-name>` via the Contents API, returning
    the ones that landed successfully as {"name", "raw_url"} — a per-file failure is
    swallowed and simply excluded from the return list (the spec's per-file isolation:
    one bad commit must never fail the whole issue-filing flow). `raw_url` is the
    Contents API response's `content.download_url` — a stable raw-blob link GitHub
    serves directly, which is what gets embedded as a markdown image in the issue body.
    Private-repo visibility follows the repo's own access (see docs/slack-integration.md).
    """
    landed = []
    for i, img in enumerate(images):
        safe_name = re.sub(r"[^A-Za-z0-9._-]", "_", img["name"])[:80] or f"image-{i}.png"
        path = f".github/orcha-attachments/{issue_slug}/{i:02d}-{safe_name}"
        try:
            result = _gh_put_contents(
                repo, token, path, img["data"],
                message=f"Add Slack screenshot {safe_name} (via Orcha)",
            )
        except (GithubPermissionError, RuntimeError):
            continue
        raw_url = ((result or {}).get("content") or {}).get("download_url")
        if raw_url:
            landed.append({"name": safe_name, "raw_url": raw_url})
    return landed


def _embed_images_markdown(body: str, landed_images: list) -> str:
    """Append a '### Screenshots' section with one markdown image per landed file.
    Pure — no network. Returns `body` unchanged when `landed_images` is empty."""
    if not landed_images:
        return body
    lines = ["### Screenshots"]
    for img in landed_images:
        lines.append(f"![{img['name']}]({img['raw_url']})")
    section = "\n\n".join(lines)
    return f"{body}\n\n{section}" if body else section


_ISSUE_FOOTER = "_Filed from Slack by {who} via Orcha_"


def create_github_issue(cur, container_id, title: str, body: str, member,
                        *, repo: str = None, token: str = None) -> dict:
    """Shared core: create a GitHub issue in the container's connected repo, attributed
    to the linked member (footer line: "Filed from Slack by <github_login> via
    Orcha"). Used by BOTH the `/orcha issue` slash command and the message-shortcut
    modal's view_submission — one place composes the footer and resolves the repo
    token, so the two entry points can never drift on copy or auth.

    `repo`/`token`, when BOTH given, skip this function's own repo/token resolution —
    `_run_view_submission_pipeline` already resolves them once (to also drive the
    image pipeline) and passes them through here so a submission never resolves the
    same repo/token twice. Omit either (the `/orcha issue` slash command's call site,
    which has no other reason to pre-resolve them) and this function resolves both
    itself, exactly as before.

    Returns {"number": int, "html_url": str, "title": str} on success.
    Raises:
      * ValueError("no_repo")  — the container has no bound GitHub repo.
      * ValueError("no_token") — the App isn't wired with an installation token for
        this repo's owner.
      * GithubPermissionError  — GitHub 403'd (Issues:write missing).
      * RuntimeError           — any other GitHub/network failure.
    Read-only w.r.t. Orcha's own DB (only reads containers.github_repo, and only when
    `repo`/`token` weren't already supplied); the GitHub POST itself is the only
    write, and it is NOT part of the caller's DB transaction (a GitHub issue cannot be
    rolled back — callers should create it before any Orcha row that depends on it,
    mirroring task_start_core's non-fatal-comment ordering, except here the issue
    creation itself IS the primary action, not a best-effort side effect, so failures
    ARE surfaced to the Slack caller rather than swallowed).
    """
    if not (repo and token):
        cur.execute("SELECT github_repo FROM containers WHERE id=%s", (container_id,))
        row = cur.fetchone()
        repo = row["github_repo"] if row else None
        if not repo:
            raise ValueError("no_repo")
        token = _hub._resolve_repo_token(repo)
        if not token:
            raise ValueError("no_token")
    who = member.get("github_login") or member.get("alias") or "an Orcha member"
    footer = _ISSUE_FOOTER.format(who=who)
    full_body = f"{body}\n\n{footer}" if body else footer
    raw = _gh_post_issue(repo, token, title, full_body)
    return {
        "number": raw.get("number"),
        "html_url": raw.get("html_url") or "",
        "title": raw.get("title") or title,
    }



def _parse_issue_command(text: str):
    """Split `<title> [-- <body>]` on the FIRST ` -- ` separator (title/body may
    themselves contain literal hyphens; only the space-dash-dash-space token is the
    separator). Returns (title, body) with both trimmed; body is "" when absent.
    Returns (None, None) when the title would be empty (bad/empty input) — the caller
    replies with the usage card rather than filing a titleless issue."""
    text = (text or "").strip()
    if " -- " in text:
        title, body = text.split(" -- ", 1)
    else:
        title, body = text, ""
    title = title.strip()
    body = body.strip()
    if not title:
        return None, None
    return title, body


def _needs_attention_summary(cur, container_id) -> dict:
    """Data for `/orcha tasks`: up to 5 needs_verification tasks (id + title, for
    linking), plus ready-unassigned and open-request counts — the same "needs you"
    signals the portal surfaces. Read-only OBSERVE; no state change."""
    cur.execute(
        """SELECT id, title FROM tasks
           WHERE container_id=%s AND status='needs_verification'
           ORDER BY started_at ASC NULLS LAST, created_at ASC
           LIMIT 5""",
        (container_id,),
    )
    needs_verification = [{"id": str(r["id"]), "title": r["title"]} for r in cur.fetchall()]
    cur.execute(
        """SELECT count(*) AS n FROM tasks t
           WHERE t.container_id=%s AND t.status='ready' AND t.is_root=false
             AND NOT EXISTS (SELECT 1 FROM agent_tasks at WHERE at.task_id=t.id
                              AND at.assignment_status IN ('assigned','accepted','working'))""",
        (container_id,),
    )
    ready_unassigned = cur.fetchone()["n"]
    cur.execute(
        """SELECT count(*) AS n FROM requests r
           JOIN agents tg ON tg.id=r.target_id
           WHERE r.container_id=%s AND r.status='open' AND tg.kind='human'""",
        (container_id,),
    )
    open_requests = cur.fetchone()["n"]
    return {"needs_verification": needs_verification,
            "ready_unassigned": ready_unassigned,
            "open_requests": open_requests}


def _handle_command(cur, member, text: str) -> dict:
    """Route a verified, linked member's command text to its handler. Returns the Slack
    ephemeral response dict. The caller commits (task creation writes)."""
    cid = str(member["container_id"])
    text = (text or "").strip()

    m = _START_RE.match(text)
    if m:
        kind_word, number = m.group(1).lower(), int(m.group(2))
        kind = "pull" if kind_word == "pr" else "issue"
        # The title-bug fix: fetch the REAL issue/PR title before composing the task,
        # exactly like the hub does (there, the frontend already has it in hand from
        # the list it just rendered and passes it straight through). Slack only gives
        # us a bare number, so this is the one extra live fetch the hub gets for free.
        gh_item = _fetch_gh_item(cur, cid, kind, number)
        gh_title = (gh_item or {}).get("title") or f"#{number}"
        html_url = (gh_item or {}).get("html_url") or ""
        body_excerpt = (gh_item or {}).get("body_excerpt") or ""
        result = start_task_from_github(
            cur,
            cid,
            kind=kind,
            number=number,
            gh_title=gh_title,
            body_excerpt=body_excerpt,
            html_url=html_url,
            created_by_agent_id=str(member["id"]),
            assignee_agent_id=None,  # Slack start is unassigned — Atlas routes it
            source="slack",
        )
        label = "PR" if kind == "pull" else "issue"
        task_link = portal_task_link(cid, result["task_id"])
        if result["existing"]:
            return _ephemeral(
                blocks_already_tracked(label, number, task_link),
                f"Already tracked: {label} #{number} has an open Orcha task.",
            )
        return _ephemeral(
            blocks_start_success(label, number, html_url, gh_title, task_link),
            f"Started an Orcha task for {label} #{number}: {gh_title}",
        )

    m = _ISSUE_RE.match(text)
    if m:
        title, body = _parse_issue_command(m.group(1))
        if title is None:
            return _ephemeral(blocks_issue_usage_help(), "Usage: /orcha issue <title> [-- <body>]")
        if len(title) > MAX_NAME_LEN:
            title = title[:MAX_NAME_LEN]
        try:
            issue = create_github_issue(cur, cid, title, body, member)
        except ValueError:
            # no_repo / no_token — not the founder-called-out 403 case, but the same
            # "never a stack trace" contract: a friendly card either way.
            return _ephemeral(
                blocks_github_permission_error(),
                "This project has no connected GitHub repo (or no installation token) to file issues in.",
            )
        except GithubPermissionError:
            return _ephemeral(
                blocks_github_permission_error(),
                "The GitHub App needs the Issues write permission to file issues from Slack.",
            )
        except RuntimeError:
            # Any other GitHub/network failure (rate limit, timeout, 5xx) — never a
            # stack trace in Slack; a short, honest ephemeral instead.
            return _ephemeral(
                blocks_github_unreachable_error(),
                "Couldn't reach GitHub to file that issue — try again in a moment.",
            )
        return _ephemeral(
            blocks_issue_filed(issue["number"], issue["html_url"], issue["title"], None),
            f"Filed GitHub issue #{issue['number']}: {issue['title']}",
        )

    if _TASKS_RE.match(text):
        s = _needs_attention_summary(cur, cid)
        blocks = blocks_tasks_summary(
            s["needs_verification"], s["open_requests"], s["ready_unassigned"],
            lambda task_id: portal_task_link(cid, task_id),
        )
        return _ephemeral(blocks, "Needs you in this project")

    return _ephemeral(blocks_usage_help(), "Orcha commands")


def _dispatch_command(slack_user_id: str, text: str) -> dict:
    """The synchronous, potentially-blocking body of slack_commands: DB cursor open
    (psycopg is sync throughout this codebase) through to the shared-core dispatch,
    which — for `/orcha issue`/`/orcha start` — makes real outbound GitHub HTTP calls
    (`_gh_post_issue`, `_hub._gh_get`) via blocking `urllib`. Split out so the route
    handler can run this whole span via `asyncio.to_thread` rather than blocking the
    single asyncio event loop for the duration of a slow/rate-limited GitHub round
    trip (matches this codebase's established pattern for blocking work inside an
    `async def` route — e.g. attachment_routes.py's `asyncio.to_thread(_attachment_ref, ...)`).
    """
    with db_cursor() as (conn, cur):
        member = _member_for_slack_user(cur, slack_user_id)
        if member is None:
            # 200 with an ephemeral body — Slack shows the text; never a 4xx (that would
            # surface a red error in the channel instead of a helpful nudge).
            return _ephemeral(
                blocks_unlinked_user(),
                "Your Slack account isn't linked to an Orcha member yet.",
            )
        response = _handle_command(cur, member, text)
        conn.commit()
    return response


@app.post("/api/slack/commands")
async def slack_commands(request: Request):
    """Slack slash-command endpoint (Feature B). Dark (503) unless both Slack secrets
    are set; otherwise: verify signature (401 on bad/stale), map the caller to a member
    (ephemeral "link your Slack" when unlinked), then run the command inline and reply
    within Slack's 3s window.
    """
    if not _slack_enabled():
        raise HTTPException(503, "Slack integration is not configured")

    raw = await request.body()
    if not verify_slack_signature(
        raw,
        request.headers.get("X-Slack-Request-Timestamp", ""),
        request.headers.get("X-Slack-Signature", ""),
    ):
        raise HTTPException(401, "invalid Slack signature")

    # Slack posts application/x-www-form-urlencoded; parse the standard slash fields.
    form = dict(urllib.parse.parse_qsl(raw.decode("utf-8"), keep_blank_values=True))
    slack_user_id = form.get("user_id", "")
    text = form.get("text", "")

    # Off the event loop: DB + any outbound GitHub call this command makes are both
    # synchronous/blocking (psycopg, urllib) — see _dispatch_command's docstring.
    return await asyncio.to_thread(_dispatch_command, slack_user_id, text)


# ------------------------------------------------------------------------------------
# POST /api/slack/interactions — message shortcuts, modal submission, block actions.
# ------------------------------------------------------------------------------------

def _live_ai_agents(cur, container_id) -> list:
    """The container's live AI agents ({id, alias}), for the 'Create Orcha task'
    modal's assignee static_select. Same 'live' filter (terminated_at IS NULL) every
    other assignee-resolution query in this codebase uses (task_assignment_routes,
    task_start_core's own assignee lookups)."""
    cur.execute(
        """SELECT id, alias FROM agents
           WHERE container_id=%s AND kind='ai' AND terminated_at IS NULL
           ORDER BY alias""",
        (container_id,),
    )
    return [{"id": str(r["id"]), "alias": r["alias"]} for r in cur.fetchall()]


def _validate_assignee(cur, container_id: str, assignee_id):
    """Re-validate a modal-selected assignee at SUBMIT time (not just at open time —
    a Slack modal can sit open indefinitely, so the agent it named could be retired,
    deleted, or moved to a different container by the time 'Create task' is clicked).
    Mirrors github_hub_routes.py's POST /github/start assignee guard exactly (live,
    in-container, kind='ai'), except degrading to None (unassigned — Atlas routes it)
    instead of raising an HTTPException: a stale assignee selection is not the kind of
    error that should fail the whole submission over, it should just fall back to the
    same safe default a bare Start already has."""
    if not assignee_id or not valid_uuid(assignee_id):
        return None
    cur.execute(
        "SELECT kind, container_id, terminated_at FROM agents WHERE id=%s",
        (assignee_id,),
    )
    a = cur.fetchone()
    if not a or str(a["container_id"]) != str(container_id) \
            or a["terminated_at"] is not None or a["kind"] != "ai":
        return None
    return assignee_id


def _land_images_on_task(cur, task_id: str, images: list, footer_author) -> int:
    """Attach downloaded Slack images to the created task via the SAME storage +
    ref-building machinery POST /api/tasks/{tid}/attachments uses
    (attachment_references.task_attachments_dir / attachment_ref), so a sandboxed
    agent sees these exactly like any other task attachment (fetch each via GET,
    per render_attachment_feed_line's framing) — the founder's actual goal (the AI
    reviews the screenshot). This is the in-process equivalent of that upload route
    (no HTTP round-trip needed; we're already inside the portal process with the
    bytes in hand) followed by a synthetic task_messages row carrying the refs,
    exactly like POST /api/tasks/{tid}/messages would after a client-side upload.

    Returns the count of images successfully landed; a per-file storage failure is
    isolated (skipped, not raised) per the spec's per-file failure isolation.

    Extension allowlist: EVERY file passed through the SAME `attachment_ext` gate
    attachment_routes.upload_attachment enforces (only extensions in
    ATTACHMENT_TYPES land — notably SVG/HTML are never on that list, "never served
    renderable" per that route's own docstring). `slack_files.select_image_files`
    already filters on Slack's reported `mimetype` being `image/*`, but that field is
    Slack-supplied metadata, not a guarantee about the actual filename/extension this
    function writes to disk — re-checking the extension here (not just trusting the
    upstream mimetype filter) keeps this in-process path exactly as strict as the
    real HTTP upload route, rather than a laxer shadow of it.
    """
    # Imported here (not at module top) to avoid a hard dependency on the attachments
    # subsystem for every slack_routes import — this path is only exercised when a
    # shortcut actually carries images.
    import uuid as _uuid

    from portal_backend.attachment_references import (
        attachment_ref as _attachment_ref,
        task_attachments_dir as _task_attachments_dir,
    )
    from portal_backend.attachment_storage import (
        attachment_ext as _attachment_ext,
        contained_path as _contained_path,
        sanitize_attachment_name as _sanitize_attachment_name,
    )

    refs = []
    tdir = _task_attachments_dir(task_id)
    try:
        tdir.mkdir(parents=True, exist_ok=True)
    except OSError:
        return 0
    for img in images:
        try:
            display = _sanitize_attachment_name(img["name"])
            if _attachment_ext(display) is None:
                continue  # same allowlist gate the real upload route enforces
            stored = _uuid.uuid4().hex + "_" + display
            dest = _contained_path(tdir, stored)
            if dest is None:
                continue
            dest.write_bytes(img["data"])
            refs.append(_attachment_ref(task_id, stored, display, len(img["data"]), dest))
        except OSError:
            continue
    if not refs:
        return 0
    who = footer_author or "an Orcha member"
    cur.execute(
        "INSERT INTO task_messages (task_id, author_id, body, attachments) "
        "VALUES (%s, %s, %s, %s)",
        (task_id, None, f"📎 {len(refs)} screenshot(s) filed from Slack by {who}.",
         json.dumps(refs)),
    )
    return len(refs)


def _message_prefill(message_text: str) -> tuple:
    """Split a Slack message's text into (title, body) for the create-issue modal:
    title = the first line, truncated to TITLE_PREFILL_MAX; body = the full message
    text with a provenance footer appended. Pure — no Slack/DB access."""
    text = message_text or ""
    first_line = text.splitlines()[0] if text.strip() else ""
    title = first_line.strip()[:TITLE_PREFILL_MAX]
    footer = "— from Slack conversation"
    body = f"{text}\n\n{footer}" if text.strip() else footer
    return title, body


def _open_modal(bot_token: str, trigger_id: str, view: dict) -> None:
    """views.open — the modal-open call that IS a shortcut's ack (must happen within
    Slack's 3s window; the caller invokes this synchronously in the request handler,
    same as every other Slack call in this module — no background queue exists here).
    Raises RuntimeError on failure (propagated to the caller, which is the request
    handler itself — a failed views.open has nothing useful to degrade to, unlike the
    best-effort outbound leaves elsewhere in this codebase)."""
    result = call_slack_api("views.open", bot_token, {"trigger_id": trigger_id, "view": view})
    if not result.get("ok"):
        raise RuntimeError(f"views.open failed: {result.get('error')}")


def _dm_or_ephemeral(bot_token: str, slack_user_id: str, blocks: list, fallback_text: str) -> None:
    """Best-effort confirmation after a modal submission closes: a DM to the submitting
    user (chat.postMessage to their user id opens/uses the Slack-App DM channel — no
    channel_id is available from a view_submission payload, only the user). Non-fatal:
    the issue/task was already created by the time this runs, so a failed DM must never
    look like the whole action failed — mirrors slack_notify's outbound-ping contract."""
    try:
        call_slack_api("chat.postMessage", bot_token, {
            "channel": slack_user_id, "blocks": blocks, "text": fallback_text,
        })
    except RuntimeError:
        pass


# Slack's own private_metadata hard limit is 3000 chars; leave headroom for the
# {cid, slack_user_id} fields sharing the same JSON blob (both short/fixed-ish) — this
# is the ceiling `_private_metadata_files` enforces on its OWN serialized-JSON size, on
# top of `select_image_files`'s existing 5-file/mimetype/size selection cap. A long
# filename × several files could otherwise blow the budget even after that cap;
# Slack silently REJECTS (or truncates) an oversized private_metadata, which would
# corrupt the OTHER fields (cid, slack_user_id) riding the same blob — so this trims
# the FILE LIST, not the file entries themselves, dropping trailing files (in message
# order) until the whole blob fits, rather than ever truncating mid-JSON.
PRIVATE_METADATA_FILES_BUDGET_CHARS = 2400


def _private_metadata_files(files: list) -> dict:
    """The SUBSET of a Slack file's fields we carry through `private_metadata` to
    view_submission time (where the actual download happens) — just enough for
    `slack_files.select_image_files`/`download_slack_file`, never the file bytes
    themselves (private_metadata is a ~3000-char Slack-imposed string budget).

    Byte-budget guard: after building the (already ≤5-file) candidate list, drop
    trailing entries — in message order, same order `_commit_images_to_repo` numbers
    files by — until the JSON-serialized list fits PRIVATE_METADATA_FILES_BUDGET_CHARS.
    In practice this only bites on unusually long filenames/URLs; the common case
    (a handful of short Slack-generated filenames) never trims anything.

    Returns {"files": [...selected, budget-capped...], "seen": int} — `seen` is the
    RAW count of files on the source message (before any filtering), carried through
    so view_submission can tell "no screenshots on this message" (seen=0) apart from
    "screenshots were present but every one got filtered out" (seen>0, files=[]) — the
    production gap (issue #234 follow-up): a message whose screenshots were all over
    the size/mimetype filter used to produce a silent card with no note at all, because
    the note was gated on `selected > 0`. Carrying `seen` lets the card be honest even
    when NOTHING survived selection.
    """
    seen = len(files or [])
    out = []
    for f in select_image_files(files):
        out.append({
            "name": f.get("name") or f.get("title") or "screenshot.png",
            "mimetype": f.get("mimetype") or "",
            "size": f.get("size"),
            "url_private_download": f.get("url_private_download"),
        })
    while out and len(json.dumps(out)) > PRIVATE_METADATA_FILES_BUDGET_CHARS:
        out.pop()
    return {"files": out, "seen": seen}


def _log_shortcut_file_verdicts(message_files: list) -> None:
    """Shortcut-time instrumentation (issue #234 follow-up): log the PER-FILE
    selection verdict (kept / dropped:size / dropped:mimetype / dropped:count_cap) plus
    summary counts, so the NEXT "screenshots didn't show up" report carries evidence
    instead of another guess. PHI-safe by construction: only mimetype + size + verdict
    ever reach the log line — never a filename, URL, or file content. No-op (logs
    nothing) when the message carried no files at all, to avoid a log line on the
    overwhelming common case of a plain-text message shortcut.
    """
    if not message_files:
        return
    verdicts = select_image_files_verdicts(message_files)
    kept = sum(1 for v in verdicts if v["verdict"] == "kept")
    SLACK_LOG.info(
        "slack shortcut files: seen=%d kept=%d verdicts=%s",
        len(verdicts), kept,
        [(v["mimetype"], v["size"], v["verdict"]) for v in verdicts],
    )


def _build_shortcut_modal_view(cur, member, payload: dict) -> dict:
    """Compose the create-issue-or-task modal `view` payload for a message-shortcut
    invocation, pre-filled from the source message. `private_metadata` is a small JSON
    blob (Slack imposes a ~3000-char budget on this field) carrying everything
    view_submission needs but can't otherwise recover: container_id, the triggering
    slack_user_id (view_submission has no other channel/user context to DM the
    confirmation back to), and the message's image files (metadata only — download
    happens at submission time, not here: even the BACKGROUNDED views.open call below
    has no business doing N file downloads before a modal can open).

    Split out from the old `_handle_shortcut` so the one DB read this needs
    (`_live_ai_agents`, only for the with-task variant) happens BEFORE the ack is
    returned (it's a fast indexed query, not the "slow work" this fix targets) while
    the actual `views.open` network call happens AFTER, in a background task — see
    `_dispatch_interaction`.
    """
    callback_id = payload.get("callback_id", "")
    message = payload.get("message") or {}
    message_text = message.get("text", "")
    title, body = _message_prefill(message_text)
    cid = str(member["container_id"])
    slack_user_id = (payload.get("user") or {}).get("id", "")
    message_files = message.get("files") or []
    _log_shortcut_file_verdicts(message_files)
    files_meta = _private_metadata_files(message_files)
    private_metadata = json.dumps({
        "cid": cid, "slack_user_id": slack_user_id,
        "files": files_meta["files"], "files_seen": files_meta["seen"],
    })

    with_task = callback_id == SHORTCUT_CALLBACK_ID_WITH_TASK
    assignee_options = _live_ai_agents(cur, cid) if with_task else None
    return build_create_issue_modal(
        title, body, private_metadata=private_metadata,
        with_task=with_task, assignee_options=assignee_options,
    )


def _open_modal_background(bot_token: str, trigger_id: str, view: dict) -> None:
    """Fire-and-forget `views.open` — the modal-open call is no longer the ack itself
    (the route already returned an empty 200 to Slack before this runs; see
    `_dispatch_interaction`/`slack_interactions`). Best-effort: a `views.open` failure
    here has no request left to surface an error to (Slack already got its 200) — logged,
    never raised, matching every other post-ack background leaf in this module.
    `trigger_id` is single-use and expires ~3s after Slack issued it, same as before;
    the background task is scheduled immediately after the ack with nothing awaited in
    between, so it still fires well inside that window in practice.
    """
    try:
        _open_modal(bot_token, trigger_id, view)
    except RuntimeError as exc:
        SLACK_LOG.warning("slack shortcut: background views.open failed: %s", exc)


def _parse_private_metadata(raw: str) -> dict:
    """Decode `_build_shortcut_modal_view`'s private_metadata JSON blob, defaulting
    every field so a malformed/legacy value degrades to 'no files, no context' rather
    than raising — view_submission's caller already fails closed on a missing cid.

    `files_seen` (added alongside the issue #234 follow-up) defaults to `len(files)`
    for a LEGACY blob that predates the field (a modal opened by an older deployed
    build, then submitted after a mid-flight deploy) — the best available estimate
    when the raw pre-filter count was never carried, since every SELECTED file was, by
    construction, also SEEN."""
    try:
        data = json.loads(raw or "{}")
    except ValueError:
        data = {}
    if not isinstance(data, dict):
        data = {}
    files = data.get("files") if isinstance(data.get("files"), list) else []
    files_seen = data.get("files_seen")
    if not isinstance(files_seen, int) or files_seen < 0:
        files_seen = len(files)
    return {
        "cid": str(data.get("cid") or ""),
        "slack_user_id": str(data.get("slack_user_id") or ""),
        "files": files,
        "files_seen": files_seen,
    }


def _extract_modal_values(view: dict) -> dict:
    """Pull {title, body, assignee_agent_id} out of a view_submission's `view.state.values`
    — Slack's nested block_id -> action_id -> {value} shape. `assignee_agent_id` is None
    when the block is absent (the issue-only modal) OR no option was selected OR the
    sentinel 'unassigned' option was chosen."""
    values = ((view.get("state") or {}).get("values")) or {}
    title = ((values.get("title_block") or {}).get("title_input") or {}).get("value") or ""
    body = ((values.get("body_block") or {}).get("body_input") or {}).get("value") or ""
    assignee_agent_id = None
    selected = ((values.get(ASSIGNEE_BLOCK_ID) or {}).get(ASSIGNEE_ACTION_ID) or {}).get("selected_option")
    if selected and selected.get("value") and selected["value"] != ASSIGNEE_UNASSIGNED_VALUE:
        assignee_agent_id = selected["value"]
    return {"title": title.strip(), "body": body.strip(), "assignee_agent_id": assignee_agent_id}


def _fetch_and_land_images(cur, cid: str, repo, token, files: list, issue_slug: str,
                           bot_token: str):
    """The shared per-submission image pipeline: download the message's selected
    images (files:read-gated), commit each to the repo under
    .github/orcha-attachments/<slug>/, and return everything the caller needs to
    embed markdown + report an honest count. Any stage failing for a given image
    just drops that image from the counts — never raises.

    Returns {"landed": [{"name","raw_url"}], "downloaded_images": [raw dicts, for
    task-attachment landing], "selected": int, "skipped": int, "scope_missing": bool}.
    `selected` is how many images PASSED the pre-filter (select_image_files) — the
    denominator the confirmation card's "N/M screenshots" count uses.
    """
    if not files:
        return {"landed": [], "downloaded_images": [], "selected": 0, "skipped": 0,
               "scope_missing": False}
    fetch_result = fetch_selected_images(files, bot_token)
    images = fetch_result["images"]
    selected = len(images) + fetch_result["skipped"]
    if not images or not repo or not token:
        # No repo/token to commit into — every downloaded image is effectively skipped
        # for the issue-embedding purpose (still counted honestly).
        return {"landed": [], "downloaded_images": images if (repo and token) else [],
               "selected": selected,
               "skipped": fetch_result["skipped"] + (len(images) if not (repo and token) else 0),
               "scope_missing": fetch_result["scope_missing"]}
    landed = _commit_images_to_repo(repo, token, issue_slug, images)
    commit_failures = len(images) - len(landed)
    return {
        "landed": landed,
        "downloaded_images": images,
        "selected": selected,
        "skipped": fetch_result["skipped"] + commit_failures,
        "scope_missing": fetch_result["scope_missing"],
    }


def _screenshot_status_note(selected: int, landed_count: int, files_seen: int = 0) -> str:
    """The honesty-count phrase for a confirmation card's context line, or "" when
    there were no images to report on at all (the common case — most messages carry
    no screenshots, so this must not add noise to every card).

    `files_seen` (issue #234 follow-up) is the RAW pre-filter file count on the source
    message — widening this beyond the old `selected == 0` gate closes the exact
    production gap: a message that carried screenshots which were ALL filtered out
    before download (over the size cap, wrong mimetype) used to produce a card with NO
    note at all, indistinguishable from a plain-text message that never had
    screenshots. Now, whenever `files_seen > 0`, the card states an outcome either
    way — 'attached' when something landed, or an explicit 'skipped — too large/wrong
    type' when nothing did.
    """
    if selected == 0:
        if files_seen == 0:
            return ""
        plural = "screenshot was" if files_seen == 1 else "screenshots were"
        return f"{files_seen} {plural} skipped — too large or not an image"
    if landed_count == selected:
        plural = "screenshot" if selected == 1 else "screenshots"
        return f"{selected} {plural} attached"
    return f"{landed_count}/{selected} screenshots attached (some skipped)"


def _prepare_view_submission(cur, payload: dict) -> dict:
    """The FAST, synchronous half of a modal submission — everything that must be
    validated before Slack's `response_action` ack (title emptiness, the linked-member
    gate, private_metadata sanity) because these render as INLINE modal errors, which
    only the synchronous response_action='errors' path can produce; there is no
    after-the-fact way to reopen a closed modal with a validation message. Nothing
    here is slow: private_metadata parsing and the member lookup are local/indexed,
    never a GitHub or Slack Web API round trip.

    Returns {"error": <response_action dict>} on a validation failure (the caller
    returns this AS the ack, unchanged), or {"error": None, ...fields} with everything
    `_run_view_submission_pipeline` needs to do the actual (backgrounded) work.
    """
    view = payload.get("view") or {}
    callback_id = view.get("callback_id", "")
    meta = _parse_private_metadata(view.get("private_metadata", ""))
    cid, slack_user_id = meta["cid"], meta["slack_user_id"]
    if not cid:
        # Shouldn't happen (we always set it on open) — fail closed with a validation
        # error on the title field rather than crash into a 500.
        return {"error": {"response_action": "errors",
                          "errors": {"title_block": "Something went wrong — please reopen the shortcut."}}}

    member = _member_for_slack_user(cur, slack_user_id) if slack_user_id else None
    if member is None or str(member["container_id"]) != cid:
        return {"error": {"response_action": "errors",
                          "errors": {"title_block": "Your Slack account isn't linked to this project anymore."}}}

    fields = _extract_modal_values(view)
    title, body = fields["title"], fields["body"]
    if not title:
        return {"error": {"response_action": "errors", "errors": {"title_block": "Title can't be empty."}}}
    if len(title) > MAX_NAME_LEN:
        title = title[:MAX_NAME_LEN]

    return {
        "error": None,
        "callback_id": callback_id,
        "cid": cid,
        "slack_user_id": slack_user_id,
        "files": meta["files"],
        "files_seen": meta["files_seen"],
        "member": member,
        "title": title,
        "body": body,
        "assignee_agent_id_raw": fields["assignee_agent_id"],
    }


def _run_view_submission_pipeline(prepared: dict, bot_token: str) -> None:
    """The SLOW half of a modal submission — everything Slack's `response_action`
    already acked before this ever runs (see `_prepare_view_submission` /
    `_dispatch_interaction`). Branches on the submitted view's callback_id:
      * create_github_issue_submit (issue-only shortcut) — files a GitHub issue
        (screenshot download + GitHub commit + markdown embed, the issue POST
        itself), UNCHANGED from before the task-first redesign except that AI
        refinement no longer exists anywhere in this codebase (see
        `_run_issue_only_pipeline`).
      * create_orcha_task_submit (task-first shortcut) — creates the Orcha TASK
        directly, no GitHub issue, no LLM call: raw title/description + Slack
        provenance, screenshots landed straight on the task's own attachment store.
        The task's own DoD (task_start_core.build_slack_captured_dod) instructs the
        eventually-assigned agent to file the polished GitHub issue itself, post
        its link back to this task's thread, triage, then implement (see
        `_run_task_first_pipeline`).

    Runs entirely in a background task on its OWN `db_cursor()` connection — the
    request's cursor is long closed by the time this executes. Every outcome is
    delivered as a follow-up `chat.postMessage` DM via `_dm_or_ephemeral`.
    """
    if prepared["callback_id"] == MODAL_CALLBACK_ID_WITH_TASK:
        _run_task_first_pipeline(prepared, bot_token)
    else:
        _run_issue_only_pipeline(prepared, bot_token)


def _run_issue_only_pipeline(prepared: dict, bot_token: str) -> None:
    """The 'Create GitHub issue' shortcut's full pipeline: screenshot download +
    GitHub commit + markdown embed, then the issue POST itself. No LLM refinement
    (removed outright — see docs/slack-integration.md) and no task creation; this
    shortcut only ever files an issue, exactly as before the task-first redesign
    minus the refine step.
    """
    cid = prepared["cid"]
    slack_user_id = prepared["slack_user_id"]
    files = prepared["files"]
    files_seen = prepared["files_seen"]
    title, body = prepared["title"], prepared["body"]

    with db_cursor() as (conn, cur):
        member = prepared["member"]

        # Resolve the repo/token ONCE up front — reused both for issue creation and
        # for committing any images (avoids re-resolving the same token twice).
        cur.execute("SELECT github_repo FROM containers WHERE id=%s", (cid,))
        crow = cur.fetchone()
        repo = crow["github_repo"] if crow else None
        token = _hub._resolve_repo_token(repo) if repo else None

        images = _fetch_and_land_images(
            cur, cid, repo, token, files, _issue_slug(title, None), bot_token,
        )
        body_with_images = _embed_images_markdown(body, images["landed"])

        try:
            issue = create_github_issue(cur, cid, title, body_with_images, member,
                                        repo=repo, token=token)
        except ValueError:
            conn.rollback()
            if slack_user_id:
                _dm_or_ephemeral(
                    bot_token, slack_user_id, blocks_github_permission_error(),
                    "No GitHub repo (or installation token) is connected to this project.",
                )
            return
        except GithubPermissionError:
            conn.rollback()
            if slack_user_id:
                _dm_or_ephemeral(
                    bot_token, slack_user_id, blocks_github_permission_error(),
                    "The GitHub App needs the Issues write permission.",
                )
            return
        except RuntimeError:
            conn.rollback()
            if slack_user_id:
                _dm_or_ephemeral(
                    bot_token, slack_user_id, blocks_github_unreachable_error(),
                    "Couldn't reach GitHub — try again in a moment.",
                )
            return

        shot_note = _screenshot_status_note(images["selected"], len(images["landed"]), files_seen)
        if images["scope_missing"]:
            shot_note = (shot_note + " · " if shot_note else "") + \
                "some screenshots skipped — add the files:read scope and reinstall the App"

        conn.commit()
        if slack_user_id:
            _dm_or_ephemeral(
                bot_token, slack_user_id,
                blocks_issue_filed(issue["number"], issue["html_url"], issue["title"], None,
                                   screenshot_note=shot_note or None),
                f"Filed GitHub issue #{issue['number']}: {issue['title']}",
            )


def _run_task_first_pipeline(prepared: dict, bot_token: str) -> None:
    """The 'Create Orcha task' shortcut's redesigned pipeline (task-first): create
    the Orcha task DIRECTLY from the raw modal title/body + Slack provenance — NO
    GitHub issue, NO LLM call. The task's own DoD
    (task_start_core.build_slack_captured_dod) tells the agent to file the polished
    GitHub issue itself once it picks the work up, post its link back to this
    task's thread, triage, then implement. Screenshots download exactly as before
    (`slack_files`/`fetch_selected_images` are unchanged) but land ONLY on the
    task's own attachment store (`_land_images_on_task`) — never committed to a
    repo at this point, since there is no issue yet for them to embed into.

    Failure contract: a task-creation failure rolls back (no partial rows) and DMs
    an honest failure card — the ack (`response_action: clear`) already closed the
    modal before this pipeline ran, so the DM is the only channel left.
    """
    cid = prepared["cid"]
    slack_user_id = prepared["slack_user_id"]
    files = prepared["files"]
    files_seen = prepared["files_seen"]
    title, body = prepared["title"], prepared["body"]

    with db_cursor() as (conn, cur):
        member = prepared["member"]

        fetch_result = {"images": [], "skipped": 0, "scope_missing": False}
        if files:
            fetch_result = fetch_selected_images(files, bot_token)
        images = fetch_result["images"]
        selected = len(images) + fetch_result["skipped"]

        who = member.get("github_login") or member.get("alias") or "an Orcha member"
        footer = f"_Captured from Slack by {who} via Orcha_"
        description = f"{body}\n\n{footer}" if body else footer

        assignee_id = _validate_assignee(cur, cid, prepared["assignee_agent_id_raw"])
        try:
            result = start_task_from_slack_capture(
                cur, cid,
                title=title,
                description=description,
                created_by_agent_id=str(member["id"]),
                assignee_agent_id=assignee_id,
            )
        except Exception:
            conn.rollback()
            if slack_user_id:
                _dm_or_ephemeral(
                    bot_token, slack_user_id,
                    blocks_github_unreachable_error(),
                    "Creating the Orcha task failed — try again in a moment.",
                )
            return

        if images:
            _land_images_on_task(
                cur, result["task_id"], images,
                member.get("github_login") or member.get("alias"),
            )

        conn.commit()
        shot_note = _screenshot_status_note(selected, len(images), files_seen)
        if fetch_result["scope_missing"]:
            shot_note = (shot_note + " · " if shot_note else "") + \
                "some screenshots skipped — add the files:read scope and reinstall the App"
        task_link = portal_task_link(cid, result["task_id"])
        if slack_user_id:
            _dm_or_ephemeral(
                bot_token, slack_user_id,
                blocks_task_created_from_slack(title, task_link, screenshot_note=shot_note or None),
                f"Created an Orcha task from Slack: {title}",
            )


def _prepare_block_action(payload: dict) -> dict:
    """The FAST, synchronous half of a block_actions click — just enough to decide
    WHAT the ack should say (today: only ever the generic usage-help ephemeral, for
    an empty/unrecognized action; the actual "Start Orcha task" work always moves to
    the background, see `_run_block_action_pipeline`) without touching the network or
    doing the GitHub fetch + task_start_core round trip inline. No DB access.
    """
    actions = payload.get("actions") or []
    if not actions:
        return {"recognized": False}
    action = actions[0]
    if action.get("action_id") != START_ISSUE_ACTION_ID:
        return {"recognized": False}
    try:
        number = int(action.get("value"))
    except (TypeError, ValueError):
        return {"recognized": False}
    return {"recognized": True, "number": number}


def _run_block_action_pipeline(cid: str, slack_user_id: str, number: int, bot_token: str) -> None:
    """The SLOW half of a "Start Orcha task" button click — the live GitHub title
    fetch + task_start_core.start_task_from_github round trip Slack's ack already
    happened before this runs (see `_prepare_block_action` / `_dispatch_interaction`).
    Runs entirely in a background task on its OWN `db_cursor()` connection. Delivers
    its result card via `chat.postMessage` DM to the clicking user — the SAME cards
    (`blocks_start_success` / `blocks_already_tracked`) this used to return inline
    before the ack-timing fix; only the timing moved.
    """
    with db_cursor() as (conn, cur):
        gh_item = _fetch_gh_item(cur, cid, "issue", number)
        gh_title = (gh_item or {}).get("title") or f"#{number}"
        html_url = (gh_item or {}).get("html_url") or ""
        body_excerpt = (gh_item or {}).get("body_excerpt") or ""
        # Re-resolve the acting member from THIS background call's own fresh cursor
        # (never trusting a dict handed across from the request's already-closed
        # cursor) — mirrors _member_for_slack_user's own lookup exactly, so a member
        # unlinked between the click and this pipeline running degrades to an
        # unattributed (but still successful) start rather than crashing.
        actor = _member_for_slack_user(cur, slack_user_id)
        result = start_task_from_github(
            cur, cid,
            kind="issue",
            number=number,
            gh_title=gh_title,
            body_excerpt=body_excerpt,
            html_url=html_url,
            created_by_agent_id=str(actor["id"]) if actor else None,
            assignee_agent_id=None,
            source="slack",
        )
        conn.commit()
        task_link = portal_task_link(cid, result["task_id"])
        if not slack_user_id:
            return
        if result["existing"]:
            _dm_or_ephemeral(
                bot_token, slack_user_id,
                blocks_already_tracked("issue", number, task_link),
                f"Already tracked: issue #{number} has an open Orcha task.",
            )
        else:
            _dm_or_ephemeral(
                bot_token, slack_user_id,
                blocks_start_success("issue", number, html_url, gh_title, task_link),
                f"Started an Orcha task for issue #{number}: {gh_title}",
            )


def _prepare_interaction(payload: dict, bot_token: str) -> tuple:
    """The FAST, synchronous half of slack_interactions: everything needed to decide
    the ACK — the linked-member gate, modal-view composition, submission validation —
    on ONE short-lived `db_cursor()` that closes before this returns. Nothing here
    makes a Slack Web API or GitHub network call; those are exactly the "slow work"
    this ack-timing fix moves to the background (see module docstring).

    Returns (ack_response: dict, background: Optional[Callable[[], None]]) — the
    route handler returns `ack_response` to Slack immediately, THEN (only after that
    response is built) schedules `background` as a fire-and-forget task when it's not
    None. `background` is a zero-arg closure that opens its OWN db_cursor() when it
    runs — never the cursor this function used, which is already closed.
    """
    payload_type = payload.get("type", "")

    with db_cursor() as (conn, cur):
        # view_submission resolves its member from private_metadata (set at modal-open
        # time) rather than this top-level lookup, since the modal may be submitted by
        # the SAME user who opened it — but resolving here first keeps the linked-member
        # gate uniform across all three payload types for shortcut/block_actions.
        member = _member_for_slack_user(cur, (payload.get("user") or {}).get("id", ""))

        if payload_type in ("shortcut", "message_action"):
            if member is None:
                # views.open is no longer this request's ack (see the module
                # docstring) — but an UNLINKED caller still gets the informational
                # "Not linked" modal, just via the same backgrounded views.open path
                # every other shortcut uses, so "never acts for an unlinked caller"
                # keeps holding without a second ack-timing code path to maintain.
                trigger_id = payload.get("trigger_id", "")
                view = build_unlinked_user_modal()
                return {}, lambda: _open_modal_background(bot_token, trigger_id, view)
            view = _build_shortcut_modal_view(cur, member, payload)
            conn.commit()  # nothing written yet in practice, but matches prior symmetry
            trigger_id = payload.get("trigger_id", "")
            return {}, lambda: _open_modal_background(bot_token, trigger_id, view)

        if payload_type == "view_submission":
            prepared = _prepare_view_submission(cur, payload)
            conn.commit()
            if prepared["error"] is not None:
                return prepared["error"], None
            return (
                {"response_action": "clear"},
                lambda: _run_view_submission_pipeline(prepared, bot_token),
            )

        if payload_type == "block_actions":
            if member is None:
                return _ephemeral(
                    blocks_unlinked_user(),
                    "Your Slack account isn't linked to an Orcha member yet.",
                ), None
            prepared = _prepare_block_action(payload)
            cid = str(member["container_id"])
            slack_user_id = (payload.get("user") or {}).get("id", "")
            if not prepared["recognized"]:
                return _ephemeral(blocks_usage_help(), "Orcha commands"), None
            number = prepared["number"]
            # A minimal, no-blocks ephemeral ack — Slack renders it as nothing visibly
            # new (no header/section), same convention as an empty {} shortcut ack;
            # the real card follows as a DM once the background pipeline finishes.
            return (
                {"response_type": "ephemeral"},
                lambda: _run_block_action_pipeline(cid, slack_user_id, number, bot_token),
            )

    # Unknown/unsupported interaction type — ack with an empty 200 (never a 4xx; an
    # unrecognized-but-benign payload shape should not read as a broken integration).
    return {}, None


@app.post("/api/slack/interactions")
async def slack_interactions(request: Request):
    """Slack interactivity endpoint (Feature B continued): message shortcuts, modal
    submissions, and block-action button clicks. Same feature flag, signature
    verification, and linked-member gate as /api/slack/commands. Slack delivers every
    interaction payload the SAME way: form-encoded body with a single `payload` field
    holding a JSON blob (never raw JSON, unlike most Slack Events API traffic) — see
    docs/slack-integration.md.

    ACK-FIRST, WORK-AFTER (see module docstring): `_prepare_interaction` does only the
    fast, local work needed to build the ack; any Slack Web API call (views.open,
    chat.postMessage) or GitHub round trip it decided is needed comes back as a
    `background` closure, scheduled via `asyncio.create_task` ONLY AFTER the ack
    value is already in hand — so a slow/flaky Slack or GitHub round trip can never
    delay the HTTP response Slack's 3s contract is timed against.
    """
    if not _slack_enabled():
        raise HTTPException(503, "Slack integration is not configured")

    raw = await request.body()
    if not verify_slack_signature(
        raw,
        request.headers.get("X-Slack-Request-Timestamp", ""),
        request.headers.get("X-Slack-Signature", ""),
    ):
        raise HTTPException(401, "invalid Slack signature")

    form = dict(urllib.parse.parse_qsl(raw.decode("utf-8"), keep_blank_values=True))
    try:
        payload = json.loads(form.get("payload", "{}"))
    except ValueError:
        raise HTTPException(400, "malformed interaction payload")

    bot_token = (os.environ.get(BOT_TOKEN_ENV) or "").strip()

    # Off the event loop for the FAST half only — see _prepare_interaction's
    # docstring: this span is now local DB reads/validation, never a network call.
    ack, background = await asyncio.to_thread(_prepare_interaction, payload, bot_token)
    if background is not None:
        _schedule_background(background)
    return ack


def _schedule_background(fn) -> None:
    """Fire `fn` (a zero-arg closure) off the request's own timeline — the ONE seam
    every ack-first background pipeline in this module goes through, so tests have a
    single monkeypatch point to make background work deterministic (call `fn()`
    inline and block on it) instead of racing a real asyncio task against the test's
    own assertions. Production behavior: `asyncio.create_task(asyncio.to_thread(fn))`
    — scheduled AFTER the caller already has its ack value in hand (see
    `slack_interactions`), never awaited by the request, so a slow/failing background
    pipeline can never delay or break the HTTP response Slack's 3s contract measures.
    """
    asyncio.create_task(asyncio.to_thread(fn))
