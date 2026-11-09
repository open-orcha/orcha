"""One live iOS simulator session over idb_companion + fb-idb.

Adapted from `sessions/ios.py` with `ios_taps`, `ios_keys`, `ios_bars`,
`ios_accessibility` and `ios_overlay` folded in, slimmed to what driving an app needs: the
companion's lifecycle and restarts, bounded tree reads, navigation/tab bar items `describe-all`
hides, the frame-signal settle, held taps aimed at a switch row's switch or clear of a context
menu, refusing a tap off screen / under a sheet / after the app left, verified typing (accents as
HID key presses), keyboard focus that an app takes back, a system share sheet idb cannot read,
and an app whose screen is not readable at all.

Only a booted simulator is driven, found by name with `xcrun simctl list devices booted -j`
(default "iPhone 17 Pro", then "iPad Pro 13-inch (M5)") and claimed with its lock directory
(`locks.py`). A simulator a person picked by name that is shut down is booted, under its lock;
nothing here creates, erases or deletes one. Physical iPhones are `ios_phone_session.py`.

Not ported: rotated (landscape) interfaces, hidden sheet layers read by hit
tests (`ios_layers`), video, logs, metrics, appearance, StoreKit, API stubs,
app data save/restore, run folders and evidence.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import time
import unicodedata
from collections.abc import Callable, Iterable, Sequence
from typing import Any

from orcha_cli.qa.device import ios_idb, locks
from orcha_cli.qa.device.base import (
    DEFAULT_IOS_DEVICES,
    SessionBase,
    DeviceBusy,
    SessionError,
    left,
    refusal,
)
from orcha_cli.qa.device.screen import (
    EMPTY_TREE_RETRY_S,
    FRAME_LOOSE_QUIET_S,
    FRAME_QUIET_S,
    MOTION_THUMB,
    RENDER_POLL_S,
    SPRINGBOARD,
    Probe,
    Screen,
    SignalResult,
    dialog_of,
    frame_thumb,
    frames_look_same,
    needs_pixels,
    now,
    poll_sleep,
    settle,
    shape_of,
    thumbs_differ,
    thumbs_moved,
)
from orcha_cli.qa.device.targets import (
    Point,
    Target,
    chosen,
    covered,
    describe,
    is_menu_scrim,
    off_screen,
    refind,
    resolve,
)
from orcha_cli.qa.device.tree import (
    Element,
    foreground_app,
    parse_tree,
    screen_size,
    tree_hash,
    visible_elements,
)

log = logging.getLogger(__name__)

#: Any idb call (other than a tree read) that has not answered in this long: the companion is
#: restarted and the call fails.
IDB_CALL_TIMEOUT_S = 30.0
#: Opening or stopping an app on a busy Mac: 100 s was measured with every other call still answering.
APP_LAUNCH_TIMEOUT_S = 150.0
#: The companion's stream rate (`start_live`); the writer sends fewer of them on.
LIVE_STREAM_FPS = 15
#: A tree read that has not answered in this long is not coming (first reads ~3.6 s, later
#: 0.2-1.2 s). One companion restart and retry follow.
TREE_TIMEOUT_S = 8.0
#: After a read timed out, the reads in the next this many seconds wait `BLIND_TREE_TIMEOUT_S`
#: only: a system sheet idb cannot read made every read of a settle wait out the full timeout.
BLIND_WINDOW_S = 30.0
BLIND_TREE_TIMEOUT_S = 3.0
#: `simctl spawn defaults` before a relaunch mid-run (they hang 30 s with a share sheet up).
AX_SETTING_TIMEOUT_S = 5.0
SIMCTL_APP_TIMEOUT_S = 60.0
COMPANION_RESTART_TIMEOUT_S = 25.0
READABLE_AFTER_SWIPE_S = 3.0
READABLE_AFTER_LAUNCH_S = 12.0
#: The frame a settle saw still stands in for the settled screen's screenshot only this soon after.
STILL_FRAME_MAX_AGE_S = 1.0
#: The settled screen looks once its tree is read; a look unlike the frame before reads the tree
#: again, at most this many reads in all (a menu blooming after the long press lifted).
FRAME_TREE_READS = 3
#: Reading a navigation or tab bar's items point by point.
BAR_PROBE_TIMEOUT_S = 3.0
BAR_PROBE_MAX_POINTS = 40
#: Before a tap, idb's hit test at its point names the process that would get it.
FRONT_CHECK_TIMEOUT_S = 0.5
APP_BACK_WAIT_S = 3.0
#: Taps a field gets at most while iOS says it is not being edited and the taps change nothing.
FOCUS_TAPS = 3
#: Looks a frame signal takes before it calls a screen unchanged.
MIN_LOOKS = 2

KEY_ENTER = 40
KEY_DELETE = 42
BUTTONS = {"home": "HOME", "lock": "LOCK", "siri": "SIRI", "side": "SIDE_BUTTON"}
# "TextArea": a multi-line field as fb-idb 1.6 names it (a React Native `multiline` TextInput).
TEXT_TYPES = frozenset({"TextField", "SecureTextField", "SearchField", "TextView", "TextArea"})


# =============================================================================================
# Taps: where a tap lands on the element it names (`ios_taps`)
# =============================================================================================

#: A UISwitch's width, in points (iOS 26 draws it 63x28, against the same edge).
SWITCH_W = 51
SWITCH_TYPES = frozenset({"Switch", "CheckBox", "Toggle"})
#: Wider than this (two switches side by side) and the element is a row with a switch in it.
ROW_MIN_W = 2 * SWITCH_W
#: Where on a context menu's scrim a tap is tried, as fractions of its box.
SCRIM_SPOTS = [(0.5, f) for f in (0.5, 0.12, 0.88, 0.3, 0.7, 0.2, 0.8)] + [
    (fx, fy) for fy in (0.5, 0.12, 0.88) for fx in (0.08, 0.92)
]
SCRIM_MARGIN = 8
#: The least of an element that must be on screen, per axis, for a tap on that part.
MIN_ON_SCREEN = 44


def right_to_left(text: str) -> bool:
    """Whether `text` reads right to left (its first letter with a direction is RTL)."""
    for ch in text:
        kind = unicodedata.bidirectional(ch)
        if kind in ("R", "AL"):
            return True
        if kind == "L":
            return False
    return False


def switch_point(e: Element) -> Point | None:
    """The switch inside a Switch/CheckBox element as wide as its row (a SwiftUI `Toggle` with
    its own label): half a switch in from the trailing edge (leading for RTL). A tap on the
    row's centre is its label, which does not flip it."""
    if e.type not in SWITCH_TYPES or e.x2 - e.x1 < ROW_MIN_W:
        return None
    cy = (e.y1 + e.y2) // 2
    if right_to_left(e.label):
        return (e.x1 + SWITCH_W // 2, cy)
    return (e.x2 - SWITCH_W // 2, cy)


def scrim_point(scrim: Element, elements: list[Element]) -> Point | None:
    """A point on a context menu's scrim no menu element holds (its centre can be "Delete")."""
    others = [
        e for e in elements
        if e.index != scrim.index and e.type != "Application" and e.x2 > e.x1 and e.y2 > e.y1
        and not (e.x1 <= scrim.x1 and e.y1 <= scrim.y1 and e.x2 >= scrim.x2 and e.y2 >= scrim.y2)
    ]
    w, h = scrim.x2 - scrim.x1, scrim.y2 - scrim.y1
    for fx, fy in SCRIM_SPOTS:
        x, y = scrim.x1 + int(w * fx), scrim.y1 + int(h * fy)
        m = SCRIM_MARGIN
        if not any(e.x1 - m <= x <= e.x2 + m and e.y1 - m <= y <= e.y2 + m for e in others):
            return (x, y)
    return None


def into_view(e: Element, point: Point, how: str, width: int, height: int) -> tuple[Point, str]:
    """`point` (off screen) moved onto the part of `e` the screen shows (a scroll view taller
    than the screen). Unchanged when too little of `e` shows."""
    vx1, vy1, vx2, vy2 = max(e.x1, 0), max(e.y1, 0), min(e.x2, width), min(e.y2, height)
    if vx2 - vx1 < min(MIN_ON_SCREEN, e.x2 - e.x1) or vy2 - vy1 < min(MIN_ON_SCREEN, e.y2 - e.y1) or vx2 <= vx1 or vy2 <= vy1:
        return point, how
    x = point[0] if 0 <= point[0] < width else (vx1 + vx2) // 2
    y = point[1] if 0 <= point[1] < height else (vy1 + vy2) // 2
    return (x, y), f"{how}, on its part on screen"


def aim(e: Element | None, point: Point, how: str, elements: list[Element]) -> tuple[Point, str]:
    """Where a plain tap on `e` goes (None for explicit bounds: as given)."""
    if e is None:
        return point, how
    spot = switch_point(e)
    if spot is not None:
        return spot, f"{how}, on its switch"
    if is_menu_scrim(e):
        spot = scrim_point(e, elements)
        if spot is not None and spot != point:
            return spot, f"{how}, clear of the menu"
    return point, how


def editing(field_: Element | None) -> bool | None:
    """Whether iOS says the field holds the keyboard (its `IsEditing` trait); None when its traits
    do not say."""
    if field_ is None or "TextEntry" not in field_.traits:
        return None
    return "IsEditing" in field_.traits


def opened(before: Any, after: Any) -> bool:
    """Whether a tap opened something: an element on the screen after it that the screen before
    did not have, the keyboard's keys aside. True when either screen is missing."""
    if before is None or after is None:
        return True

    def seen(shot: Any) -> set[tuple[str, str, str]]:
        return {
            (e.type, e.label, e.value)
            for e in visible_elements(list(getattr(shot, "elements", None) or []))
            if "KeyboardKey" not in e.traits
        }

    return bool(seen(after) - seen(before))


def back_button(elements: list[Element], width: int, height: int) -> Element | None:
    """The navigation bar's back control: UIKit's `BackButton`, a button called Back, else the
    leading button in the top bar (SwiftUI names it after the previous screen)."""
    buttons = [e for e in elements if e.type == "Button" and e.enabled and e.x2 > e.x1 and e.y2 > e.y1]
    for e in buttons:
        if e.identifier == "BackButton" or e.label.strip().lower() == "back":
            return e
    top = min(160, max(height, 1) // 5) if height else 160
    lead = [
        e for e in buttons
        if e.y2 <= top + 20 and e.y1 >= 20 and e.x1 < (width or 400) * 0.2
        and e.label.strip().lower() not in ("close", "cancel", "done", "edit", "search", "")
    ]
    return min(lead, key=lambda e: (e.y1, e.x1)) if lead else None


# =============================================================================================
# Keys: text as HID key presses (`ios_keys`)
# =============================================================================================

OPTION = 226  # HID usage: left Alt, the Mac's Option
SHIFT = 225
DEAD: dict[str, tuple[int, str]] = {
    "́": (8, "aeiouAEIOU"),  # acute: Option-E
    "̀": (53, "aeiouAEIOU"),  # grave: Option-`
    "̂": (12, "aeiouAEIOU"),  # circumflex: Option-I
    "̈": (24, "aeiouyAEIOUY"),  # diaeresis: Option-U
    "̃": (17, "anoANO"),  # tilde: Option-N
}
CHORD: dict[str, tuple[int, bool]] = {
    "ç": (6, False), "Ç": (6, True), "ß": (22, False), "ø": (18, False), "Ø": (18, True),
    "å": (4, False), "Å": (4, True), "æ": (52, False), "Æ": (52, True), "œ": (20, False), "Œ": (20, True),
    "‘": (48, False), "’": (48, True), "“": (47, False), "”": (47, True), "–": (45, False), "—": (45, True),
    "…": (51, False), "¡": (30, False), "¿": (56, True), "£": (32, False), "€": (31, True), "¥": (28, False),
    "©": (10, False), "®": (21, False), "™": (31, False), "•": (37, False), "°": (37, True),
}


def _press_event(key: int, down: bool) -> Any:
    from idb.common.types import HIDDirection, HIDKey, HIDPress

    return HIDPress(action=HIDKey(keycode=key), direction=HIDDirection.DOWN if down else HIDDirection.UP)


def _with_option(key: int, shift: bool = False) -> list[Any]:
    held = [OPTION, SHIFT] if shift else [OPTION]
    return [_press_event(k, True) for k in held] + [_press_event(key, True), _press_event(key, False)] + [
        _press_event(k, False) for k in reversed(held)
    ]


def char_events(ch: str) -> list[Any] | None:
    """The presses that type `ch` on the simulator's US hardware keyboard, or None."""
    from idb.common.hid import KEY_MAP

    if ch in KEY_MAP:
        return list(KEY_MAP[ch])
    if ch in CHORD:
        key, shift = CHORD[ch]
        return _with_option(key, shift)
    parts = unicodedata.normalize("NFD", ch)
    if len(parts) == 2 and parts[1] in DEAD:
        dead, letters = DEAD[parts[1]]
        if parts[0] in letters and parts[0] in KEY_MAP:
            return _with_option(dead) + list(KEY_MAP[parts[0]])
    return None


def text_events(text: str) -> tuple[list[Any], list[str]]:
    """Every press that types `text`, and the characters it cannot type (each once, in order):
    an emoji or a letter of another script has no key; the caller then types nothing."""
    events: list[Any] = []
    missing: list[str] = []
    for ch in unicodedata.normalize("NFC", text):
        got = char_events(ch)
        if got is None:
            if ch not in missing:
                missing.append(ch)
        else:
            events.extend(got)
    return events, missing


def plain(text: str) -> str:
    """`text` with the punctuation iOS swaps in as you type (smart quotes and dashes) put back."""
    return (text.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
            .replace("—", "-").replace("–", "-"))


# =============================================================================================
# Bars: navigation and tab bar items `describe-all` leaves out (`ios_bars`)
# =============================================================================================

BAR_ROLES = frozenset({"nav bar", "navigation bar", "tab bar", "toolbar"})
BAR_LABELS = frozenset({"tab bar", "toolbar"})
STEP_PT = 22
SLACK_PT = 6
BAR_UNREAD = "items not readable by the harness (describe-all hides them); not an accessibility finding"


def _frame(node: dict[str, Any]) -> tuple[float, float, float, float] | None:
    f = node.get("frame") or {}
    try:
        x, y, w, h = float(f.get("x", 0)), float(f.get("y", 0)), float(f.get("width", 0)), float(f.get("height", 0))
    except (TypeError, ValueError):
        return None
    return (x, y, w, h) if w > 0 and h > 0 else None


def _center(node: dict[str, Any]) -> tuple[float, float] | None:
    f = _frame(node)
    return (f[0] + f[2] / 2, f[1] + f[3] / 2) if f else None


def _inside(point: tuple[float, float], frame: tuple[float, float, float, float], slack: float = 0) -> bool:
    x, y, w, h = frame
    return x - slack <= point[0] <= x + w + slack and y - slack <= point[1] <= y + h + slack


def is_bar(node: dict[str, Any]) -> bool:
    if str(node.get("type") or "") != "Group":
        return False
    role = str(node.get("role_description") or "").strip().lower()
    label = str(node.get("AXLabel") or "").strip().lower()
    return role in BAR_ROLES or label in BAR_LABELS


def opaque_bars(raw: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The bars in `raw` with no element inside their frame (`describe-all` hid their items:
    iOS 26 gives a navigation bar as one empty `Group`, the tab bar as `Group "Tab Bar"`)."""
    out = []
    for node in raw:
        frame = _frame(node)
        if frame is None or not is_bar(node):
            continue
        contained = False
        for other in raw:
            if other is node or str(other.get("type")) == "Application":
                continue
            c = _center(other)
            if c and _inside(c, frame):
                contained = True
                break
        if not contained:
            out.append(node)
    return out


def probe_rows(frame: tuple[float, float, float, float]) -> list[float]:
    """The y of each probe row: the middle, plus the top row of a tall (large-title) bar."""
    _, y, _, h = frame
    rows = [y + h / 2]
    if h > 70:
        rows.insert(0, y + 22)
    return rows


def items_from_probe(bar: dict[str, Any], found: Any) -> list[dict[str, Any]]:
    """The elements a `describe-point` answer holds inside `bar`, leaves first."""
    frame = _frame(bar)
    if frame is None:
        return []
    out: list[dict[str, Any]] = []
    stack = list(found) if isinstance(found, list) else [found]
    while stack:
        node = stack.pop(0)
        if not isinstance(node, dict):
            continue
        children = node.get("children")
        if isinstance(children, list):
            stack.extend(children)
        if str(node.get("type") or "") in ("Application", "Window"):
            continue
        f, c = _frame(node), _center(node)
        if f is None or c is None or not _inside(c, frame, SLACK_PT):
            continue
        if f == frame and str(node.get("type")) == "Group":
            continue  # the bar itself, answered for a point between its items
        out.append({k: v for k, v in node.items() if k != "children"})
    return out


def _bar_key(node: dict[str, Any]) -> tuple[Any, ...]:
    f = _frame(node) or (0, 0, 0, 0)
    return (node.get("type"), node.get("AXLabel"), node.get("AXUniqueId"), tuple(round(v) for v in f))


def merge_bars(raw: list[dict[str, Any]], found: dict[int, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    """`raw` with each bar's probed items (`{id(bar): [item]}`) right after the bar, once each."""
    have = {_bar_key(n) for n in raw}
    out: list[dict[str, Any]] = []
    for node in raw:
        out.append(node)
        for item in found.get(id(node), []):
            k = _bar_key(item)
            if k in have:
                continue
            have.add(k)
            out.append(item)
    return out


def tree_signature(raw: list[dict[str, Any]]) -> str:
    parts = [
        [n.get("type"), n.get("AXLabel"), n.get("AXValue"), n.get("AXUniqueId"), _frame(n), n.get("enabled"), n.get("traits")]
        for n in raw
    ]
    return hashlib.sha1(json.dumps(parts, default=str, sort_keys=True).encode()).hexdigest()[:16]


def bar_frame_key(bar: dict[str, Any]) -> tuple[Any, ...]:
    return (str(bar.get("role_description") or ""), str(bar.get("AXLabel") or ""), tuple(round(v) for v in (_frame(bar) or (0, 0, 0, 0))))


# =============================================================================================
# An app whose screen idb cannot read (`ios_accessibility`)
# =============================================================================================

LOST_NOTE = (
    "tree: unavailable. The simulator stopped reporting this app's screen elements (accessibility is "
    "off for it, or idb cannot read it). Relaunch the app with launch_app: the session turns accessibility "
    "back on and restarts the app first. Until then judge nothing from this screen and never report a "
    "missing accessibility tree as an app bug."
)
#: Captures in a row with no tree, after one that had it, before a capture says the tree is lost.
LOST_AFTER = 3
#: An app window this much smaller than the screen is not full screen (an iPhone app on an iPad).
WINDOW_SHARE = 0.9


def dead_tree(raw: list[dict[str, Any]] | None) -> bool:
    """idb's answer for an app whose accessibility runtime never loaded: one Application node
    with no size."""
    if not raw or len(raw) != 1 or not isinstance(raw[0], dict):
        return False
    node = raw[0]
    frame = node.get("frame") or {}
    return str(node.get("type") or "") == "Application" and not (frame.get("width") or frame.get("height"))


def blind(raw: list[dict[str, Any]] | None, available: bool = True) -> bool:
    """A capture showing nothing of the app's screen: no tree, an empty one, or the dead tree."""
    return not available or not raw or dead_tree(raw)


class TreeWatch:
    """Whether the tree is lost mid-run: `LOST_AFTER` captures in a row with no tree, after one
    that had it."""

    def __init__(self) -> None:
        self.seen = False
        self.blank = 0

    def lost(self, raw: list[dict[str, Any]] | None, available: bool) -> bool:
        if not blind(raw, available):
            self.seen, self.blank = True, 0
            return False
        self.blank += 1
        return self.seen and self.blank >= LOST_AFTER


def started_note(turned_on: Sequence[str] | None) -> str | None:
    if not turned_on:
        return None
    return (f"accessibility was off on this simulator ({' and '.join(turned_on)}; no app's screen could be read); "
            "the session turned it on before launching the app")


def windowed(app: tuple[int, int], screen: tuple[int, int] | None) -> bool:
    """Whether the app's window is smaller than the device screen (an iPhone-only app on an iPad):
    idb gives its elements in window points while taps land in screen points."""
    if not screen or not all(app) or not all(screen):
        return False
    return max(app) < WINDOW_SHARE * max(screen) and min(app) < WINDOW_SHARE * min(screen)


def windowed_message(app_name: str, app: tuple[int, int], device_name: str) -> str:
    return (
        f"{app_name} is an iPhone app running in a {app[0]}x{app[1]} window on {device_name}, so taps would land "
        "outside it and every check would be wrong. Run it on an iPhone simulator, or build it for iPad "
        "(TARGETED_DEVICE_FAMILY 1,2)."
    )


def blind_message(app_name: str, flutter: bool, reason: str | None = None) -> str:
    kind = "This Flutter app" if flutter else "This app"
    said = f" (idb: {reason.strip()[:200]})" if reason and reason.strip() else ""
    return (
        f"cannot read {app_name}'s screen on this simulator: the simulator reports no elements for it{said}, "
        f"even after turning accessibility on and relaunching it. {kind} would only be tapped by position, so the "
        "session stopped instead of driving it blind. Restart the simulator (Device > Restart) and try again, or "
        "run on Android."
    )


# =============================================================================================
# A system sheet over the app idb cannot read (`ios_overlay`)
# =============================================================================================

NO_TRANSLATION = "No translation object returned"
HARNESS_KEY = "system_overlay"
PS_TIMEOUT_S = 5.0
SERVICES: dict[str, str] = {
    "SharingUIService": "the system share sheet",
    "SharingViewService": "the system share sheet",
    "AirDropUI": "the AirDrop sheet",
    "MessagesViewService": "the Messages composer",
    "SafariViewService": "a Safari view",
    "PhotosUIService": "the photo picker",
    "PeopleViewService": "the contact picker",
    "StoreKitUIService": "an App Store sheet",
    "EventViewService": "the calendar event sheet",
}
UNNAMED = "a system sheet"
SCRIM_SHARE = 0.9
#: The actions a system sheet opens after.
OVERLAY_OPENERS = frozenset({"tap", "long_press", "swipe", "press", "type", "open_url", "launch"})


def tree_failure(reason: str | None, timeout_s: float) -> str:
    if reason == "timeout":
        return f"the screen read timed out after {timeout_s:g} s"
    if reason and NO_TRANSLATION in reason:
        return "the simulator could not reach the app's screen (idb: no translation object)"
    return f"the screen read failed ({reason})" if reason else "the screen read failed"


def unread_note(failure: str) -> str:
    return (
        f"the session could not read this screen: {failure}. Act on the screenshot with x,y targets, "
        "and judge nothing from the missing tree; it is not an app bug."
    )


def _covers_screen(e: Any, w: int, h: int) -> bool:
    try:
        return (e.x2 - e.x1) >= SCRIM_SHARE * w and (e.y2 - e.y1) >= SCRIM_SHARE * h
    except (AttributeError, TypeError):
        return False


def _full_screen_only(shot: Any) -> bool:
    if shot is None or not getattr(shot, "tree_available", True):
        return False
    elements = list(getattr(shot, "elements", None) or [])
    root = next((e for e in elements if getattr(e, "type", None) == "Application"), None)
    rest = [e for e in elements if e is not root]
    if root is None or not rest:
        return False
    w, h = root.x2 - root.x1, root.y2 - root.y1
    return w > 0 and h > 0 and all(_covers_screen(e, w, h) for e in rest)


def scrim_only(shot: Any) -> bool:
    """The app's root under nothing but UIKit's dimming scrim (`Group "dismiss popup"`): a sheet
    whose content another process draws (the share sheet)."""
    return _full_screen_only(shot) and any(
        "dismiss" in str(getattr(e, "label", "") or "").lower()
        for e in getattr(shot, "elements", None) or [] if getattr(e, "type", None) != "Application"
    )


def unreadable(shot: Any) -> bool:
    """A capture that does not show what is on screen: no tree, only the app's root, or the root
    under nothing but full-screen elements."""
    if shot is None:
        return False
    if not getattr(shot, "tree_available", True):
        return True
    return len(list(getattr(shot, "elements", None) or [])) <= 1 or _full_screen_only(shot)


def readable_app(shot: Any, bundle_id: str) -> bool:
    return shot is not None and not unreadable(shot) and getattr(shot, "foreground", None) == bundle_id


def _exe_name(command: str) -> str:
    exe = re.split(r" -{1,2}[A-Za-z]", command, maxsplit=1)[0].strip()
    return os.path.basename(exe)


def elapsed_s(etime: str) -> int | None:
    """`ps`'s elapsed time (`[[dd-]hh:]mm:ss`) in seconds; None when it is not one."""
    m = re.fullmatch(r"(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)", etime.strip())
    if not m:
        return None
    days, hours, minutes, seconds = (int(g or 0) for g in m.groups())
    return ((days * 24 + hours) * 60 + minutes) * 60 + seconds


def services_in(ps_text: str, udid: str, started_within_s: float | None = None) -> list[str]:
    """The view services (`SERVICES`) running in the simulator `udid`, from `ps -ax -o
    pid=,ppid=,etime=,command=` (a simulator's processes are host processes under its
    `launchd_sim`). With `started_within_s`, only those that started that recently."""
    rows: list[tuple[str, str, str, str]] = []
    for line in ps_text.splitlines():
        parts = line.strip().split(None, 3)
        if len(parts) == 4:
            rows.append((parts[0], parts[1], parts[2], parts[3]))
    roots = {pid for pid, _, _, cmd in rows if "launchd_sim" in cmd and f"/{udid}/" in cmd}
    if not roots:
        return []
    found: list[str] = []
    for _, ppid, etime, cmd in rows:
        name = _exe_name(cmd)
        if ppid not in roots or name not in SERVICES or name in found:
            continue
        age = elapsed_s(etime)
        if started_within_s is not None and (age is None or age > started_within_s):
            continue
        found.append(name)
    return found


def overlay_services(udid: str, started_within_s: float | None = None) -> list[str] | None:
    try:
        out = subprocess.run(["ps", "-ax", "-o", "pid=,ppid=,etime=,command="], capture_output=True, text=True, timeout=PS_TIMEOUT_S)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if out.returncode != 0:
        return None
    return services_in(out.stdout, udid, started_within_s)


def names_share(label: str | None) -> bool:
    return bool(label) and re.search(r"(?<![a-z])share(?![a-z])", str(label), re.IGNORECASE) is not None


def overlay_name(services: Iterable[str], action_label: str | None = None) -> str:
    for name in services:
        if name in SERVICES:
            return SERVICES[name]
    if names_share(action_label):
        return SERVICES["SharingUIService"]
    return UNNAMED


def dismissed_note(name: str, how: str, app_name: str, drawn: bool = True) -> str:
    """What the agent is told after the session dealt with a sheet it cannot read. `how`: swipe |
    relaunch | failed."""
    cap = name[:1].upper() + name[1:]
    if drawn:
        head = f"{cap} opened. The session cannot read it (iOS draws it in a process of its own)"
        swiped = "a swipe down did not close it, so " if how == "relaunch" else ""
    else:
        head = (f"{cap} did not finish opening and {app_name} stopped answering while it waited for it, "
                "so the session could not read the screen")
        swiped = ""
    if how == "swipe":
        body = "so the session closed it with a swipe down. The screen below is after it."
    elif how == "relaunch":
        body = (f"and {swiped}the session stopped {app_name} and launched it again. "
                "The screen below is after the restart: anything not saved before it is gone.")
    else:
        body = (f"and the session could not clear it, even by restarting {app_name}; the screen is still unreadable. "
                "Do not judge the app from it.")
    return (f"system sheet: {head}, {body} A system sheet the session cannot read is not an app bug: do not report "
            "it as one, and do not open it again in this session.")


# =============================================================================================
# Devices
# =============================================================================================


def pick_simulators(sims: list[ios_idb.Simulator], *, device_name: str | None = None, udid: str | None = None,
                    any_device: bool = False) -> list[ios_idb.Simulator]:
    """The booted simulators to try, in order: the one asked for (by udid or name), else the
    defaults ("iPhone 17 Pro", then "iPad Pro 13-inch (M5)"), then any other booted one. With
    `any_device` a name is a preference (the project's usual device, not this run's pick): it comes
    first, then the rest, so a second run takes the other booted device."""
    if udid:
        return [s for s in sims if s.udid == udid]
    named = [s for s in sims if s.name == device_name] if device_name else []
    if device_name and not any_device:
        return named
    if device_name and not named:
        return []  # a usual device that is not booted says so, as a named one does
    ordered = named + [s for name in DEFAULT_IOS_DEVICES for s in sims if s.name == name and s not in named]
    return ordered + [s for s in sims if s not in ordered]


class FrameSignal:
    """The settle's change signal on iOS: idb gives no event feed, so the screen is watched
    through a greyscale thumbnail of the simulator's frame (about 110 ms a look) compared with
    the screen before the action; a tree read is about 300 ms, and the settle then needs one.
    The screen is still once nothing has moved for `quiet_s` (the accessibility frames trail an
    animation, so a tree read taken while a selection pill slides aims the next tap wrong); a
    small region that never stops (a spinner) is let through once the screen has looked the same
    for `FRAME_LOOSE_QUIET_S`."""

    source = "frames"
    quiet_s = FRAME_QUIET_S

    def __init__(self, session: IosSession, before_png: bytes | None):
        self.session = session
        self.before_png = before_png
        self.last_png: bytes | None = None
        self.last_thumb: Any = None

    async def _look(self) -> Any:
        png = await self.session._idb(self.session.client.screenshot(), "screenshot")
        self.last_png = png
        self.last_thumb = await asyncio.to_thread(frame_thumb, png, MOTION_THUMB) if png else None
        return self.last_thumb

    def _keep(self, result: SignalResult) -> SignalResult:
        if result.still and self.last_png:
            self.session._still_frame = (self.last_png, now(), self.last_thumb)
        return result

    async def wait(self, *, change_s: float, quiet_s: float, max_s: float) -> SignalResult | None:
        def changed(a: Any, b: Any) -> bool:
            return thumbs_moved(a, b) or thumbs_differ(a, b)

        started = now()
        frames = 0
        prev = await asyncio.to_thread(frame_thumb, self.before_png, MOTION_THUMB) if self.before_png else None
        first: float | None = None
        while True:
            cur = await self._look()
            frames += 1
            if cur is None:
                return None
            if prev is None:
                prev = cur
            elif changed(prev, cur):
                prev, first = cur, now() - started
                break
            if now() - started >= change_s and frames >= MIN_LOOKS:
                break
        if first is None:
            return self._keep(SignalResult(changed=False, still=True, first_s=None, took_s=now() - started, frames=frames))
        if max_s <= 0:
            return SignalResult(changed=True, still=True, first_s=first, took_s=now() - started, frames=frames)
        deadline = now() + max_s
        moved_at = looked_same_since = now()
        while now() < deadline:
            cur = await self._look()
            frames += 1
            if cur is None:
                return None
            t = now()
            if thumbs_moved(prev, cur):
                moved_at = t
            if thumbs_differ(prev, cur):
                looked_same_since = t
            prev = cur
            if t - moved_at >= quiet_s or t - looked_same_since >= FRAME_LOOSE_QUIET_S:
                return self._keep(SignalResult(changed=True, still=True, first_s=first, took_s=t - started, frames=frames))
        return SignalResult(changed=True, still=False, first_s=first, took_s=now() - started, frames=frames)


async def _ready(value: Any) -> Any:
    return value


# =============================================================================================
# The session
# =============================================================================================


class IosSession(SessionBase):
    """A booted iOS simulator driven through idb. `IosSession(device_name=...)` then
    `await s.start(bundle_id)`; see `base.SessionBase` for the actions."""

    platform = "ios"

    def __init__(
        self,
        *,
        device_name: str | None = None,
        udid: str | None = None,
        client_factory: Callable[[str], Any] | None = None,
        any_device: bool = False,
        **kw: Any,
    ) -> None:
        super().__init__(device_name=device_name, **kw)
        self._want_udid = udid
        #: A name is a preference: a second run takes another booted simulator.
        self.any_device = any_device
        self._client_factory = client_factory or ios_idb.IdbClient
        self.client: Any = None
        #: The live frame stream while a session runs (`start_live`).
        self._live_task: asyncio.Task | None = None
        self.apps: list[ios_idb.AppInfo] = []
        self.runtime = ""
        self._pid_paths: dict[int, str | None] = {}
        self._bar_cache: dict[tuple[Any, ...], tuple[str, list[dict[str, Any]] | None]] = {}
        self._tree_watch = TreeWatch()
        self._tree_error: str | None = None
        self._tree_lost = False
        self._tree_timed_out_at: float | None = None
        self._tree_restarted = False
        self._companion_down = False
        self.tree_failure: str | None = None
        self._last_tree_failure: str | None = None
        self._read_app = False
        self._overlay_tried = False
        self._last_readable_png: bytes | None = None
        self._last_readable_at = 0.0
        self._still_frame: tuple[bytes, float, Any] | None = None
        self._last_focused: Element | None = None
        self._focus_taps = 0
        self._focus_editing: bool | None = None

    # ---------- lifecycle ----------

    async def start(self, app_id: str, launch: bool = True) -> Screen:
        """Attach to a booted simulator, claim its lock, start idb_companion, and (with `launch`)
        launch `app_id` fresh. Returns the first screen. Raises `SessionError` with what to do."""
        if shutil.which("idb_companion") is None:
            raise SessionError("idb_companion not found on PATH. Install with: brew tap facebook/fb && brew install facebook/fb/idb-companion")
        try:
            sims = await asyncio.to_thread(ios_idb.booted_simulators)
        except Exception as e:  # noqa: BLE001
            raise SessionError(f"xcrun simctl could not list the booted simulators: {e}") from e
        candidates = pick_simulators(sims, device_name=self.device_name or None, udid=self._want_udid, any_device=self.any_device)
        stopped = None
        if not candidates and self.device_name and not self.any_device:
            stopped = await asyncio.to_thread(ios_idb.stopped_simulator, self.device_name)
            candidates = [stopped] if stopped else []
        if not candidates and not self.device_name and not self._want_udid and not sims:
            # Default with nothing booted: boot the default simulator, as the picker says.
            for name in DEFAULT_IOS_DEVICES:
                stopped = await asyncio.to_thread(ios_idb.stopped_simulator, name)
                if stopped:
                    candidates = [stopped]
                    break
        if not candidates:
            wanted = self._want_udid or self.device_name or " or ".join(DEFAULT_IOS_DEVICES)
            booted = ", ".join(s.name for s in sims) or "none"
            raise SessionError(f"no booted simulator named {wanted} (booted: {booted}). Boot it in Simulator.app; the session never creates one.")
        sim = None
        if self.claim_lock:
            for cand in candidates:
                lock = locks.claim(cand.name, is_booted=(lambda: True) if stopped else (lambda c=cand: ios_idb.is_booted(c.udid)))
                if lock is not None:
                    sim, self.lock = cand, lock
                    break
            if sim is None:
                held = ", ".join(f"{c.name} ({locks.lock_path(c.name)})" for c in candidates)
                raise DeviceBusy(f"every candidate simulator is in use by another agent: {held}. Wait for it, or name another booted device.",
                                 [c.name for c in candidates])
        else:
            sim = candidates[0]
        try:
            if stopped:
                self._stage(f"Starting {sim.name}")
                try:
                    await asyncio.to_thread(ios_idb.boot_simulator, sim.udid)
                except subprocess.SubprocessError as e:
                    raise SessionError(f"{sim.name} did not boot: {e}") from e
            await self._attach(sim, app_id, launch)
        except BaseException:
            if self.client is not None:
                try:
                    await self.client.cleanup()
                except Exception:  # noqa: BLE001
                    pass
            if self.lock is not None:
                self.lock.release()
                self.lock = None
            raise
        shot = await self._after_look(self.last_screen) if self.last_screen is not None else await self._capture(0)
        self._mark_seen(shot)
        return shot

    async def _attach(self, sim: ios_idb.Simulator, app_id: str, launch: bool) -> None:
        self.udid, self.device_name, self.runtime, self.app_id = sim.udid, sim.name, sim.runtime, app_id
        self.started_at = time.time()
        self._stage(f"Reading the apps on {sim.name}")
        try:
            self.apps = await asyncio.to_thread(ios_idb.installed_apps, sim.udid)
        except subprocess.TimeoutExpired as e:
            raise SessionError(f"{sim.name} took too long to answer. This Mac may be very busy; it is worth trying again.") from e
        except Exception as e:  # noqa: BLE001
            raise SessionError(f"could not list the apps on {sim.name}: {e}") from e
        if app_id not in {a.bundle_id for a in self.apps}:
            needle = app_id.lower()
            close = [a.bundle_id for a in self.apps if needle in a.bundle_id.lower() or needle in a.name.lower()]
            raise SessionError(f"{app_id} is not installed on {sim.name}. Close matches: {close or 'none'}")
        self.app_name = next((a.name for a in self.apps if a.bundle_id == app_id), app_id)
        self._stage(f"Connecting to {sim.name}")
        self.client = self._client_factory(sim.udid)
        if not await self.client.init_companion():
            raise SessionError(f"idb_companion failed to start for {sim.name}; try `idb_companion --udid {sim.udid}` by hand")
        self._stage(f"Getting {sim.name} ready to read the screen")
        note = started_note(await asyncio.to_thread(ios_idb.ensure_app_accessibility, sim.udid))
        if note:
            self.notes.append(note)
        if launch:
            self._stage(f"Opening {self.app_name}")
            await self.client.terminate(app_id)
            await self.client.launch(app_id)
        self._stage(f"Waiting for {self.app_name} to show its first screen")
        await self._wait_until_rendered()
        if launch:
            await self._require_readable()
            await self._require_full_screen()

    async def _require_readable(self) -> None:
        """Never start blind: an app the simulator reports nothing for is relaunched once with
        accessibility on; still unreadable, the session stops with the reason."""
        shot = self.last_screen
        if shot is None or not blind(shot.raw, shot.tree_available):
            return
        await asyncio.to_thread(ios_idb.ensure_app_accessibility, self.udid)
        await self.client.terminate(self.app_id)
        await self.client.launch(self.app_id)
        shot = await self._wait_until_rendered()
        if not blind(shot.raw, shot.tree_available):
            self.notes.append("the app came back with an empty screen tree; the session relaunched it once and can read it now")
            return
        app = next((a for a in self.apps if a.bundle_id == self.app_id), None)
        raise SessionError(blind_message(self.app_name, ios_idb.is_flutter_app(app.path if app else None), self._tree_error))

    async def _require_full_screen(self) -> None:
        """Never tap a windowed app (an iPhone-only app on an iPad): judged on the app's own
        window once it is in front."""
        shot = self.last_screen
        deadline = time.time() + 8.0
        while shot is not None and shot.foreground != self.app_id and time.time() < deadline:
            await poll_sleep(RENDER_POLL_S)
            shot = await self._capture(0)
        if shot is None or shot.foreground != self.app_id:
            return
        app = screen_size(shot.elements)
        try:
            desc = await asyncio.wait_for(self.client.describe(), timeout=10)
            dims = getattr(desc, "screen_dimensions", None)
            dev = (int(getattr(dims, "width_points", 0) or 0), int(getattr(dims, "height_points", 0) or 0))
        except Exception:  # noqa: BLE001 - no description: nothing to compare
            return
        if windowed(app, dev):
            raise SessionError(windowed_message(self.app_name, app, self.device_name))

    # ---------- what the session records about the device ----------

    async def app_version(self) -> str | None:
        """The installed app's version, `"1.4.0 (212)"` (its Info.plist), or None when unreadable."""
        def read() -> str | None:
            try:
                out = subprocess.run(["xcrun", "simctl", "get_app_container", self.udid, self.app_id, "app"],
                                     capture_output=True, text=True, timeout=SIMCTL_APP_TIMEOUT_S)
                if out.returncode != 0 or not out.stdout.strip():
                    return None
                plist = os.path.join(out.stdout.strip(), "Info.plist")
                got = [subprocess.run(["plutil", "-extract", k, "raw", "-o", "-", plist], capture_output=True, text=True, timeout=5)
                       for k in ("CFBundleShortVersionString", "CFBundleVersion")]
            except (OSError, subprocess.SubprocessError):
                return None
            short, build = [g.stdout.strip() if g.returncode == 0 else "" for g in got]
            return (f"{short} ({build})" if short and build and short != build else short or build) or None

        return await asyncio.to_thread(read)

    async def appearance_setting(self) -> str | None:
        """What the simulator is set to, `light` or `dark`; None when `simctl ui` cannot say."""
        def read() -> str | None:
            try:
                out = subprocess.run(["xcrun", "simctl", "ui", self.udid, "appearance"], capture_output=True, text=True, timeout=5)
            except (OSError, subprocess.SubprocessError):
                return None
            word = out.stdout.strip().lower() if out.returncode == 0 else ""
            return word if word in ("light", "dark") else None

        return await asyncio.to_thread(read)

    async def start_live(self, writer: Any, first_frame_s: float = 5.0) -> bool:
        """Stream the simulator screen into `writer` (a `live_frames.LiveFrameWriter`) from
        idb's video stream (`IdbClient.jpeg_frames`). False when no frame came within
        `first_frame_s` (an idb_companion without video streaming): the page then shows the
        frame of each step. A stream that breaks later (the companion was restarted)
        reconnects on its own."""
        if self._live_task is not None:
            return True
        first = asyncio.Event()

        async def pump() -> None:
            failures = 0
            while True:
                try:
                    async for frame in self.client.jpeg_frames(fps=LIVE_STREAM_FPS):
                        writer.offer(frame)
                        first.set()
                        failures = 0
                except asyncio.CancelledError:
                    raise
                except Exception as e:  # noqa: BLE001 - reconnect; the session goes on
                    failures += 1
                    if failures in (1, 10):
                        print(f"live stream: {type(e).__name__}: {e}", file=sys.stderr)
                # A reconnect backoff for the live stream, off the action path.
                await asyncio.sleep(min(5.0, 0.5 * failures + 0.5))

        self._live_task = asyncio.create_task(pump())
        try:
            await asyncio.wait_for(first.wait(), timeout=first_frame_s)
            return True
        except asyncio.TimeoutError:
            await self.stop_live()
            return False

    async def stop_live(self) -> None:
        task, self._live_task = self._live_task, None
        if task is None:
            return
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001 - teardown
            pass

    async def _teardown(self, terminate: bool) -> None:
        client, self.client = self.client, None
        if client is None:
            return
        if terminate and self.app_id:
            try:
                await asyncio.wait_for(client.terminate(self.app_id), timeout=10)
            except Exception:  # noqa: BLE001
                await asyncio.to_thread(ios_idb.terminate_app, self.udid, self.app_id, SIMCTL_APP_TIMEOUT_S)
        await client.cleanup()

    async def _ensure_alive(self) -> None:
        if self.client is None:
            raise SessionError("the session has ended; start a new one")
        proc = getattr(self.client, "companion_process", None)
        # After a restart that failed there is no process to look at: try again, or the session stays
        # dead for good over one hiccup (Snug Log, load 600: every later call failed on a healthy simulator).
        if self._companion_down or (proc is not None and proc.poll() is not None):
            await self.client.cleanup()
            self._companion_down = not await self.client.init_companion()
            if self._companion_down:
                raise SessionError("companion unavailable: idb_companion could not be restarted; the next action tries again")

    async def _idb(self, coro: Any, what: str, timeout: float = IDB_CALL_TIMEOUT_S) -> Any:
        """Await an idb call with a timeout; on timeout restart the companion and raise (a wedged
        companion would hang the tool call forever)."""
        try:
            return await asyncio.wait_for(coro, timeout=timeout)
        except asyncio.TimeoutError:
            restarted = False
            try:
                await self.client.cleanup()
                restarted = bool(await self.client.init_companion())
            except Exception:  # noqa: BLE001
                pass
            self._companion_down = not restarted
            state = "companion restarted" if restarted else "companion did not restart; the next action tries again"
            raise SessionError(f"idb {what} timed out after {int(timeout)}s; {state}") from None

    # ---------- perception ----------

    def _bundle_for(self, pid: int | None, name: str | None) -> str:
        path = self._process_path(pid) if pid else None
        if path:
            if "/SpringBoard.app/" in path:
                return SPRINGBOARD
            for a in self.apps:
                if a.path and path.startswith(a.path.rstrip("/") + "/"):
                    return a.bundle_id
        if name and name.strip():
            for a in self.apps:
                if a.name == name:
                    return a.bundle_id
            if name.lower() == "springboard":
                return SPRINGBOARD
        return f"unknown ({path or name or '?'})"

    def _process_path(self, pid: int) -> str | None:
        if pid not in self._pid_paths:
            self._pid_paths[pid] = ios_idb.process_path(pid)
        return self._pid_paths[pid]

    def _front_of(self, elements: list[Element]) -> str | None:
        name, pid = foreground_app(elements)
        if name is None and pid is None:
            return None
        bundle = self._bundle_for(pid, name)
        return None if bundle.startswith("unknown") else bundle

    def _app_label(self, bundle: str) -> str:
        if bundle == SPRINGBOARD:
            return "the home screen"
        return next((a.name for a in self.apps if a.bundle_id == bundle and a.name), bundle)

    def _blind_read(self) -> bool:
        since = self._tree_timed_out_at
        return since is not None and self._read_app and now() - since < BLIND_WINDOW_S

    async def _describe_all(self) -> list[dict] | None:
        """The flat tree, or None when it could not be read (the reason kept in `tree_failure`)."""
        for attempt in (1, 2):
            short = attempt == 1 and self._blind_read()
            timeout = min(BLIND_TREE_TIMEOUT_S, TREE_TIMEOUT_S) if short else TREE_TIMEOUT_S
            try:
                raw = await asyncio.wait_for(self.client.accessibility_tree(), timeout=timeout)
            except asyncio.TimeoutError:
                reason = "timeout"
                if not short:
                    self._tree_timed_out_at = now()
                    if attempt == 1 and await self._restart_companion():
                        continue  # a wedged companion answers again once restarted
            except Exception as e:  # noqa: BLE001 - the screenshot still stands
                reason = f"{type(e).__name__}: {e}"
            else:
                self._tree_error = self.tree_failure = None
                self._tree_timed_out_at = None
                return raw
            self._tree_error = f"timed out after {timeout:g} s" if reason == "timeout" else reason
            self.tree_failure = tree_failure(reason, timeout)
            if self.tree_failure != self._last_tree_failure:
                self._last_tree_failure = self.tree_failure
                log.warning("accessibility tree unavailable: %s", self.tree_failure)
            return None
        return None

    async def _restart_companion(self) -> bool:
        """Restart idb_companion once per session after a tree timeout."""
        if self._tree_restarted or getattr(self.client, "companion_process", None) is None:
            return False
        self._tree_restarted = True
        try:
            await self.client.cleanup()
            return bool(await self.client.init_companion())
        except Exception:  # noqa: BLE001
            return False

    async def _bar_items(self, bar: dict[str, Any]) -> list[dict[str, Any]] | None:
        """The items of a bar `describe-all` returned empty, read point by point with
        `describe-point` (what VoiceOver hit-tests). None when the bar could not be read."""
        frame = _frame(bar)
        if frame is None:
            return []
        items: list[dict[str, Any]] = []
        probes = 0
        for y in probe_rows(frame):
            x = frame[0] + STEP_PT / 2
            while x < frame[0] + frame[2] and probes < BAR_PROBE_MAX_POINTS:
                probes += 1
                try:
                    found = await asyncio.wait_for(self.client.describe_point(int(x), int(y), nested=False), timeout=BAR_PROBE_TIMEOUT_S)
                except Exception:  # noqa: BLE001 - a bar that cannot be read is marked, not fatal
                    found = None
                if found is None:
                    return items or None
                got = items_from_probe(bar, found)
                items.extend(got)
                right = x
                for g in got:
                    f = _frame(g)
                    if f and f[1] <= y <= f[1] + f[3]:
                        right = max(right, f[0] + f[2])
                x = max(x + STEP_PT, right + 1)
        return items

    async def _with_bars(self, raw: list[dict[str, Any]], *, fresh: bool) -> list[dict[str, Any]]:
        """`raw` with its opaque bars' items put back. A full capture reads a bar again whenever
        the screen changed; a settle poll reuses the last read of a bar with that frame."""
        bars = opaque_bars(raw)
        if not bars:
            return raw
        sig = tree_signature(raw)
        found: dict[int, list[dict[str, Any]]] = {}
        for bar in bars:
            key = bar_frame_key(bar)
            hit = self._bar_cache.get(key)
            if hit is not None and (not fresh or hit[0] == sig):
                items = hit[1]
            else:
                items = await self._bar_items(bar)
                self._bar_cache[key] = (sig, items)
            if items is None:
                bar["AXValue"] = BAR_UNREAD
            elif items:
                found[id(bar)] = items
        return merge_bars(raw, found) if found else raw

    async def _capture(self, settle_s: float = 0.0) -> Screen:
        await self._ensure_alive()
        deadline = time.time() + settle_s
        while True:
            # The frame the settle's signal just saw still, when there is one: the settled screen
            # then costs one tree read and no second screenshot.
            kept, self._still_frame = self._still_frame, None
            still = kept[0] if kept and now() - kept[1] < STILL_FRAME_MAX_AGE_S else None
            png, raw = await asyncio.gather(
                self._idb(self.client.screenshot(), "screenshot") if still is None else _ready(still),
                self._describe_all(),
            )
            if png is None:
                raise SessionError("screenshot failed")
            available = raw is not None
            if still is not None and raw is not None and kept is not None:
                png, raw = await self._frame_after_tree(still, raw, kept[2])
            raw = await self._with_bars(raw, fresh=True) if raw else []
            elements = parse_tree(raw)
            if len(elements) > 1 or not available or time.time() >= deadline:
                break
            await poll_sleep(EMPTY_TREE_RETRY_S)
        w, h = screen_size(elements)
        if w > 0 and h > 0:
            self.width, self.height = w, h
        lost = self._tree_watch.lost(raw, available)
        available = available and not lost
        self._tree_lost = lost or (available and dead_tree(raw))
        name, pid = foreground_app(elements)
        bundle = self._bundle_for(pid, name)
        if self._tree_lost:
            extra = LOST_NOTE
        elif not available:
            extra = unread_note(self.tree_failure or "the screen read failed")
        else:
            extra = ""
        shot = Screen(
            png=png, raw=raw, elements=elements, tree_hash=tree_hash(elements), size=(self.width, self.height),
            foreground=bundle, foreground_name=name or "unknown",
            locked_app_violation=self.lock_app and available and bundle != self.app_id,
            tree_available=available, extra=extra,
        )
        self.last_screen = shot
        if readable_app(shot, self.app_id):
            self._read_app = True
            self._last_readable_png = png
            self._last_readable_at = time.time()
            self._overlay_tried = False
        return shot

    async def _frame_after_tree(self, before: bytes, raw: list[dict], before_thumb: Any = None) -> tuple[bytes, list[dict]]:
        """`(frame, tree)` of one moment: one look once the tree is read; a look unlike the frame
        before means the screen moved while the tree was read, so the tree is read again."""
        prev = before_thumb if before_thumb is not None else await asyncio.to_thread(frame_thumb, before, MOTION_THUMB)
        for reads in range(1, FRAME_TREE_READS + 1):
            look = await self._idb(self.client.screenshot(), "screenshot")
            cur = await asyncio.to_thread(frame_thumb, look, MOTION_THUMB) if look else None
            if prev is None or cur is None:
                return (look or before), raw
            if not thumbs_differ(prev, cur) or reads == FRAME_TREE_READS:
                return look, raw
            again = await self._describe_all()
            if again is None:
                return look, raw
            raw, prev = again, cur
        return before, raw

    async def probe(self) -> Probe:
        """A settle poll: the tree only; the frame only when the tree cannot describe the screen."""
        await self._ensure_alive()
        raw = await self._describe_all()
        available = raw is not None
        elements = parse_tree(await self._with_bars(raw, fresh=False) if raw else [])
        png = None
        if needs_pixels(elements, available):
            png = await self._idb(self.client.screenshot(), "screenshot")
        return Probe(elements=elements, tree_available=available, png=png)

    def change_signal(self, after: str) -> Any:
        return FrameSignal(self, getattr(self.last_screen, "png", None))

    # ---------- actions ----------

    async def _tap(self, target: Target, long_press_ms: int | None) -> str:
        await self._ensure_alive()
        kind = "long_press" if long_press_ms else "tap"
        shot = self.last_screen or await self._capture(0)
        elements = shot.elements
        point, how = resolve(target, elements)
        if point is None:
            return f"tap failed: {how}"
        seen = chosen(target, elements)
        if not long_press_ms:
            point, how = aim(seen, point, how, elements)
        if seen is not None and off_screen(point, self.width, self.height):
            point, how = into_view(seen, point, how, self.width, self.height)
        away = off_screen(point, self.width, self.height)
        if away:
            return f"error: {away}"
        over = covered(target, elements, point)
        if over:
            return f"error: target is covered by {over}"
        gone = await self._app_left(point, kind)
        if gone:
            return f"error: {gone}"
        error = await self._send_tap(point, long_press_ms)
        if error:
            return f"tap failed: {error}"
        verb = f"long-pressed {long_press_ms}ms" if long_press_ms else "tapped"
        return f"{verb} at {point} via {how}"

    async def _send_tap(self, point: tuple[int, int], long_press_ms: int | None = None) -> str | None:
        """Touch `point`: a plain tap holds `TAP_HOLD_S` (an instant one does not flip a SwiftUI
        switch), a long press its own length."""
        duration = long_press_ms / 1000 if long_press_ms else ios_idb.TAP_HOLD_S
        if not await self._idb(self.client.tap(point[0], point[1], duration=duration), "tap"):
            return f"idb could not tap at {point}"
        return None

    async def _app_left(self, point: tuple[int, int], kind: str) -> str | None:
        """None when an input at `point` may go; else what the agent is told (nothing was sent,
        and with `lock_app` the app was brought back). Not while the screen cannot be read."""
        if self._blind() or self._tree_lost:
            return None
        seen = self.seen_foreground or self.app_id
        if not left(await self._owner_at(point), self.app_id, seen):
            return None
        # The hit test can name SpringBoard for its own chrome over the app (the status bar).
        raw = await self._describe_all()
        elements = parse_tree(raw) if raw else []
        front = self._front_of(elements)
        if not left(front, self.app_id, seen):
            return None
        alert = front == SPRINGBOARD and dialog_of(front, elements) is not None
        brought, still = None, None
        if self.lock_app and not alert:
            try:
                await self._idb(self.client.launch(self.app_id), "launch", APP_LAUNCH_TIMEOUT_S)
                now_front = await self._wait_front(APP_BACK_WAIT_S)
            except Exception:  # noqa: BLE001 - the agent is told it is not back
                now_front = None
            brought, still = now_front == self.app_id, self._app_label(now_front) if now_front else None
        line = refusal(self.app_name or self.app_id, "a system alert" if alert else self._app_label(front or "?"), kind,
                       brought_back=brought, still=still)
        print(f"orcha qa: {line}", file=sys.stderr, flush=True)
        return line

    async def _owner_at(self, point: tuple[int, int]) -> str | None:
        """The app a touch at `point` reaches (idb's hit test names its process); None when it
        cannot tell."""
        try:
            found = await asyncio.wait_for(self.client.describe_point(point[0], point[1], nested=False), timeout=FRONT_CHECK_TIMEOUT_S)
        except Exception:  # noqa: BLE001 - the tap goes as it always did
            return None
        node = next((n for n in (found if isinstance(found, list) else [found]) if isinstance(n, dict) and n.get("pid")), None)
        try:
            bundle = self._bundle_for(int(node["pid"]), None) if node is not None else None
        except (TypeError, ValueError):
            return None
        return None if bundle is None or bundle.startswith("unknown") else bundle

    async def _wait_front(self, within: float) -> str | None:
        deadline = now() + within
        while True:
            raw = await self._describe_all()
            front = self._front_of(parse_tree(raw)) if raw else None
            if front == self.app_id or now() >= deadline:
                return front
            await poll_sleep(RENDER_POLL_S)

    async def _swipe_points(self, x1: int, y1: int, x2: int, y2: int, duration_ms: int) -> str:
        await self._ensure_alive()
        if not await self._idb(self.client.swipe(x1, y1, x2, y2, duration=duration_ms / 1000), "swipe"):
            return f"swipe failed: idb could not swipe ({x1},{y1})->({x2},{y2})"
        return f"swiped ({x1},{y1})->({x2},{y2}) in {duration_ms}ms"

    async def _press(self, key: str) -> str:
        await self._ensure_alive()
        if key == "enter":
            ok = await self._idb(self.client.key(KEY_ENTER), "key")
        elif key in BUTTONS:
            ok = await self._idb(self.client.button(BUTTONS[key]), "button")
        elif key == "back":
            return await self._back()
        else:
            return "error: key must be one of back, enter, home, lock, siri, side"
        return f"pressed {key}" if ok else f"press failed: idb could not press {key}"

    async def _back(self) -> str:
        """iOS has no back key: tap the navigation bar's back control, else swipe from the
        leading edge (the interactive pop gesture)."""
        shot = self.last_screen or await self._capture(0)
        btn = back_button(shot.elements, self.width, self.height)
        if btn is not None:
            error = await self._send_tap(btn.center)
            if error:
                return f"press failed: {error}"
            return f"pressed back: tapped {describe(btn)} at {btn.center} (iOS has no back key)"
        w, h = self.width or 402, self.height or 874
        y = int(h * 0.45)
        if not await self._idb(self.client.swipe(1, y, int(w * 0.75), y, duration=0.3), "swipe"):
            return "press failed: idb could not swipe from the left edge"
        return "pressed back: swiped from the left edge (iOS has no back key and no back button was on screen)"

    async def _open_url(self, url: str) -> str:
        await self._ensure_alive()
        if not await self._idb(self.client.open_url(url), "open_url"):
            return f"open_url failed: idb could not open {url}"
        return f"opened {url}"

    async def _launch(self, app_id: str) -> str:
        await self._ensure_alive()
        mine = app_id == self.app_id
        relaunch = False
        if mine:
            turned = await asyncio.to_thread(ios_idb.ensure_app_accessibility, self.udid, AX_SETTING_TIMEOUT_S)
            if self._wedged():
                ok = await self._restart_app()
                return (f"launched {app_id} (its screen could not be read, so the session stopped the app and started it again)"
                        if ok else f"error: could not launch {app_id}: simctl did not start it")
            # A running app keeps the accessibility it launched with: restarted when a key was just
            # turned on or its tree is lost.
            relaunch = bool(turned) or self._tree_lost
            if relaunch:
                await self._idb(self.client.terminate(app_id), "terminate", APP_LAUNCH_TIMEOUT_S)
        if not await self._idb(self.client.launch(app_id), "launch", APP_LAUNCH_TIMEOUT_S):
            return f"launch failed: idb could not launch {app_id}"
        return f"launched {app_id}" + (" (restarted with accessibility on: its screen could not be read)" if relaunch else "")

    async def _terminate(self, app_id: str) -> str:
        await self._ensure_alive()
        if app_id == self.app_id and self._wedged():
            ok = await asyncio.to_thread(ios_idb.terminate_app, self.udid, app_id, SIMCTL_APP_TIMEOUT_S)
            await self._fresh_companion()
            return f"terminated {app_id}" if ok else f"error: could not terminate {app_id}: simctl did not stop it"
        if not await self._idb(self.client.terminate(app_id), "terminate", APP_LAUNCH_TIMEOUT_S):
            return f"terminate failed: idb could not terminate {app_id}"
        return f"terminated {app_id}"

    # ---------- a system sheet the session cannot read ----------

    def _blind(self) -> bool:
        return self._read_app and unreadable(self.last_screen)

    def _wedged(self) -> bool:
        """The screen is unreadable and idb is stuck on it (a read timed out, or a sheet could not
        be cleared): idb's launch and terminate hang then, so they go through simctl."""
        return self._blind() and ("timed out" in (self.tree_failure or "") or self._overlay_tried)

    async def _fresh_companion(self) -> bool:
        self._tree_timed_out_at = None
        try:
            await asyncio.wait_for(self.client.cleanup(), timeout=COMPANION_RESTART_TIMEOUT_S)
            return bool(await asyncio.wait_for(self.client.init_companion(), timeout=COMPANION_RESTART_TIMEOUT_S))
        except Exception:  # noqa: BLE001
            return False

    async def _restart_app(self) -> bool:
        await asyncio.to_thread(ios_idb.terminate_app, self.udid, self.app_id, SIMCTL_APP_TIMEOUT_S)
        await self._fresh_companion()
        return await asyncio.to_thread(ios_idb.launch_app, self.udid, self.app_id, SIMCTL_APP_TIMEOUT_S, list(getattr(self.client, "launch_args", None) or []))

    def _last_action_label(self) -> tuple[Any, str]:
        for step in reversed(self.steps):
            if step.kind in OVERLAY_OPENERS and step.args.get("source") != "harness":
                target = step.args.get("target") or {}
                return step, str(target.get("text") or step.args.get("element") or "")
        return None, ""

    async def _clear_system_overlay(self, shot: Screen) -> str | None:
        """A system sheet over the app idb cannot read (the share sheet): swipe it down, and when
        the screen is still unreadable stop the app with simctl and launch it again. Returns what
        the agent is told, or None when `shot` is no such sheet. Never raises."""
        if not unreadable(shot) or not self._read_app or self._overlay_tried:
            return None
        action, label = self._last_action_label()
        since = time.time() - (self._last_readable_at or time.time()) + 2.0
        try:
            services = await asyncio.to_thread(overlay_services, self.udid, since) or []
        except Exception:  # noqa: BLE001
            services = []
        if not (scrim_only(shot) or services or names_share(label)):
            return None
        self._overlay_tried = True
        name = overlay_name(services, label)
        how, drawn = "failed", True
        try:
            before, png = self._last_readable_png, shot.png
            drawn = not (before and png and frames_look_same(before, png))
            if drawn:
                w, h = self.width or 402, self.height or 874
                await self._idb(self.client.swipe(w // 2, int(h * 0.62), w // 2, int(h * 0.98), duration=0.3), "swipe")
                if "timed out" in (self.tree_failure or ""):
                    await self._fresh_companion()
                if await self._read_until_readable(READABLE_AFTER_SWIPE_S):
                    how = "swipe"
            if how != "swipe":
                await asyncio.to_thread(ios_idb.ensure_app_accessibility, self.udid, AX_SETTING_TIMEOUT_S)
                if await self._restart_app() and await self._read_until_readable(READABLE_AFTER_LAUNCH_S):
                    how = "relaunch"
        except Exception as e:  # noqa: BLE001 - the agent is told it is still unreadable
            log.warning("clearing a system sheet failed: %s: %s", type(e).__name__, e)
        line = f"could not read {name} and " + {
            "swipe": "closed it with a swipe down", "relaunch": f"restarted {self.app_name}", "failed": "could not close it",
        }[how]
        self._record("wait", {"ms": 0, "source": "harness", HARNESS_KEY: name, "dismissed": how,
                              **({"opened_at": action.seq} if action is not None else {})}, line)
        return dismissed_note(name, how, self.app_name, drawn)

    async def _read_until_readable(self, timeout_s: float) -> bool:
        deadline = now() + timeout_s
        while True:
            if not unreadable(await self._capture(0)):
                return True
            if now() >= deadline:
                return False
            await poll_sleep(RENDER_POLL_S)

    # ---------- text ----------

    def _refind_field(self, target: Target, before: Element | None, elements: list[Element]) -> Element | None:
        if target.id:
            for e in elements:
                if e.identifier == target.id:
                    return e
        if before is None and not target.has_locator:
            # No locator: the keys went to the field this session focused last.
            before = self._last_focused
        if before is not None:
            # The same field by its identity first: a keyboard sliding in scrolls the form.
            if before.identifier:
                for e in elements:
                    if e.identifier == before.identifier and e.type in TEXT_TYPES:
                        return e
            if before.label:
                same = [e for e in elements if e.type == before.type and e.label == before.label]
                if len(same) == 1:
                    return same[0]
            best, best_overlap = None, 0
            for e in elements:
                if e.type not in TEXT_TYPES:
                    continue
                ox = max(0, min(e.x2, before.x2) - max(e.x1, before.x1))
                oy = max(0, min(e.y2, before.y2) - max(e.y1, before.y1))
                if ox * oy > best_overlap:
                    best, best_overlap = e, ox * oy
            if best is None:
                best = refind(before, elements)
                if best is None:
                    same = [e for e in elements if e.type == before.type]
                    best = same[0] if len(same) == 1 else None
            return best
        return next((e for e in elements if e.type in TEXT_TYPES), None)

    def _field_at(self, point: tuple[int, int], elements: list[Element]) -> Element | None:
        hits = [e for e in elements if e.x1 <= point[0] <= e.x2 and e.y1 <= point[1] <= e.y2 and e.type in TEXT_TYPES]
        return min(hits, key=lambda e: (e.x2 - e.x1) * (e.y2 - e.y1)) if hits else None

    async def _focus(self, target: Target, kind: str = "type") -> tuple[Element | None, str | None]:
        shot = self.last_screen or await self._capture(0)
        elements = shot.elements
        if not target.has_locator:
            # Assumed focused already, but the keys go to whatever is in front.
            last = self._last_focused
            return None, await self._app_left(last.center if last else (self.width // 2, self.height // 2), kind)
        point, how = resolve(target, elements)
        if point is None:
            return None, how
        elem = self._field_at(point, elements)
        if elem is not None:
            point = elem.center  # a plain centre tap; edge taps hit clear/dictate buttons
        away = off_screen(point, self.width, self.height, what="field")
        if away:
            return None, away
        gone = await self._app_left(point, kind)
        if gone:
            return None, gone
        for taps in range(1, FOCUS_TAPS + 1):
            self._focus_taps = taps
            before_shot = self.last_screen
            before = shape_of(before_shot) if before_shot else None
            await self._send_tap(point)
            await settle(self, after="focus", before_shape=before)
            cur = self._refind_field(target, elem, self.last_screen.elements) if elem is not None and self.last_screen else None
            self._focus_editing = editing(cur)
            if self._focus_editing is not False or opened(before_shot, self.last_screen) or cur is None or off_screen(cur.center, self.width, self.height):
                break
            # The field says it is not being edited and the tap opened nothing: the app took focus
            # straight back. Again, where the field is now (the keyboard moves it).
            point = cur.center
        self._last_focused = elem
        return elem, None

    async def _value_at(self, point: tuple[int, int]) -> str | None:
        """The accessibility value of whatever sits at `point` (even when the tree hides it)."""
        try:
            info = await asyncio.wait_for(self.client.describe_point(point[0], point[1]), timeout=10)
        except Exception:  # noqa: BLE001
            return None
        if not isinstance(info, dict):
            return None
        val = info.get("AXValue") or info.get("value")
        return str(val) if val not in (None, "") else ""

    async def _type_text(self, target: Target, text: str) -> str:
        await self._ensure_alive()
        presses, missing = text_events(text)
        if missing:
            return (f"type failed: the simulator's keyboard has no key for {''.join(missing)!r} (emoji and letters "
                    "of other scripts cannot be typed on an iOS simulator; Latin accents can); nothing was typed")
        before_hash = self.last_screen.tree_hash if self.last_screen else None
        self._focus_editing, self._focus_taps = None, 0
        before, err = await self._focus(target)
        if err:
            return f"type failed: {err}"
        typed_on = shape_of(self.last_screen) if self.last_screen else None
        sent = await self._idb(self.client.text(text) if text.isascii() else self.client.keys(presses), "text")
        if sent is False:
            return "type failed: the simulator did not take the key presses"
        await settle(self, after="type", before_shape=typed_on)
        after_screen = self.last_screen
        assert after_screen is not None
        after_screen.settled = self.last_settled
        elem = self._refind_field(target, before, after_screen.elements)
        if elem is not None and elem.type == "SecureTextField":
            return f"typed {text!r} into secure field; verified: unknown (masked)"
        value = elem.value if elem is not None else None
        if value is None and before is not None:
            value = await self._value_at(before.center)
        if value is not None:
            # iOS may auto-capitalise, and swaps in smart quotes and dashes as you type.
            ok = plain(value).lower().endswith(plain(text).lower())
            taps, editing_now = self._focus_taps, self._focus_editing
            if ok:
                why = (f"; the field took the keyboard only at tap {taps}: after each tap before, iOS did not report it as being edited"
                       if editing_now and taps > 1 else "")
            else:
                why = _not_typed(before, value, editing_now, taps)
            return f"typed {text!r}; verified: {str(ok).lower()}; field value now {value!r}{why}"
        changed = before_hash is not None and after_screen.tree_hash != before_hash
        hint = "screen changed after typing, check the screenshot" if changed else "screen unchanged"
        return f"typed {text!r}; verified: unknown (field not readable; {hint})"

    async def _clear_text(self, target: Target) -> str:
        await self._ensure_alive()
        before, err = await self._focus(target, "clear")
        if err:
            return f"clear failed: {err}"
        typed_on = shape_of(self.last_screen) if self.last_screen else None
        n = len(before.value) if before and before.value else 50
        for _ in range(n):
            await self._idb(self.client.key(KEY_DELETE), "key")
        await settle(self, after="clear", before_shape=typed_on)
        after_screen = self.last_screen
        assert after_screen is not None
        after_screen.settled = self.last_settled
        after = self._refind_field(target, before, after_screen.elements)
        value = after.value if after else "?"
        cleared = after is not None and (
            after.value == "" or (before is not None and after.value != before.value and len(after.value) < len(before.value))
        )
        return f"sent {n} deletes; cleared: {str(cleared).lower()}; field value now {value!r}"


def _not_typed(before: Element | None, value: str, editing_now: bool | None, taps: int = 1) -> str:
    """Why a typed text is not in the field, when the session can tell."""
    if editing_now is False:
        n = f"{taps} taps" if taps > 1 else "the tap"
        return (f"; nothing was typed into it: after {n} iOS did not report the field as being edited "
                "(it never took the keyboard), so the keys went to whatever the app keeps focus on")
    if before is not None and value == before.value:
        return "; nothing reached the field: its value is what it was before typing"
    return ""
