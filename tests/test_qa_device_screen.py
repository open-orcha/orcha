"""The QA device layer's screen, change detection and settle (`orcha_cli/qa/device/screen.py`) and
its lock directories (`locks.py`), adapted from the original `test_settle.py`, `test_change.py` and
the permission-dialog tests. Fakes only: no device."""

from __future__ import annotations

import io
import os
import time
from types import SimpleNamespace

import pytest

from orcha_cli.qa.device import locks
from orcha_cli.qa.device import screen as s
from orcha_cli.qa.device.tree import parse_tree

PIL = pytest.importorskip("PIL")
from PIL import Image, ImageDraw  # noqa: E402


def _png(color=0, size=(96, 192), box=None, box_color=255) -> bytes:
    img = Image.new("L", size, color)
    if box:
        ImageDraw.Draw(img).rectangle(box, fill=box_color)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def _els(*labels, value=""):
    return parse_tree([
        {"type": "Button", "AXLabel": label, "AXValue": value, "frame": {"x": 0, "y": 40 * i, "width": 100, "height": 30}}
        for i, label in enumerate(labels)
    ])


def _shot(*labels, value=""):
    return SimpleNamespace(elements=_els(*labels, value=value), tree_available=True, png=b"")


def _screen(elements, png=None, **kw) -> s.Screen:
    from orcha_cli.qa.device.tree import tree_hash

    defaults = dict(size=(402, 874), foreground="com.x", foreground_name="X", locked_app_violation=False, tree_available=True)
    defaults.update(kw)
    return s.Screen(png=png or _png(), raw=[], elements=elements, tree_hash=tree_hash(elements), **defaults)


class _Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t

    async def sleep(self, seconds):
        self.t += seconds


class _Session:
    def __init__(self, shots):
        self.shots = list(shots)
        self.captures = 0
        self.last_screen = None
        self.last_settled = None

    async def screen(self, settle_s=0):
        self.captures += 1
        shot = self.shots[min(self.captures - 1, len(self.shots) - 1)]
        self.last_screen = shot
        return shot


async def _settle(sess, after, before):
    clock = _Clock()
    verdict = await s.settle(sess, after=after, before_shape=s.shape_of(before) if before else None, clock=clock, sleep=clock.sleep)
    return verdict, clock.t


# ---------- the settle ----------


async def test_settle_returns_changed_when_shape_leaves_and_holds():
    sess = _Session([_shot("A"), _shot("B"), _shot("B")])
    verdict, _ = await _settle(sess, "tap", _shot("A"))
    assert verdict == "changed" and sess.captures == 3 and sess.last_settled == "changed"


async def test_settle_waits_out_the_change_window_for_a_dead_control():
    verdict, t = await _settle(_Session([_shot("A")]), "tap", _shot("A"))
    assert verdict == "unchanged" and t >= s.FULL_CHANGE_WAIT_S


async def test_settle_after_swipe_uses_the_brief_window():
    verdict, t = await _settle(_Session([_shot("A")]), "swipe", _shot("A"))
    assert verdict == "unchanged" and s.BRIEF_CHANGE_WAIT_S <= t < s.FULL_CHANGE_WAIT_S


async def test_settle_after_type_skips_held_still():
    sess = _Session([_shot("A"), _shot("B"), _shot("C")])
    verdict, _ = await _settle(sess, "type", _shot("A"))
    assert verdict == "changed" and sess.captures == 2


async def test_settle_reports_timeout_when_the_screen_keeps_moving():
    verdict, _ = await _settle(_Session([_shot(f"S{i}") for i in range(100)]), "tap", _shot("A"))
    assert verdict == "timeout"


async def test_settle_without_before_shape_only_holds_still():
    sess = _Session([_shot("A"), _shot("A")])
    verdict, _ = await _settle(sess, "tap", None)
    assert verdict == "changed" and sess.captures == 2


async def test_settle_waits_through_an_empty_transitional_tree():
    empty = SimpleNamespace(elements=[], tree_available=True, png=b"")
    sess = _Session([empty, empty, _shot("B"), _shot("B")])
    verdict, _ = await _settle(sess, "tap", _shot("A"))
    assert verdict == "changed" and s.shape_of(sess.last_screen) == s.shape_of(_shot("B"))


class _Signal:
    source = "frames"
    quiet_s = s.FRAME_QUIET_S

    def __init__(self, result):
        self.result = result
        self.calls = []

    async def wait(self, *, change_s, quiet_s, max_s):
        self.calls.append((change_s, quiet_s, max_s))
        return self.result


async def test_settle_on_a_signal_reads_the_tree_once():
    sess = _Session([_shot("B")])
    sig = _Signal(s.SignalResult(changed=True, still=True, first_s=0.1, took_s=0.5, frames=6))
    sess.change_signal = lambda after: sig
    verdict, _ = await _settle(sess, "tap", _shot("A"))
    assert verdict == "changed" and sess.captures == 1
    assert sig.calls[0][0] == s.DEAD_TAP_S  # a tap's dead window, not the full change wait
    assert sess.last_settle_timing["source"] == "frames" and sess.last_settle_timing["frames"] == 6


