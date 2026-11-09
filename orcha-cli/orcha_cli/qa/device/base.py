"""The device session every QA tool drives: the `DeviceSession` protocol and `SessionBase`, the
action pipeline the iOS and Android sessions share.

Adapted from `sessions/protocol.py` (the protocol) and the action path of the original MCP
server (`server._guarded_action`, `_settle_after_action`, `_look`, `_permission_check`,
`_stale_index`), which in Orcha belongs to the device layer so the MCP server stays thin.

How an action goes (`SessionBase._act`):

1. a ref (`e12`) that names another element now than on the screen the agent last saw is
   refused (`error: ref e12 was ...`): the agent looks again instead of tapping the wrong row;
2. after a tap the settle called dead, a permission dialog the app opened late is answered first;
3. the platform sends the input and returns its result text (`error: ...` / `... failed` on
   failure, then nothing else happens and `last_screen` stays the screen the decision was taken
   on);
4. the shared settle waits for the screen to react and hold still (`screen.settle`);
5. the settled screen is checked for a system sheet the session cannot read (iOS) and a
   permission dialog (answered when `auto_allow_permissions`), each told in `Screen.notes`;
6. an action that changed nothing gets a `screen_unchanged:` note;
7. the settled screen is `last_screen` (with `settled` set): show `last_screen.text()` after the
   result, as the original tools do, so the agent does not spend a turn on `screen()`.

Every action is reported to `on_step(Step)` (when given) and kept in `steps`; Orcha's MCP server
records them through the portal. the original run folders, evidence and recorder are not ported.
"""

from __future__ import annotations

import re
import sys
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

from orcha_cli.qa.device.screen import (
    RENDER_POLL_S,
    Dialog,
    Probe,
    Screen,
    action_failed,
    dialog_of,
    poll_sleep,
    settle,
    shape_of,
    unchanged_after,
    unchanged_note,
    wait_for,
)
from orcha_cli.qa.device.targets import Target, chosen, describe, identity, nearest, parse_target
from orcha_cli.qa.device.tree import find as find_elements
from orcha_cli.qa.device.tree import visible_elements

#: Default devices, in the order a session tries them (the machine keeps exactly these).
DEFAULT_IOS_DEVICES = ("iPhone 17 Pro", "iPad Pro 13-inch (M5)")

#: Actions after which the screen settles (the action's own kind is the settle's `after`).
SETTLES = frozenset({"tap", "long_press", "swipe", "press", "open_url", "launch", "terminate", "type", "clear"})
#: Actions whose platform method settles inside itself (typing reads the value back).
SELF_SETTLED = frozenset({"type", "clear"})
#: Permission dialogs answered in a row on one look (an app that asks for two at once).
PERMISSION_DIALOGS_PER_LOOK = 3
#: A dialog's window slides in: its allow button is read again until it holds still.
DIALOG_STEADY_POLL_S = 0.15
DIALOG_STEADY_READS = 10

TargetLike = Any  # a `Target`, a ref string ("e12"), a text, "x,y", a dict, or None


class SessionError(Exception):
    """A failure that ends the call (no device, the app not installed, the device link gone).
    Tools turn it into `error: <message>`."""


class DeviceBusy(SessionError):
    """Every device this run could use is held. Not a failure: the tool server waits in line.
    `devices`: the names it could take."""

    def __init__(self, message: str, devices: list[str]) -> None:
        super().__init__(message)
        self.devices = devices


@dataclass
class Step:
    """One action as the session reports it to `on_step`. `kind`: tap | long_press | type |
    clear | swipe | press | open_url | launch | terminate | wait (a harness step, such as a
    permission dialog the session answered, is a `wait` with `args.source == "harness"`).
    `screen_hash`/`foreground` are of the screen the action was taken on."""

    seq: int
    kind: str
    args: dict[str, Any]
    result: str
    screen_hash: str | None
    foreground: str | None
    at: float = field(default_factory=time.time)

    @property
    def failed(self) -> bool:
        return action_failed(self.result)


