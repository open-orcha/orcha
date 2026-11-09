"""One live session on a physical iPhone or iPad connected to this Mac.

idb automates simulators only, and Apple allows UI automation on a real device only through
XCUITest. So this session starts a local Appium server with its XCUITest driver
(`appium_local`), and speaks WebDriver to WebDriverAgent on the phone (`webdriver`). It feeds the
same action pipeline as every other device (`SessionBase`), so the agent's tools, the tree and the
frames read the same as on a simulator. Adapted from `sessions/ios_physical.py`,
`sessions/appium.py` and `clouddevices/pagesource.py`.

What differs from a simulator:

- A phone not ready to run (locked, untrusted, Developer Mode off, not connected) stops with the
  one thing a person must do, never a failure of the app.
- The app must already be on the phone. This session never installs, removes or clears anything:
  it may be someone's own phone, and devicectl has no "clear app data".
- The phone is kept awake with a key press no app acts on; its Auto-Lock setting is never changed.
"""

from __future__ import annotations

import asyncio
import sys
import time
import xml.etree.ElementTree as ET
from typing import Any, Optional

from orcha_cli.qa.device import appium_local, ios_phone, locks
from orcha_cli.qa.device.android import TEXT_TYPES, _live_jpeg
from orcha_cli.qa.device.base import DeviceBusy, SessionBase, SessionError, left, refusal
from orcha_cli.qa.device.screen import Probe, Screen, needs_pixels, poll_sleep, settle, shape_of
from orcha_cli.qa.device.targets import Target, chosen, off_screen, refind, resolve
from orcha_cli.qa.device.tree import Element, parse_tree, screen_size, tree_hash
from orcha_cli.qa.device.webdriver import WebDriver, WebDriverError, swipe_actions, tap_actions

#: The phone's own system UI that may cover the app: alerts, the Local Network prompt.
SYSTEM_APPS = frozenset({"com.apple.springboard"})
#: iOS's shortest Auto-Lock is 30 s: one F24 press (HID keyboard page) every 10 s is activity.
KEEP_AWAKE_S = 10.0
HID_KEYBOARD_PAGE = 0x07
HID_F24 = 0x73
LIVE_FPS = 2
EMPTY_TREE_RETRY_S = 0.5
APP_BACK_WAIT_S = 3.0
LOG_NAME = "appium-{udid}.log"
IOS_INTERACTIVE = frozenset({"Button", "TextField", "SecureTextField", "SearchField", "TextView", "Switch", "Toggle", "Slider", "Cell",
                             "Link", "Tab", "SegmentedControl", "Picker", "PickerWheel", "Stepper", "MenuItem", "Key"})
IOS_CONTAINERS = frozenset({"Other", "Window", "ScrollView", "Table", "CollectionView", "Group", "Any", "StatusBar"})


class PageSourceError(Exception):
    pass


def _int(v: Any) -> int:
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return 0


def _true(v: Any) -> bool:
    return str(v).lower() == "true"


def ios_raw(xml: str, *, foreground: Optional[str] = None) -> list[dict[str, Any]]:
    """An XCUITest page source as the idb-shaped dicts `tree.parse_tree` reads: the
    `XCUIElementTypeApplication` root as the `Application` node, then each visible node with a
    label, value, identifier or an interactive type."""
    try:
        root = ET.fromstring(xml.strip().encode("utf-8"))
    except ET.ParseError as e:
        raise PageSourceError(f"page source is not XML: {e}") from None
    app = root if root.tag == "XCUIElementTypeApplication" else root.find(".//XCUIElementTypeApplication")
    if app is None:
        raise PageSourceError("no XCUIElementTypeApplication in the page source")
    name = app.attrib.get("name") or app.attrib.get("label") or ""
    out: list[dict[str, Any]] = [{"type": "Application", "AXLabel": foreground or name or "unknown", "enabled": True,
                                  "frame": {"x": 0, "y": 0, "width": _int(app.attrib.get("width")), "height": _int(app.attrib.get("height"))}}]
    for node in app.iter():
        a = node.attrib
        if node is app or a.get("visible") == "false":
            continue
        typ = (a.get("type") or node.tag).replace("XCUIElementType", "")
        label, nm, value = a.get("label") or "", a.get("name") or "", a.get("value") or ""
        identifier = nm if nm and nm != label else ""
        w, h = _int(a.get("width")), _int(a.get("height"))
        named = bool(label or identifier or value)
        if w <= 0 or h <= 0 or (typ in IOS_CONTAINERS and not named) or (typ not in IOS_INTERACTIVE and not named):
            continue
        traits = [word for word, on in (("Selected", _true(a.get("selected"))), ("Focused", _true(a.get("focused")) or _true(a.get("hasFocus")))) if on]
        out.append({"type": "Switch" if typ == "Toggle" else typ, "AXLabel": label or ("" if identifier else nm),
                    "AXValue": "" if typ == "SecureTextField" else value, "AXUniqueId": identifier,
                    "frame": {"x": _int(a.get("x")), "y": _int(a.get("y")), "width": w, "height": h},
                    "enabled": a.get("enabled") != "false", "traits": traits})
    return out


