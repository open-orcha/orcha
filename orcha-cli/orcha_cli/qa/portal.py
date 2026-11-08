"""A tiny HTTP client for the portal's QA routes (docs/orcha-qa-plan.md "HTTP API").

urllib only, no new dependency. Every write carries `actor_agent_id` (in the JSON body; the raw
frame upload carries it as a query parameter). Every failure raises `PortalError` with one plain
line (`HTTP 409: <the route's detail>`, `portal unreachable: ...`): the MCP server turns it into
`error: ...` text and never crashes on it.
"""

from __future__ import annotations

import copy
import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional

DEFAULT_TIMEOUT_S = 15.0
MAX_FRAME_BYTES = 4 * 1024 * 1024
#: The live view's calls run off the action path, and a late frame is worth nothing.
LIVE_TIMEOUT_S = 3.0


class PortalError(Exception):
    """A portal call that did not succeed; `str(e)` is one line for the agent."""

    def __init__(self, message: str, status: Optional[int] = None):
        super().__init__(message)
        self.status = status


def _detail(raw: bytes) -> str:
    text = raw.decode(errors="replace").strip()
    try:
        data = json.loads(text)
    except ValueError:
        return text[:500]
    if isinstance(data, dict) and "detail" in data:
        d = data["detail"]
        if isinstance(d, list):  # FastAPI validation errors
            parts = []
            for item in d[:5]:
                if isinstance(item, dict):
                    loc = ".".join(str(x) for x in item.get("loc", []) if x != "body")
                    parts.append(f"{loc}: {item.get('msg')}" if loc else str(item.get("msg")))
            return "; ".join(parts) or text[:500]
        return str(d)[:500]
    return text[:500]


