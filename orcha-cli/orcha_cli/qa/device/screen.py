"""What one look at the device returns (`Screen`), the text the model reads, and the settle.

Adapted from `sessions/protocol.py` (Screen, Probe, settle, wait_for, model_jpeg, secure
masking), `recording/change.py` (screen shape, frame thumbnails, "did the action change
anything") and `environment/app_permissions.py` (`dialog_of`: a system permission dialog on
screen).

The settle is what makes an action's result trustworthy: after a tap the session waits for the
screen to leave the shape it had (phase 1, the action's change window), then for it to hold
still (phase 2), and the settled screen is what the agent sees next. A session that can tell
cheaply that the screen moved (iOS: a frame fingerprint, `ChangeSignal`) waits on that instead
of reading the tree again and again.

PIL is imported inside the functions that need it: this module imports without the `qa` extra.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

from orcha_cli.qa.device.tree import (
    MAX_TREE_NODES,
    Element,
    compact_capped,
    screen_shape,
    tree_value_hash,
    visible_elements,
)

# ---------- time (swappable for tests) ----------

_clock: Callable[[], float] = time.monotonic
_sleep: Callable[[float], Awaitable[Any]] | None = None


def now() -> float:
    return _clock()


async def poll_sleep(seconds: float) -> None:
    """The interval between two polls of a condition wait (settle, `wait`)."""
    if _sleep is not None:
        await _sleep(seconds)
    else:
        await asyncio.sleep(seconds)


def use_clock(clock: Callable[[], float] | None, sleep: Callable[[float], Awaitable[Any]] | None) -> None:
    """Swap the clock and the poll sleep (tests: virtual time). `use_clock(None, None)` restores."""
    global _clock, _sleep
    _clock = clock or time.monotonic
    _sleep = sleep


# ---------- the settle's windows ----------

# Between captures while `screen()` waits for an empty tree to fill (an app still launching).
EMPTY_TREE_RETRY_S = 0.2
# Between captures while a session waits for its first screen, or for its app to come forward.
RENDER_POLL_S = 0.2
SETTLE_POLL_S = 0.075
HELD_STILL_S = 1.0
# How long a shape must hold before the settle calls it still: a click's synchronous re-render
# holds for a frame or two while the content it announced is still animating in.
STILL_FOR_S = 0.3
FULL_CHANGE_WAIT_S = 2.0
BRIEF_CHANGE_WAIT_S = 0.5

# after -> (change wait, held still). Typing reads the first capture past the change (a caret or
# an autocorrect popup would keep the stillness check from passing). A scroll usually moves
# nothing the tree records, so its change wait is brief.
SETTLE_AFTER: dict[str, tuple[float, bool]] = {
    "tap": (FULL_CHANGE_WAIT_S, True), "long_press": (FULL_CHANGE_WAIT_S, True),
    "press": (FULL_CHANGE_WAIT_S, True), "open_url": (FULL_CHANGE_WAIT_S, True),
    "launch": (FULL_CHANGE_WAIT_S, True), "terminate": (FULL_CHANGE_WAIT_S, True),
    "swipe": (BRIEF_CHANGE_WAIT_S, True),
    "type": (FULL_CHANGE_WAIT_S, False), "clear": (FULL_CHANGE_WAIT_S, False),
    # The tap into a field before typing: no change to wait for, only a keyboard sliding in.
    "focus": (0.0, True),
    "wait": (FULL_CHANGE_WAIT_S, True),  # `wait_for` passes the agent's ms as the change window
}

#: No signal this long after a tap, a press or a swipe: nothing is going to happen.
DEAD_TAP_S = 0.3
#: How long a signal must stay quiet for the screen to count as still.
SIGNAL_QUIET_S = 0.2
#: A frame signal (iOS) needs the tree's own stillness window with nothing moving; a small
#: region that never stops (a spinner, a caret) is let through once the screen has looked the
#: same for the loose window.
FRAME_QUIET_S = STILL_FOR_S
FRAME_LOOSE_QUIET_S = 0.5
DEAD_TAP_KINDS = frozenset({"tap", "long_press", "swipe", "press"})

# A condition wait polls the tree this often, for at most this long.
WAIT_POLL_S = 0.15
MAX_WAIT_MS = 10_000


# ---------- the screen ----------

SECURE_TYPES = frozenset({"SecureTextField"})
MAX_SCREENSHOT_LONG_SIDE = 768  # 640 still read every label; 512 misread small keypads
JPEG_QUALITY = 50


@dataclass
class Probe:
    """A settle poll's read: the tree, and the frame only when the tree cannot describe the
    screen (no tree, or no interactive element: a canvas, a map)."""

    elements: list[Element]
    tree_available: bool
    png: bytes | None = None


def needs_pixels(elements: list[Element], tree_available: bool) -> bool:
    """Whether `shape_of` falls back to the frame for this tree."""
    return not tree_available or not any(e.interactive for e in visible_elements(elements))


@dataclass
class Screen:
    """One look: the frame, the tree and what the model reads (`text()`).

    `png` is the full-resolution frame (secure fields painted black); `jpeg` the model-sized
    JPEG (long side at most 768 px, built on first use); `size` the screen in the tree's units
    (points on iOS, pixels on Android); `foreground` the bundle id / package in front.
    `settled` is how the screen settled after the action that produced it ("changed",
    "unchanged", "timeout"; None for a plain look); `notes` are lines the session adds for the
    agent (a permission dialog it answered, a system sheet it closed, an action that changed
    nothing)."""

    png: bytes
    raw: list[dict]
    elements: list[Element]
    tree_hash: str
    size: tuple[int, int]
    foreground: str
    foreground_name: str
    locked_app_violation: bool
    tree_available: bool
    extra: str = ""
    degraded: bool = False
    settled: str | None = None
    url: str | None = None  # web: the page's address
    notes: list[str] = field(default_factory=list)
    secure_rects: list[tuple[int, int, int, int]] = field(default_factory=list)
    masking_proven: bool = True
    at: float = field(default_factory=time.time)
    _jpeg: bytes | None = field(default=None, repr=False)
    _jpeg_size: tuple[int, int] | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        secure = [e for e in self.elements if e.type in SECURE_TYPES or "Secure" in e.traits]
        if not secure:
            return
        rects = [(e.x1, e.y1, e.x2, e.y2) for e in secure if e.x2 > e.x1 and e.y2 > e.y1]
        self.secure_rects = rects
        if not rects or not self.png:
            self.masking_proven = False
            return
        try:
            self.png = mask_png(self.png, rects, screen_width=self.size[0] or screen_width_of(self.elements))
            self.masking_proven = len(rects) == len(secure)
        except Exception:  # noqa: BLE001 - an unmaskable frame is withheld, never sent
            self.masking_proven = False

    @property
    def hash(self) -> str:
        return self.tree_hash

    @property
    def jpeg(self) -> bytes:
        """The frame the model sees: long side at most `MAX_SCREENSHOT_LONG_SIDE`, JPEG."""
        if self._jpeg is None:
            self._jpeg, self._jpeg_size = model_jpeg(self.png)
        return self._jpeg

    @property
    def jpeg_size(self) -> tuple[int, int]:
        if self._jpeg_size is None:
            _ = self.jpeg
        assert self._jpeg_size is not None
        return self._jpeg_size

    @property
    def width(self) -> int:
        return self.size[0]

    @property
    def height(self) -> int:
        return self.size[1]

    def header(self) -> list[str]:
        head = [
            f"foreground: {self.foreground} ({self.foreground_name})",
            *([f"url: {self.url}"] if self.url else []),
            f"locked_app_violation: {str(self.locked_app_violation).lower()}",
            f"tree_hash: {self.tree_hash}",
        ]
        if self.size[0] and self.size[1]:
            head.append(f"screen: {self.size[0]}x{self.size[1]}")
        if self.degraded:
            head.append("degraded: true")
        if self.settled:
            head.append(f"settled: {self.settled}")
        return head

    def text(self, max_nodes: int | None = None) -> str:
        """What the model reads: the session's notes, the header lines, the tree (one element per
        line, `e12 Button "Save" id=save (x1,y1)-(x2,y2)`), and any trailing block."""
        body = (
            compact_capped(self.elements, max_nodes or MAX_TREE_NODES)
            if self.tree_available
            else "tree: unavailable - use screenshot coordinates as x,y targets"
        )
        out = "\n".join([*self.notes, *self.header()]) + "\n\n" + body
        if self.extra:
            out += "\n\n" + self.extra
        return out

    def image_note(self) -> str:
        """The line that goes with the model-sized image: its size and how its pixels map to the
        tree's units (for x,y targets and `swipe_coords`)."""
        w, h = self.jpeg_size
        sw = self.size[0]
        scale = f"; 1 px = {sw / w:.2f} screen units, so multiply image coordinates by {sw / w:.2f}" if sw and w else ""
        return f"screenshot: {w}x{h} px (downscaled; bounds in the tree are screen units{scale})"


