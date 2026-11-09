"""The Android session (`orcha_cli/qa/device/android.py`) and driver (`android_u2.py`) against a
fake uiautomator2 client and adb: hierarchy mapping, emoji text, keyboard restore, device pick
and lock, launch, settled actions, the launcher in front, typing, a read that fails, permission
dialogs. Ported from the original `test_tree_readers.py`, `test_android_input_method.py` and
`test_app_in_front.py`. No emulator needed."""

from __future__ import annotations

import io
from typing import Any

import pytest

pytest.importorskip("PIL")

from PIL import Image  # noqa: E402

from orcha_cli.qa.device import android, android_u2, locks  # noqa: E402
from orcha_cli.qa.device import screen as screen_mod  # noqa: E402
from orcha_cli.qa.device.base import SessionError  # noqa: E402
from orcha_cli.qa.device.tree import parse_tree  # noqa: E402

APP = "com.android.settings"
LAUNCHER = "com.google.android.apps.nexuslauncher"
PERMS = "com.google.android.permissioncontroller"
W, H = 360, 800


def _n(cls: str, *, text: str = "", desc: str = "", rid: str = "", bounds=(0, 0, 0, 0), pkg: str = APP, **attrs: Any) -> dict[str, Any]:
    x1, y1, x2, y2 = bounds
    node = {"class": f"android.widget.{cls}", "text": text, "content-desc": desc, "resource-id": rid,
            "bounds": f"[{x1},{y1}][{x2},{y2}]", "package": pkg, "enabled": "true"}
    node.update({k.replace("_", "-"): v for k, v in attrs.items()})
    return node


class Clock:
    def __init__(self) -> None:
        self.t = 500.0

    def __call__(self) -> float:
        return self.t

    async def sleep(self, seconds: float) -> None:
        self.t += seconds


class FakeDevice:
    def __init__(self, clock: Clock) -> None:
        self.clock = clock
        self.screen = "list"
        self.front = APP
        self.running = True
        self.query = ""
        self.focused = False
        self.shell: list[str] = []
        self.taps: list[tuple[int, int, int | None]] = []
        self.fail_reads = 0
        self.installed = {APP}

    def nodes(self) -> list[dict[str, Any]]:
        status = _n("TextView", text="12:30", bounds=(0, 0, W, 40), pkg="com.android.systemui")
        if self.front == LAUNCHER:
            return [status, _n("TextView", text="Phone", clickable="true", bounds=(20, 600, 100, 680), pkg=LAUNCHER)]
        if self.front == PERMS:
            return [status,
                    _n("TextView", text="Allow Settings to send you notifications?", bounds=(30, 300, 330, 360), pkg=PERMS),
                    _n("Button", text="Allow", rid=f"{PERMS}:id/permission_allow_button", clickable="true", bounds=(30, 400, 330, 450), pkg=PERMS),
                    _n("Button", text="Don't allow", rid=f"{PERMS}:id/permission_deny_button", clickable="true", bounds=(30, 460, 330, 510), pkg=PERMS)]
        if self.screen == "detail":
            return [status,
                    _n("ImageButton", desc="Navigate up", clickable="true", bounds=(0, 50, 60, 110)),
                    _n("TextView", text="Network & internet", bounds=(70, 60, 300, 100))]
        return [status,
                _n("FrameLayout", bounds=(0, 40, W, H)),
                _n("TextView", text="Settings", bounds=(20, 60, 200, 100)),
                _n("EditText", text=self.query, rid="com.android.settings:id/search", clickable="true", focused="true" if self.focused else "false", bounds=(20, 110, 340, 160)),
                _n("LinearLayout", desc="Network & internet", clickable="true", bounds=(0, 180, W, 260)),
                _n("Switch", text="Wi-Fi", checked="false", clickable="true", bounds=(0, 270, W, 330)),
                _n("Button", text="Notify me", clickable="true", bounds=(20, 350, 200, 400)),
                _n("RecyclerView", bounds=(0, 400, W, H))]

    def png(self) -> bytes:
        tone = {LAUNCHER: 20, PERMS: 60}.get(self.front, 120 if self.screen == "list" else 200)
        img = Image.new("L", (W, H), tone)
        if self.query:
            img.paste(0, (20, 110, 20 + 10 * len(self.query), 160))
        buf = io.BytesIO()
        img.save(buf, "PNG")
        return buf.getvalue()

    def at(self, x: int, y: int) -> dict[str, Any] | None:
        hits = []
        for n in self.nodes():
            x1, y1, x2, y2 = android.parse_bounds(n["bounds"])
            if x1 <= x <= x2 and y1 <= y <= y2 and n.get("clickable") == "true":
                hits.append((x2 - x1) * (y2 - y1) and n)
        return min(hits, key=lambda n: len(n["bounds"])) if hits else None

    def tap(self, x: int, y: int) -> None:
        node = self.at(x, y)
        label = (node or {}).get("content-desc") or (node or {}).get("text")
        if self.front == PERMS:
            if label in ("Allow", "Don't allow"):
                self.front = APP
            return
        self.focused = bool(node and node.get("class", "").endswith("EditText"))
        if label == "Network & internet":
            self.screen = "detail"
        elif label == "Navigate up":
            self.screen = "list"
        elif label == "Notify me":
            self.front = PERMS


