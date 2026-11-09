"""The live device view on the tool server's side: the frame writer, the masking, a person's inputs,
and that none of it can slow or break the agent's actions. No device, no network."""

from __future__ import annotations

import asyncio
import base64
import io
import threading
import time
from types import SimpleNamespace
from typing import Any, Optional

import pytest

from orcha_cli.qa import mcp_server
from orcha_cli.qa.device import android as android_mod
from orcha_cli.qa.device import ios as ios_mod
from orcha_cli.qa.device import ios_idb
from orcha_cli.qa.device.live_frames import (
    LiveEnded,
    LiveFrameWriter,
    execute_command,
    frame_guard,
    group_commands,
    masked_frame,
    merged_args,
    split_jpegs,
)
from orcha_cli.qa.device.web import WebSession
from orcha_cli.qa.mcp_server import QATools
from orcha_cli.qa.portal import PortalError
from orcha_cli.qa.session_state import person_result, person_step_args
from test_qa_mcp_fakes import FakeDevice, FakePortal, Identity, opener, shot

A = b"\xff\xd8aaa\xff\xd9"
B = b"\xff\xd8bbb\xff\xd9"
HOME = shot("home", ("Heading", "Home"), ("Button", "Sign in"))
NEXT = shot("next", ("Heading", "Next"), ("Button", "Done"))


def until(check, timeout: float = 3.0) -> bool:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if check():
            return True
        time.sleep(0.005)
    return check()


async def auntil(check, timeout: float = 3.0) -> bool:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if check():
            return True
        await asyncio.sleep(0.005)
    return check()


# ---------- the frame writer ----------


def test_split_jpegs_keeps_a_partial_frame_for_the_next_chunk():
    frames, rest = split_jpegs(b"junk" + A + B[:3])
    assert frames == [A] and rest == B[:3]
    frames, rest = split_jpegs(rest + B[3:])
    assert frames == [B] and rest == b""
    assert split_jpegs(b"no image here") == ([], b"")


def writer(sink, **kw) -> LiveFrameWriter:
    return LiveFrameWriter(sink, fps=15, **kw).start()


def test_the_newest_frame_goes_out_and_the_last_is_never_dropped():
    sent: list[bytes] = []
    gate = threading.Event()

    def sink(jpeg: bytes, _seq: int) -> None:
        gate.wait(2)
        sent.append(jpeg)

    w = writer(sink)
    w.offer(b"1")
    assert until(lambda: w._pending is None)
    for i in range(2, 9):
        w.offer(str(i).encode())
    gate.set()
    assert until(lambda: len(sent) == 2)
    w.close()
    assert sent == [b"1", b"8"]


def test_offering_never_waits_for_the_portal():
    stuck = threading.Event()
    w = writer(lambda *_: stuck.wait(5))
    w.offer(b"1")
    assert until(lambda: w._pending is None)
    started = time.monotonic()
    for i in range(500):
        w.offer(str(i).encode())
    assert time.monotonic() - started < 0.2
    stuck.set()
    w.close()


def test_a_frame_the_same_as_the_last_is_not_sent_again():
    sent: list[bytes] = []
    w = writer(lambda j, _s: sent.append(j))
    w.offer(b"1")
    assert until(lambda: len(sent) == 1)
    w.offer(b"1")
    time.sleep(0.15)
    w.close()
    assert sent == [b"1"] and w.frames_written == 1


def test_the_writer_stops_when_the_session_ended():
    calls: list[bytes] = []

    def sink(jpeg: bytes, _seq: int) -> None:
        calls.append(jpeg)
        raise LiveEnded()

    w = writer(sink)
    w.offer(b"1")
    assert until(lambda: w.ended)
    w.offer(b"2")
    time.sleep(0.1)
    assert calls == [b"1"]
    assert until(lambda: not w._thread.is_alive())


def test_a_failing_upload_tries_the_newest_frame_again():
    sent: list[bytes] = []
    fail = [True]

    def sink(jpeg: bytes, _seq: int) -> None:
        if fail[0]:
            fail[0] = False
            raise OSError("portal down")
        sent.append(jpeg)

    w = writer(sink)
    w.offer(b"1")
    assert until(lambda: w._failures == 1)
    w._retry_at = float("-inf")  # no need to sit out the back-off here
    w.offer(b"2")
    assert until(lambda: sent == [b"2"])
    w.close()