def screen_width_of(elements: list[Element]) -> int | None:
    """Width of the screen in the elements' own units: the widest element's right edge."""
    xs = [e.x2 for e in elements if e.x2 > 0]
    return max(xs) if xs else None


def mask_png(png: bytes, rects: list[tuple[int, int, int, int]], *, screen_width: int | None = None) -> bytes:
    """Paint `rects` black. `rects` are in screen units; they are scaled to PNG pixels by
    `png_width / screen_width` (iOS frames are in points, the PNG in pixels)."""
    from PIL import Image, ImageDraw

    img = Image.open(io.BytesIO(png)).convert("RGB")
    scale = (img.width / screen_width) if screen_width else 1.0
    if scale < 1.0:
        scale = 1.0
    draw = ImageDraw.Draw(img)
    for x1, y1, x2, y2 in rects:
        draw.rectangle(
            [int(x1 * scale) - 2, int(y1 * scale) - 2, int(x2 * scale) + 2, int(y2 * scale) + 2],
            fill=(0, 0, 0),
        )
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def model_jpeg(png: bytes, quality: int = JPEG_QUALITY, max_long_side: int = MAX_SCREENSHOT_LONG_SIDE) -> tuple[bytes, tuple[int, int]]:
    """The screenshot the model sees: the (masked) frame resampled so its long side is at most
    `max_long_side`, then JPEG; returns the bytes and the image size."""
    from PIL import Image

    img = Image.open(io.BytesIO(png)).convert("RGB")
    img.thumbnail((max_long_side, max_long_side), Image.LANCZOS)  # keeps aspect, never upscales
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return buf.getvalue(), img.size


