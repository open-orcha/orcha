"""Fakes for the Orcha QA MCP tests (no tests here): an in-memory portal (the real `PortalClient` with its
transport replaced, so the paths and the `actor_agent_id` it sends are what is tested) and a
device session that walks through scripted screens. No device, no network."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from orcha_cli.qa.portal import PortalClient, PortalError

CID = "11111111-1111-1111-1111-111111111111"
AGENT = "22222222-2222-2222-2222-222222222222"


class Identity:
    ok = True
    api_base = "http://portal.test"
    container_id = CID
    agent_id = AGENT
    alias = "qa-bot"
    problems: list[str] = []


class FakePortal(PortalClient):
    """Routes `(method, path)` to handlers; records every call."""

    def __init__(self) -> None:
        super().__init__(Identity.api_base, CID, AGENT)
        self.calls: list[tuple[str, str, Any, dict[str, Any]]] = []
        self.frames: list[bytes] = []
        self.steps: dict[int, dict[str, Any]] = {}
        self.sessions: dict[str, dict[str, Any]] = {}
        self.findings: list[dict[str, Any]] = []
        self.scens: dict[str, dict[str, Any]] = {}
        self.walk_patches: list[dict[str, Any]] = []
        self.observed: list[dict[str, Any]] = []
        self.flows: list[dict[str, Any]] = []
        self.queue: list[tuple[dict[str, Any], dict[str, Any]]] = []
        self.targets_rows = [{"platform": "ios", "app_id": "com.example.snug", "device_name": None, "notes": "sign in as Maya"}]
        self.map_data: dict[str, Any] = {"features": [], "nodes": [], "edges": []}
        self.fail: dict[tuple[str, str], str] = {}  # (method, path regex) -> error message
        self.keys: dict[str, str] = {}

    def calls_to(self, method: str, pattern: str) -> list[tuple[str, str, Any, dict[str, Any]]]:
        return [c for c in self.calls if c[0] == method and re.search(pattern, c[1])]

    def _request(self, method: str, path: str, body: Any = None, *, query: Optional[dict[str, Any]] = None,
                 raw: Optional[bytes] = None, content_type: str = "application/json",
                 headers: Optional[dict[str, str]] = None) -> Any:
        self.calls.append((method, path, body if raw is None else raw, dict(query or {})))
        for (m, pat), msg in self.fail.items():
            if m == method and re.search(pat, path):
                raise PortalError(msg, 500)
        c = f"/api/containers/{CID}/qa"
        if method == "GET" and path == c + "/targets":
            return {"targets": self.targets_rows}
        if method == "PUT" and path.startswith(c + "/targets/"):
            return {"platform": path.rsplit("/", 1)[-1], **body}
        if method == "POST" and path == c + "/run-task":
            return {"task_id": "task-of-the-worker", "created": False}
        if method == "POST" and path == c + "/sessions":
            sid = f"sess-{len(self.sessions) + 1}"
            self.sessions[sid] = {"id": sid, **body}
            return dict(self.sessions[sid])
        m = re.fullmatch(r"/api/qa/sessions/([^/]+)", path)
        if m and method == "PATCH":
            self.sessions.setdefault(m.group(1), {}).update(body)
            return dict(self.sessions[m.group(1)])
        if m and method == "GET":
            return {"session": self.sessions.get(m.group(1), {})}
        if re.fullmatch(r"/api/qa/sessions/[^/]+/frames", path):
            self.frames.append(raw or b"")
            return {"frame_id": f"frame-{len(self.frames)}"}
        if re.fullmatch(r"/api/qa/sessions/[^/]+/steps", path) and method == "POST":
            for s in body["steps"]:
                self.steps[s["seq"]] = s
            return {"saved": len(body["steps"])}
        if method == "POST" and path == c + "/map/observe":
            self.observed.append(body)
            title = body.get("title") or (body.get("texts") or ["?"])[0]
            key = re.sub(r"\W+", "-", title.lower()).strip("-")
            new = key not in self.keys
            self.keys[key] = title
            return {"screen_key": key, "label": title, "state": "seen", "new": new}
        if method == "POST" and path == c + "/map/blocked":
            return {"screen_key": body["screen"], "state": "blocked"}
        if method == "GET" and path == c + "/map":
            return self.map_data
        if method == "PUT" and path == c + "/features":
            return {"features": body["features"]}
        if re.fullmatch(r"/api/qa/sessions/[^/]+/findings", path):
            fid = f"find-{len(self.findings) + 1}"
            self.findings.append({"id": fid, **body})
            return {"id": fid}
        if method == "POST" and path == c + "/flows":
            self.flows.extend(body["flows"])
            return {"flows": body["flows"]}
        if re.fullmatch(r"/api/qa/sessions/[^/]+/walks/next", path):
            if not self.queue:
                return {"walk": None}
            walk, flow = self.queue.pop(0)
            return {"walk": walk, "flow": flow}
        m = re.fullmatch(r"/api/qa/walks/([^/]+)", path)
        if m and method == "PATCH":
            self.walk_patches.append(body)
            return {"walk": {"id": m.group(1)}}
        if method == "POST" and path == c + "/scenarios":
            existing = next((s for s in self.scens.values() if s["name"] == body["name"]), None)
            if existing and existing.get("status") == "validated":
                return {"outcome": "suggested", "scenario": existing}
            sid = existing["id"] if existing else f"scen-{len(self.scens) + 1}"
            self.scens[sid] = {"id": sid, "status": "draft", **body}
            return {"outcome": "updated" if existing else "created", "scenario": self.scens[sid]}
        if method == "GET" and path == c + "/scenarios":
            return {"scenarios": list(self.scens.values())}
        m = re.fullmatch(r"/api/qa/scenarios/([^/]+)", path)
        if m and method == "GET":
            row = self.scens.get(m.group(1))
            if row is None:
                raise PortalError(f"HTTP 404 on GET {path}: scenario not found", 404)
            return {"scenario": row, "evidence": row.get("evidence") or []}
        if m and method == "PATCH":
            self.scens[m.group(1)].update(body)
            return self.scens[m.group(1)]
        if method == "GET" and path == c + "/overview":
            return {"ios": {"screens_seen": len(self.keys)}}
        if re.fullmatch(r"/api/qa/sessions/[^/]+/verdicts", path):
            return {"id": "verdict-1"}
        raise PortalError(f"HTTP 404 on {method} {path}: no route in the fake", 404)


@dataclass
class El:
    index: int
    type: str
    label: str
    value: str = ""
    identifier: str = ""
    x1: int = 0
    y1: int = 0
    x2: int = 100
    y2: int = 40
    enabled: bool = True
    traits: list[str] = field(default_factory=list)

    @property
    def interactive(self) -> bool:
        return self.type in ("Button", "Tab", "TextField", "Cell")

    def compact_line(self) -> str:
        return f'e{self.index} {self.type} "{self.label}"'


@dataclass
class Shot:
    name: str
    elements: list[El]
    masking_proven: bool = True

    @property
    def tree_hash(self) -> str:
        return f"hash-{self.name}"

    @property
    def jpeg(self) -> bytes:
        return f"jpeg:{self.name}".encode()

    def text(self) -> str:
        return "\n".join(e.compact_line() for e in self.elements)


def shot(name: str, *labels: tuple[str, str]) -> Shot:
    return Shot(name, [El(i, role, label, y1=i * 50, y2=i * 50 + 40) for i, (role, label) in enumerate(labels)])


class FakeDevice:
    """Walks through `screens`: each tap/press/swipe/type moves to the next one."""

    def __init__(self, screens: list[Shot], *, device_name: str = "iPhone 17 Pro") -> None:
        self.screens = screens
        self.pos = 0
        self.device_name = device_name
        self.udid = "SIM-UDID"
        self.last_screen: Any = screens[0]
        self.calls: list[tuple[str, tuple[Any, ...]]] = []
        self.ended = False
        self.raise_on: set[str] = set()
        self.notes: list[str] = []

    def _advance(self, name: str, *args: Any) -> str:
        self.calls.append((name, args))
        if name in self.raise_on:
            raise RuntimeError(f"{name} broke")
        self.pos = min(self.pos + 1, len(self.screens) - 1)
        self.last_screen = self.screens[self.pos]
        return f"{name} ok"

    async def screen(self) -> Shot:
        self.last_screen = self.screens[self.pos]
        return self.last_screen

    async def tap(self, target: Any, long_press_ms: Optional[int] = None) -> str:
        return self._advance("long_press" if long_press_ms else "tap", target)

    async def type_text(self, target: Any, text: str) -> str:
        return self._advance("type_text", target, text)

    async def clear_text(self, target: Any) -> str:
        return self._advance("clear_text", target)

    async def swipe(self, direction: str, pct: int = 50) -> str:
        return self._advance("swipe", direction, pct)

    async def swipe_coords(self, *a: int) -> str:
        return self._advance("swipe_coords", *a)

    async def press(self, key: str) -> str:
        return self._advance("press", key)

    async def open_url(self, url: str) -> str:
        return self._advance("open_url", url)

    async def launch_app(self, app: Optional[str] = None) -> str:
        self.calls.append(("launch_app", (app,)))
        self.pos = 0
        self.last_screen = self.screens[0]
        return "launched"

    async def terminate_app(self, app: Optional[str] = None) -> str:
        self.calls.append(("terminate_app", (app,)))
        return "terminated"

    async def wait(self, ms: int) -> str:
        self.calls.append(("wait", (ms,)))
        return f"waited {ms}ms"

    async def end(self) -> dict[str, Any]:
        self.ended = True
        return {}


def opener(device: FakeDevice, seen: Optional[list[Any]] = None) -> Callable[..., Any]:
    async def open_(platform: str, app_id: str, device_name: Optional[str], **opts: Any) -> FakeDevice:
        opts.pop("on_stage", None)
        if seen is not None:
            seen.append((platform, app_id, device_name, *([opts] if opts else [])))
        return device

    return open_


class FakeWebSession(FakeDevice):
    """A web session: each screen has a URL; `open_url` goes to the screen whose URL matches."""

    def __init__(self, screens: list[Shot], urls: list[str], *, viewport: str = "desktop") -> None:
        super().__init__(screens, device_name=f"Chromium ({viewport})")
        self.urls = urls
        self.udid = ""

    @property
    def url(self) -> str:
        return self.urls[self.pos]

    async def open_url(self, url: str) -> str:
        self.calls.append(("open_url", (url,)))
        if url in self.urls:
            self.pos = self.urls.index(url)
        self.last_screen = self.screens[self.pos]
        return f"navigated to {url}"
