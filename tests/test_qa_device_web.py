"""The web session (`orcha_cli/qa/device/web.py`): pure policy helpers, then a real headless
Chromium against static pages served from a temp dir with `http.server`. The Chromium tests are
skipped when Playwright's Chromium is not installed. Ported from the original web session, origin,
input-policy and site-limit tests."""

from __future__ import annotations

import functools
import http.server
import threading
from pathlib import Path

import pytest

from orcha_cli.qa.device import web
from orcha_cli.qa.device.base import attack_kind, input_refusal

# ---------- pure helpers (no browser) ----------


@pytest.mark.parametrize("text, kind", [
    ("<script>alert(1)</script>", "script"), ("javascript:alert(1)", "script"), ('<img src=x onerror=alert(1)>', "script"),
    ("' OR 1=1", "sql"), ("x'; DROP TABLE users; --", "sql"), ("{{7*7}}", "template"), ("${jndi:ldap://x}", "template"),
    ("%s%s%s%s", "format"), ("../../etc/passwd", "path"), ("; rm -rf /", "shell"), ("$(whoami)", "shell"),
])
def test_attack_strings_are_named(text, kind):
    assert attack_kind(text) == kind and input_refusal(text).startswith("error: refused")


@pytest.mark.parametrize("text", ["O'Brien", "R&D", "50% off", "José Zoë 🦊", "C:\\Users", "{name}", "", "a" * 500])
def test_realistic_input_is_allowed(text):
    assert attack_kind(text) is None and input_refusal(text) is None


def test_navigation_is_limited_to_the_allowed_origins():
    d = web.navigation_decision
    assert d("http://localhost:3000/a?b=1", session_origin="http://localhost:3000") is None
    assert d("about:blank", session_origin="http://localhost:3000") is None
    assert d("https://shop.test/x", session_origin="http://localhost:3000", extra=["https://shop.test"]) is None
    assert d("https://evil.example/", session_origin="http://localhost:3000").startswith("blocked: https://evil.example/ is outside")
    assert "scheme 'javascript'" in d("javascript:alert(1)", session_origin="http://localhost:3000")
    assert "scheme 'view-source'" in d("view-source:file:///etc/passwd", session_origin="http://localhost:3000")
    assert d("file:///tmp/a.html", session_origin="file://") is None
    assert d("file:///tmp/a.html", session_origin="http://localhost:3000").startswith("blocked:")


def test_same_site_redirects_join_the_session_origins():
    assert web.same_site_redirect("https://saucedemo.com", "https://www.saucedemo.com/") == "https://www.saucedemo.com"
    assert web.same_site_redirect("http://example.com", "https://example.com/") == "https://example.com"
    assert web.same_site_redirect("https://example.com", "http://example.com/") is None
    assert web.same_site_redirect("https://example.com", "https://accounts.google.com/") is None
    assert web.same_site_redirect("https://app.example.com", "https://example.com/") is None


def test_site_limit_responses():
    sites = ["example.com"]
    sig = web.classify_response("https://api.example.com/v1", 429, {"Retry-After": "12"}, app_sites=sites)
    assert sig.kind == web.RATE_LIMITED and sig.retry_after_s == 12 and "HTTP 429" in sig.detail
    assert web.classify_response("https://analytics.other.com/x", 429, app_sites=sites) is None
    assert web.classify_response("https://example.com/", 403, {"cf-mitigated": "challenge"}, app_sites=sites).kind == web.BOT_BLOCKED
    assert web.classify_response("https://example.com/", 503, {"Retry-After": "5"}, app_sites=sites).source == "header"
    assert web.classify_response("https://example.com/", 403, app_sites=sites) is None
    assert web.classify_response("https://example.com/", 200, app_sites=sites) is None
    assert web.registrable_domain("www.example.co.uk") == "example.co.uk" and web.site_of("https://cdn.dribbble.com/x") == "dribbble.com"


def test_site_limit_pages():
    assert web.classify_page("Just a moment...").kind == web.BOT_BLOCKED
    assert web.classify_page("Oops", ["You've been rate limited for a minute."]).kind == web.RATE_LIMITED
    assert web.classify_page("Shop", ["Please verify you are human"]).kind == web.BOT_BLOCKED
    full = ["Too many requests"] + [f"Product {i}: a long description of what it is and costs" for i in range(40)]
    assert web.classify_page("Shop", full) is None  # a full page: the app's own toast
    assert web.classify_page("Access denied", [], document_status=403).kind == web.BOT_BLOCKED
    assert web.classify_page("Access denied", []) is None  # the app's own permissions screen