def full_jpeg(png: bytes, quality: int = 80) -> bytes:
    """The frame at full resolution as JPEG (evidence)."""
    from PIL import Image

    img = Image.open(io.BytesIO(png)).convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


# ---------- did the screen change ----------

#: Action kinds expected to change what is on screen.
CHANGE_KINDS = frozenset({"tap", "long_press", "swipe", "press"})
#: Mean grey-level difference (0..255) on a thumbnail below which two frames are the same screen.
SAME_FRAME_MAX_DIFF = 1.5
#: The same inside the tapped element's region (a toggled switch changes its own region).
SAME_REGION_MAX_DIFF = 6.0
REGION_PAD = 4
_THUMB = (48, 96)
#: The frame signal's motion thumbnail: the tail of an animation moves too few levels for the
#: mean rule, yet the accessibility frames are still in flight then.
MOTION_THUMB = (128, 256)
MOTION_MIN_LEVELS = 16
MOTION_MIN_PIXELS = 20


def frames_look_same(png_a: bytes, png_b: bytes) -> bool:
    """Whether two frames show the same screen, compared as small greyscale thumbnails. False
    when either cannot be decoded (never claim "unchanged" without evidence)."""
    try:
        from PIL import Image, ImageChops, ImageStat

        a = Image.open(io.BytesIO(png_a)).convert("L").resize(_THUMB)
        b = Image.open(io.BytesIO(png_b)).convert("L").resize(_THUMB)
        return ImageStat.Stat(ImageChops.difference(a, b)).mean[0] <= SAME_FRAME_MAX_DIFF
    except Exception:  # noqa: BLE001
        return False


