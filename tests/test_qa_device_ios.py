"""The iOS session (`orcha_cli/qa/device/ios.py`) against a fake idb client and a fake app: device
pick and lock, launch, settled actions, held taps, refusals, typing, back, permission dialogs,
an app that left, navigation bars idb hides. Ported from the original `test_ios_taps.py`,
`test_ios_keys.py`, `test_app_in_front.py`, `test_tree_readers.py`,
`test_ios_app_accessibility.py` and `test_ios_overlay.py`. No simulator needed."""

from __future__ import annotations

import io
from types import SimpleNamespace
from typing import Any

import pytest

pytest.importorskip("PIL")
pytest.importorskip("idb")

from PIL import Image  # noqa: E402

from orcha_cli.qa.device import ios, ios_idb, locks  # noqa: E402
from orcha_cli.qa.device import screen as screen_mod  # noqa: E402
from orcha_cli.qa.device.base import SessionError  # noqa: E402
from orcha_cli.qa.device.tree import Element, parse_tree  # noqa: E402

APP = "com.x.slate"
APP_PID, SB_PID = 42, 99
APP_PATH = "/apps/Slate.app"
SB_PATH = "/Library/Developer/CoreSimulator/Volumes/iOS_23A/CoreServices/SpringBoard.app/SpringBoard"
W, H = 402, 874


def _f(x, y, w, h):
    return {"x": x, "y": y, "width": w, "height": h}


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t

    async def sleep(self, seconds: float) -> None:
        self.t += seconds