class FakeUi:
    def __init__(self, dev: FakeDevice) -> None:
        self.dev = dev
        self.restarts = 0

    def connect(self) -> Any:
        return self

    def get_screen_data(self) -> android_u2.ScreenData:
        self.dev.clock.t += 0.2
        if self.dev.fail_reads:
            self.dev.fail_reads -= 1
            raise RuntimeError("uiautomator2 dropped the connection")
        return android_u2.ScreenData(png=self.dev.png(), elements=self.dev.nodes(), width=W, height=H)

    def get_hierarchy(self) -> tuple[list[dict], int, int]:
        self.dev.clock.t += 0.05
        return self.dev.nodes(), W, H

    def restart(self) -> None:
        self.restarts += 1


class FakeController:
    def __init__(self, dev: FakeDevice) -> None:
        self.dev = dev

    def shell(self, cmd: str) -> str:
        d = self.dev
        d.shell.append(cmd)
        if cmd.startswith("pm path "):
            return f"package:/data/app/{cmd[8:]}/base.apk" if cmd[8:] in d.installed else ""
        if cmd.startswith(f"monkey -p {APP}"):
            d.front, d.running = APP, True
        if cmd == "input keyevent KEYCODE_HOME":
            d.front = LAUNCHER
        if cmd.startswith("pidof"):
            return "4242\n" if d.running else ""
        if cmd.startswith("input keyevent KEYCODE_DEL"):
            d.query = d.query[: max(0, len(d.query) - cmd.count("KEYCODE_DEL"))]
        return ""

    def tap(self, x: int, y: int, long_press_ms: int | None = None) -> str | None:
        self.dev.taps.append((x, y, long_press_ms))
        self.dev.tap(x, y)
        return None

    def swipe(self, x1, y1, x2, y2, duration_ms=400) -> str | None:
        return None

    def keyevent(self, code) -> bool:
        if code == "KEYCODE_BACK" and self.dev.screen == "detail":
            self.dev.screen = "list"
        return True

    def input_text(self, text: str) -> bool:
        if self.dev.focused:
            self.dev.query += text
        return True

    def open_url(self, url: str, package: str | None = None) -> str:
        return "Status: ok"


@pytest.fixture
def clock():
    c = Clock()
    screen_mod.use_clock(c, c.sleep)
    yield c
    screen_mod.use_clock(None, None)