def test_a_held_writer_lets_nothing_out():
    sent: list[bytes] = []
    w = writer(lambda j, _s: sent.append(j))
    w.hold(True)
    w.offer(b"secret")
    time.sleep(0.1)
    assert sent == []
    w.hold(False)
    w.offer(b"after")
    assert until(lambda: sent == [b"after"])
    w.close()


def test_a_frame_carries_the_command_it_can_show():
    sent: list[tuple[bytes, int]] = []
    w = writer(lambda j, s: sent.append((j, s)))
    w.executed(5)
    w.offer(b"taken before 5 ran", 4)
    assert until(lambda: len(sent) == 1)
    w.offer(b"taken after")
    assert until(lambda: len(sent) == 2)
    w.close()
    assert sent == [(b"taken before 5 ran", 4), (b"taken after", 5)]


def test_a_command_that_changed_nothing_is_published_after_the_settle():
    w = LiveFrameWriter(lambda *_: None, sink_seq=lambda _s: None, settle_s=0.02).start()
    w.executed(3)
    assert w.published_seq == 0
    assert until(lambda: w.published_seq == 3)
    w.close()


# ---------- secure fields ----------


def _jpeg(w: int = 100, h: int = 200, colour=(255, 255, 255)) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (w, h), colour).save(buf, format="JPEG")
    return buf.getvalue()


def _pixel(jpeg: bytes, x: int, y: int) -> tuple[int, int, int]:
    from PIL import Image

    return Image.open(io.BytesIO(jpeg)).convert("RGB").getpixel((x, y))


def test_a_mask_lands_on_the_field_at_any_scale():
    # A 100 px wide frame of a 400 point wide screen: the field at 200,200 is at 50,50.
    out = masked_frame(_jpeg(), [(160, 160, 240, 240)], 400)
    assert max(_pixel(out, 50, 50)) < 40
    assert min(_pixel(out, 5, 150)) > 200


def test_the_guard_masks_from_the_newest_screen_and_withholds_when_it_cannot():
    dev = SimpleNamespace(width=400, last_screen=SimpleNamespace(secure_rects=[(160, 160, 240, 240)], masking_proven=True, size=(400, 800)))
    guard = frame_guard(dev)
    assert max(_pixel(guard(_jpeg()), 50, 50)) < 40

    dev.last_screen = SimpleNamespace(secure_rects=[], masking_proven=True, size=(400, 800))
    frame = _jpeg()
    assert guard(frame) is frame

    dev.last_screen = SimpleNamespace(secure_rects=[(1, 1, 2, 2)], masking_proven=False, size=(400, 800))
    assert guard(frame) is None

    dev.last_screen = SimpleNamespace(secure_rects=[(1, 1, 2, 2)], masking_proven=True, size=(400, 800))
    assert guard(b"not an image") is None


def test_what_a_person_typed_stays_out_of_the_trace():
    assert person_step_args("type", {"text": "hunter2"}) == {"source": "person", "chars": 7}
    assert person_step_args("tap", {"x": 1, "y": 2}) == {"x": 1, "y": 2, "source": "person"}
    assert person_result("type", "typed 'hunter2' into secure field; verified: unknown (masked)") == "typed by a person"
    assert person_result("type", "error: no field 'hunter2'") == "typing failed"
    assert person_result("tap", "tapped") == "tapped"


# ---------- a person's commands ----------


class Recorder:
    def __init__(self) -> None:
        self.calls: list[tuple[Any, ...]] = []

    def __getattr__(self, name: str):
        async def call(*a: Any, **k: Any) -> str:
            self.calls.append((name, *a, *k.items()))
            return "ok"

        return call


@pytest.mark.parametrize("kind,args,call", [
    ("tap", {"x": 10, "y": 20}, ("tap", "10,20")),
    ("long_press", {"x": 1, "y": 2, "duration_ms": 700}, ("tap", "1,2", ("long_press_ms", 700))),
    ("type", {"text": "hi"}, ("type_text", None, "hi")),
    ("swipe", {"x1": 1, "y1": 2, "x2": 3, "y2": 4, "duration_ms": 90}, ("swipe_coords", 1, 2, 3, 4, 90)),
    ("swipe", {"x": 100, "y": 100, "dx": 0, "dy": 40}, ("swipe_coords", 100, 100, 100, 60, 120)),
    ("swipe", {"direction": "up"}, ("swipe", "up", 50)),
    ("press", {"key": "home"}, ("press", "home")),
    ("open_url", {"url": "https://a.test/"}, ("open_url", "https://a.test/")),
])
def test_a_command_plays_through_the_session(kind, args, call):
    dev = Recorder()
    assert asyncio.run(execute_command(dev, kind, args)) == "ok"
    assert dev.calls == [call]


