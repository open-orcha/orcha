"""A thin W3C WebDriver client for the local Appium server that drives a physical iPhone.

Adapted from `clouddevices/webdriver.py`, without the hub credentials: only what
`IosPhoneSession` uses. A W3C error becomes `WebDriverError` with the server's own reason.
`poll_screenshot` is the live view's frame: it never overlaps a command.
"""

from __future__ import annotations

import asyncio
import base64
from typing import Any, Optional

import httpx

#: The first session on a phone builds and signs WebDriverAgent: minutes.
NEW_SESSION_TIMEOUT_S = 300.0
COMMAND_TIMEOUT_S = 60.0
POLL_TIMEOUT_S = 10.0
ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecc"
MESSAGE_LIMIT = 600
# Where a server's message stops being about the failure.
_TAIL_MARKERS = ("build info:", "system info:", "driver info:", "session info:", "capabilities {", "stacktrace:")


class WebDriverError(Exception):
    def __init__(self, message: str, error: Optional[str] = None, status: Optional[int] = None):
        super().__init__(message)
        self.error = error
        self.status = status


def meaningful_message(text: str, limit: int = MESSAGE_LIMIT) -> str:
    """A server's error trimmed to what explains the failure, on one line."""
    lines: list[str] = []
    for raw in str(text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.lower().startswith(_TAIL_MARKERS):
            break
        lines.append(line)
    out = " ".join(lines)
    return out if len(out) <= limit else out[: limit - 1].rstrip() + "…"


def _error_of(resp: httpx.Response) -> WebDriverError:
    try:
        value = (resp.json() or {}).get("value") or {}
    except ValueError:
        value = {}
    if isinstance(value, dict) and value.get("message"):
        msg = meaningful_message(str(value["message"]))
        error = str(value.get("error") or "error")
        if msg.lower().startswith(error.lower()):
            return WebDriverError(msg, value.get("error"), resp.status_code)
        return WebDriverError(f"{error}: {msg}" if msg else error, value.get("error"), resp.status_code)
    return WebDriverError(f"HTTP {resp.status_code}: {meaningful_message(resp.text, 300)}", None, resp.status_code)


class WebDriver:
    """One Appium session on `hub`."""

    def __init__(self, hub: str, *, transport: Optional[httpx.AsyncBaseTransport] = None):
        self.hub = hub.rstrip("/")
        self.session_id: Optional[str] = None
        headers = {"Content-Type": "application/json; charset=utf-8", "Accept": "application/json"}
        self._http = httpx.AsyncClient(headers=headers, timeout=COMMAND_TIMEOUT_S, transport=transport)
        self._busy = 0
        self._polling: Optional[asyncio.Event] = None

    async def _send(self, method: str, path: str, payload: Any = None, *, timeout: Optional[float] = None) -> Any:
        self._busy += 1
        try:
            while self._polling is not None:
                await self._polling.wait()
            return await self._request(method, path, payload, timeout=timeout)
        finally:
            self._busy -= 1

    async def poll_screenshot(self, timeout: float = POLL_TIMEOUT_S) -> Optional[bytes]:
        """A frame for the live view; None when a command is in flight or there is no session."""
        if self._busy or self._polling is not None or not self.session_id:
            return None
        done = self._polling = asyncio.Event()
        try:
            value = await self._request("GET", f"/session/{self.session_id}/screenshot", timeout=timeout)
        finally:
            self._polling = None
            done.set()
        return base64.b64decode(value or "") or None

    async def _request(self, method: str, path: str, payload: Any = None, *, timeout: Optional[float] = None) -> Any:
        try:
            resp = await self._http.request(method, f"{self.hub}{path}", json=payload, timeout=timeout or COMMAND_TIMEOUT_S)
        except httpx.HTTPError as e:
            raise WebDriverError(f"could not reach the Appium server: {type(e).__name__}") from None
        if resp.status_code >= 400:
            raise _error_of(resp)
        try:
            return (resp.json() or {}).get("value")
        except ValueError:
            return None

    def _s(self, path: str = "") -> str:
        if not self.session_id:
            raise WebDriverError("no session")
        return f"/session/{self.session_id}{path}"

    async def new_session(self, capabilities: dict[str, Any]) -> str:
        value = await self._send("POST", "/session", {"capabilities": {"alwaysMatch": capabilities, "firstMatch": [{}]}},
                                 timeout=NEW_SESSION_TIMEOUT_S) or {}
        sid = value.get("sessionId")
        if not sid:
            raise WebDriverError(f"the server returned no session id: {str(value)[:200]}")
        self.session_id = str(sid)
        return self.session_id

    async def quit(self) -> None:
        """End the session (one already gone is fine), then close the HTTP client."""
        try:
            if self.session_id:
                try:
                    await self._send("DELETE", self._s())
                except WebDriverError as e:
                    if e.status != 404 and e.error != "invalid session id":
                        raise
        finally:
            await self._http.aclose()

    async def screenshot(self) -> bytes:
        return base64.b64decode(await self._send("GET", self._s("/screenshot")) or "")

    async def page_source(self) -> str:
        return str(await self._send("GET", self._s("/source")) or "")

    async def window_rect(self) -> dict[str, Any]:
        return dict(await self._send("GET", self._s("/window/rect")) or {})

    async def actions(self, actions: list[dict[str, Any]]) -> None:
        await self._send("POST", self._s("/actions"), {"actions": actions})

    async def active_element(self) -> Optional[str]:
        try:
            value = await self._send("GET", self._s("/element/active"))
        except WebDriverError:
            return None
        return (value.get(ELEMENT_KEY) or value.get("ELEMENT")) if isinstance(value, dict) else None

    async def element_send_keys(self, element: str, text: str) -> None:
        await self._send("POST", self._s(f"/element/{element}/value"), {"text": text, "value": list(text)})

    async def element_clear(self, element: str) -> None:
        await self._send("POST", self._s(f"/element/{element}/clear"), {})

    async def navigate(self, url: str) -> None:
        await self._send("POST", self._s("/url"), {"url": url})

    async def mobile(self, command: str, params: Optional[dict[str, Any]] = None) -> Any:
        return await self._send("POST", self._s("/execute/sync"), {"script": f"mobile: {command}", "args": [params or {}]})


def _pointer(actions: list[dict[str, Any]]) -> dict[str, Any]:
    return {"type": "pointer", "id": "finger", "parameters": {"pointerType": "touch"}, "actions": actions}


def tap_actions(x: int, y: int, hold_ms: int = 50) -> list[dict[str, Any]]:
    return [_pointer([{"type": "pointerMove", "duration": 0, "x": int(x), "y": int(y)}, {"type": "pointerDown", "button": 0},
                      {"type": "pause", "duration": max(0, int(hold_ms))}, {"type": "pointerUp", "button": 0}])]


def swipe_actions(x1: int, y1: int, x2: int, y2: int, duration_ms: int) -> list[dict[str, Any]]:
    return [_pointer([{"type": "pointerMove", "duration": 0, "x": int(x1), "y": int(y1)}, {"type": "pointerDown", "button": 0},
                      {"type": "pause", "duration": 100}, {"type": "pointerMove", "duration": max(1, int(duration_ms)), "x": int(x2), "y": int(y2)},
                      {"type": "pointerUp", "button": 0}])]