@pytest.fixture
def dev(monkeypatch, tmp_path, clock):
    d = FakeDevice(clock)
    monkeypatch.setattr(android_u2, "focused_package", lambda serial: d.front)
    monkeypatch.setattr(android_u2, "first_device", lambda: "emulator-5554")
    monkeypatch.setattr(android_u2, "adb_devices", lambda: [("emulator-5554", "device"), ("emulator-5556", "offline")])
    monkeypatch.setattr(android_u2, "avd_name", lambda serial: "Pixel_9_Pro")
    monkeypatch.setattr(android_u2, "is_connected", lambda serial: True)
    monkeypatch.setattr(locks, "LOCK_ROOT", tmp_path)
    return d


async def _start(dev: FakeDevice, **kw: Any) -> android.AndroidSession:
    s = android.AndroidSession(ui_factory=lambda serial: FakeUi(dev), controller_factory=lambda serial, ui: FakeController(dev), **kw)
    await s.start(APP)
    return s


# ---------- mapping the hierarchy ----------


def test_android_to_raw_maps_classes_ids_and_chrome():
    nodes = [
        _n("TextView", text="12:30", bounds=(0, 0, 360, 40), pkg="com.android.systemui"),
        _n("EditText", text="secret", rid="com.x:id/password", password="true", bounds=(0, 50, 300, 100)),
        _n("LinearLayout", desc="Network", clickable="true", bounds=(0, 100, 360, 180)),
        _n("CheckBox", text="Remember me", checked="true", bounds=(0, 200, 200, 240)),
        _n("FrameLayout", bounds=(0, 0, 360, 800)),
        _n("RecyclerView", text="list", bounds=(0, 0, 360, 800)),
    ]
    raw = android.android_to_raw(nodes, width=360, height=800, foreground_package="com.x")
    assert raw[0] == {"type": "Application", "AXLabel": "com.x", "frame": {"x": 0, "y": 0, "width": 360, "height": 800}, "enabled": True}
    els = parse_tree(raw)
    assert [(e.type, e.label) for e in els[1:]] == [
        ("StaticText", "12:30"), ("SecureTextField", "secret"), ("Button", "Network"), ("Switch", "Remember me"),
    ]
    assert "System" in els[1].traits and els[2].identifier == "password" and "Secure" in els[2].traits
    assert "Selected" in els[4].traits and els[2].value == "secret"


def test_foreground_package_prefers_dumpsys_and_skips_the_status_bar():
    nodes = [_n("TextView", pkg="com.android.systemui"), _n("TextView", pkg="com.x")]
    assert android.foreground_package(nodes, "com.y") == "com.y"
    assert android.foreground_package(nodes, None) == "com.x"
    assert android_u2.focused_package_of("  mCurrentFocus=Window{5694122 u0 com.x/com.x.Main}") == "com.x"
    assert android_u2.focused_package_of("  mCurrentFocus=null") is None


def test_am_start_problems_are_read_from_its_output():
    assert android_u2.am_start_problem("Error: Activity not started, unable to resolve Intent") is not None
    assert android_u2.am_start_problem("Status: ok\nActivity: com.x/.Main") is None


def test_parse_hierarchy_flattens_in_document_order():
    xml = '<hierarchy><node class="a" text="1"><node class="b" text="2"/></node><node class="c" text="3"/></hierarchy>'
    assert [n["text"] for n in android_u2.parse_hierarchy(xml)] == ["1", "2", "3"]
    assert android_u2.parse_hierarchy("<broken") == []


def test_emoji_text_is_read_back_by_bounds_or_marked():
    els = [{"text": "..", "bounds": "[0,0][10,10]"}, {"content-desc": "Hi ..", "bounds": "[0,20][10,30]"}, {"text": "a..b", "bounds": "[5,5][6,6]"}]
    infos = [{"text": "🦊", "bounds": {"left": 0, "top": 0, "right": 10, "bottom": 10}},
             {"contentDescription": "Hi 🦊", "bounds": {"left": 0, "top": 20, "right": 10, "bottom": 30}}]
    assert android_u2.restore_stripped_text(els, infos) == 2
    assert els[0]["text"] == "🦊" and els[1]["content-desc"] == "Hi 🦊" and els[2]["text"] == "a..b"
    lost = [{"text": "....", "bounds": "[0,0][1,1]"}]
    android_u2.restore_stripped_text(lost, None)
    assert lost[0]["text"] == android_u2.UNREADABLE