async def test_a_dead_tap_on_a_signal_is_unchanged_and_a_broken_signal_falls_back():
    sess = _Session([_shot("A")])
    sess.change_signal = lambda after: _Signal(s.SignalResult(changed=False, still=True, first_s=None, took_s=0.3))
    assert (await _settle(sess, "tap", _shot("A")))[0] == "unchanged"
    sess = _Session([_shot("A"), _shot("B"), _shot("B")])
    sess.change_signal = lambda after: _Signal(None)
    assert (await _settle(sess, "tap", _shot("A")))[0] == "changed"


# ---------- shapes and frames ----------


def test_shape_of_uses_pixels_only_without_interactive_nodes():
    canvas = lambda c: SimpleNamespace(elements=[], tree_available=True, png=_png(c))  # noqa: E731
    assert s.shape_of(canvas(0)) != s.shape_of(canvas(255))
    btn = lambda c: SimpleNamespace(elements=_els("Pay"), tree_available=True, png=_png(c))  # noqa: E731
    assert s.shape_of(btn(0)) == s.shape_of(btn(255))


def test_frames_look_same_ignores_a_caret_but_not_a_sheet():
    base = _png(200)
    assert s.frames_look_same(base, _png(200, box=(40, 40, 41, 50), box_color=0))
    assert not s.frames_look_same(base, _png(200, box=(0, 96, 96, 192), box_color=40))
    assert not s.frames_look_same(base, b"not a png")


def test_motion_sees_an_animation_tail_but_not_a_caret():
    a = s.frame_thumb(_png(200, size=(256, 512)), s.MOTION_THUMB)
    pill = s.frame_thumb(_png(200, size=(256, 512), box=(40, 40, 80, 60), box_color=0), s.MOTION_THUMB)
    caret = s.frame_thumb(_png(200, size=(256, 512), box=(40, 40, 40, 44), box_color=0), s.MOTION_THUMB)
    assert s.thumbs_moved(a, pill) and not s.thumbs_moved(a, caret)


def test_unchanged_after_needs_the_same_tree_values_and_pixels():
    before = _screen(_els("A"), _png(100))
    assert s.unchanged_after("tap", "tapped at (1, 1) via ref", before, _screen(_els("A"), _png(100)))
    assert not s.unchanged_after("tap", "tapped", before, _screen(_els("B"), _png(100)))
    assert not s.unchanged_after("tap", "tapped", before, _screen(_els("A", value="1"), _png(100)))
    assert not s.unchanged_after("tap", "tapped", before, _screen(_els("A"), _png(10)))
    assert not s.unchanged_after("type", "typed", before, _screen(_els("A"), _png(100)))
    assert not s.unchanged_after("tap", "tap failed: nope", before, _screen(_els("A"), _png(100)))


def test_a_toggle_whose_value_the_tree_hides_is_caught_by_its_own_pixels():
    els = _els("Dark mode")
    before = _screen(els, _png(200, size=(402, 874)))
    after = _screen(els, _png(200, size=(402, 874), box=(60, 2, 90, 28), box_color=30))
    assert s.frames_look_same(before.png, after.png)  # the whole frame barely moves
    assert not s.unchanged_after("tap", "tapped", before, after, {"target": {"ref": "e0"}})
    assert "screen_unchanged" in s.unchanged_note("tap", {"target": {"ref": "e0"}})


# ---------- the screen and its text ----------


def test_screen_text_is_notes_header_and_tree_with_refs():
    shot = _screen(_els("Save", "Cancel"), settled="changed", notes=["permission: allowed"])
    text = shot.text()
    head, _, body = text.partition("\n\n")
    assert head.splitlines() == [
        "permission: allowed", "foreground: com.x (X)", "locked_app_violation: false",
        f"tree_hash: {shot.tree_hash}", "screen: 402x874", "settled: changed",
    ]
    assert body.splitlines()[0] == 'e0 Button "Save" (0,0)-(100,30)'


def test_screen_without_a_tree_says_so_and_carries_its_extra():
    shot = _screen([], tree_available=False, extra="the session could not read this screen")
    assert "tree: unavailable" in shot.text() and shot.text().endswith("the session could not read this screen")


def test_model_jpeg_is_downscaled_and_says_how_to_map_it():
    shot = _screen(_els("A"), _png(120, size=(1206, 2622)))
    data, size = s.model_jpeg(shot.png)
    assert max(size) == s.MAX_SCREENSHOT_LONG_SIDE and data[:2] == b"\xff\xd8"
    assert shot.jpeg_size == size and shot.jpeg[:2] == b"\xff\xd8"
    assert "1 px = 1.14" in shot.image_note()