def test_the_guard_backs_off_once_then_stops():
    g = web.SiteLimitGuard()
    sig = web.SiteSignal(web.RATE_LIMITED, "status", "HTTP 429", retry_after_s=500)
    assert g.wait_for(sig) == web.MAX_WAIT_S and g.refusal() is None
    assert "STOPPED" in g.stop(sig) and g.stopped and g.refusal().startswith("error: action refused")


def test_an_unknown_viewport_is_refused():
    with pytest.raises(ValueError):
        web.WebSession(viewport="tablet")


# ---------- a real Chromium ----------

chromium = pytest.mark.skipif(not web.chromium_installed(), reason="Playwright's Chromium is not installed (playwright install chromium)")

PAGES = {
    "index.html": """<!doctype html><title>Shop</title><h1>Shop</h1>
<a href="/second.html">Second page</a>
<label>Name <input id="name"></label>
<button onclick="document.getElementById('out').textContent='Saved '+document.getElementById('name').value; console.error('save failed')">Save</button>
<button onclick="fetch('/boom')">Load prices</button>
<button onclick="setTimeout(() => { throw new Error('kaboom') }, 0)">Break</button>
<button>Dead</button>
<p id="out"></p>""",
    "second.html": "<!doctype html><title>Second</title><h1>Second</h1><a href='/index.html'>Home link</a>",
    "long.html": "<!doctype html><title>Long</title>" + "".join(f"<p>Row {i}</p>" for i in range(200)),
    "limited.html": "<!doctype html><title>Limited</title><p>You've been rate limited for a minute.</p>",
}


class _Handler(http.server.SimpleHTTPRequestHandler):
    limited_hits = 0

    def log_message(self, *args) -> None:
        pass

    def do_GET(self) -> None:
        if self.path.startswith("/boom"):
            self.send_response(500)
            self.end_headers()
            self.wfile.write(b"no")
            return
        if self.path.startswith("/limited"):
            type(self).limited_hits += 1
            body = PAGES["limited.html"].encode()
            self.send_response(429)
            self.send_header("Retry-After", "0")
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()


