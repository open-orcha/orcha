"""Live smoke check of the QA device layer on this Mac's booted devices (not collected by pytest).

    .venv-qa/bin/python tests/manual/qa_device_smoke.py [ios|android|web|both|all]

iOS: Settings (com.apple.Preferences) on the booted "iPhone 17 Pro" (or the iPad when the
iPhone's lock is held): read the screen, tap a row, go back, end. Android: Settings
(com.android.settings) on the first adb emulator, likewise. Each session claims the device's
`/tmp/claude-sim-lock-<name>` and releases it at the end. It never creates, boots, erases or
deletes a device. Web: headless Chromium on https://example.com (read, follow its link off the
origin, back, a blocked open_url) and on a local page served from a temp dir (type, tap, events).
"""

from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "orcha-cli"))

from orcha_cli.qa.device.base import SessionError  # noqa: E402

IOS_ROWS = ("General", "Accessibility", "Privacy & Security")
ANDROID_ROWS = ("Network & internet", "Connected devices", "Apps", "Display")


def _show(title: str, text: str, lines: int = 30) -> None:
    body = text.splitlines()
    print(f"--- {title} ({len(body)} lines) ---")
    print("\n".join(body[:lines]))
    if len(body) > lines:
        print(f"... {len(body) - lines} more")


async def _drive(session, app_id: str, rows: tuple[str, ...]) -> bool:
    t0 = time.monotonic()
    try:
        shot = await session.start(app_id)
    except SessionError as e:
        print(f"{session.platform}: start refused: {e}")
        return False
    print(f"{session.platform}: started on {session.device_name} ({session.udid}) in {time.monotonic() - t0:.1f}s; lock {getattr(session.lock, 'path', None)}")
    for note in session.notes:
        print(f"note: {note}")
    ok = True
    try:
        _show("first screen", shot.text())
        print(shot.image_note())
        row = next((r for r in rows if any(e.label == r for e in shot.elements)), None)
        if row is None:
            print(f"none of {rows} on screen")
            return False
        t = time.monotonic()
        result = await session.tap(row)
        print(f"tap {row!r}: {result} ({time.monotonic() - t:.2f}s, {session.last_settle_timing})")
        _show(f"after tapping {row}", session.last_screen.text(), 20)
        ok = ok and result.startswith("tapped") and session.last_screen.settled == "changed"
        t = time.monotonic()
        result = await session.press("back")
        print(f"back: {result} ({time.monotonic() - t:.2f}s)")
        _show("after back", session.last_screen.text(), 12)
        back_home = any(e.label == row for e in session.last_screen.elements)
        print(f"back on the first screen: {back_home}")
        ok = ok and back_home
    finally:
        summary = await session.end()
        lock_gone = session.lock is None
        print(f"ended: {summary}; lock released: {lock_gone}")
    return ok


LOCAL_PAGE = """<!doctype html><title>Local shop</title><h1>Local shop</h1>
<label>Email <input id="email" type="email"></label>
<button onclick="document.getElementById('out').textContent='Thanks ' + document.getElementById('email').value; fetch('/api/fail')">Subscribe</button>
<p id="out"></p><a href="/about.html">About us</a>"""


async def _web() -> bool:
    import functools
    import http.server
    import tempfile
    import threading

    from orcha_cli.qa.device.web import WebSession

    ok = True
    s = WebSession()
    t0 = time.monotonic()
    shot = await s.start("https://example.com")
    print(f"web: started {s.app_id} on {s.device_name} in {time.monotonic() - t0:.1f}s")
    _show("example.com", shot.text())
    link = next((e.label for e in shot.elements if e.type == "Link"), None)
    result = await s.tap(link)
    print(f"tap {link!r}: {result} -> {s.last_screen.url} (settled {s.last_screen.settled})")
    _show("after the link", s.last_screen.text(), 8)
    print(f"back: {await s.press('back')}")
    blocked = await s.open_url("https://www.iana.org/")
    print(f"open_url off-origin: {blocked[:90]}...")
    ok = ok and blocked.startswith("blocked:") and s.last_screen.url.startswith("https://example.com")
    print(f"ended: {await s.end()}")

    root = tempfile.mkdtemp()
    Path(root, "index.html").write_text(LOCAL_PAGE)
    Path(root, "about.html").write_text("<!doctype html><title>About</title><h1>About us</h1>")

    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=root))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        s = WebSession(viewport="mobile")
        shot = await s.start(f"http://127.0.0.1:{srv.server_address[1]}/index.html")
        _show("local page (mobile)", shot.text())
        typed = await s.type_text("Email", "amani@example.com")
        print(f"type: {typed}")
        print(f"tap: {await s.tap('Subscribe')}")
        _show("after Subscribe", s.last_screen.text())
        thanks_seen = any(e.label == "Thanks amani@example.com" for e in s.last_screen.elements)
        print(f"attack string: {(await s.type_text('Email', chr(39) + ' OR 1=1 --'))[:70]}...")
        await s.tap("About us")
        print(f"back: {await s.press('back')}")
        ok = ok and "verified: true" in typed and thanks_seen
        print(f"ended: {await s.end()}")
    finally:
        srv.shutdown()
    return ok


async def main(which: str) -> int:
    results: dict[str, bool] = {}
    if which in ("ios", "both", "all"):
        from orcha_cli.qa.device.ios import IosSession

        results["ios"] = await _drive(IosSession(), "com.apple.Preferences", IOS_ROWS)
    if which in ("android", "both", "all"):
        from orcha_cli.qa.device.android import AndroidSession

        results["android"] = await _drive(AndroidSession(), "com.android.settings", ANDROID_ROWS)
    if which in ("web", "all"):
        results["web"] = await _web()
    print(f"smoke: {results}")
    return 0 if results and all(results.values()) else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "both")))