def test_an_unknown_command_is_refused():
    assert asyncio.run(execute_command(Recorder(), "finish", {})).startswith("error:")


def test_a_wheel_burst_plays_as_one_scroll():
    wheel = lambda seq, dy: {"seq": seq, "kind": "swipe", "args": {"x": 5, "y": 5, "dx": 0, "dy": dy}}  # noqa: E731
    tap = {"seq": 3, "kind": "tap", "args": {"x": 1, "y": 1}}
    groups = group_commands([wheel(1, 10), wheel(2, 20), tap, wheel(4, 5)])
    assert [[c["seq"] for c in g] for g in groups] == [[1, 2], [3], [4]]
    assert merged_args(groups[0])["dy"] == 30


# ---------- the tool server ----------


class LiveDevice(FakeDevice):
    """A device with a stream: `start_live` hands one frame over, `first_frame` holds it back."""

    def __init__(self, screens=None, *, stream: bool = True) -> None:
        super().__init__(screens or [HOME, NEXT])
        self.width, self.height = 402, 874
        self.stream = stream
        self.writer: Any = None
        self.stopped = 0
        self.first_frame = asyncio.Event()
        self.first_frame.set()

    async def start_live(self, writer: Any) -> bool:
        self.writer = writer
        await self.first_frame.wait()
        if not self.stream:
            return False
        writer.offer(b"\xff\xd8stream\xff\xd9")
        return True

    async def stop_live(self) -> None:
        self.stopped += 1


class LivePortal(FakePortal):
    def __init__(self) -> None:
        super().__init__()
        self.live_frames: list[tuple[bytes, dict[str, Any]]] = []
        self.beats: list[dict[str, Any]] = []
        self.answers: list[dict[str, Any]] = []
        self.takeover: Optional[dict[str, Any]] = None
        self.ended_status: Optional[int] = None
        self.frame_delay = 0.0
        self.dropped = 0

    def with_timeout(self, timeout: float) -> "LivePortal":
        return self  # a copy would not see what the tests set on this one

    def _request(self, method, path, body=None, *, query=None, raw=None, content_type="application/json", headers=None):
        if path.endswith("/live/frame"):
            time.sleep(self.frame_delay)
            if self.ended_status:
                raise PortalError("ended", self.ended_status)
            self.live_frames.append((raw, query))
            return {"n": len(self.live_frames)}
        if path.endswith("/live/beat"):
            if self.ended_status:
                raise PortalError("ended", self.ended_status)
            self.beats.append(body)
            answer = self.answers.pop(0) if self.answers else {}
            return {"takeover": self.takeover, "inputs": [], **answer}
        if path.endswith("/live"):
            self.dropped += 1
            return None
        return super()._request(method, path, body, query=query, raw=raw, content_type=content_type)


@pytest.fixture(autouse=True)
def quick(monkeypatch):
    monkeypatch.setattr(mcp_server, "LIVE_BEAT_S", 0.01)
    monkeypatch.setattr(mcp_server, "LIVE_DRIVE_BEAT_S", 0.01)


def make(device=None, minutes=0):
    portal = LivePortal()
    device = device or LiveDevice()
    tools = QATools(identity=Identity(), portal=portal, device_opener=opener(device, []))
    return tools, portal, device


PERSON = {"by_id": "h1", "by": "Hussein", "since": "now"}


async def start(tools, minutes=0, kind="map"):
    out = await tools.start_session("ios", kind, minutes=minutes, app="com.acme")
    assert out.startswith("session started"), out
    return tools.live


