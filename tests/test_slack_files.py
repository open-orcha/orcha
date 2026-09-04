"""Slack message-file handling (screenshots-from-Slack feature): selection filtering
(count cap, mimetype, size), the files:read-scope-missing degradation, and per-file
download failure isolation. Pure unit tests — no DB, no FastAPI client; `slack_files`
has no framework dependency of its own."""
import urllib.error

import pytest

from portal_backend import slack_files

_PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"restofpngdata"


def _file(name="shot.png", mimetype="image/png", size=1024, url="https://files.slack.com/x/download"):
    return {"name": name, "mimetype": mimetype, "size": size, "url_private_download": url}


class _FakeResponse:
    """A minimal `http.client.HTTPResponse`-shaped stand-in for
    `download_slack_file`'s `opener.open(...)` context-manager usage — carries a body
    and a `headers.get(...)`-capable header mapping (real HTTPMessage supports the
    same `.get`)."""

    def __init__(self, body: bytes, content_type: str = "image/png"):
        self._body = body
        self.headers = {"Content-Type": content_type} if content_type is not None else {}

    def read(self, n=-1):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class _FakeOpener:
    """Stand-in for `urllib.request.build_opener(...)`'s return value — captures the
    `Request` it was asked to open (for header/URL assertions) and returns a
    caller-supplied fake response or raises a caller-supplied exception."""

    def __init__(self, respond=None, raise_exc=None, captured: dict = None):
        self._respond = respond
        self._raise_exc = raise_exc
        self._captured = captured if captured is not None else {}

    def open(self, request, timeout=None):
        self._captured["headers"] = dict(request.header_items())
        self._captured["url"] = request.full_url
        if self._raise_exc is not None:
            raise self._raise_exc
        return self._respond


def _patch_opener(monkeypatch, *, respond=None, raise_exc=None, captured: dict = None):
    """Patch `slack_files.urllib.request.build_opener` (the seam `download_slack_file`
    now uses, via `_AuthPreservingRedirectHandler`, instead of the bare
    `urllib.request.urlopen` the pre-redirect-fix code called directly) to return a
    `_FakeOpener` wired to the given response/exception. Returns the `captured` dict
    the fake opener records the outgoing request's headers/URL into."""
    captured = captured if captured is not None else {}
    monkeypatch.setattr(
        slack_files.urllib.request, "build_opener",
        lambda *handlers: _FakeOpener(respond=respond, raise_exc=raise_exc, captured=captured),
    )
    return captured


# ------------------------- select_image_files: filtering -------------------------

def test_select_image_files_filters_non_image_mimetypes():
    files = [_file(mimetype="image/png"), _file(mimetype="application/pdf"),
             _file(mimetype="text/plain")]
    selected = slack_files.select_image_files(files)
    assert len(selected) == 1
    assert selected[0]["mimetype"] == "image/png"


def test_select_image_files_filters_oversize():
    ok = _file(size=slack_files.SLACK_IMAGE_MAX_BYTES)
    too_big = _file(size=slack_files.SLACK_IMAGE_MAX_BYTES + 1)
    selected = slack_files.select_image_files([ok, too_big])
    assert len(selected) == 1
    assert selected[0]["size"] == slack_files.SLACK_IMAGE_MAX_BYTES


def test_select_image_files_caps_at_five():
    files = [_file(name=f"shot{i}.png") for i in range(8)]
    selected = slack_files.select_image_files(files)
    assert len(selected) == slack_files.SLACK_IMAGE_MAX_COUNT == 5
    assert [f["name"] for f in selected] == [f"shot{i}.png" for i in range(5)]


def test_select_image_files_requires_download_url():
    files = [_file(url=None), _file(url="")]
    assert slack_files.select_image_files(files) == []


def test_select_image_files_ignores_non_dict_entries():
    assert slack_files.select_image_files([None, "not a file", 42, _file()]) == [_file()]


def test_select_image_files_empty_input():
    assert slack_files.select_image_files([]) == []
    assert slack_files.select_image_files(None) == []


def test_select_image_files_missing_size_field_not_filtered():
    # Slack SHOULD always send `size`, but a missing/non-int size must not crash the
    # filter — treat it as "unknown, don't reject on size" rather than raising.
    f = _file()
    del f["size"]
    assert slack_files.select_image_files([f]) == [f]


# ------------------------- download_slack_file: scope / failure shapes -------------------------

class _FakeHTTPError(urllib.error.HTTPError):
    def __init__(self, code):
        super().__init__("https://files.slack.com/x", code, "err", {}, None)