def session_error(name: str, error: str) -> str:
    """A failed start in plain words, with the fix when it is a known problem."""
    low = error.lower()
    if "unlock" in low or "locked" in low:
        return f"{name} is locked: unlock it and keep it unlocked while the run goes ({error[:200]})"
    if "developer mode" in low:
        return f"Developer Mode is off on {name}: turn it on in Settings > Privacy & Security ({error[:200]})"
    if "xcodebuild failed" in low or "signing" in low or "provisioning" in low:
        return (f"WebDriverAgent could not be built and signed for {name}: {error[:400]}. Check the team's Apple Development "
                f"signing in Xcode (Settings > Accounts), or set {appium_local.TEAM_ENV}")
    return f"could not start a session on {name}: {error[:400]}"


class IosPhoneSession(SessionBase):
    """A physical iPhone or iPad. `phone` is its `ios_phone.phones()` entry."""

    platform = "ios"

    def __init__(self, *, phone: dict[str, Any], driver_factory: Any = None, server_factory: Any = None, **kw: Any) -> None:
        super().__init__(device_name=phone["name"], **kw)
        self.phone = phone
        self.udid = phone["udid"]
        self.driver: Optional[WebDriver] = None
        self.server: Any = None
        self._driver_factory = driver_factory or WebDriver
        self._server_factory = server_factory or (lambda: appium_local.start(log_path=appium_local.tools_dir() / LOG_NAME.format(udid=self.udid)))
        self._awake_task: Optional[asyncio.Task] = None
        self._live_task: Optional[asyncio.Task] = None
        self._ended = False

    # ---------- start ----------

    async def start(self, app_id: str, launch: bool = True) -> Screen:
        name, word = self.device_name, ios_phone.word_for(self.phone.get("model") or "")
        self.app_id, self.app_name, self.started_at = app_id, app_id, time.time()
        self._stage(f"Checking {name}")
        ready = await asyncio.to_thread(ios_phone.readiness, self.udid)
        if not ready.ready:
            raise SessionError(f"{ready.problem}. {ready.fix}")
        if self.claim_lock:
            self.lock = locks.claim(name, is_booted=lambda: True)
            if self.lock is None:
                raise DeviceBusy(f"{name} is in use by another run. Wait for it, or pick another device.", [name])
        try:
            installed = await asyncio.to_thread(ios_phone.installed_app, self.udid, app_id)
            if installed is None:
                raise SessionError(
                    f"{app_id} is not installed on {name}. Build it for a device and install it, then start again: "
                    f"xcodebuild -scheme <scheme> -destination generic/platform=iOS -allowProvisioningUpdates build, then "
                    f"xcrun devicectl device install app --device {self.udid} <path to the .app>")
            self.version = str(installed.get("bundleVersion") or "") or None
            self.short_version = str(installed.get("version") or "") or None
            await self._open_driver(name, word)
            rect = await self.driver.window_rect()
            self.width, self.height = _int(rect.get("width")), _int(rect.get("height"))
            self._awake_task = asyncio.create_task(self._keep_awake())
            if launch:
                self._stage("Opening the app")
                await self._launch_fresh(app_id)
            self._stage("Waiting for the app to show its first screen")
            await self._wait_until_rendered()
        except BaseException:
            await self._close()
            if self.lock is not None:
                self.lock.release()
                self.lock = None
            raise
        shot = await self._after_look(self.last_screen) if self.last_screen is not None else await self._capture(0)
        self._mark_seen(shot)
        return shot

    async def _open_driver(self, name: str, word: str) -> None:
        """Appium up, WebDriverAgent on the phone. Its build is reused after the first time; a
        reused build that does not start (a new Xcode, an expired profile) is built again once."""
        if not appium_local.installed():
            self._stage("Installing the phone tools, about two minutes, this once")
            try:
                await asyncio.to_thread(appium_local.install)
            except appium_local.AppiumUnavailable as e:
                raise SessionError(str(e)) from e
        self._stage("Starting Appium")
        try:
            self.server = await asyncio.to_thread(self._server_factory)
        except appium_local.AppiumUnavailable as e:
            raise SessionError(str(e)) from e
        team = await asyncio.to_thread(appium_local.signing_team)
        prebuilt = appium_local.wda_prebuilt(self.udid, self.app_id, team)

        async def attempt(reuse: bool) -> None:
            self._stage(f"Starting WebDriverAgent on {name}" if reuse else f"Building WebDriverAgent for this {word}, one to three minutes the first time. Keep it unlocked")
            driver = self._driver_factory(self.server.url)
            try:
                await driver.new_session(appium_local.capabilities(udid=self.udid, bundle_id=self.app_id, team=team, prebuilt=reuse))
            except BaseException:
                await driver.quit()
                raise
            self.driver = driver

        try:
            try:
                await attempt(prebuilt)
            except WebDriverError:
                if not prebuilt:
                    raise
                appium_local.forget_wda(self.udid, self.app_id)
                await attempt(False)
        except WebDriverError as e:
            raise SessionError(session_error(name, str(e))) from None
        appium_local.remember_wda(self.udid, self.app_id, team)

    async def _launch_fresh(self, app_id: str) -> None:
        try:
            await self.driver.mobile("terminateApp", {"bundleId": app_id})
        except WebDriverError:
            pass  # not running
        args = list(getattr(self, "launch_args", None) or [])
        await self._call(self.driver.mobile("launchApp", {"bundleId": app_id, **({"arguments": args} if args else {})}), "launch")

    async def _keep_awake(self) -> None:
        """A WebDriverAgent session does not hold the screen on, and a phone with a 30 s Auto-Lock
        locks between two agent turns. Skipped while the keyboard is up: a hardware key may hide it."""
        failures = 0
        while not self._ended and failures < 3:
            await asyncio.sleep(KEEP_AWAKE_S)
            shot = self.last_screen
            if shot is not None and any(e.type == "Key" for e in shot.elements):
                continue
            try:
                await self.driver.mobile("performIoHidEvent", {"page": HID_KEYBOARD_PAGE, "usage": HID_F24, "durationSeconds": 0.005})
                failures = 0
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - an older driver: the phone may lock, readiness says so next run
                failures += 1

    # ---------- what the session records about the device ----------

    async def app_version(self) -> Optional[str]:
        short, build = getattr(self, "short_version", None), getattr(self, "version", None)
        return f"{short} ({build})" if short and build else short or build

    # ---------- perception ----------

    async def _call(self, coro: Any, what: str) -> Any:
        if self.driver is None:
            raise SessionError("the session has ended; start a new one")
        try:
            return await coro
        except WebDriverError as e:
            raise SessionError(f"{self.device_name} {what} failed: {e}") from None

    async def _foreground(self) -> Optional[str]:
        try:
            info = await self.driver.mobile("activeAppInfo")
        except WebDriverError:
            return None
        return str((info or {}).get("bundleId") or "") or None

    async def _capture(self, settle_s: float = 0.0) -> Screen:
        deadline = time.time() + settle_s
        while True:
            png, xml, front = await asyncio.gather(self._call(self.driver.screenshot(), "screenshot"),
                                                   self._call(self.driver.page_source(), "screen read"), self._foreground())
            available = True
            try:
                raw = ios_raw(xml, foreground=front)
            except PageSourceError:
                available = False
                raw = [{"type": "Application", "AXLabel": front or self.app_id, "frame": {"x": 0, "y": 0, "width": self.width, "height": self.height}}]
            elements = parse_tree(raw)
            if len(elements) > 1 or time.time() >= deadline or not available:
                break
            await poll_sleep(EMPTY_TREE_RETRY_S)
        w, h = screen_size(elements)
        if w > 0 and h > 0:
            self.width, self.height = w, h
        bundle = front or self.app_id
        shot = Screen(png=png, raw=raw, elements=elements, tree_hash=tree_hash(elements), size=(self.width, self.height),
                      foreground=bundle, foreground_name=self.app_name if bundle == self.app_id else bundle,
                      locked_app_violation=self.lock_app and bundle != self.app_id and bundle not in SYSTEM_APPS, tree_available=available)
        self.last_screen = shot
        return shot

    async def _live_elements(self) -> Optional[list[Element]]:
        try:
            return parse_tree(ios_raw(await self.driver.page_source()))
        except (WebDriverError, PageSourceError):
            return None

    async def probe(self) -> Probe:
        elements = await self._live_elements()
        if elements is None:
            last = self.last_screen
            return Probe(elements=last.elements if last else [], tree_available=bool(last and last.tree_available), png=last.png if last else None)
        if needs_pixels(elements, True):
            return Probe(elements=elements, tree_available=True, png=await self._call(self.driver.screenshot(), "screenshot"))
        return Probe(elements=elements, tree_available=True)

    async def start_live(self, writer: Any, first_frame_s: float = 10.0) -> bool:
        """The live view: WebDriverAgent's screenshot, skipped while a command is in flight."""
        if self._live_task is not None:
            return True
        first = asyncio.Event()

        async def pump() -> None:
            while self.driver is not None:
                seq = getattr(writer, "cmd_seq", None)
                try:
                    png = await self.driver.poll_screenshot()
                    if png:
                        writer.offer(await asyncio.to_thread(_live_jpeg, png), seq)
                        first.set()
                except asyncio.CancelledError:
                    raise
                except Exception as e:  # noqa: BLE001 - the next tick tries again
                    print(f"live frames: phone screenshot failed: {e}", file=sys.stderr)
                await asyncio.sleep(1.0 / LIVE_FPS)

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

    # ---------- actions ----------

    async def _app_left(self, kind: str) -> Optional[str]:
        front = await self._foreground()
        seen = self.seen_foreground or self.app_id
        if not front or not left(front, self.app_id, seen, SYSTEM_APPS):
            return None
        brought, still = None, None
        if self.lock_app:
            try:
                await self.driver.mobile("activateApp", {"bundleId": self.app_id})
                await asyncio.sleep(APP_BACK_WAIT_S / 3)
            except WebDriverError:
                pass
            now_front = await self._foreground()
            brought, still = now_front == self.app_id, now_front
        line = refusal(self.app_name or self.app_id, front, kind, brought_back=brought, still=still)
        print(f"orcha qa: {line}", file=sys.stderr, flush=True)
        return line

    async def _send_tap(self, point: tuple[int, int], long_press_ms: Optional[int] = None) -> Optional[str]:
        try:
            await self.driver.actions(tap_actions(point[0], point[1], long_press_ms or 50))
        except WebDriverError as e:
            return str(e)
        return None

    async def _tap(self, target: Target, long_press_ms: Optional[int]) -> str:
        kind = "long_press" if long_press_ms else "tap"
        shot = self.last_screen or await self._capture(0)
        point, how = resolve(target, shot.elements)
        if point is None:
            return f"tap failed: {how}"
        seen = chosen(target, shot.elements)
        live = await self._live_elements()
        if seen is not None and live:
            cur = refind(seen, live)
            if cur is not None and cur.center != point:
                point, how = cur.center, f"{how}, re-found on the live screen (was at {point})"
        away = off_screen(point, self.width, self.height)
        if away:
            return f"error: {away}"
        gone = await self._app_left(kind)
        if gone:
            return f"error: {gone}"
        error = await self._send_tap(point, long_press_ms)
        if error:
            return f"tap failed: {error}"
        return f"{f'long-pressed {long_press_ms}ms' if long_press_ms else 'tapped'} at {point} via {how}"

    async def _swipe_points(self, x1: int, y1: int, x2: int, y2: int, duration_ms: int) -> str:
        try:
            await self.driver.actions(swipe_actions(x1, y1, x2, y2, duration_ms))
        except WebDriverError as e:
            return f"swipe failed: {e}"
        return f"swiped ({x1},{y1})->({x2},{y2}) in {duration_ms}ms"

    async def _press(self, key: str) -> str:
        try:
            if key == "home":
                await self.driver.mobile("pressButton", {"name": "home"})
            elif key == "enter":
                field = await self.driver.active_element()
                if not field:
                    return "press failed: no focused field to send enter to"
                await self.driver.element_send_keys(field, "\n")
            elif key == "back":
                return "error: iOS has no back key; tap the screen's own back button"
            else:
                return "error: key must be one of enter, home"
        except WebDriverError as e:
            return f"press failed: {e}"
        return f"pressed {key}"

    async def _open_url(self, url: str) -> str:
        try:
            await self.driver.mobile("deepLink", {"url": url, "bundleId": self.app_id})
        except WebDriverError:
            try:
                await self.driver.navigate(url)
            except WebDriverError as e:
                return f"open_url failed: {e}"
        return f"opened {url}"

    async def _launch(self, app_id: str) -> str:
        await self._launch_fresh(app_id)
        return f"launched {app_id}"

    async def _terminate(self, app_id: str) -> str:
        await self._call(self.driver.mobile("terminateApp", {"bundleId": app_id}), "terminate")
        return f"terminated {app_id}"

    # ---------- text ----------

    def _field(self, target: Target, before: Optional[Element], elements: list[Element]) -> Optional[Element]:
        if target.id:
            hit = next((e for e in elements if e.identifier == target.id), None)
            if hit is not None:
                return hit
        if before is None:
            return None
        return refind(before, elements) or next((e for e in elements if e.type in TEXT_TYPES and e.center == before.center), None)

    async def _focus(self, target: Target, kind: str) -> tuple[Optional[Element], Optional[str]]:
        shot = self.last_screen or await self._capture(0)
        if not target.has_locator:
            return None, await self._app_left(kind)
        point, how = resolve(target, shot.elements)
        if point is None:
            return None, how
        live = await self._live_elements() or shot.elements
        hits = [e for e in live if e.x1 <= point[0] <= e.x2 and e.y1 <= point[1] <= e.y2 and e.type in TEXT_TYPES]
        elem = min(hits, key=lambda e: (e.x2 - e.x1) * (e.y2 - e.y1)) if hits else None
        if elem is not None:
            point = elem.center
        gone = await self._app_left(kind)
        if gone:
            return None, gone
        shape = shape_of(self.last_screen) if self.last_screen else None
        error = await self._send_tap(point)
        if error:
            return None, error
        await settle(self, after="focus", before_shape=shape)
        return elem, None

    async def _type_text(self, target: Target, text: str) -> str:
        before, err = await self._focus(target, "type")
        if err:
            return f"type failed: {err}"
        field = await self.driver.active_element()
        if not field:
            return "type failed: no field has focus after tapping it"
        shape = shape_of(self.last_screen) if self.last_screen else None
        try:
            await self.driver.element_send_keys(field, text)
        except WebDriverError as e:
            return f"type failed: {e}"
        await settle(self, after="type", before_shape=shape)
        after = self.last_screen
        after.settled = self.last_settled
        elem = self._field(target, before, after.elements)
        if elem is not None and elem.type == "SecureTextField":
            return f"typed {text!r} into secure field; verified: unknown (masked)"
        if elem is not None and elem.value:
            return f"typed {text!r}; verified: {str(elem.value.lower().endswith(text.lower())).lower()}; field value now {elem.value!r}"
        return f"typed {text!r}; verified: unknown (field not readable, check the screenshot)"

    async def _clear_text(self, target: Target) -> str:
        before, err = await self._focus(target, "clear")
        if err:
            return f"clear failed: {err}"
        field = await self.driver.active_element()
        if not field:
            return "clear failed: no field has focus after tapping it"
        shape = shape_of(self.last_screen) if self.last_screen else None
        try:
            await self.driver.element_clear(field)
        except WebDriverError as e:
            return f"clear failed: {e}"
        await settle(self, after="clear", before_shape=shape)
        after = self.last_screen
        after.settled = self.last_settled
        elem = self._field(target, before, after.elements)
        value = elem.value if elem else "?"
        cleared = elem is not None and (elem.value == "" or (before is not None and len(elem.value or "") < len(before.value or "")))
        return f"cleared: {str(cleared).lower()}; field value now {value!r}"

    # ---------- the end ----------

    async def _close(self) -> None:
        self._ended = True
        task, self._awake_task = self._awake_task, None
        if task is not None:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001 - teardown
                pass
        driver, self.driver = self.driver, None
        if driver is not None:
            try:
                await driver.quit()
            except Exception:  # noqa: BLE001 - the server stops next either way
                pass
        server, self.server = self.server, None
        if server is not None:
            await asyncio.to_thread(server.stop)
            await asyncio.to_thread(appium_local.stop_wda, self.udid)

    async def _teardown(self, terminate: bool) -> None:
        if terminate and self.driver is not None and self.app_id:
            try:
                await self.driver.mobile("terminateApp", {"bundleId": self.app_id})
            except WebDriverError:
                pass
        await self._close()