class _Ime:
    def __init__(self, before="com.google/.LatinIME", switches=True, fail=False):
        self.ime = before
        self.switches = switches
        self.fail = fail
        self.sent: list[str] = []
        self.shells: list[list[str]] = []

    def current_ime(self):
        return self.ime

    def send_keys(self, text):
        if self.switches:
            self.ime = "com.github.uiautomator/.AdbKeyboard"
        if self.fail:
            raise RuntimeError("boom")
        self.sent.append(text)

    def shell(self, args):
        self.shells.append(args)
        self.ime = args[-1]
        return type("R", (), {"exit_code": 0})()


def test_send_text_types_once_and_restores_the_keyboard():
    ui = android_u2.UiAutomatorClient("emulator-5554")
    ime = _Ime()
    ui.connect = lambda: ime  # type: ignore[method-assign]
    ui.send_text("Zoë 🦊")
    assert ime.sent == ["Zoë 🦊"] and ime.ime == "com.google/.LatinIME" and ime.shells == [["ime", "set", "com.google/.LatinIME"]]
    failing = _Ime(fail=True)
    ui.connect = lambda: failing  # type: ignore[method-assign]
    with pytest.raises(RuntimeError, match="boom"):
        ui.send_text("x")
    assert failing.ime == "com.google/.LatinIME"
    none = _Ime(before="null")
    ui.connect = lambda: none  # type: ignore[method-assign]
    with pytest.raises(RuntimeError, match="unavailable"):
        ui.send_text("x")
    assert none.sent == []


# ---------- the session ----------


async def test_start_claims_the_emulator_and_launches_fresh(dev, tmp_path):
    s = await _start(dev)
    assert (s.platform, s.udid, s.serial, s.device_name, s.app_id) == ("android", "emulator-5554", "emulator-5554", "Pixel_9_Pro", APP)
    assert (tmp_path / "claude-sim-lock-emulator-5554").is_dir()
    assert dev.shell[:4] == [f"pm path {APP}", "input keyevent KEYCODE_HOME", f"am force-stop {APP}", f"monkey -p {APP} -c android.intent.category.LAUNCHER 1"]
    text = s.last_screen.text()
    assert text.startswith(f"foreground: {APP} ({APP})") and 'Button "Network & internet"' in text and "screen: 360x800" in text
    await s.end()
    assert dev.shell[-1] == f"am force-stop {APP}" and not (tmp_path / "claude-sim-lock-emulator-5554").exists()


async def test_a_device_is_named_by_serial_or_avd(dev):
    s = await _start(dev, device_name="Pixel_9_Pro")
    assert s.udid == "emulator-5554" and s.device_name == "Pixel_9_Pro"
    await s.end()
    with pytest.raises(SessionError, match="no Android device named Pixel_4.*attached: emulator-5554"):
        await _start(dev, device_name="Pixel_4")


async def test_a_locked_emulator_and_a_missing_app_are_refused(dev, tmp_path):
    (tmp_path / "claude-sim-lock-emulator-5554").mkdir()
    with pytest.raises(SessionError, match="in use by another agent"):
        await _start(dev)
    (tmp_path / "claude-sim-lock-emulator-5554").rmdir()
    dev.installed = set()
    with pytest.raises(SessionError, match="not installed"):
        await _start(dev)
    assert not list(tmp_path.iterdir())