def frame_thumb(png: bytes, size: tuple[int, int] = _THUMB) -> Any:
    """A greyscale thumbnail for `thumbs_differ`/`thumbs_moved`; None when undecodable."""
    try:
        from PIL import Image

        return Image.open(io.BytesIO(png)).convert("L").resize(size)
    except Exception:  # noqa: BLE001
        return None


def thumbs_differ(a: Any, b: Any) -> bool:
    """Two thumbnails show different screens (the `SAME_FRAME_MAX_DIFF` rule)."""
    try:
        from PIL import ImageChops, ImageStat

        if a.size != b.size:
            a, b = a.resize(_THUMB), b.resize(_THUMB)
        return ImageStat.Stat(ImageChops.difference(a, b)).mean[0] > SAME_FRAME_MAX_DIFF
    except Exception:  # noqa: BLE001 - two frames that cannot be compared are not "the same"
        return True


def thumbs_moved(a: Any, b: Any) -> bool:
    """Something moved between two `MOTION_THUMB` thumbnails: more than `MOTION_MIN_PIXELS`
    pixels changed by more than `MOTION_MIN_LEVELS` levels (blind to a caret blink)."""
    try:
        from PIL import ImageChops, ImageStat

        changed = ImageChops.difference(a, b).point(lambda v: 255 if v > MOTION_MIN_LEVELS else 0)
        return ImageStat.Stat(changed).sum[0] / 255 > MOTION_MIN_PIXELS
    except Exception:  # noqa: BLE001
        return True