def test_download_slack_file_403_raises_scope_missing(monkeypatch):
    _patch_opener(monkeypatch, raise_exc=_FakeHTTPError(403))
    with pytest.raises(slack_files.SlackFilesScopeMissing):
        slack_files.download_slack_file("https://files.slack.com/x", "xoxb-test")


def test_download_slack_file_401_raises_scope_missing(monkeypatch):
    _patch_opener(monkeypatch, raise_exc=_FakeHTTPError(401))
    with pytest.raises(slack_files.SlackFilesScopeMissing):
        slack_files.download_slack_file("https://files.slack.com/x", "xoxb-test")


def test_download_slack_file_404_raises_plain_runtime_error(monkeypatch):
    _patch_opener(monkeypatch, raise_exc=_FakeHTTPError(404))
    with pytest.raises(RuntimeError):
        slack_files.download_slack_file("https://files.slack.com/x", "xoxb-test")
    # NOT the scope-missing subtype for a 404.
    _patch_opener(monkeypatch, raise_exc=_FakeHTTPError(404))
    try:
        slack_files.download_slack_file("https://files.slack.com/x", "xoxb-test")
    except slack_files.SlackFilesScopeMissing:
        pytest.fail("404 must not raise SlackFilesScopeMissing")
    except RuntimeError:
        pass


def test_download_slack_file_sends_bearer_auth(monkeypatch):
    captured = _patch_opener(
        monkeypatch, respond=_FakeResponse(_PNG_BYTES, content_type="image/png"),
    )
    data = slack_files.download_slack_file("https://files.slack.com/x/download", "xoxb-secret")
    assert data == _PNG_BYTES
    assert captured["headers"]["Authorization"] == "Bearer xoxb-secret"
    assert captured["url"] == "https://files.slack.com/x/download"


def test_download_slack_file_empty_body_raises(monkeypatch):
    _patch_opener(monkeypatch, respond=_FakeResponse(b"", content_type="image/png"))
    with pytest.raises(RuntimeError):
        slack_files.download_slack_file("https://files.slack.com/x", "xoxb-test")


# ------------------------- download_slack_file: task 394d1063 (auth-dropped-on-redirect,
# HTML-with-200 accepted as a "screenshot") -------------------------

def test_download_slack_file_redirect_preserves_authorization_header():
    """`_AuthPreservingRedirectHandler.redirect_request` must re-attach the SAME
    Authorization header the original request carried onto the redirected request —
    the exact mechanism task 394d1063 traced the incident to (the stdlib's default
    redirect handling does not guarantee this across a cross-host hop)."""
    import urllib.request

    handler = slack_files._AuthPreservingRedirectHandler()
    original = urllib.request.Request(
        "https://files.slack.com/x/download",
        headers={"Authorization": "Bearer xoxb-secret", "User-Agent": "orcha-portal"},
    )
    new_req = handler.redirect_request(
        original, None, 302, "Found",
        {"location": "https://files-edge.slack.com/x/download"},
        "https://files-edge.slack.com/x/download",
    )
    assert new_req is not None
    assert new_req.get_header("Authorization") == "Bearer xoxb-secret"
    assert new_req.full_url == "https://files-edge.slack.com/x/download"


def test_download_slack_file_html_with_200_rejected_by_content_type(monkeypatch):
    """The task 394d1063 shape: Slack answers HTTP 200 (not 401/403) with an HTML
    body when the download wasn't actually authorized. The Content-Type check alone
    must reject this — never accepted as a screenshot just because the status was
    200."""
    html = b"<!DOCTYPE html><html lang=\"en-US\">not a screenshot</html>"
    _patch_opener(monkeypatch, respond=_FakeResponse(html, content_type="text/html; charset=utf-8"))
    with pytest.raises(RuntimeError, match="not_image"):
        slack_files.download_slack_file("https://files.slack.com/x", "xoxb-test")


def test_download_slack_file_html_with_200_and_no_content_type_rejected_by_magic_bytes(monkeypatch):
    """Belt-and-suspenders: even if the server sends NO (or a lying) Content-Type, the
    magic-byte sniff independently rejects a non-image body — the Content-Type header
    is not the only gate."""
    html = b"<!DOCTYPE html><html lang=\"en-US\">not a screenshot</html>"
    _patch_opener(monkeypatch, respond=_FakeResponse(html, content_type=None))
    with pytest.raises(RuntimeError, match="not_image"):
        slack_files.download_slack_file("https://files.slack.com/x", "xoxb-test")


def test_download_slack_file_valid_png_accepted(monkeypatch):
    _patch_opener(monkeypatch, respond=_FakeResponse(_PNG_BYTES, content_type="image/png"))
    data = slack_files.download_slack_file("https://files.slack.com/x", "xoxb-test")
    assert data == _PNG_BYTES