class DeviceSession(Protocol):
    """What the QA tools need from a device. `IosSession` and `AndroidSession` satisfy it.

    Targets (`target`) are what `targets.parse_target` reads: a ref from the last screen
    (`"e12"`), `"id=..."`, a text, `"x,y"`, a dict, a `Target`, or None (the focused field).
    Every action returns its result text; failures start with `error:` or contain `failed`.
    After a successful action `last_screen` is the settled screen."""

    platform: str  # "ios" | "android"
    device_name: str
    udid: str  # simulator udid / adb serial
    app_id: str  # bundle id / package
    app_name: str
    width: int
    height: int
    last_screen: Screen | None
    last_settled: str | None
    steps: list[Step]
    notes: list[str]
    on_step: Callable[[Step], Any] | None

    async def start(self, app_id: str, launch: bool = True) -> Screen: ...
    async def end(self, terminate: bool = True) -> dict[str, Any]: ...
    async def start_live(self, writer: Any) -> bool: ...
    async def stop_live(self) -> None: ...
    async def screen(self, settle_s: float = 2.0) -> Screen: ...
    async def tap(self, target: TargetLike, long_press_ms: int | None = None) -> str: ...
    async def type_text(self, target: TargetLike, text: str) -> str: ...
    async def clear_text(self, target: TargetLike) -> str: ...
    async def swipe(self, direction: str, distance_percent: int = 50, duration_ms: int = 400) -> str: ...
    async def swipe_coords(self, x1: int, y1: int, x2: int, y2: int, duration_ms: int = 400) -> str: ...
    async def press(self, key: str) -> str: ...
    async def open_url(self, url: str) -> str: ...
    async def launch_app(self, app_id: str | None = None) -> str: ...
    async def terminate_app(self, app_id: str | None = None) -> str: ...
    async def wait(self, ms: int, until_text: str | None = None, gone_text: str | None = None) -> str: ...
    async def find(self, text: str, role: str | None = None) -> str: ...