async def test_a_tap_navigates_and_back_returns(dev):
    s = await _start(dev)
    result = await s.tap("Network & internet")
    assert result.startswith("tapped at (180, 220) via text") and dev.screen == "detail"
    assert s.last_screen.settled == "changed" and 'Button "Navigate up"' in s.last_screen.text()
    assert (await s.press("back")) == "pressed back" and dev.screen == "list"
    assert s.steps[-1].kind == "press" and s.steps[-1].args == {"key": "back"}


async def test_a_tap_with_the_launcher_in_front_sends_nothing_and_brings_the_app_back(dev):
    s = await _start(dev)
    dev.front = LAUNCHER
    result = await s.tap("Network & internet")
    assert result.startswith(f"error: {APP} was not in front (the launcher was), so nothing was tapped; the session brought it back")
    assert dev.taps == [] and dev.front == APP
    assert (await s.tap("Network & internet")).startswith("tapped")


async def test_an_app_that_stopped_is_started_again_and_said_so(dev):
    s = await _start(dev)
    dev.front, dev.running = LAUNCHER, False
    assert "it had stopped running, so the session started it again" in await s.tap("Network & internet")


async def test_typing_is_verified_against_the_field(dev):
    s = await _start(dev)
    result = await s.type_text("id=search", "wifi")
    assert dev.query == "wifi" and "verified: true" in result and "field value now 'wifi'" in result
    cleared = await s.clear_text("id=search")
    assert dev.query == "" and "cleared: true" in cleared


async def test_a_permission_dialog_is_allowed_by_its_id(dev):
    s = await _start(dev)
    await s.tap("Notify me")
    assert dev.front == APP
    assert any(n.startswith('permission: the session allowed "Allow Settings to send you notifications?"') for n in s.last_screen.notes)


async def test_a_read_that_fails_once_serves_the_last_screen_degraded(dev):
    s = await _start(dev)
    dev.fail_reads = 2  # the driver retries a dropped read once itself
    shot = await s.screen()
    assert shot.degraded and "degraded: true" in shot.text() and "could not be read just now" in shot.text()
    assert not (await s.screen()).degraded


async def test_an_unknown_key_and_open_url(dev):
    s = await _start(dev)
    assert (await s.press("volume")).startswith("error: key must be one of")
    assert (await s.open_url("https://example.com")) == "opened https://example.com"


def test_a_nameless_row_takes_the_texts_inside_it():
    nodes = [
        _n("LinearLayout", clickable="true", bounds=(0, 726, 1280, 960)),
        _n("ImageView", rid="android:id/icon", bounds=(96, 783, 216, 903)),
        _n("TextView", text="Network & internet", rid="android:id/title", bounds=(240, 774, 736, 855)),
        _n("TextView", text="Mobile, Wi-Fi, hotspot", rid="android:id/summary", bounds=(240, 855, 640, 912)),
        _n("TextView", text="Below the row", bounds=(240, 970, 640, 1000)),
        _n("Button", clickable="true", bounds=(0, 1000, 100, 1100)),
    ]
    els = parse_tree(android.android_to_raw(nodes, width=1280, height=2856))
    assert els[1].label == "Network & internet, Mobile, Wi-Fi, hotspot"
    assert els[-1].label == ""  # nothing inside it: still nameless


async def test_a_second_run_takes_the_other_attached_device_unless_one_was_picked(dev, tmp_path, monkeypatch):
    monkeypatch.setattr(android_u2, "adb_devices", lambda: [("emulator-5554", "device"), ("emulator-5556", "device")])
    monkeypatch.setattr(android_u2, "serial_named", lambda name: "emulator-5554")
    (tmp_path / "claude-sim-lock-emulator-5554").mkdir()
    s = await _start(dev, device_name="Pixel_9_Pro", any_device=True)
    assert s.udid == "emulator-5556" and (tmp_path / "claude-sim-lock-emulator-5556").is_dir()
    await s.end()
    with pytest.raises(SessionError, match="in use by another agent") as busy:
        await _start(dev, device_name="Pixel_9_Pro")
    assert busy.value.devices == ["emulator-5554"]