def test_a_session_publishes_its_stream_and_stops_with_it():
    async def go():
        tools, portal, dev = make()
        live = await start(tools)
        writer = live.frames
        assert await auntil(lambda: portal.live_frames and portal.beats)
        jpeg, query = portal.live_frames[-1]
        assert jpeg == b"\xff\xd8stream\xff\xd9" and query["screen_w"] == 402 and query["screen_h"] == 874
        assert portal.beats[-1]["stream"] is True or await auntil(lambda: portal.beats[-1]["stream"] is True)
        tasks = list(live.live_tasks)
        out = await tools.end_session("done", reason="blocked: the app has nothing left to see", force=True)
        assert "ended" in out
        assert all(t.done() for t in tasks)
        assert dev.stopped == 1 and portal.dropped == 1
        assert not writer._thread.is_alive()
        beats = len(portal.beats)
        await asyncio.sleep(0.05)
        assert len(portal.beats) == beats

    asyncio.run(go())


def test_a_stream_that_is_slow_to_start_does_not_hold_the_session_up():
    async def go():
        tools, _portal, dev = make()
        dev.first_frame.clear()
        await asyncio.wait_for(start(tools), timeout=1.0)
        assert "tap ok" in await asyncio.wait_for(tools.tap("Sign in"), timeout=1.0)
        dev.first_frame.set()
        await tools.shutdown()

    asyncio.run(go())


def test_a_portal_that_hangs_on_frames_does_not_slow_an_action():
    async def go():
        tools, portal, dev = make()
        portal.frame_delay = 1.0
        await start(tools)
        await asyncio.sleep(0.02)
        dev.writer.offer(b"\xff\xd8more\xff\xd9")
        began = time.monotonic()
        out = await tools.tap("Sign in")
        assert "tap ok" in out and time.monotonic() - began < 0.5
        portal.frame_delay = 0.0
        await tools.shutdown()

    asyncio.run(go())


def test_a_live_failure_never_reaches_the_agent():
    async def go():
        tools, portal, dev = make()

        def broken(*_a: Any, **_k: Any) -> None:
            raise OSError("no route")

        portal.with_timeout = lambda _t: SimpleNamespace(put_live_frame=broken, live_beat=broken, end_live=broken)  # type: ignore[method-assign]
        await start(tools)
        assert "tap ok" in await tools.tap("Sign in")
        assert "error" not in await tools.tap("Sign in")
        await tools.shutdown()

    asyncio.run(go())


def test_a_device_with_no_stream_shows_each_steps_frame():
    async def go():
        tools, portal, dev = make(LiveDevice(stream=False))
        await start(tools)
        await auntil(lambda: portal.beats)
        await tools.tap("Sign in")
        assert await auntil(lambda: any(j == b"jpeg:next" for j, _q in portal.live_frames))
        await tools.shutdown()

    asyncio.run(go())


def test_a_device_with_no_live_support_changes_nothing():
    async def go():
        tools, portal, _dev = make(FakeDevice([HOME, NEXT]))
        live = await start(tools)
        assert live.frames is None and live.live_tasks == []
        assert "tap ok" in await tools.tap("Sign in")
        await tools.end_session("done", reason="blocked: nothing else to see here", force=True)
        assert portal.beats == [] and portal.dropped == 0

    asyncio.run(go())


def test_the_session_ending_elsewhere_stops_the_beat_and_lets_the_agent_go():
    async def go():
        tools, portal, _dev = make()
        live = await start(tools)
        portal.takeover = PERSON
        assert await auntil(lambda: live.person is not None)
        portal.ended_status = 409
        assert await auntil(lambda: all(t.done() for t in live.live_tasks))
        assert live.person is None
        await tools.shutdown()

    asyncio.run(go())


def test_shutdown_stops_the_live_view():
    async def go():
        tools, portal, dev = make()
        live = await start(tools)
        tasks, writer = list(live.live_tasks), live.frames
        await tools.shutdown()
        assert all(t.done() for t in tasks) and dev.stopped == 1
        assert not writer._thread.is_alive() and tools.live is None

    asyncio.run(go())


def test_no_frame_leaves_while_text_goes_into_a_secure_screen():
    async def go():
        tools, _portal, dev = make()
        live = await start(tools)
        dev.last_screen = SimpleNamespace(secure_rects=[(1, 1, 9, 9)], masking_proven=True)
        held = []
        real = live.frames.hold
        live.frames.hold = lambda on: (held.append(on), real(on))  # type: ignore[method-assign]
        await tools.type_text("Password", "hunter2")
        assert held == [True, False]
        held.clear()
        dev.last_screen = HOME
        await tools.type_text("Name", "Maya")
        assert held == []
        await tools.shutdown()

    asyncio.run(go())