@pytest.fixture(scope="module")
def site(tmp_path_factory):
    root: Path = tmp_path_factory.mktemp("site")
    for name, body in PAGES.items():
        (root / name).write_text(body)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(_Handler, directory=str(root)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


@pytest.fixture
async def session(site):
    steps = []
    s = web.WebSession(on_step=steps.append)
    s.recorded = steps
    yield s
    await s.end()


@chromium
async def test_start_reads_the_page_in_the_native_format(session, site):
    shot = await session.start(f"{site}/index.html")
    assert (session.platform, session.device_name, session.udid, session.app_id) == ("web", "desktop", None, f"{site}/index.html")
    assert (shot.width, shot.height) == (1280, 800) and shot.foreground == site and shot.foreground_name == "Shop"
    text = shot.text()
    assert text.startswith(f"foreground: {site} (Shop)\nurl: {site}/index.html\nlocked_app_violation: false")
    assert 'e1 Heading "Shop"' in text and 'Link "Second page"' in text and 'TextField "Name" id=name' in text
    assert session.lock is None


@chromium
async def test_typing_is_verified_and_a_tap_settles_with_its_events(session, site):
    await session.start(f"{site}/index.html")
    result = await session.type_text("Name", "Amani")
    assert result == "typed 'Amani'; verified: true; field value now 'Amani'"
    result = await session.tap("Save")
    assert result.startswith("tapped at") and session.last_screen.settled == "changed"
    text = session.last_screen.text()
    assert 'StaticText "Saved Amani"' in text and "events since last screen (1):\nconsole.error: save failed" in text
    assert "events since" not in (await session.screen()).text()  # drained
    assert [s.kind for s in session.recorded] == ["type", "tap"]


@chromium
async def test_a_5xx_and_a_page_error_are_in_the_events(session, site):
    await session.start(f"{site}/index.html")
    await session.tap("Load prices")
    text = session.last_screen.text()  # the tap's settled screen carries what happened since the last look
    await session.wait(300, until_text="never there")
    text += session.last_screen.text()
    assert "response 500: GET /boom" in text
    await session.tap("Break")
    text = session.last_screen.text() + (await session.screen()).text()
    assert "pageerror: kaboom" in text


@chromium
async def test_a_dead_button_settles_unchanged(session, site):
    await session.start(f"{site}/index.html")
    await session.tap("Dead")
    # Unchanged in the tree; the button's hover style keeps the pixels from calling it a no-op.
    assert session.last_screen.settled == "unchanged"


@chromium
async def test_links_back_and_home(session, site):
    await session.start(f"{site}/index.html")
    await session.tap("Second page")
    assert session.last_screen.url == f"{site}/second.html" and 'Heading "Second"' in session.last_screen.text()
    assert (await session.press("back")) == f"pressed back; now at {site}/index.html"
    await session.tap("Second page")
    assert (await session.press("home")) == f"pressed home; now at {site}/index.html"
    assert (await session.press("volume")).startswith("error: key must be one of")


@chromium
async def test_agent_navigation_stays_on_the_origin(session, site):
    await session.start(f"{site}/index.html")
    blocked = await session.open_url("https://example.com/")
    assert blocked.startswith("blocked: https://example.com/ is outside the allowed origins")
    assert session.recorded[-1].kind == "open_url" and session.recorded[-1].result == blocked
    assert (await session.open_url("javascript:alert(1)")).startswith("blocked: scheme 'javascript'")
    assert (await session.open_url(f"{site}/second.html")) == f"opened {site}/second.html"
    assert (await session.launch_app("anything")) == f"launched {site}/index.html"
    assert (await session.launch_app("https://example.org/")).startswith("blocked:")


@chromium
async def test_allowed_origins_widen_the_policy(site):
    s = web.WebSession(allowed_origins=["https://example.com"])
    try:
        await s.start(f"{site}/index.html")
        assert web.navigation_decision("https://example.com/x", session_origin=s.origin, extra=s.allowed_origins) is None
    finally:
        await s.end()


@chromium
async def test_attack_strings_are_refused_before_anything_is_typed(session, site):
    await session.start(f"{site}/index.html")
    result = await session.type_text("Name", "<script>alert(1)</script>")
    assert result.startswith("error: refused, that is a script/HTML injection payload") and session.recorded == []
    assert await session._value_at(None) in (None, "")


@chromium
async def test_swipe_scrolls_and_clear_text_empties(session, site):
    await session.start(f"{site}/long.html")
    top = session.last_screen.elements[1].label
    result = await session.swipe("up", 80)
    assert "scrolled by (0,640)" in result and session.last_screen.elements[1].label != top
    await session.open_url(f"{site}/index.html")
    await session.type_text("Name", "Amani")
    assert "cleared: true" in await session.clear_text("Name")


@chromium
async def test_the_mobile_viewport(site):
    s = web.WebSession(viewport="mobile")
    try:
        shot = await s.start(f"{site}/index.html")
        assert s.device_name == "mobile" and shot.size == (390, 844)
    finally:
        await s.end()


@chromium
async def test_a_rate_limit_backs_off_once_then_stops(session, site, monkeypatch):
    monkeypatch.setattr(web, "MIN_WAIT_S", 0.05)
    monkeypatch.setattr(web, "DEFAULT_WAIT_S", 0.05)
    monkeypatch.setattr(web, "SLOWED_GAP_S", 0.0)
    await session.start(f"{site}/index.html")
    result = await session.open_url(f"{site}/limited")
    assert result == f"opened {site}/limited"
    notes = session.last_screen.notes
    assert any("site_limit: the site is rate-limiting us" in n for n in notes)
    assert any("site_limit: STOPPED" in n for n in notes)  # still limited after the one reload
    assert session.site_guard.stopped and session.site_guard.record()["state"] == "stopped"
    assert (await session.tap("anything")).startswith("error: action refused: the session stopped")


def test_a_stored_request_body_keeps_no_credentials():
    from orcha_cli.qa.device.web import scrub_body, scrub_url

    out = scrub_body('{"email":"a@b.c","password":"hunter2","nested":{"accessToken":"xyz"}}')
    assert "hunter2" not in out and "xyz" not in out and "a@b.c" in out
    form = scrub_body("user=a&pwd=hunter2&next=/home")
    assert "hunter2" not in form and "next=/home" in form
    assert "s3cr3t" not in scrub_url("https://a.test/cb?token=s3cr3t&page=2")
    assert scrub_url("https://a.test/plain") == "https://a.test/plain"