class SessionBase:
    """The action pipeline shared by `IosSession` and `AndroidSession`. A platform implements
    `start`, `_capture`, `probe`, `_tap`, `_send_tap`, `_swipe_points`, `_press`, `_open_url`,
    `_launch`, `_terminate`, `_type_text`, `_clear_text`, `_teardown`, and optionally
    `change_signal` and `_clear_system_overlay`."""

    platform = ""

    def _stage(self, text: str) -> None:
        if self.on_stage:
            self.on_stage(text)

    def __init__(
        self,
        *,
        device_name: str | None = None,
        lock_app: bool = True,
        auto_allow_permissions: bool = True,
        claim_lock: bool = True,
        on_step: Callable[[Step], Any] | None = None,
    ) -> None:
        self.device_name = device_name or ""
        self.udid = ""
        self.app_id = ""
        self.app_name = ""
        self.lock_app = lock_app
        self.auto_allow_permissions = auto_allow_permissions
        self.claim_lock = claim_lock
        self.on_step = on_step
        #: Told each stage of `start` in plain words: opening a device on a busy Mac can take minutes.
        self.on_stage: Callable[[str], Any] | None = None
        self.width = 0
        self.height = 0
        self.last_screen: Screen | None = None
        self.last_settled: str | None = None
        self.last_settle_timing: dict[str, Any] | None = None
        self.steps: list[Step] = []
        self.notes: list[str] = []
        self.started_at = 0.0
        self.lock: Any = None
        #: The app in front on the screen the agent last saw (an input to another app the agent
        #: did not see come up is refused, `_app_left`).
        self.seen_foreground: str | None = None
        self._shown: dict[int, str] | None = None
        self._dead_tap_pending = False

    # ---------- what a platform implements ----------

    async def start(self, app_id: str, launch: bool = True) -> Screen:
        raise NotImplementedError

    async def _capture(self, settle_s: float = 0.0) -> Screen:
        """A full read (frame + tree) that sets `last_screen`; retried for up to `settle_s` while
        the tree is empty (mid-transition)."""
        raise NotImplementedError

    async def probe(self) -> Probe:
        raise NotImplementedError

    async def _tap(self, target: Target, long_press_ms: int | None) -> str:
        raise NotImplementedError

    async def _send_tap(self, point: tuple[int, int], long_press_ms: int | None = None) -> str | None:
        raise NotImplementedError

    async def _swipe_points(self, x1: int, y1: int, x2: int, y2: int, duration_ms: int) -> str:
        raise NotImplementedError

    async def _press(self, key: str) -> str:
        raise NotImplementedError

    async def _open_url(self, url: str) -> str:
        raise NotImplementedError

    async def _launch(self, app_id: str) -> str:
        raise NotImplementedError

    async def _terminate(self, app_id: str) -> str:
        raise NotImplementedError

    async def _type_text(self, target: Target, text: str) -> str:
        raise NotImplementedError

    async def _clear_text(self, target: Target) -> str:
        raise NotImplementedError

    async def _teardown(self, terminate: bool) -> None:
        raise NotImplementedError

    async def _clear_system_overlay(self, shot: Screen) -> str | None:
        """A system sheet over the app the session cannot read: close it and say what was done
        (iOS). None when there is none."""
        return None

    # ---------- reads ----------

    async def start_live(self, writer: Any) -> bool:
        """Stream the screen into `writer` (`live_frames.LiveFrameWriter`). False when this
        device has no stream: the page then follows the frames each step uploads."""
        return False

    async def stop_live(self) -> None:
        """Stop what `start_live` started. Safe to call when nothing runs."""

    async def snapshot(self) -> Screen:
        """A full capture that the agent does not see (settle polls, dialog checks)."""
        return await self._capture(0)

    async def screen(self, settle_s: float = 2.0) -> Screen:
        """Look: a full capture (retried for up to `settle_s` while the tree is empty), with a
        system sheet or a permission dialog over the app handled first and told in `notes`."""
        shot = await self._capture(settle_s)
        shot = await self._after_look(shot)
        self._mark_seen(shot)
        return shot

    async def find(self, text: str, role: str | None = None) -> str:
        """The elements of the last screen whose label, value or id contains `text`."""
        shot = self.last_screen or await self.screen()
        hits = find_elements(shot.elements, text, role)
        return "\n".join(e.compact_line() for e in hits) or f"no element matches {text!r}"

    async def wait(self, ms: int, until_text: str | None = None, gone_text: str | None = None) -> str:
        """Wait for the screen to change and hold still (at most `ms`), or for `until_text` to
        show / `gone_text` to go away. `last_screen` is the screen after it."""
        if self.last_screen is None:
            await self._capture(0)
        args: dict[str, Any] = {"ms": ms, **({"until_text": until_text} if until_text else {}), **({"gone_text": gone_text} if gone_text else {})}
        pre = self.last_screen
        met, waited, what = await wait_for(self, ms=ms, until_text=until_text, gone_text=gone_text)
        result = f"waited {waited}ms: {what}"
        self._record("wait", args, result, on=pre)
        shot = self.last_screen
        assert shot is not None
        if not until_text and not gone_text:
            shot.settled = self.last_settled
        shot = await self._after_look(shot)
        self._mark_seen(shot)
        return result

    # ---------- actions ----------

    async def tap(self, target: TargetLike, long_press_ms: int | None = None) -> str:
        t = parse_target(target)
        kind = "long_press" if long_press_ms else "tap"
        args: dict[str, Any] = {"target": t.to_dict(), **({"duration_ms": long_press_ms} if long_press_ms else {})}
        return await self._act(kind, args, lambda: self._tap(t, long_press_ms), target=t)

    async def type_text(self, target: TargetLike, text: str) -> str:
        t = parse_target(target)
        refused = input_refusal(text)
        if refused:
            # Realistic input only, on every platform: never a security payload.
            return refused
        return await self._act("type", {"target": t.to_dict(), "text": text}, lambda: self._type_text(t, text), target=t)

    async def clear_text(self, target: TargetLike) -> str:
        t = parse_target(target)
        return await self._act("clear", {"target": t.to_dict()}, lambda: self._clear_text(t), target=t)

    async def swipe(self, direction: str, distance_percent: int = 50, duration_ms: int = 400) -> str:
        """Swipe from the screen's middle: `up` scrolls the content down (shows what is below)."""
        args = {"direction": direction, "distance_percent": distance_percent, "duration_ms": duration_ms}

        async def go() -> str:
            if self.width <= 0 or self.height <= 0:
                await self._capture(0)
            cx, cy = self.width // 2, self.height // 2
            dx = self.width * distance_percent // 200
            dy = self.height * distance_percent // 200
            ends = {
                "up": ((cx, cy + dy), (cx, cy - dy)),
                "down": ((cx, cy - dy), (cx, cy + dy)),
                "left": ((cx + dx, cy), (cx - dx, cy)),
                "right": ((cx - dx, cy), (cx + dx, cy)),
            }
            if direction not in ends:
                return f"error: direction must be one of {sorted(ends)}"
            (x1, y1), (x2, y2) = ends[direction]
            return await self._swipe_points(x1, y1, x2, y2, duration_ms)

        return await self._act("swipe", args, go)

    async def swipe_coords(self, x1: int, y1: int, x2: int, y2: int, duration_ms: int = 400) -> str:
        args = {"x1": x1, "y1": y1, "x2": x2, "y2": y2, "duration_ms": duration_ms}
        return await self._act("swipe", args, lambda: self._swipe_points(int(x1), int(y1), int(x2), int(y2), duration_ms))

    async def press(self, key: str) -> str:
        """A hardware/system key: `home`, `back`, `enter` on both; iOS also `lock`, `siri`,
        `side`; Android also `recent`."""
        k = str(key).strip().lower()
        return await self._act("press", {"key": k}, lambda: self._press(k))

    async def open_url(self, url: str) -> str:
        return await self._act("open_url", {"url": url}, lambda: self._open_url(url))

    async def launch_app(self, app_id: str | None = None) -> str:
        app = app_id or self.app_id
        return await self._act("launch", {"app_id": app}, lambda: self._launch(app))

    async def terminate_app(self, app_id: str | None = None) -> str:
        app = app_id or self.app_id
        return await self._act("terminate", {"app_id": app}, lambda: self._terminate(app))

    async def end(self, terminate: bool = True) -> dict[str, Any]:
        """Stop the session: the app is stopped (`terminate`), the device link closed and the
        device lock released. Safe to call twice."""
        try:
            await self.stop_live()
            await self._teardown(terminate)
        finally:
            if self.lock is not None:
                self.lock.release()
                self.lock = None
        return {
            "platform": self.platform,
            "device_name": self.device_name,
            "udid": self.udid,
            "app_id": self.app_id,
            "steps": len(self.steps),
            "duration_s": round(time.time() - self.started_at, 1) if self.started_at else 0.0,
        }

    async def __aenter__(self) -> SessionBase:
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.end()

    # ---------- the pipeline ----------

    async def _act(self, kind: str, args: dict[str, Any], fn: Callable[[], Awaitable[str]], *, target: Target | None = None) -> str:
        if self.last_screen is None:
            await self.screen()
        stale = self._stale_ref(target)
        if stale:
            return stale
        late = await self._permission_before_action() if self._dead_tap_pending else None
        pre = self.last_screen
        picked = chosen(target, pre.elements) if target is not None and pre is not None else None
        if picked is not None:
            args = {**args, "element": describe(picked)}
        result = await fn()
        if "no element matched" in result and target is not None and pre is not None:
            near = nearest(target.text or target.id or "", pre.elements)
            if near:
                result += "\nnearest:\n" + "\n".join(e.compact_line() for e in near)
        self._record(kind, args, result, on=pre)
        if action_failed(result) or kind not in SETTLES:
            self._dead_tap_pending = False
            return f"{late}\n{result}" if late else result
        if kind not in SELF_SETTLED:
            try:
                await settle(self, after=kind, before_shape=shape_of(pre) if pre is not None else None)
            except SessionError:
                raise
            except Exception as e:  # noqa: BLE001 - a settle that cannot capture leaves the action as it was
                print(f"orcha qa: settle after {kind} failed: {type(e).__name__}: {e}", file=sys.stderr)
        shot = self.last_screen
        assert shot is not None
        shot.settled = self.last_settled
        shot = await self._after_look(shot)
        if unchanged_after(kind, result, pre, shot, args):
            shot.notes.append(unchanged_note(kind, args))
        self._mark_seen(shot)
        # A dialog the app opens late (a permission request after a tap the settle called dead)
        # is looked for before the next action.
        self._dead_tap_pending = kind in ("tap", "long_press") and self.last_settled == "unchanged"
        return f"{late}\n{result}" if late else result

    def _record(self, kind: str, args: dict[str, Any], result: str, *, on: Screen | None = None) -> str:
        shot = on if on is not None else self.last_screen
        step = Step(
            seq=len(self.steps) + 1, kind=kind, args=dict(args), result=result,
            screen_hash=shot.tree_hash if shot else None, foreground=shot.foreground if shot else None,
        )
        self.steps.append(step)
        if self.on_step is not None:
            try:
                self.on_step(step)
            except Exception as e:  # noqa: BLE001 - a hook never breaks an action
                print(f"orcha qa: on_step failed: {type(e).__name__}: {e}", file=sys.stderr)
        return result

    def _mark_seen(self, shot: Screen) -> None:
        """`shot` is what the agent sees next: refs are checked against it, and its foreground is
        what an input may go to."""
        self.seen_foreground = shot.foreground
        self._shown = {e.index: identity(e) for e in visible_elements(shot.elements)} if shot.tree_available else None

    def _stale_ref(self, target: Target | None) -> str | None:
        """A ref is a position in the screen the agent last saw; when the screen changed since (an
        action in between) the same number can name another control: refuse instead of tapping."""
        if target is None or target.index is None or self._shown is None or self.last_screen is None:
            return None
        seen = self._shown.get(target.index)
        if seen is None:
            return None
        elements = self.last_screen.elements
        now = identity(elements[target.index]) if target.index < len(elements) else "nothing"
        if now == seen:
            return None
        return (
            f"error: ref e{target.index} was {seen!r} on the screen you last saw; the screen has changed "
            f"since and e{target.index} is now {now!r}. Call screen and pick again."
        )

    async def _after_look(self, shot: Screen) -> Screen:
        """The screen the agent is about to see, with a system sheet the session cannot read closed
        and a permission dialog answered (each looked at again and told in `notes`)."""
        notes: list[str] = []
        settled = shot.settled
        try:
            overlay = await self._clear_system_overlay(shot)
        except Exception:  # noqa: BLE001 - the agent sees the unreadable screen, said plainly
            overlay = None
        if overlay:
            notes.append(overlay)
            shot = await self._capture(0)
        if self.auto_allow_permissions:
            for _ in range(PERMISSION_DIALOGS_PER_LOOK):
                dialog = dialog_of(shot.foreground, shot.elements)
                if dialog is None or not await self._allow_dialog(dialog, shot):
                    break
                notes.append(f'permission: the session allowed "{dialog.prompt}" ({dialog.allow_label}) by itself; the screen below is after it.')
                shot = await self._capture(0)
        if notes:
            shot.notes = [*notes, *shot.notes]
            shot.settled = settled
        return shot

    async def _permission_before_action(self) -> str | None:
        """After a tap the settle called dead, look once before the next action: a permission
        dialog the app opened late is answered first, so the action lands on the app."""
        self._dead_tap_pending = False
        if not self.auto_allow_permissions:
            return None
        try:
            shot = await self.snapshot()
        except Exception:  # noqa: BLE001 - the action goes ahead as before
            return None
        dialog = dialog_of(shot.foreground, shot.elements)
        if dialog is None or not await self._allow_dialog(dialog, shot):
            return None
        self._mark_seen(self.last_screen or shot)
        return f'permission: the session allowed "{dialog.prompt}" ({dialog.allow_label}) by itself before this action.'

    async def _allow_dialog(self, dialog: Dialog, shot: Screen) -> bool:
        """Tap the dialog's allow control once it holds still, settle, and report a harness step.
        False when the tap could not be sent or the dialog went away."""
        last = (dialog.allow.x1, dialog.allow.y1, dialog.allow.x2, dialog.allow.y2)
        for _ in range(DIALOG_STEADY_READS):
            await poll_sleep(DIALOG_STEADY_POLL_S)
            try:
                shot = await self.snapshot()
            except Exception:  # noqa: BLE001 - tap where it was last seen
                break
            again = dialog_of(shot.foreground, shot.elements)
            if again is None:
                return False
            where = (again.allow.x1, again.allow.y1, again.allow.x2, again.allow.y2)
            dialog = again
            if where == last:
                break
            last = where
        try:
            error = await self._send_tap(dialog.allow.center)
        except Exception:  # noqa: BLE001 - the agent sees the dialog instead
            return False
        if error:
            return False
        try:
            await settle(self, after="tap", before_shape=shape_of(shot))
        except Exception:  # noqa: BLE001 - the next look reads the screen anyway
            pass
        line = f'allowed the permission dialog "{dialog.prompt}": tapped {dialog.allow_label}'
        self._record("wait", {"ms": 0, "permission": dialog.allow_label, "dialog": dialog.prompt, "source": "harness"}, line, on=shot)
        return True

    async def _wait_until_rendered(self, timeout_s: float = 10.0) -> Screen:
        """Poll until the tree has real content (more than the Application node)."""
        deadline = time.time() + timeout_s
        shot = await self._capture(2.0)
        while time.time() < deadline and (self.width == 0 or len(shot.elements) <= 1):
            await poll_sleep(RENDER_POLL_S)
            shot = await self._capture(2.0)
        return shot