def test_a_takeover_holds_the_agent_and_plays_the_persons_inputs():
    async def go():
        tools, portal, dev = make()
        live = await start(tools, minutes=10)
        portal.takeover = PERSON
        assert await auntil(lambda: live.person is not None)
        out = await tools.tap("Sign in")
        assert out.startswith("held: Hussein has taken over")
        assert not [c for c in dev.calls if c[0] == "tap"]
        assert "held:" in await tools.wait(1)

        portal.answers = [{"inputs": [{"seq": 1, "kind": "tap", "args": {"x": 10, "y": 20}}, {"seq": 2, "kind": "type", "args": {"text": "hunter2"}}]}]
        assert await auntil(lambda: any(r for b in portal.beats for r in b["results"] if r["seq"] == 2))
        assert ("tap", ("10,20",)) in dev.calls
        results = [r for b in portal.beats for r in b["results"]]
        assert "hunter2" not in str(results)
        steps = [s for s in live.trace if (s["args"] or {}).get("source") == "person"]
        assert [s["kind"] for s in steps] == ["tap", "type"]
        assert "hunter2" not in str(steps) and steps[1]["args"]["chars"] == 7
        assert await auntil(lambda: portal.beats[-1]["cmd_seq"] == 2 or live.frames.cmd_seq == 2)

        started = live.budget.started
        portal.takeover = None
        assert await auntil(lambda: live.person is None)
        assert live.budget.started > started  # their time is not the agent's
        out = await tools.tap("Done")
        assert "tap ok" in out and "Hussein drove the device (2 inputs)" in out
        await tools.shutdown()

    asyncio.run(go())


def test_inputs_that_came_with_the_hand_back_are_played_first():
    async def go():
        tools, portal, dev = make()
        live = await start(tools)
        portal.takeover = PERSON
        assert await auntil(lambda: live.person is not None)
        portal.takeover = None
        portal.answers = [{"inputs": [{"seq": 1, "kind": "tap", "args": {"x": 1, "y": 2}}]}]
        assert await auntil(lambda: live.person is None)
        assert ("tap", ("1,2",)) in dev.calls
        await tools.shutdown()

    asyncio.run(go())


def test_an_input_waits_for_the_agents_step_to_finish():
    async def go():
        tools, portal, dev = make()
        live = await start(tools)
        order: list[str] = []
        release = asyncio.Event()
        real = dev.tap

        async def slow_tap(target: Any, long_press_ms: Optional[int] = None) -> str:
            order.append(f"begin {target}")
            if target == "Sign in":
                await release.wait()
            order.append(f"end {target}")
            return await real(target, long_press_ms)

        dev.tap = slow_tap  # type: ignore[method-assign]
        step = asyncio.create_task(tools.tap("Sign in"))
        assert await auntil(lambda: order == ["begin Sign in"])
        portal.takeover = PERSON
        portal.answers = [{"inputs": [{"seq": 1, "kind": "tap", "args": {"x": 1, "y": 2}}]}]
        assert await auntil(lambda: live.person is not None)
        await asyncio.sleep(0.03)
        assert order == ["begin Sign in"]
        release.set()
        await step
        assert await auntil(lambda: order == ["begin Sign in", "end Sign in", "begin 1,2", "end 1,2"])
        await tools.shutdown()

    asyncio.run(go())


def test_a_portal_gone_quiet_gives_the_device_back_to_the_agent(monkeypatch):
    monkeypatch.setattr(mcp_server, "LIVE_LOST_BEATS", 2)
    monkeypatch.setattr(mcp_server, "LIVE_BEAT_S", 0.001)

    async def go():
        tools, portal, _dev = make()
        live = await start(tools)
        portal.takeover = PERSON
        assert await auntil(lambda: live.person is not None)
        real = portal._request

        def down(method, path, *a, **k):
            if path.endswith("/live/beat"):
                raise PortalError("portal unreachable")
            return real(method, path, *a, **k)

        portal._request = down  # type: ignore[method-assign]
        assert await auntil(lambda: live.person is None)
        await tools.shutdown()

    asyncio.run(go())


# ---------- the devices ----------


