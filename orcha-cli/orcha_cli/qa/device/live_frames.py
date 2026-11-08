"""Live frames of a running session: what a person watches on the session's page.

A step's frame (`Screen.jpeg`) is a screenshot plus the element tree, about 150 ms each, and only
exists once an action ends: fine for the trace, far too slow to watch. While a session runs the
device also streams its screen (`start_live`: a CDP screencast on the web, idb's MJPEG video
stream on an iOS simulator, a screencap loop on Android) into a `LiveFrameWriter`, which hands the
newest frame to `sink` at no more than `fps` frames a second.

The sink uploads it to the portal, which keeps only the latest frame of a session in memory
(`qa_live_routes.py`). Nothing is written to disk and no frame becomes a history row.

The writer runs its own thread: producers (an asyncio screencast handler, an idb stream task)
only hand over bytes, so neither a slow portal nor a frame's masking can reach the device action
path. A frame offered sooner than `1 / fps` after the previous one waits and is sent once that
interval is up, unless a newer one replaces it first: the last frame of a movement is never
dropped. A sink slower than `fps` simply sees fewer frames. After a person's command runs without
the screen changing (a tap on nothing, a scroll at the end of the page), no frame comes; `cmd_seq`
is then published on its own after `settle_s` (`sink_seq`, `published_seq`), so the page knows the
frame it shows is already current. A frame identical to the last one sent is not sent again.

Secure fields: a stored frame has them painted out (`Screen.__post_init__`) and is withheld when
that cannot be proven. A live frame comes straight off the device, so `frame_guard` applies the
same rule to it, from the newest screen the session read, and `hold` stops frames altogether
while text goes into a secure field (a field that moves as the keyboard comes up would slip out
from under the mask, and a phone shows the last typed character for a moment).
"""

from __future__ import annotations

import io
import threading
import time
from collections.abc import Callable
from typing import Any

MAX_FPS = 15
#: Frames a second while an agent drives: enough to follow, cheap to upload.
WATCH_FPS = 5
#: ...and while a person drives: their input's feedback is the frame.
DRIVE_FPS = 12
#: A failed upload is tried again after this long (the newest frame by then).
RETRY_S = 1.0
RETRY_MAX_S = 5.0


#: A wheel scroll plays as a swipe this long (the web scrolls by the delta at once).
WHEEL_DURATION_MS = 120


class LiveEnded(Exception):
    """The portal will take no more frames of this session: it ended. Stops the writer."""


def split_jpegs(buffer: bytes) -> tuple[list[bytes], bytes]:
    """Whole JPEGs (start-of-image to end-of-image) at the front of an MJPEG byte stream, and
    the bytes left over (an incomplete frame, kept for the next chunk). Bytes before a
    start-of-image marker are dropped."""
    frames: list[bytes] = []
    while True:
        start = buffer.find(b"\xff\xd8")
        if start < 0:
            return frames, b""
        end = buffer.find(b"\xff\xd9", start + 2)
        if end < 0:
            return frames, buffer[start:]
        frames.append(buffer[start : end + 2])
        buffer = buffer[end + 2 :]


def masked_frame(jpeg: bytes, rects: list[tuple[int, int, int, int]], screen_width: int) -> bytes:
    """`rects` (screen units) painted black on a JPEG of any scale. Raises when it cannot."""
    from PIL import Image, ImageDraw

    img = Image.open(io.BytesIO(jpeg)).convert("RGB")
    scale = img.width / screen_width if screen_width > 0 else 1.0
    draw = ImageDraw.Draw(img)
    for x1, y1, x2, y2 in rects:
        draw.rectangle([int(x1 * scale) - 2, int(y1 * scale) - 2, int(x2 * scale) + 2, int(y2 * scale) + 2], fill=(0, 0, 0))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=70)
    return buf.getvalue()


def frame_guard(device: Any) -> Callable[[bytes], bytes | None]:
    """What a live frame of `device` goes through before it leaves the machine: the newest
    screen's secure fields painted out, and None (withheld) when that screen's could not be
    found or painted. Runs on the writer's thread."""

    def guard(jpeg: bytes) -> bytes | None:
        shot = getattr(device, "last_screen", None)
        if shot is None:
            return jpeg
        if not getattr(shot, "masking_proven", True):
            return None
        rects = list(getattr(shot, "secure_rects", None) or [])
        if not rects:
            return jpeg
        size = getattr(shot, "size", None) or (0, 0)
        width = int(size[0] or getattr(device, "width", 0) or 0)
        try:
            return masked_frame(jpeg, rects, width)
        except Exception:  # noqa: BLE001 - an unmaskable frame is withheld, never sent
            return None

    return guard