class FakeApp:
    """A small app: a list screen with rows, a switch row, a field, a dead button, a button that
    asks for notifications, an off-screen row, and an opaque navigation bar; a detail screen with
    a back button. What is in front: the app, the home screen, or a SpringBoard permission alert."""

    def __init__(self) -> None:
        self.screen = "list"
        self.front = "app"  # app | home | alert
        self.airplane = "0"
        self.name = ""
        self.focused = False
        self.taps: list[tuple[int, int, float | None]] = []
        self.launched = 0
        self.terminated = 0
        self.typed: list[str] = []
        self.keys = 0

    def nodes(self) -> list[dict[str, Any]]:
        if self.front == "home":
            return [
                {"type": "Application", "AXLabel": "SpringBoard", "pid": SB_PID, "frame": _f(0, 0, W, H)},
                {"type": "Button", "AXLabel": "Calendar", "pid": SB_PID, "frame": _f(40, 500, 150, 44)},
            ]
        if self.front == "alert":
            return [
                {"type": "Application", "AXLabel": "SpringBoard", "pid": SB_PID, "frame": _f(0, 0, W, H)},
                {"type": "StaticText", "AXLabel": "“Slate” Would Like to Send You Notifications", "pid": SB_PID, "frame": _f(40, 300, 320, 40)},
                {"type": "Button", "AXLabel": "Don’t Allow", "pid": SB_PID, "frame": _f(40, 400, 150, 44)},
                {"type": "Button", "AXLabel": "Allow", "pid": SB_PID, "frame": _f(210, 400, 150, 44)},
            ]
        app = {"type": "Application", "AXLabel": "Slate", "pid": APP_PID, "frame": _f(0, 0, W, H)}
        if self.screen == "detail":
            return [
                app,
                {"type": "Button", "AXLabel": "Library", "AXUniqueId": "BackButton", "frame": _f(8, 60, 100, 44)},
                {"type": "Heading", "AXLabel": "General", "frame": _f(16, 120, 200, 40)},
                {"type": "Cell", "AXLabel": "About", "frame": _f(0, 180, W, 50)},
            ]
        field_traits = ["TextEntry", *(["IsEditing"] if self.focused else [])]
        return [
            app,
            {"type": "Group", "role_description": "Nav bar", "AXLabel": "Library", "frame": _f(0, 54, W, 50)},
            {"type": "Heading", "AXLabel": "Library", "frame": _f(16, 110, 200, 40)},
            {"type": "Cell", "AXLabel": "General", "frame": _f(0, 160, W, 50)},
            {"type": "Cell", "AXLabel": "Privacy", "frame": _f(0, 210, W, 50)},
            {"type": "CheckBox", "AXLabel": "Airplane Mode", "AXValue": self.airplane, "frame": _f(16, 270, 370, 44)},
            {"type": "TextField", "AXLabel": "Name", "AXValue": self.name, "AXUniqueId": "name", "traits": field_traits, "frame": _f(16, 330, 370, 44)},
            {"type": "Button", "AXLabel": "Dead", "frame": _f(16, 390, 100, 44)},
            {"type": "Button", "AXLabel": "Notify me", "frame": _f(16, 450, 150, 44)},
            {"type": "Cell", "AXLabel": "Far away", "frame": _f(0, 1000, W, 50)},
        ]

    #: Items `describe-all` hides inside the navigation bar; `describe-point` finds them.
    BAR_ITEMS = [{"type": "Button", "AXLabel": "Edit", "pid": APP_PID, "frame": _f(330, 60, 60, 40)}]

    def at(self, x: int, y: int) -> dict[str, Any] | None:
        if self.front == "app" and self.screen == "list":
            for item in self.BAR_ITEMS:
                f = item["frame"]
                if f["x"] <= x <= f["x"] + f["width"] and f["y"] <= y <= f["y"] + f["height"]:
                    return dict(item)
        hits = []
        for n in self.nodes()[1:]:
            f = n["frame"]
            if f["x"] <= x <= f["x"] + f["width"] and f["y"] <= y <= f["y"] + f["height"]:
                hits.append(n)
        if not hits:
            # A hit test always reaches something: the front process's own view.
            return {"type": "Group", "pid": APP_PID if self.front == "app" else SB_PID, "frame": _f(0, 0, W, H)}
        n = min(hits, key=lambda n: n["frame"]["width"] * n["frame"]["height"])
        return {**n, "pid": n.get("pid", APP_PID)}

    def tap(self, x: int, y: int) -> None:
        node = self.at(x, y)
        label = (node or {}).get("AXLabel")
        if self.front == "alert":
            if label in ("Allow", "Don’t Allow"):
                self.front = "app"
            return
        if self.front != "app":
            return
        self.focused = bool(node and node.get("AXUniqueId") == "name")
        if label == "General":
            self.screen = "detail"
        elif label == "Library" and self.screen == "detail":
            self.screen = "list"
        elif label == "Airplane Mode" and x > 16 + 370 - 51:
            self.airplane = "1" if self.airplane == "0" else "0"
        elif label == "Notify me":
            self.front = "alert"

    def png(self) -> bytes:
        tone = {"home": 30, "alert": 60}.get(self.front, 100 if self.screen == "list" else 180)
        img = Image.new("L", (W // 2, H // 2), tone)
        if self.front == "app" and self.screen == "list":
            if self.airplane == "1":
                img.paste(250, (170, 135, 195, 157))
            if self.name:
                img.paste(10 + 7 * len(self.name) % 200, (10, 165, 10 + 4 * len(self.name), 187))
        buf = io.BytesIO()
        img.save(buf, "PNG")
        return buf.getvalue()


class FakeClient:
    def __init__(self, app: FakeApp, clock: Clock) -> None:
        self.app = app
        self.clock = clock
        self.companion_process = None
        self.cleaned = False

    async def init_companion(self) -> bool:
        return True

    async def cleanup(self) -> None:
        self.cleaned = True

    async def accessibility_tree(self) -> list[dict]:
        self.clock.t += 0.05
        return self.app.nodes()

    async def screenshot(self) -> bytes:
        self.clock.t += 0.1
        return self.app.png()

    async def describe_point(self, x, y, nested=True):
        return self.app.at(x, y)

    async def describe(self):
        return SimpleNamespace(screen_dimensions=SimpleNamespace(width_points=W, height_points=H))

    async def tap(self, x, y, duration=None):
        self.app.taps.append((x, y, duration))
        self.app.tap(x, y)
        return True

    async def swipe(self, x1, y1, x2, y2, duration=None):
        if x1 <= 2 and x2 > x1 and self.app.screen == "detail":
            self.app.screen = "list"
        return True

    async def launch(self, bundle_id):
        self.app.launched += 1
        self.app.front = "app"
        return True

    async def terminate(self, bundle_id):
        self.app.terminated += 1
        return True

    async def text(self, text):
        self.app.typed.append(text)
        if self.app.focused:
            self.app.name += text
        return True

    async def keys(self, events):
        self.app.typed.append(f"<{len(events)} presses>")
        if self.app.focused:
            self.app.name += "é"
        return True

    async def key(self, code):
        self.app.keys += 1
        if code == ios.KEY_DELETE and self.app.focused:
            self.app.name = self.app.name[:-1]
        return True

    async def button(self, name):
        if name == "HOME":
            self.app.front = "home"
        return True

    async def open_url(self, url):
        return True


@pytest.fixture
def clock():
    c = Clock()
    screen_mod.use_clock(c, c.sleep)
    yield c
    screen_mod.use_clock(None, None)


@pytest.fixture
def sims(monkeypatch, tmp_path):
    booted = [ios_idb.Simulator("U-PHONE", "iPhone 17 Pro", "iOS 26.5"), ios_idb.Simulator("U-PAD", "iPad Pro 13-inch (M5)", "iOS 26.5")]
    monkeypatch.setattr(ios.shutil, "which", lambda name: f"/opt/homebrew/bin/{name}")
    monkeypatch.setattr(ios_idb, "booted_simulators", lambda: list(booted))
    monkeypatch.setattr(ios_idb, "is_booted", lambda udid: True)
    monkeypatch.setattr(ios_idb, "installed_apps", lambda udid: [
        ios_idb.AppInfo(APP, "Slate", False, APP_PATH), ios_idb.AppInfo("com.apple.Preferences", "Settings", True, "/sys/Preferences.app"),
    ])
    monkeypatch.setattr(ios_idb, "ensure_app_accessibility", lambda udid, timeout_s=0: ())
    monkeypatch.setattr(ios_idb, "process_path", lambda pid: {APP_PID: f"{APP_PATH}/Slate", SB_PID: SB_PATH}.get(pid))
    monkeypatch.setattr(locks, "LOCK_ROOT", tmp_path)
    return booted


async def _start(clock, *, app: FakeApp | None = None, **kw) -> tuple[ios.IosSession, FakeApp, FakeClient]:
    app = app or FakeApp()
    client = FakeClient(app, clock)
    s = ios.IosSession(client_factory=lambda udid: client, **kw)
    await s.start(APP)
    return s, app, client


# ---------- start and end ----------


async def test_start_claims_the_iphone_launches_the_app_and_end_releases_it(sims, clock, tmp_path):
    s, app, client = await _start(clock)
    assert (s.platform, s.device_name, s.udid, s.app_id, s.app_name) == ("ios", "iPhone 17 Pro", "U-PHONE", APP, "Slate")
    assert (tmp_path / "claude-sim-lock-iPhone-17-Pro").is_dir()
    assert app.terminated == 1 and app.launched == 1
    text = s.last_screen.text()
    assert text.startswith(f"foreground: {APP} (Slate)") and 'Cell "General"' in text
    assert any(line.startswith("e") and 'Cell "General"' in line for line in text.splitlines())
    summary = await s.end()
    assert summary["platform"] == "ios" and client.cleaned and app.terminated == 2
    assert not (tmp_path / "claude-sim-lock-iPhone-17-Pro").exists()


async def test_a_held_iphone_falls_back_to_the_ipad_and_both_held_refuses(sims, clock, tmp_path):
    (tmp_path / "claude-sim-lock-iPhone-17-Pro").mkdir()
    s, _, _ = await _start(clock)
    assert s.device_name == "iPad Pro 13-inch (M5)" and (tmp_path / "claude-sim-lock-iPad-Pro-13-inch-M5").is_dir()
    await s.end()
    (tmp_path / "claude-sim-lock-iPad-Pro-13-inch-M5").mkdir()
    with pytest.raises(SessionError, match="in use by another agent"):
        await _start(clock)


async def test_an_app_that_is_not_installed_refuses_and_frees_the_lock(sims, clock, tmp_path):
    s = ios.IosSession(client_factory=lambda udid: FakeClient(FakeApp(), clock))
    with pytest.raises(SessionError, match="not installed.*com.apple.Preferences"):
        await s.start("com.apple")
    assert not list(tmp_path.iterdir())


async def test_a_named_simulator_that_is_not_booted_is_never_created(sims, clock):
    s = ios.IosSession(device_name="iPhone 15", client_factory=lambda udid: FakeClient(FakeApp(), clock))
    with pytest.raises(SessionError, match="no booted simulator named iPhone 15.*never creates"):
        await s.start(APP)


def test_pick_simulators_order():
    a, b, c = ios_idb.Simulator("1", "Other"), ios_idb.Simulator("2", "iPad Pro 13-inch (M5)"), ios_idb.Simulator("3", "iPhone 17 Pro")
    assert [x.udid for x in ios.pick_simulators([a, b, c])] == ["3", "2", "1"]
    assert ios.pick_simulators([a, b, c], device_name="Other") == [a]
    assert ios.pick_simulators([a, b, c], udid="2") == [b]


def test_parse_booted_reads_simctl_json():
    text = '{"devices": {"com.apple.CoreSimulator.SimRuntime.iOS-26-5": [{"udid": "U", "name": "iPhone 17 Pro", "state": "Booted", "deviceTypeIdentifier": "t"}, {"udid": "V", "name": "Old", "state": "Shutdown"}]}}'
    assert ios_idb.parse_booted(text) == [ios_idb.Simulator("U", "iPhone 17 Pro", "iOS 26.5", "t")]


# ---------- actions ----------


async def test_a_tap_navigates_holds_and_reports_the_settled_screen(sims, clock):
    steps = []
    s, app, _ = await _start(clock, on_step=steps.append)
    result = await s.tap("General")
    assert result.startswith("tapped at (201, 185) via text")
    assert app.screen == "detail" and app.taps[-1][2] == ios_idb.TAP_HOLD_S
    assert s.last_screen.settled == "changed" and 'Heading "General"' in s.last_screen.text()
    assert "settled: changed" in s.last_screen.text()
    assert steps[-1].kind == "tap" and steps[-1].args["target"] == {"text": "General"} and steps[-1].args["element"] == 'Cell "General"'


async def test_a_long_press_keeps_its_length(sims, clock):
    s, app, _ = await _start(clock)
    assert (await s.tap("Privacy", long_press_ms=800)).startswith("long-pressed 800ms")
    assert app.taps[-1][2] == 0.8


async def test_a_switch_row_is_tapped_on_its_switch(sims, clock):
    s, app, _ = await _start(clock)
    result = await s.tap("Airplane Mode")
    assert "on its switch" in result and app.taps[-1][0] == 16 + 370 - ios.SWITCH_W // 2
    assert app.airplane == "1"


async def test_a_ref_resolves_on_the_screen_the_agent_saw(sims, clock):
    s, app, _ = await _start(clock)
    ref = next(e.ref for e in s.last_screen.elements if e.label == "General")
    assert (await s.tap(ref)).startswith("tapped") and app.screen == "detail"


async def test_a_ref_that_now_names_another_element_is_refused(sims, clock):
    s, app, _ = await _start(clock)
    ref = next(e.ref for e in s.last_screen.elements if e.label == "Privacy")
    app.screen = "detail"
    await s.snapshot()  # the session read the new screen; the agent did not see it
    result = await s.tap(ref)
    assert result.startswith(f"error: ref {ref} was") and "Call screen" in result and app.taps == []


async def test_a_target_off_screen_is_refused_not_sent(sims, clock):
    s, app, _ = await _start(clock)
    result = await s.tap("Far away")
    assert result.startswith("error: the target is off screen") and "swipe up" in result and app.taps == []


async def test_a_target_that_matched_nothing_lists_the_nearest(sims, clock):
    s, app, _ = await _start(clock)
    result = await s.tap("Privcy")
    assert "no element matched" in result and "nearest:" in result and 'Cell "Privacy"' in result
    assert s.steps[-1].failed


async def test_a_dead_control_settles_unchanged_and_says_so(sims, clock):
    s, _, _ = await _start(clock)
    await s.tap("Dead")
    assert s.last_screen.settled == "unchanged"
    assert any(n.startswith("screen_unchanged:") for n in s.last_screen.notes)


async def test_typing_is_verified_and_an_emoji_is_refused(sims, clock):
    s, app, _ = await _start(clock)
    result = await s.type_text("id=name", "Amani")
    assert app.focused and app.name == "Amani"
    assert "verified: true" in result and "field value now 'Amani'" in result
    assert s.last_screen.settled == "changed"
    refused = await s.type_text("id=name", "hi 🦊")
    assert refused.startswith("type failed") and "nothing was typed" in refused and app.name == "Amani"


async def test_accents_go_in_as_key_presses(sims, clock):
    s, app, _ = await _start(clock)
    await s.type_text("id=name", "é")
    assert app.typed[-1].startswith("<") and app.name == "é"


async def test_clear_text_deletes_the_value(sims, clock):
    s, app, _ = await _start(clock)
    await s.type_text("id=name", "Amani")
    result = await s.clear_text("id=name")
    assert app.name == "" and "cleared: true" in result and app.keys == 5


async def test_back_taps_the_navigation_back_button(sims, clock):
    s, app, _ = await _start(clock)
    await s.tap("General")
    result = await s.press("back")
    assert result.startswith('pressed back: tapped Button "Library"') and app.screen == "list"
    assert s.last_screen.settled == "changed"


async def test_back_without_a_button_swipes_from_the_edge(sims, clock):
    s, app, _ = await _start(clock)
    app.screen = "detail"
    s.last_screen.elements = [e for e in s.last_screen.elements if e.label != "Library"]
    result = await s.press("back")
    assert "swiped from the left edge" in result


async def test_an_unknown_key_is_an_error(sims, clock):
    s, _, _ = await _start(clock)
    assert (await s.press("volume")).startswith("error: key must be one of")


async def test_a_permission_alert_is_allowed_and_told(sims, clock):
    s, app, _ = await _start(clock)
    await s.tap("Notify me")
    assert app.front == "app"
    notes = s.last_screen.notes
    assert any(n.startswith('permission: the session allowed "“Slate” Would Like to Send You Notifications" (Allow)') for n in notes)
    assert s.steps[-1].args.get("source") == "harness" and s.steps[-1].args["permission"] == "Allow"
    assert s.last_screen.foreground == APP


async def test_permission_alerts_are_left_alone_when_asked(sims, clock):
    s, app, _ = await _start(clock, auto_allow_permissions=False)
    await s.tap("Notify me")
    assert app.front == "alert" and s.last_screen.foreground == "com.apple.springboard"


async def test_a_tap_after_the_app_left_is_refused_and_the_app_brought_back(sims, clock):
    s, app, _ = await _start(clock)
    launched = app.launched
    app.front = "home"
    result = await s.tap("General")
    assert result.startswith("error: Slate was not in front (the home screen was), so nothing was tapped; the session brought it back")
    assert app.launched == launched + 1 and app.screen == "list" and app.front == "app"
    assert (await s.tap("General")).startswith("tapped")


async def test_navigation_bar_items_idb_hides_are_read_point_by_point(sims, clock):
    s, _, _ = await _start(clock)
    labels = [e.label for e in s.last_screen.elements]
    assert "Edit" in labels and labels.index("Edit") == labels.index("Library") + 1


async def test_find_and_wait(sims, clock):
    s, app, _ = await _start(clock)
    assert 'Cell "Privacy"' in await s.find("priv")
    assert "no element matches" in await s.find("zzz")
    result = await s.wait(500)
    assert result.startswith("waited") and "did not change" in result
    assert s.steps[-1].kind == "wait"


# ---------- pure helpers ----------


def _el(type_, label, box, value="", traits=None):
    x1, y1, x2, y2 = box
    return Element(index=0, type=type_, label=label, value=value, identifier="", x1=x1, y1=y1, x2=x2, y2=y2, enabled=True, traits=list(traits or []))


def test_switch_point_and_right_to_left():
    row = _el("CheckBox", "Pages turn right-to-left", (16, 100, 360, 144))
    assert ios.switch_point(row) == (360 - ios.SWITCH_W // 2, 122)
    assert ios.switch_point(_el("CheckBox", "الوضع الليلي", (16, 100, 360, 144))) == (16 + ios.SWITCH_W // 2, 122)
    assert ios.switch_point(_el("Switch", "", (300, 100, 351, 131))) is None
    assert ios.switch_point(_el("Button", "Row", (0, 0, 400, 44))) is None


def test_into_view_and_editing():
    tall = _el("ScrollView", "Feed", (0, 100, 402, 2000))
    assert ios.into_view(tall, (201, 1050), "text", 402, 874) == ((201, 487), "text, on its part on screen")
    sliver = _el("Cell", "Row", (0, 860, 402, 920))
    assert ios.into_view(sliver, (201, 890), "text", 402, 874) == ((201, 890), "text")
    assert ios.editing(_el("TextField", "", (0, 0, 1, 1), traits=["TextEntry", "IsEditing"])) is True
    assert ios.editing(_el("TextField", "", (0, 0, 1, 1), traits=["TextEntry"])) is False
    assert ios.editing(_el("TextField", "", (0, 0, 1, 1))) is None


def test_text_events_and_plain():
    events, missing = ios.text_events("José Zoë’s")
    assert events and missing == []
    assert ios.text_events("hi 🦊 مرحبا")[1][0] == "🦊"
    assert ios.plain("Amani’s “note” — ok") == 'Amani\'s "note" - ok'


def test_bars_helpers():
    bar = {"type": "Group", "role_description": "Nav bar", "AXLabel": "Edit routine", "frame": _f(0, 54, 402, 96)}
    raw = [{"type": "Application", "frame": _f(0, 0, 402, 874)}, bar]
    assert ios.opaque_bars(raw) == [bar] and ios.probe_rows((0, 54, 402, 96)) == [76, 102]
    found = {"type": "Button", "AXLabel": "Close", "frame": _f(8, 60, 44, 44), "children": [{"type": "StaticText", "AXLabel": "x", "frame": _f(10, 62, 10, 10)}]}
    items = ios.items_from_probe(bar, found)
    assert [i["AXLabel"] for i in items] == ["Close", "x"] and "children" not in items[0]
    merged = ios.merge_bars(raw, {id(bar): items + items})
    assert [n.get("AXLabel") for n in merged] == [None, "Edit routine", "Close", "x"]


def test_a_tree_that_is_dead_or_lost():
    assert ios.dead_tree([{"type": "Application", "frame": _f(0, 0, 0, 0)}])
    assert not ios.dead_tree([{"type": "Application", "frame": _f(0, 0, 402, 874)}])
    assert ios.blind(None) and ios.blind([]) and ios.blind([{"type": "Button"}], available=False)
    watch = ios.TreeWatch()
    assert not watch.lost(None, False)  # never seen: not "lost"
    watch.lost([{"type": "Button"}], True)
    assert [watch.lost([], True) for _ in range(ios.LOST_AFTER)][-1] is True


def test_an_iphone_app_in_an_ipad_window_is_windowed():
    assert ios.windowed((402, 874), (1032, 1376)) and not ios.windowed((1032, 1376), (1032, 1376))
    assert "iPhone app running in a 402x874 window" in ios.windowed_message("Slate", (402, 874), "iPad Pro 13-inch (M5)")


def test_a_system_sheet_is_told_apart():
    root = {"type": "Application", "AXLabel": "Safari", "frame": _f(0, 0, 402, 874)}
    scrim = {"type": "Group", "AXLabel": "dismiss popup", "frame": _f(0, 0, 402, 874)}
    shot = SimpleNamespace(elements=parse_tree([root, scrim]), tree_available=True)
    assert ios.scrim_only(shot) and ios.unreadable(shot)
    assert ios.unreadable(SimpleNamespace(elements=[], tree_available=False))
    ps = (
        "  100     1  1-00:00:00 /Library/Developer/CoreSimulator/Devices/U1/data/launchd_sim\n"
        "  200   100       00:03 /Runtime/SharingUIService.app/SharingUIService\n"
        "  300   100    01:00:00 /Runtime/PhotosUIService.app/PhotosUIService\n"
    )
    assert ios.services_in(ps, "U1") == ["SharingUIService", "PhotosUIService"]
    assert ios.services_in(ps, "U1", started_within_s=10) == ["SharingUIService"]
    assert ios.overlay_name([], "Share PDF") == "the system share sheet" and ios.overlay_name([], "Save") == "a system sheet"
    assert "closed it with a swipe down" in ios.dismissed_note("the system share sheet", "swipe", "Slate")
    assert ios.elapsed_s("1-02:03:04") == 93784 and ios.elapsed_s("x") is None


def test_back_button_heuristic():
    els = parse_tree([
        {"type": "Application", "frame": _f(0, 0, 402, 874)},
        {"type": "Button", "AXLabel": "Settings", "frame": _f(8, 60, 100, 44)},
        {"type": "Button", "AXLabel": "Edit", "frame": _f(330, 60, 60, 44)},
    ])
    assert ios.back_button(els, 402, 874).label == "Settings"
    assert ios.back_button(parse_tree([{"type": "Button", "AXLabel": "Close", "frame": _f(8, 60, 60, 44)}]), 402, 874) is None


async def test_start_says_each_stage_after_the_lock_is_taken(sims, clock):
    said: list[str] = []
    app = FakeApp()
    client = FakeClient(app, clock)
    s = ios.IosSession(client_factory=lambda udid: client)
    s.on_stage = said.append
    await s.start(APP)
    assert said[0].startswith("Reading the apps on") and any(t.startswith("Connecting to") for t in said)
    assert said[-1].endswith("to show its first screen")
    await s.end()


async def test_a_failed_companion_restart_is_retried_on_the_next_action_and_said_honestly(sims, clock):
    s, app, client = await _start(clock)
    starts = {"ok": False, "calls": 0}

    async def init(*a: Any, **k: Any) -> bool:
        starts["calls"] += 1
        return starts["ok"]

    async def cleanup() -> None:
        return None

    client.init_companion = init
    client.cleanup = cleanup

    async def hang() -> None:
        raise ios.asyncio.TimeoutError

    with pytest.raises(SessionError, match="did not restart; the next action tries again"):
        await s._idb(hang(), "terminate", timeout=1)
    with pytest.raises(SessionError, match="could not be restarted"):
        await s._ensure_alive()
    assert starts["calls"] == 2
    starts["ok"] = True
    await s._ensure_alive()
    assert starts["calls"] == 3
    await s._ensure_alive()
    assert starts["calls"] == 3