def test_jpeg_frames_reassembles_whole_frames_from_the_stream(monkeypatch):
    pytest.importorskip("idb")

    async def stream(**kw):
        assert kw["format"].name == "MJPEG"
        for chunk in (A[:4], A[4:] + B[:2], B[2:]):
            yield chunk

    client = ios_idb.IdbClient.__new__(ios_idb.IdbClient)
    monkeypatch.setattr(ios_idb.IdbClient, "client", property(lambda _s: SimpleNamespace(stream_video=stream)), raising=False)

    async def collect():
        return [f async for f in client.jpeg_frames()]

    assert asyncio.run(collect()) == [A, B]


def test_ios_pumps_the_stream_into_the_writer_and_reconnects():
    async def go():
        sess = ios_mod.IosSession.__new__(ios_mod.IosSession)
        sess._live_task = None
        runs = [0]

        async def frames(fps: int):
            runs[0] += 1
            if runs[0] == 1:
                raise RuntimeError("companion went away")
            yield A
            await asyncio.sleep(60)

        sess.client = SimpleNamespace(jpeg_frames=frames)
        got: list[bytes] = []
        w = SimpleNamespace(offer=got.append)
        assert await sess.start_live(w, first_frame_s=3.0) is True
        assert got == [A] and runs[0] == 2
        task = sess._live_task
        await sess.stop_live()
        assert task.cancelled() and sess._live_task is None
        await sess.stop_live()  # safe twice

    asyncio.run(go())


def test_ios_without_a_stream_says_so():
    async def go():
        sess = ios_mod.IosSession.__new__(ios_mod.IosSession)
        sess._live_task = None

        async def frames(fps: int):
            raise RuntimeError("no video")
            yield b""

        sess.client = SimpleNamespace(jpeg_frames=frames)
        assert await sess.start_live(SimpleNamespace(offer=lambda _f: None), first_frame_s=0.05) is False
        assert sess._live_task is None

    asyncio.run(go())


def test_android_sends_each_capture_with_the_command_it_began_at():
    async def go():
        sess = android_mod.AndroidSession.__new__(android_mod.AndroidSession)
        sess._live_task = None

        async def capture() -> bytes:
            return A

        sess._live_frame = capture
        got: list[tuple[bytes, Any]] = []
        w = SimpleNamespace(cmd_seq=7, offer=lambda f, s=None: got.append((f, s)))
        assert await sess.start_live(w, first_frame_s=1.0) is True
        await sess.stop_live()
        assert got[0] == (A, 7)

    asyncio.run(go())


def test_android_jpeg_is_scaled_down():
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (1440, 3120), (10, 20, 30)).save(buf, format="PNG")
    out = Image.open(io.BytesIO(android_mod._live_jpeg(buf.getvalue())))
    assert out.format == "JPEG" and max(out.size) == android_mod.LIVE_LONG_SIDE


class FakeCdp:
    def __init__(self) -> None:
        self.sent: list[tuple[str, Any]] = []
        self.handlers: dict[str, Any] = {}
        self.detached = False

    def on(self, event: str, fn: Any) -> None:
        self.handlers[event] = fn

    async def send(self, method: str, params: Any = None) -> None:
        self.sent.append((method, params))

    async def detach(self) -> None:
        self.detached = True


def test_the_web_screencast_offers_each_frame_and_acks_it():
    async def go():
        sess = WebSession()
        cdp = FakeCdp()

        async def new_cdp_session(_page: Any) -> FakeCdp:
            return cdp

        sess.context = SimpleNamespace(new_cdp_session=new_cdp_session)
        got: list[bytes] = []
        assert await sess.start_live(SimpleNamespace(offer=got.append)) is True
        start = cdp.sent[0]
        assert start[0] == "Page.startScreencast" and start[1]["format"] == "jpeg" and start[1]["maxWidth"] == sess.width
        cdp.handlers["Page.screencastFrame"]({"data": base64.b64encode(A).decode(), "sessionId": 4})
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert got == [A]
        assert ("Page.screencastFrameAck", {"sessionId": 4}) in cdp.sent
        await sess.stop_live()
        assert ("Page.stopScreencast", None) in cdp.sent and cdp.detached
        await sess.stop_live()

    asyncio.run(go())


def test_a_screencast_that_will_not_start_leaves_the_steps_frames():
    async def go():
        sess = WebSession()

        async def new_cdp_session(_page: Any) -> None:
            raise RuntimeError("not chromium")

        sess.context = SimpleNamespace(new_cdp_session=new_cdp_session)
        assert await sess.start_live(SimpleNamespace(offer=lambda _f: None)) is False
        assert sess._live is None

    asyncio.run(go())