# ---------- the app under test is in front before an input goes to it ----------

#: What a refused input did not do, and what the agent is asked to do before, by action kind.
VERBS = {
    "tap": ("tapped", "tapping"),
    "long_press": ("long-pressed", "long-pressing"),
    "type": ("typed", "typing"),
    "clear": ("cleared", "clearing"),
}


def left(front: str | None, app: str, seen: str | None, passes: Any = ()) -> bool:
    """Whether an input must not go: `front` (what is in front now, None when unknown) is not
    the app, not one of `passes` (a permission dialog) and not what the agent last saw (the
    app left between the look and the input: the tap would reach the home screen or another app)."""
    if not front or front == app or front in passes:
        return False
    return front != seen


def refusal(app_name: str, front_name: str, kind: str, *, brought_back: bool | None, still: str | None = None,
            stopped: bool = False) -> str:
    """What the agent is told when an input was refused. `brought_back`: True when the app is in
    front again, False when the session tried and `still` is in front, None when it did not try
    (`lock_app` off). `stopped`: the app's process was gone."""
    done, doing = VERBS.get(kind, VERBS["tap"])
    line = f"{app_name} was not in front ({front_name} was), so nothing was {done}"
    if brought_back is True and stopped:
        line += "; it had stopped running, so the session started it again"
    elif brought_back is True:
        line += "; the session brought it back"
    elif brought_back is False:
        line += "; the session tried to bring it back, but " + (
            f"{still} is still in front" if still == front_name
            else f"{still} is in front now" if still else "it is not in front yet"
        )
    elif stopped:
        line += "; it had stopped running"
    return f"{line}. Look again before {doing}."