def test_sniff_image_mimetype_recognizes_common_formats():
    assert slack_files._sniff_image_mimetype(b"\x89PNG\r\n\x1a\nrest") == "image/png"
    assert slack_files._sniff_image_mimetype(b"\xff\xd8\xffrest") == "image/jpeg"
    assert slack_files._sniff_image_mimetype(b"GIF89arest") == "image/gif"
    assert slack_files._sniff_image_mimetype(b"RIFF\x00\x00\x00\x00WEBPrest") == "image/webp"


def test_sniff_image_mimetype_rejects_html_and_riff_non_webp():
    assert slack_files._sniff_image_mimetype(b"<!DOCTYPE html>") == ""
    # RIFF magic without the WEBP fourCC (e.g. a WAV file) must not false-positive.
    assert slack_files._sniff_image_mimetype(b"RIFF\x00\x00\x00\x00WAVErest") == ""


# ------------------------- fetch_selected_images: end-to-end + isolation -------------------------

def test_fetch_selected_images_happy_path(monkeypatch):
    files = [_file(name="a.png"), _file(name="b.png")]
    monkeypatch.setattr(slack_files, "download_slack_file", lambda url, token: b"bytes")
    result = slack_files.fetch_selected_images(files, "xoxb-test")
    assert len(result["images"]) == 2
    assert result["skipped"] == 0
    assert result["scope_missing"] is False
    assert {i["name"] for i in result["images"]} == {"a.png", "b.png"}


def test_fetch_selected_images_per_file_failure_isolated(monkeypatch):
    """One bad download must not take down the others — only the failing one is
    excluded/counted as skipped. Downloads run CONCURRENTLY (a bounded thread pool —
    see fetch_selected_images' docstring), so the fake leaf identifies "which file"
    by its OWN url/name, never by call order (order is not guaranteed across
    threads)."""
    files = [
        _file(name="good.png", url="https://files.slack.com/good"),
        _file(name="bad.png", url="https://files.slack.com/bad"),
        _file(name="also-good.png", url="https://files.slack.com/also-good"),
    ]

    def flaky_by_url(url, token):
        if url == "https://files.slack.com/bad":
            raise RuntimeError("boom")
        return b"bytes"

    monkeypatch.setattr(slack_files, "download_slack_file", flaky_by_url)
    result = slack_files.fetch_selected_images(files, "xoxb-test")
    assert len(result["images"]) == 2
    assert {i["name"] for i in result["images"]} == {"good.png", "also-good.png"}
    assert result["skipped"] == 1
    assert result["scope_missing"] is False


def test_fetch_selected_images_preserves_source_message_order(monkeypatch):
    """images[] must come back in the SOURCE message's order, not completion order —
    _commit_images_to_repo numbers committed files by this order (00-, 01-, 02-...)."""
    files = [_file(name=f"img{i}.png", url=f"https://files.slack.com/{i}") for i in range(5)]

    def slow_for_first(url, token):
        # Make the FIRST file's "download" the slowest, so if results were ordered by
        # completion (not input order) it would land last instead of first.
        if url.endswith("/0"):
            import time
            time.sleep(0.05)
        return f"bytes-{url}".encode()

    monkeypatch.setattr(slack_files, "download_slack_file", slow_for_first)
    result = slack_files.fetch_selected_images(files, "xoxb-test")
    assert [i["name"] for i in result["images"]] == [f"img{i}.png" for i in range(5)]


def test_fetch_selected_images_scope_missing_counts_all_as_skipped(monkeypatch):
    files = [_file(name="a.png"), _file(name="b.png")]

    def denied(url, token):
        raise slack_files.SlackFilesScopeMissing("403")

    monkeypatch.setattr(slack_files, "download_slack_file", denied)
    result = slack_files.fetch_selected_images(files, "xoxb-test")
    assert result["images"] == []
    assert result["skipped"] == 2
    assert result["scope_missing"] is True


def test_fetch_selected_images_no_files_returns_empty(monkeypatch):
    result = slack_files.fetch_selected_images([], "xoxb-test")
    assert result == {"images": [], "skipped": 0, "scope_missing": False}


def test_fetch_selected_images_respects_cap_and_type_filter(monkeypatch):
    files = [_file(name=f"img{i}.png") for i in range(6)] + [_file(name="doc.pdf", mimetype="application/pdf")]
    monkeypatch.setattr(slack_files, "download_slack_file", lambda url, token: b"bytes")
    result = slack_files.fetch_selected_images(files, "xoxb-test")
    # Only the first 5 PNGs are attempted at all — the PDF is never selected, and the
    # 6th PNG never makes it into the selection either.
    assert len(result["images"]) == 5
    assert all(i["name"].endswith(".png") for i in result["images"])