def is_wheel(kind: str, args: dict[str, Any]) -> bool:
    """A wheel or trackpad scroll from the page: a `swipe` with `{x, y, dx, dy}`."""
    return kind == "swipe" and all(k in args for k in ("x", "y", "dx", "dy"))


def group_commands(commands: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """Commands in order, grouped so a burst plays as one action: consecutive wheel batches."""
    groups: list[list[dict[str, Any]]] = []
    for cmd in commands:
        prev = groups[-1][-1] if groups else None
        if prev is not None and is_wheel(cmd["kind"], cmd.get("args") or {}) and is_wheel(prev["kind"], prev.get("args") or {}):
            groups[-1].append(cmd)
        else:
            groups.append([cmd])
    return groups


def merged_args(group: list[dict[str, Any]]) -> dict[str, Any]:
    """The args of a group: a wheel burst scrolls by the sum of its batches."""
    args = dict(group[0].get("args") or {})
    if len(group) > 1:
        args["dx"] = sum(int((c.get("args") or {}).get("dx") or 0) for c in group)
        args["dy"] = sum(int((c.get("args") or {}).get("dy") or 0) for c in group)
    return args


async def execute_command(session: Any, kind: str, args: dict[str, Any]) -> str:
    """One person input through the session. Taps come as screen points. A drag on the live
    screen is a swipe with its start and end points (`x1, y1, x2, y2`) and how long it took
    (`duration_ms`: a flick flings, a slow drag scrolls precisely). A wheel scroll (`x, y, dx, dy`)
    is a swipe the same distance the other way from the pointer, which on the web is a real wheel
    scroll by exactly (dx, dy) and on a phone a swipe that moves the content that far."""
    if kind in ("tap", "long_press"):
        target = f"{int(args['x'])},{int(args['y'])}"
        if kind == "long_press":
            return await session.tap(target, long_press_ms=int(args.get("duration_ms") or 1000))
        return await session.tap(target)
    if kind == "type":
        return await session.type_text(None, str(args.get("text") or ""))
    if kind == "swipe":
        if is_wheel(kind, args):
            x, y = int(args["x"]), int(args["y"])
            return await session.swipe_coords(x, y, x - int(args["dx"]), y - int(args["dy"]), int(args.get("duration_ms") or WHEEL_DURATION_MS))
        if all(k in args for k in ("x1", "y1", "x2", "y2")):
            return await session.swipe_coords(int(args["x1"]), int(args["y1"]), int(args["x2"]), int(args["y2"]), int(args.get("duration_ms") or 400))
        return await session.swipe(str(args.get("direction") or "up"), int(args.get("distance_percent") or 50))
    if kind == "press":
        return await session.press(str(args.get("key") or ""))
    if kind == "open_url":
        return await session.open_url(str(args.get("url") or ""))
    return f"error: unknown command {kind!r}"


class LiveFrameWriter:
    """`sink(jpeg, cmd_seq)` gets the newest frame on the writer's thread; `sink_seq(cmd_seq)`
    (optional) a newer `cmd_seq` with no new frame. A sink raises `LiveEnded` to stop the writer,
    anything else to have the newest frame tried again a little later."""

    def __init__(
        self,
        sink: Callable[[bytes, int], Any],
        *,
        sink_seq: Callable[[int], Any] | None = None,
        transform: Callable[[bytes], bytes | None] | None = None,
        fps: int = WATCH_FPS,
        settle_s: float = 0.25,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.sink = sink
        self.sink_seq = sink_seq
        self.transform = transform
        self.interval = self._interval(fps)
        self.settle_s = settle_s
        self._clock = clock
        self._cond = threading.Condition()
        self._pending: bytes | None = None
        self._pending_seq = 0
        self._cmd_seq = 0
        self._published_seq = 0
        self._executed_at: float | None = None
        self._n = 0
        self._last_write = float("-inf")
        self._last_sent: bytes | None = None
        self._closed = False
        self._held = False
        self._failures = 0
        self._retry_at = float("-inf")
        self.ended = False
        self._thread: threading.Thread | None = None

    @staticmethod
    def _interval(fps: int) -> float:
        return 1.0 / max(1, min(fps, MAX_FPS))

    @property
    def frames_written(self) -> int:
        return self._n

    def start(self) -> LiveFrameWriter:
        self._thread = threading.Thread(target=self._run, name="qa-live-frames", daemon=True)
        self._thread.start()
        return self

    @property
    def cmd_seq(self) -> int:
        """The newest command that has run (`executed`)."""
        return self._cmd_seq

    @property
    def published_seq(self) -> int:
        """The newest command the page may take as shown: a frame showing it went out, or the
        screen stayed the same for `settle_s` after it."""
        return self._published_seq

    def set_fps(self, fps: int) -> None:
        with self._cond:
            self.interval = self._interval(fps)
            self._cond.notify()

    def hold(self, on: bool) -> None:
        """While on, no frame leaves: what is pending is dropped and new ones are refused."""
        with self._cond:
            self._held = on
            if on:
                self._pending = None
            self._cond.notify()

    def offer(self, jpeg: bytes, taken_at_seq: int | None = None) -> None:
        """The newest frame (JPEG bytes). Cheap and thread-safe; never blocks on the portal.
        `taken_at_seq`: the `cmd_seq` when a slow capture (an Android screencap) started, so a
        frame begun before a command ran is not published as showing it."""
        if not jpeg:
            return
        with self._cond:
            if self._closed or self._held:
                return
            seq = self._cmd_seq if taken_at_seq is None else min(taken_at_seq, self._cmd_seq)
            self._pending, self._pending_seq = jpeg, seq
            self._cond.notify()

    def executed(self, seq: int) -> None:
        """Person command `seq` has run: frames sent from now on show it."""
        with self._cond:
            if seq > self._cmd_seq:
                self._cmd_seq = seq
                self._executed_at = self._clock()
                self._cond.notify()

    def close(self) -> None:
        """Stops the thread. It is left a moment for an upload in flight; being a daemon it
        cannot outlive the server if the portal never answers."""
        with self._cond:
            self._closed = True
            self._pending = None
            self._cond.notify()
        if self._thread is not None and self._thread is not threading.current_thread():
            self._thread.join(timeout=2.0)

    # ---------- writer thread ----------

    def _run(self) -> None:
        while True:
            with self._cond:
                while True:
                    if self._closed:
                        return
                    wait = self._next_wait()
                    if wait is None:
                        self._cond.wait()
                    elif wait > 0:
                        self._cond.wait(timeout=wait)
                    else:
                        break
                frame, self._pending = self._pending, None
                # A frame carries the command seq of when it was taken; with no frame, the
                # newest seq is published alone (the screen did not change).
                seq = self._published_seq = self._pending_seq if frame is not None else self._cmd_seq
            try:
                if frame is not None:
                    self._write(frame, seq)
                elif self.sink_seq is not None:
                    self.sink_seq(seq)
                self._failures = 0
            except LiveEnded:
                with self._cond:
                    self._closed = True
                    self.ended = True
                return
            except Exception:  # noqa: BLE001 - the page keeps its last frame; the agent never hears of it
                self._failures += 1
                self._retry_at = self._clock() + min(RETRY_MAX_S, RETRY_S * self._failures)

    def _next_wait(self) -> float | None:
        """Seconds until there is something to send (0: now), or None: nothing to do."""
        now = self._clock()
        if self._pending is not None:
            return max(0.0, self._last_write + self.interval - now, self._retry_at - now)
        if self._cmd_seq > self._published_seq and self._executed_at is not None:
            return max(0.0, self._executed_at + self.settle_s - now, self._retry_at - now)
        return None

    def _write(self, jpeg: bytes, seq: int) -> None:
        out = self.transform(jpeg) if self.transform is not None else jpeg
        self._last_write = self._clock()
        if out is None or out == self._last_sent:  # withheld, or a screen that did not change
            return
        self.sink(out, seq)
        self._last_sent = out
        self._n += 1