def pixel_digest(png: bytes) -> str:
    """sha1 of the quantised greyscale thumbnail; "" when the frame cannot be decoded."""
    try:
        from PIL import Image

        thumb = Image.open(io.BytesIO(png)).convert("L").resize(_THUMB)
        return hashlib.sha1(bytes(v // 8 for v in thumb.tobytes())).hexdigest()[:12]
    except Exception:  # noqa: BLE001
        return ""


def shape_of(shot: Any) -> str:
    """`screen_shape` of the tree, plus the frame digest when the tree cannot describe the
    screen (no element, or no interactive element: a canvas, a map, a video)."""
    elements = list(getattr(shot, "elements", None) or []) if getattr(shot, "tree_available", True) else []
    text = screen_shape(elements)
    if any(e.interactive for e in visible_elements(elements)):
        return text
    png = getattr(shot, "png", None)
    return f"{text}\n<pixels {pixel_digest(png) if png else ''}>"


def region_looks_same(png_a: bytes, png_b: bytes, box: tuple[int, int, int, int], scale: float) -> bool:
    """Whether the pixels inside `box` (screen units, `scale` pixels per unit) are the same."""
    try:
        from PIL import Image, ImageChops, ImageStat

        a = Image.open(io.BytesIO(png_a)).convert("L")
        b = Image.open(io.BytesIO(png_b)).convert("L")
        if a.size != b.size:
            return False
        w, h = a.size
        x1 = max(0, int((box[0] - REGION_PAD) * scale))
        y1 = max(0, int((box[1] - REGION_PAD) * scale))
        x2 = min(w, int((box[2] + REGION_PAD) * scale) + 1)
        y2 = min(h, int((box[3] + REGION_PAD) * scale) + 1)
        if x2 <= x1 or y2 <= y1:
            return True
        crop = (x1, y1, x2, y2)
        return ImageStat.Stat(ImageChops.difference(a.crop(crop), b.crop(crop))).mean[0] <= SAME_REGION_MAX_DIFF
    except Exception:  # noqa: BLE001
        return False


def action_failed(result: str) -> bool:
    return result.startswith("error:") or "failed" in result.lower()


def action_region(args: dict[str, Any] | None, elements: list[Element] | None) -> tuple[int, int, int, int] | None:
    """The box (screen units) the action aimed at: the element its target resolves to."""
    from orcha_cli.qa.device.targets import has_locator, parse_target, resolve

    target = (args or {}).get("target")
    if not isinstance(target, dict) or not elements or not has_locator(target):
        return None
    try:
        point, _ = resolve(parse_target(target), elements)
    except Exception:  # noqa: BLE001 - no region is a weaker check, never a failure
        return None
    if point is None:
        return None
    hits = [e for e in elements if e.type != "Application" and e.x1 <= point[0] <= e.x2 and e.y1 <= point[1] <= e.y2]
    if not hits:
        return None
    e = min(hits, key=lambda e: (e.x2 - e.x1) * (e.y2 - e.y1))
    return (e.x1, e.y1, e.x2, e.y2)


def unchanged_after(kind: str, result: str, before: Any, after: Any, args: dict[str, Any] | None = None) -> bool:
    """True when a successful tap/long press/swipe/press left the screen as it was: the same
    tree hash, the same values, the same frame, and the same pixels where it was aimed (a
    toggle is a few hundred pixels, far too small to move the whole-frame mean)."""
    if kind not in CHANGE_KINDS or action_failed(result) or before is None or after is None:
        return False
    if getattr(before, "tree_hash", None) != getattr(after, "tree_hash", None):
        return False
    eb, ea = getattr(before, "elements", None), getattr(after, "elements", None)
    if eb and ea and tree_value_hash(eb) != tree_value_hash(ea):
        return False  # a value-only change (toggle, checkbox, stepper) is a change
    if not (before.png and after.png) or not frames_look_same(before.png, after.png):
        return False
    box = action_region(args, eb)
    if box is not None:
        width = (getattr(before, "size", None) or (0, 0))[0] or screen_width_of(eb or [])
        scale = 1.0
        try:
            from PIL import Image

            scale = Image.open(io.BytesIO(before.png)).size[0] / width if width else 1.0
        except Exception:  # noqa: BLE001
            pass
        if not region_looks_same(before.png, after.png, box, scale):
            return False
    return True


def unchanged_note(kind: str, args: dict[str, Any] | None) -> str:
    """The note on a screen after an action that changed nothing."""
    target = (args or {}).get("target") or {}
    what = target.get("text") or target.get("id") or target.get("ref") or (args or {}).get("direction") or (args or {}).get("key")
    action = f"{kind} on {what!r}" if what and kind in ("tap", "long_press") else f"{kind} {what}" if what else kind
    return (
        f"screen_unchanged: the screen looks the same as before your {action}. If you expected a change, "
        "wait and look again before acting on it; if it still did nothing, that is either the wrong element or a bug."
    )


def transitional(shot: Any) -> bool:
    """A capture with a readable tree that holds no element at all, or only the device's own
    chrome (Android's status bar) with none of the app's: a screen between two screens."""
    if not getattr(shot, "tree_available", True):
        return False
    elements = list(getattr(shot, "elements", None) or [])
    if not elements:
        return True
    traits = [list(getattr(e, "traits", None) or []) for e in elements if getattr(e, "type", None) != "Application"]
    return bool(traits) and all("System" in t for t in traits)


# ---------- the settle ----------


@dataclass
class SignalResult:
    """What a change signal saw: whether the screen moved after the action (first at
    `first_s`), whether it then held still, how long the wait took, how many frames it read."""

    changed: bool
    still: bool
    first_s: float | None
    took_s: float
    frames: int = 0


class ChangeSignal(Protocol):
    source: str

    async def wait(self, *, change_s: float, quiet_s: float, max_s: float) -> SignalResult | None:
        """Wait up to `change_s` for the screen to move, then (with `max_s` > 0) until it held
        still for `quiet_s`, for at most `max_s`. None when the signal failed."""
        ...


def _full(session: Any) -> Callable[[], Awaitable[Any]]:
    return getattr(session, "snapshot", None) or (lambda: session.screen(settle_s=0))


async def settle(
    session: Any,
    *,
    after: str,
    before_shape: str | None,
    clock: Callable[[], float] | None = None,
    sleep: Callable[[float], Awaitable[Any]] | None = None,
    change_wait: float | None = None,
) -> str:
    """Wait for the screen to react to the action just taken, then to hold still.

    With a change signal (`session.change_signal(after)`): wait on it, read the tree once, and
    let the tree's shape and the frame decide. Otherwise, on tree polls: phase 1 polls
    (`session.probe()`) until `shape_of` differs from `before_shape`, for at most the action's
    change wait; phase 2 polls until one shape has held for `STILL_FOR_S`, for at most
    `HELD_STILL_S`. Returns "changed", "unchanged" (a dead control, or an effect the tree and
    pixels cannot show) or "timeout" (still moving). `session.last_screen` is a full capture of
    the settled screen afterwards (`session.snapshot()`); the verdict is kept in
    `session.last_settled` and the cost in `session.last_settle_timing`."""
    clock = clock or now
    sleep = sleep or poll_sleep
    timing = SettleTiming(clock)
    full = timing.counted(_full(session))
    probe = getattr(session, "probe", None)
    read = timing.counted(probe) if probe is not None else full
    default_wait, held_still = SETTLE_AFTER.get(after, (FULL_CHANGE_WAIT_S, True))
    change_wait = default_wait if change_wait is None else change_wait
    started = clock()
    before_shot = getattr(session, "last_screen", None)
    make_signal = getattr(session, "change_signal", None)
    signal = make_signal(after) if callable(make_signal) else None
    if signal is not None:
        verdict = await _settle_on_signal(
            session, signal, after=after, before_shape=before_shape, before_shot=before_shot,
            change_wait=change_wait, held_still=held_still, timing=timing, full=full, read=read,
            clock=clock, sleep=sleep, started=started,
        )
        if verdict is not None:
            return verdict
        timing = SettleTiming(clock)  # the signal failed: time the tree polls on their own
        full = timing.counted(_full(session))
        read = timing.counted(probe) if probe is not None else full
        started = clock()
    shot = await read()
    is_full = probe is None
    shape = shape_of(shot)
    seen_at = clock()
    deadline = seen_at + change_wait
    # An empty tree mid-transition is neither the old shape nor a new one: keep waiting.
    while (transitional(shot) or (before_shape is not None and shape == before_shape)) and clock() < deadline:
        await sleep(SETTLE_POLL_S)
        shot = await read()
        nxt = shape_of(shot)
        if nxt != shape:
            shape, seen_at = nxt, clock()
    verdict = "changed" if before_shape is None or shape != before_shape else "unchanged"
    phase1_done = clock()
    if held_still:
        still, shape, seen_at, is_full = await _hold_still(shot, shape, seen_at, full=full, read=read, probe=probe, clock=clock, sleep=sleep)
        if not still:
            verdict = "timeout"
    phase2_done = clock()
    if not is_full:
        await full()
    timing.finish(session, started=started, phase1_done=phase1_done, phase2_done=phase2_done, verdict=verdict, source="tree")
    return verdict


async def _hold_still(
    shot: Any, shape: str, seen_at: float, *, full: Callable[[], Awaitable[Any]], read: Callable[[], Awaitable[Any]],
    probe: Any, clock: Callable[[], float], sleep: Callable[[float], Awaitable[Any]],
) -> tuple[bool, str, float, bool]:
    """Phase 2 on tree polls: `(still, shape, seen_at, last read was full)`. The first poll is a
    full capture (most screens are still by then)."""
    deadline = clock() + HELD_STILL_S
    still = False
    first = True
    is_full = False
    while clock() < deadline:
        await sleep(max(SETTLE_POLL_S, STILL_FOR_S - (clock() - seen_at)))
        shot = await (full() if first else read())
        is_full = first or probe is None
        first = False
        nxt = shape_of(shot)
        still = nxt == shape and not transitional(shot)
        if still:
            break
        shape, seen_at = nxt, clock()
    return still, shape, seen_at, is_full


async def _settle_on_signal(
    session: Any, signal: Any, *, after: str, before_shape: str | None, before_shot: Any, change_wait: float,
    held_still: bool, timing: SettleTiming, full: Callable[[], Awaitable[Any]], read: Callable[[], Awaitable[Any]],
    clock: Callable[[], float], sleep: Callable[[float], Awaitable[Any]], started: float,
) -> str | None:
    """The settle on a change signal; None when the signal failed (the caller polls the tree).
    One wait on the signal (a dead-tap window for a tap, press or swipe, else the change wait;
    then the quiet window), one full read, and the verdict from the tree's shape and the frame."""
    if before_shape is None:
        first_window = 0.0
    elif after in DEAD_TAP_KINDS:
        first_window = min(change_wait, DEAD_TAP_S)
    else:
        first_window = change_wait
    try:
        quiet_s = float(getattr(signal, "quiet_s", SIGNAL_QUIET_S))
        res = await signal.wait(change_s=first_window, quiet_s=quiet_s, max_s=HELD_STILL_S if held_still else 0.0)
    except Exception:  # noqa: BLE001 - a signal that breaks is a signal we do not have
        res = None
    if res is None:
        return None
    phase1_done = started + (res.first_s if res.changed and res.first_s is not None else min(res.took_s, first_window))
    phase2_done = started + res.took_s
    shot = await full()
    shape = shape_of(shot)
    moved = before_shape is None or shape != before_shape
    before_png, after_png = getattr(before_shot, "png", None), getattr(shot, "png", None)
    if not moved and res.changed and before_png and after_png and not frames_look_same(before_png, after_png):
        moved = True  # the same tree with other pixels: a scroll, a redraw the tree does not name
    source = getattr(signal, "source", "signal")
    if before_shape is None:
        verdict = "changed" if res.still or not held_still else "timeout"
    elif held_still and ((moved and not res.changed) or (res.changed and not res.still) or transitional(shot)):
        # The tree moved where the signal saw nothing, the signal never went quiet, or the tree is
        # mid-transition: prove stillness on tree polls.
        still, shape, _, is_full = await _hold_still(
            shot, shape, clock(), full=full, read=read, probe=getattr(session, "probe", None), clock=clock, sleep=sleep,
        )
        phase2_done = clock()
        if not is_full:
            await full()
        moved = shape != before_shape
        source = f"{source}+tree"
        verdict = ("changed" if still else "timeout") if moved else "unchanged"
    elif moved:
        verdict = "changed" if res.still or not held_still else "timeout"
    else:
        verdict = "unchanged"
    timing.frames = res.frames
    timing.finish(session, started=started, phase1_done=phase1_done, phase2_done=phase2_done, verdict=verdict, source=source)
    return verdict


class SettleTiming:
    """What one settle cost (`session.last_settle_timing`): the reads it made and the phases."""

    def __init__(self, clock: Callable[[], float]):
        self.clock = clock
        self.reads = 0
        self.read_s = 0.0
        self.frames = 0

    def counted(self, fn: Callable[[], Awaitable[Any]]) -> Callable[[], Awaitable[Any]]:
        async def go() -> Any:
            t0 = self.clock()
            try:
                return await fn()
            finally:
                self.reads += 1
                self.read_s += self.clock() - t0

        return go

    def finish(self, session: Any, *, started: float, phase1_done: float, phase2_done: float, verdict: str, source: str) -> None:
        try:
            session.last_settled = verdict
            session.last_settle_timing = {
                "verdict": verdict, "source": source,
                "phase1_ms": _ms(phase1_done - started), "phase2_ms": _ms(phase2_done - phase1_done),
                "total_ms": _ms(self.clock() - started), "reads": self.reads, "read_ms": _ms(self.read_s),
                **({"frames": self.frames} if self.frames else {}),
            }
        except AttributeError:
            pass


def _ms(seconds: float) -> int:
    return max(0, round(seconds * 1000))


def _shows(elements: list[Any], text: str) -> bool:
    needle = text.strip().lower()
    return any(needle in (e.label or "").lower() or needle in (e.value or "").lower() for e in elements)


async def wait_for(session: Any, *, ms: int, until_text: str | None = None, gone_text: str | None = None) -> tuple[bool, int, str]:
    """A condition wait, `(met, waited_ms, what)`, leaving `session.last_screen` a full capture.

    With `until_text`/`gone_text`: poll the tree every `WAIT_POLL_S` until the text is on screen
    / off it, for at most `ms`. With neither: wait for the screen to change and then hold still
    (the action settle with `ms` as its change window); a screen that never changes waits the
    whole `ms`, one that settles returns at once."""
    ms = max(0, min(int(ms), MAX_WAIT_MS))
    full = _full(session)
    read = getattr(session, "probe", None) or full
    started = now()
    if not until_text and not gone_text:
        before = session.last_screen if session.last_screen is not None else await full()
        verdict = await settle(session, after="wait", before_shape=shape_of(before), change_wait=ms / 1000)
        waited = int((now() - started) * 1000)
        what = {
            "changed": "the screen changed and held still",
            "timeout": "the screen changed and was still moving",
            "unchanged": "the screen did not change",
        }[verdict]
        return verdict != "unchanged", waited, what
    deadline = started + ms / 1000
    met = False
    while True:
        shot = await read()
        elements = list(getattr(shot, "elements", None) or [])
        met = (not until_text or _shows(elements, until_text)) and (not gone_text or not _shows(elements, gone_text))
        if met or now() >= deadline:
            break
        await poll_sleep(WAIT_POLL_S)
    await full()
    waited = int((now() - started) * 1000)
    want = " and ".join(x for x in (f"{until_text!r} showed" if until_text else "", f"{gone_text!r} went away" if gone_text else "") if x)
    return met, waited, want if met else f"not met: {want.replace('showed', 'did not show').replace('went away', 'stayed')}"


# ---------- a system permission dialog on screen ----------

ANDROID_DIALOG_PACKAGES = frozenset({"com.android.permissioncontroller", "com.google.android.permissioncontroller"})
SPRINGBOARD = "com.apple.springboard"
#: Android's allow buttons, best first.
ANDROID_ALLOW_IDS = (
    "permission_allow_foreground_only_button",
    "permission_allow_button",
    "permission_allow_all_button",
    "permission_allow_one_time_button",
)
ALLOW_LABELS = (
    "while using the app", "allow while using app", "allow while using the app", "allow full access", "allow all",
    "allow", "ok", "only this time", "allow once",
)
_DENY = re.compile(r"^(?:don['’]t allow|do not allow|deny|not now)$", re.IGNORECASE)


@dataclass(frozen=True)
class Dialog:
    """A permission dialog on screen: what it asks, and the allow control to tap."""

    prompt: str
    allow: Element
    allow_label: str


def _norm(text: str) -> str:
    return " ".join(str(text or "").replace("’", "'").split()).strip().lower()


def _prompt_text(elements: list[Element], allow: Element) -> str:
    texts = [e.label for e in elements if e.type in ("StaticText", "TextView", "Alert", "Other") and e.label]
    asks = [t for t in texts if re.search(r"\?|would like|allow\b|access", t, re.IGNORECASE) and t != allow.label]
    return (asks[0] if asks else (texts[0] if texts else "a permission")).strip()[:160]


def dialog_of(foreground: str | None, elements: list[Element]) -> Dialog | None:
    """The permission dialog on this screen, or None. Android: the permission controller's
    window with an allow button (by its id, else its words). iOS: a SpringBoard alert with a
    "Don't Allow" button beside an allow one."""
    fg = str(foreground or "")
    elements = list(elements or [])
    if fg in ANDROID_DIALOG_PACKAGES:
        by_id = {e.identifier: e for e in elements if e.identifier}
        for key in ANDROID_ALLOW_IDS:
            if key in by_id:
                e = by_id[key]
                return Dialog(_prompt_text(elements, e), e, e.label or "Allow")
        return _by_label(elements, needs_deny=False)
    if fg == SPRINGBOARD:
        return _by_label(elements, needs_deny=True)
    return None


def _by_label(elements: list[Element], *, needs_deny: bool) -> Dialog | None:
    buttons = [e for e in elements if e.type == "Button" and e.enabled]
    if needs_deny and not any(_DENY.match(_norm(e.label)) for e in buttons):
        return None
    for want in ALLOW_LABELS:
        for e in buttons:
            if _norm(e.label) == want:
                return Dialog(_prompt_text(elements, e), e, e.label)
    return None