class PortalClient:
    """The QA routes of one container, acting as one agent."""

    def __init__(self, api_base: str, container_id: str, agent_id: str = "", *, timeout: float = DEFAULT_TIMEOUT_S):
        self.api_base = (api_base or "").rstrip("/")
        self.container_id = container_id
        self.agent_id = agent_id
        self.timeout = timeout

    @classmethod
    def from_identity(cls, ident: Any) -> "PortalClient":
        return cls(ident.api_base, ident.container_id, ident.agent_id)

    def with_timeout(self, timeout: float) -> "PortalClient":
        """The same client with another time limit per call."""
        out = copy.copy(self)
        out.timeout = timeout
        return out

    # ---------- transport ----------

    def _request(
        self,
        method: str,
        path: str,
        body: Any = None,
        *,
        query: Optional[dict[str, Any]] = None,
        raw: Optional[bytes] = None,
        content_type: str = "application/json",
        headers: Optional[dict[str, str]] = None,
    ) -> Any:
        """One call; the parsed JSON answer (None for an empty one). Raises `PortalError`."""
        if not self.api_base:
            raise PortalError("no portal configured (.claude/orcha.json api_base_url or ORCHA_QA_API)")
        url = self.api_base + path
        q = {k: v for k, v in (query or {}).items() if v is not None and v != ""}
        if q:
            url += ("&" if "?" in url else "?") + urllib.parse.urlencode(q)
        data = raw
        sent = {"Accept": "application/json", **(headers or {})}
        if raw is not None:
            sent["Content-Type"] = content_type
        elif body is not None:
            data = json.dumps(body, default=str).encode()
            sent["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, method=method, headers=sent)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                payload = resp.read()
        except urllib.error.HTTPError as e:
            try:
                detail = _detail(e.read())
            except Exception:  # noqa: BLE001
                detail = str(e.reason)
            raise PortalError(f"HTTP {e.code} on {method} {path}: {detail}", e.code) from None
        except (urllib.error.URLError, OSError, ValueError) as e:
            reason = getattr(e, "reason", e)
            raise PortalError(f"portal unreachable at {self.api_base}: {reason}") from None
        if not payload:
            return None
        try:
            return json.loads(payload)
        except ValueError:
            return payload.decode(errors="replace")

    def _write(self, body: Optional[dict[str, Any]]) -> dict[str, Any]:
        out = dict(body or {})
        if self.agent_id:
            out.setdefault("actor_agent_id", self.agent_id)
        return out

    def _c(self, path: str) -> str:
        if not self.container_id:
            raise PortalError("no container configured (.claude/orcha.json current_container_id or ORCHA_QA_CID)")
        return f"/api/containers/{self.container_id}/qa{path}"

    # ---------- reachability ----------

    def ping(self) -> bool:
        """Whether the portal answers at all (any HTTP status counts)."""
        try:
            urllib.request.urlopen(self.api_base + "/", timeout=3).close()
            return True
        except urllib.error.HTTPError:
            return True
        except Exception:  # noqa: BLE001
            return False

    # ---------- container scope ----------

    def overview(self) -> Any:
        return self._request("GET", self._c("/overview"))

    def targets(self) -> Any:
        return self._request("GET", self._c("/targets"))

    def put_target(self, platform: str, body: dict[str, Any]) -> Any:
        """Human only (the portal refuses an agent actor)."""
        return self._request("PUT", self._c(f"/targets/{platform}"), self._write(body))

    def get_map(self, platform: Optional[str] = None) -> Any:
        return self._request("GET", self._c("/map"), query={"platform": platform})

    def map_build_start(self, platform: str, source: str = "code") -> Any:
        """Say a build has started, so the map shows it while the code is read."""
        return self._request("POST", self._c("/map/builds"), self._write({"platform": platform, "source": source}))

    def map_import(self, payload: dict[str, Any]) -> Any:
        return self._request("POST", self._c("/map/import"), self._write(payload))

    def map_observe(self, body: dict[str, Any]) -> Any:
        return self._request("POST", self._c("/map/observe"), self._write(body))

    def map_blocked(self, body: dict[str, Any]) -> Any:
        return self._request("POST", self._c("/map/blocked"), self._write(body))

    def put_features(self, features: list[dict[str, Any]], source: str) -> Any:
        return self._request("PUT", self._c("/features"), self._write({"features": features, "source": source}))

    def run_task(self, body: dict[str, Any], run_token: Optional[str] = None) -> Any:
        """The task a session starts on: the worker's current task, else a new run task."""
        return self._request("POST", self._c("/run-task"), self._write(body),
                             headers={"X-Orcha-Run-Token": run_token} if run_token else None)

    def create_session(self, body: dict[str, Any]) -> Any:
        return self._request("POST", self._c("/sessions"), self._write(body))

    def list_sessions(self, **query: Any) -> Any:
        return self._request("GET", self._c("/sessions"), query=query)

    def flows(self, platform: Optional[str] = None) -> Any:
        return self._request("GET", self._c("/flows"), query={"platform": platform})

    def post_flows(self, platform: str, flows: list[dict[str, Any]], source: str) -> Any:
        return self._request("POST", self._c("/flows"), self._write({"platform": platform, "flows": flows, "source": source}))

    def scenarios(self, platform: Optional[str] = None, status: Optional[str] = None) -> Any:
        return self._request("GET", self._c("/scenarios"), query={"platform": platform, "status": status})

    def propose_scenario(self, body: dict[str, Any]) -> Any:
        return self._request("POST", self._c("/scenarios"), self._write(body))

    # ---------- the handoff: requests and settings ----------

    def qa_settings(self) -> Any:
        return self._request("GET", self._c("/settings"))

    def create_request(self, body: dict[str, Any], task_id: Optional[str] = None) -> Any:
        """A handoff; `task_id` is the source task. Answers `{request, qa_task_id}`."""
        path = f"/api/tasks/{task_id}/qa/requests" if task_id else self._c("/requests")
        return self._request("POST", path, self._write(body))

    def get_request(self, request_id: str) -> Any:
        return self._request("GET", f"/api/qa/requests/{request_id}")

    def list_requests(self, **query: Any) -> Any:
        return self._request("GET", self._c("/requests"), query=query)

    def memory(self) -> Any:
        return self._request("GET", self._c("/memory"))

    def triage_finding(self, finding_id: str, body: dict[str, Any]) -> Any:
        return self._request("POST", f"/api/qa/findings/{finding_id}/triage", self._write(body))

    def cancel_request(self, request_id: str) -> Any:
        return self._request("POST", f"/api/qa/requests/{request_id}/cancel", self._write({}))

    # ---------- session scope ----------

    def get_session(self, sid: str) -> Any:
        return self._request("GET", f"/api/qa/sessions/{sid}")

    def patch_session(self, sid: str, body: dict[str, Any]) -> Any:
        return self._request("PATCH", f"/api/qa/sessions/{sid}", self._write(body))

    def upload_frame(self, sid: str, jpeg: bytes, screen_hash: Optional[str] = None,
                     facts: Optional[dict[str, Any]] = None) -> Optional[str]:
        """`facts`: what the frame says (`frame_facts.read`): its fingerprint, appearance or blank."""
        if not jpeg:
            return None
        if len(jpeg) > MAX_FRAME_BYTES:
            raise PortalError(f"frame is {len(jpeg)} bytes, over the 4 MB limit")
        out = self._request(
            "POST", f"/api/qa/sessions/{sid}/frames", raw=jpeg, content_type="image/jpeg",
            query={"actor_agent_id": self.agent_id or None, "screen_hash": (screen_hash or None) and str(screen_hash)[:128], **(facts or {})},
        )
        if isinstance(out, dict):
            fid = out.get("frame_id") or out.get("id")
            return str(fid) if fid else None
        return None

    def put_live_frame(self, sid: str, jpeg: bytes, cmd_seq: int = 0, screen: Optional[tuple[int, int]] = None) -> Any:
        """The session's newest live frame; the portal keeps only the latest, in memory."""
        w, h = screen or (None, None)
        return self._request(
            "PUT", f"/api/qa/sessions/{sid}/live/frame", raw=jpeg, content_type="image/jpeg",
            query={"actor_agent_id": self.agent_id or None, "cmd_seq": cmd_seq or None, "screen_w": w or None, "screen_h": h or None},
        )

    def live_beat(self, sid: str, body: dict[str, Any]) -> Any:
        """The tool server is here: `{cmd_seq?, screen_w?, screen_h?, stream?, results?}`. Answers
        `{takeover, inputs}`: who drives the device now, and the person's inputs to apply."""
        return self._request("POST", f"/api/qa/sessions/{sid}/live/beat", self._write(body))

    def end_live(self, sid: str) -> Any:
        return self._request("DELETE", f"/api/qa/sessions/{sid}/live", query={"actor_agent_id": self.agent_id or None})

    def put_crawl_queue(self, sid: str, queue: dict[str, Any]) -> Any:
        """A planned crawl's queue as it stands (`crawl_queue.CrawlQueue.as_json`)."""
        return self._request("PUT", f"/api/qa/sessions/{sid}/crawl-queue", self._write({"queue": queue}))

    def post_steps(self, sid: str, steps: list[dict[str, Any]]) -> Any:
        return self._request("POST", f"/api/qa/sessions/{sid}/steps", self._write({"steps": steps}))

    def post_telemetry(self, sid: str, logs: list[dict[str, Any]], requests: list[dict[str, Any]]) -> Any:
        return self._request("POST", f"/api/qa/sessions/{sid}/telemetry", self._write({"logs": logs, "requests": requests}))

    def get_steps(self, sid: str, from_seq: Optional[int] = None, to_seq: Optional[int] = None) -> Any:
        return self._request("GET", f"/api/qa/sessions/{sid}/steps", query={"from_seq": from_seq, "to_seq": to_seq})

    def post_finding(self, sid: str, body: dict[str, Any]) -> Any:
        return self._request("POST", f"/api/qa/sessions/{sid}/findings", self._write(body))

    def post_measured(self, sid: str, rows: list[dict[str, Any]]) -> Any:
        return self._request("POST", f"/api/qa/sessions/{sid}/measured", self._write({"rows": rows}))

    def walks_next(self, sid: str) -> Any:
        return self._request("POST", f"/api/qa/sessions/{sid}/walks/next", self._write({}))

    def patch_walk(self, wid: str, body: dict[str, Any]) -> Any:
        return self._request("PATCH", f"/api/qa/walks/{wid}", self._write(body))

    def post_verdict(self, sid: str, body: dict[str, Any]) -> Any:
        return self._request("POST", f"/api/qa/sessions/{sid}/verdicts", self._write(body))

    # ---------- scenarios ----------

    def post_messages(self, sid: str, messages: list[dict[str, Any]]) -> Any:
        return self._request("POST", f"/api/qa/sessions/{sid}/messages", self._write({"messages": messages}))

    def drafting_board(self, sid: str, labels: bool = False) -> Any:
        return self._request("GET", f"/api/qa/sessions/{sid}/drafting", query={"labels": "true" if labels else None})

    def ask_explorer(self, sid: str, question: str, flow: Optional[str] = None) -> Any:
        return self._request("POST", f"/api/qa/sessions/{sid}/requests", self._write({"question": question, "flow": flow}))

    def next_request(self, sid: str) -> Any:
        return self._request("POST", f"/api/qa/sessions/{sid}/requests/next", self._write({}))

    def answer_request(self, request_id: str, body: dict[str, Any]) -> Any:
        return self._request("POST", f"/api/qa/requests/{request_id}/answer", self._write(body))

    def get_scenario(self, scenario_id: str) -> Any:
        return self._request("GET", f"/api/qa/scenarios/{scenario_id}")

    def scenario_trace(self, scenario_id: str) -> Any:
        return self._request("GET", f"/api/qa/scenarios/{scenario_id}/trace")

    def scenario_files(self, scenario_id: str) -> Any:
        return self._request("GET", f"/api/qa/scenarios/{scenario_id}/files")

    def reveal_example(self, scenario_id: str, ref: str) -> Any:
        return self._request("POST", f"/api/qa/scenarios/{scenario_id}/examples/reveal", self._write({"ref": ref}))

    def patch_scenario(self, scenario_id: str, body: dict[str, Any]) -> Any:
        return self._request("PATCH", f"/api/qa/scenarios/{scenario_id}", self._write(body))