def test_a_password_field_is_painted_black():
    field = parse_tree([{"type": "SecureTextField", "AXLabel": "Password", "frame": {"x": 10, "y": 10, "width": 50, "height": 20}}])
    shot = _screen(field, _png(255, size=(100, 200)), size=(100, 200))
    img = Image.open(io.BytesIO(shot.png)).convert("L")
    assert img.getpixel((30, 20)) == 0 and img.getpixel((90, 150)) == 255 and shot.masking_proven


# ---------- permission dialogs ----------


def _alert(*buttons, fg="com.apple.springboard"):
    nodes = [{"type": "Application", "AXLabel": "SpringBoard", "frame": {"x": 0, "y": 0, "width": 402, "height": 874}},
             {"type": "StaticText", "AXLabel": "“Slate” Would Like to Send You Notifications", "frame": {"x": 40, "y": 300, "width": 320, "height": 40}}]
    nodes += [{"type": "Button", "AXLabel": b, "AXUniqueId": b if b.startswith("permission_") else "", "frame": {"x": 40 + 160 * i, "y": 400, "width": 150, "height": 44}}
              for i, b in enumerate(buttons)]
    return fg, parse_tree(nodes)


def test_an_ios_permission_alert_needs_a_dont_allow_beside_allow():
    d = s.dialog_of(*_alert("Don’t Allow", "Allow"))
    assert d is not None and d.allow_label == "Allow" and "Notifications" in d.prompt
    assert s.dialog_of(*_alert("Cancel", "OK")) is None  # an app's own alert over SpringBoard? never tapped
    assert s.dialog_of(*_alert("Don't Allow", "Allow", fg="com.x")) is None


def test_an_android_permission_dialog_is_found_by_its_allow_id():
    fg, els = _alert("Don't allow", "permission_allow_foreground_only_button", fg="com.google.android.permissioncontroller")
    d = s.dialog_of(fg, els)
    assert d is not None and d.allow.identifier == "permission_allow_foreground_only_button"


# ---------- wait_for ----------


async def test_wait_for_text_polls_until_it_shows(monkeypatch):
    clock = _Clock()
    s.use_clock(clock, clock.sleep)
    try:
        shots = [_shot("Loading"), _shot("Loading"), _shot("Done")]

        class Sess(_Session):
            async def probe(self):
                return await self.screen()

        sess = Sess(shots)
        met, waited, what = await s.wait_for(sess, ms=5000, until_text="done")
        assert met and "'done' showed" in what
        met, _, what = await s.wait_for(Sess([_shot("Loading")]), ms=300, gone_text="loading")
        assert not met and "stayed" in what
    finally:
        s.use_clock(None, None)


# ---------- locks ----------


def test_lock_names_follow_the_machines_convention():
    assert locks.lock_name("iPhone 17 Pro") == "iPhone-17-Pro"
    assert locks.lock_name("iPad Pro 13-inch (M5)") == "iPad-Pro-13-inch-M5"
    assert locks.lock_path("emulator-5554").name == "claude-sim-lock-emulator-5554"


def test_claim_is_exclusive_reentrant_and_released(tmp_path):
    lock = locks.claim("iPhone 17 Pro", root=tmp_path)
    assert lock is not None and (tmp_path / "claude-sim-lock-iPhone-17-Pro").is_dir()
    assert locks.claim("iPhone 17 Pro", root=tmp_path) is lock  # this process already holds it
    lock.release()
    lock.release()  # idempotent
    assert not lock.path.exists()


def test_someone_elses_fresh_lock_is_respected(tmp_path):
    (tmp_path / "claude-sim-lock-iPhone-17-Pro").mkdir()
    assert locks.claim("iPhone 17 Pro", root=tmp_path, is_booted=lambda: False) is None


def _age(path, seconds):
    old = time.time() - seconds
    os.utime(path, (old, old))


def test_an_old_lock_is_stale_only_when_the_device_is_not_booted(tmp_path):
    path = tmp_path / "claude-sim-lock-iPhone-17-Pro"
    path.mkdir()
    _age(path, locks.STALE_AFTER_S + 60)
    assert locks.claim("iPhone 17 Pro", root=tmp_path, is_booted=lambda: True) is None
    assert locks.claim("iPhone 17 Pro", root=tmp_path, is_booted=lambda: (_ for _ in ()).throw(RuntimeError())) is None
    lock = locks.claim("iPhone 17 Pro", root=tmp_path, is_booted=lambda: False)
    assert lock is not None and path.is_dir()
    lock.release()


def test_release_all_frees_every_lock_at_exit(tmp_path):
    a = locks.claim("iPhone 17 Pro", root=tmp_path)
    b = locks.claim("emulator-5554", root=tmp_path)
    locks.release_all()
    assert a.released and b.released and not list(tmp_path.iterdir())