# ---------- what the agent may type (`runs/input_policy.py`) ----------

#: (kind, pattern). Each pattern needs the payload's syntax, not a lone character: `O'Brien`,
#: `R&D`, `50% off`, `C:\\Users` and `{name}` are ordinary text.
ATTACK_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("script", re.compile(r"<\s*/?\s*(script|iframe|svg|img|object|embed|body|style|link|meta)\b", re.I)),
    ("script", re.compile(r"\bjavascript\s*:", re.I)),
    ("script", re.compile(r"\bon(error|load|click|mouseover|focus)\s*=", re.I)),
    ("script", re.compile(r"\balert\s*\(|\bdocument\.cookie\b|\bprompt\s*\(\s*\d", re.I)),
    ("sql", re.compile(r"'\s*(or|and)\s+['\d\w]+\s*=\s*['\d\w]+", re.I)),
    ("sql", re.compile(r"\b(union\s+(all\s+)?select|drop\s+table|insert\s+into|delete\s+from|sleep\s*\(\s*\d|benchmark\s*\()", re.I)),
    ("sql", re.compile(r"'\s*;\s*--|'\s*--\s*$|;\s*--\s*$")),
    ("template", re.compile(r"\{\{\s*[\d\w]+\s*[*+]\s*[\d\w]+\s*\}\}|\$\{\s*(jndi|\d+\s*\*)", re.I)),
    ("format", re.compile(r"(%[sxn]){3,}|%n", re.I)),
    ("path", re.compile(r"(\.\./){2,}|(\.\.\\\\){2,}|/etc/passwd|\bwin\.ini\b", re.I)),
    ("shell", re.compile(r"(;|\|\||&&|\|)\s*(rm|cat|curl|wget|nc|bash|sh|ls|id|whoami)\b|\$\((\s*\w+)|`\s*(id|whoami|ls|cat)\b", re.I)),
)
ATTACK_NAMES = {
    "script": "a script/HTML injection payload",
    "sql": "an SQL injection payload",
    "template": "a template injection payload",
    "format": "a format-string payload",
    "path": "a path traversal payload",
    "shell": "a shell injection payload",
}


def attack_kind(text: str) -> str | None:
    """The kind of security payload `text` contains, or None for ordinary input. An explorer told
    to try "special characters" once typed `<script>alert(1)</script>` into a public site's search
    box: that is security testing, not QA, and on a site the person does not own it is an attack."""
    if not text:
        return None
    for kind, pattern in ATTACK_PATTERNS:
        if pattern.search(text):
            return kind
    return None


def input_refusal(text: str) -> str | None:
    """`type_text`'s error for a security payload; None when the text may be typed."""
    kind = attack_kind(text)
    if kind is None:
        return None
    return (
        f"error: refused, that is {ATTACK_NAMES[kind]}. Exploration tests what real users type, never "
        "attack strings. Try a realistic edge case instead: empty, a typo, very long, an accented or "
        "apostrophe name (José, O'Brien), an emoji, or a query with no results."
    )
