"""An in-memory stand-in for a Verdikt site, served over REAL HTTP (stdlib only) so the
Orcha → Verdikt client is exercised end to end (urllib transport, JSON shapes, errors).

Implements exactly the routes Orcha uses, with the shapes of verdikt/web/src/app/api/*:
  GET  /api/health                       {ok, worker:{online, lastHeartbeat}}
  POST /api/db                           read-only select executor → {data, error}
  GET  /api/scenarios?app_id=            {scenarios:[…]}
  POST /api/scenarios                    {scenario} (201)  — UNIQUE (app_id, name) → 500
  PATCH /api/scenarios/{id}              {scenario, version}
  POST /api/requests                     {request, worker} (201)
  PATCH /api/requests/{id}               {request} (cancel)
  GET  /api/artifacts/qa-runs/{path}     run artifact bytes (`files`), Range on video
Tests drive the "worker" by calling `complete(...)` / `fail(...)` on the state, or SCRIPT it:
`script(fail_a, fail_b, passing)` answers the next queued requests in order (each entry a
`scripted(...)` dict: a verdict + criteria, or `error=` for a run that failed to run) — the
auto-fix loop's fail → fail → pass sequences.
"""
from __future__ import annotations

import json
import re
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

ARTIFACT_PREFIX = "/api/artifacts/qa-runs/"
PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"\x00" * 24 + b"fake-png"
JPG_BYTES = b"\xff\xd8\xff\xe0" + b"\x00" * 16 + b"fake-jpg"
WEBM_BYTES = b"\x1aE\xdf\xa3" + bytes(range(256)) * 4  # 1028 bytes, enough to seek into


class FakeVerdikt:
    def __init__(self):
        self.lock = threading.Lock()
        self.worker_online = True
        self.tables: dict[str, list[dict]] = {k: [] for k in (
            "apps", "scenarios", "run_requests", "runs", "scenario_results", "evidence", "steps")}
        self.calls: list[tuple[str, str, object]] = []
        self.fail_next: dict[str, int] = {}
        # run artifacts served at /api/artifacts/qa-runs/<path> (written by `complete`)
        self.files: dict[str, bytes] = {}
        self.artifact_requests: list[dict] = []
        self.artifact_content_type: str | None = None  # None → the real per-type answer
        self.server = None
        self.thread = None
        # scripted worker: queued requests are answered from this list, in order
        self.scripted_results: list[dict] = []
        self.answered: list[tuple[str, dict]] = []

    # ------------------------------------------------------------------ seeding
    def add_project(self, slug, name=None, archived=False):
        row = {"id": str(uuid.uuid4()), "slug": slug, "name": name or slug, "owner_id": "o",
               "created_at": "2026-09-29T00:00:00Z", "archived_at": "2026-09-01" if archived else None}
        self.tables["apps"].append(row)
        return row

    def request_row(self, rid):
        return next(r for r in self.tables["run_requests"] if r["id"] == rid)

    def start_run(self, rid):
        req = self.request_row(rid)
        run_id = str(uuid.uuid4())
        req.update(status="running", run_id=run_id)
        self.tables["runs"].append({"id": run_id, "status": "running", "request_id": rid, "video_path": None,
                                    "counts": {}, "created_at": "2026-09-29T00:00:01Z"})
        return run_id

    def complete(self, rid, outcome, criteria, *, reason="", evidence=(), video=True, frames=()):
        req = self.request_row(rid)
        run_id = req.get("run_id") or self.start_run(rid)
        req["status"] = "completed"
        run = next(r for r in self.tables["runs"] if r["id"] == run_id)
        run.update(status="completed", video_path=f"{run_id}/run.webm" if video else None)
        sid = json.loads(req["scenario_ids"])[0] if isinstance(req["scenario_ids"], str) else req["scenario_ids"][0]
        # Verdikt stores criteria JSON as text in SQLite; the executor returns it parsed or as text
        self.tables["scenario_results"].append({"run_id": run_id, "scenario_id": sid, "outcome": outcome,
                                                "reason": reason, "criteria": json.dumps(criteria),
                                                "finding_seqs": "[]"})
        for seq, (label, sev) in enumerate(evidence, start=1):
            self.tables["evidence"].append({"run_id": run_id, "seq": seq, "severity": sev, "label": label,
                                            "note": "", "png_path": f"{run_id}/evidence/{seq:03d}-{sev}.png",
                                            "step_seq": seq})
            self.files[f"{run_id}/evidence/{seq:03d}-{sev}.png"] = PNG_BYTES
        for seq in frames:
            self.tables["steps"].append({"run_id": run_id, "seq": seq, "frame_path": f"{run_id}/frames/{seq:04d}.jpg"})
            self.files[f"{run_id}/frames/{seq:04d}.jpg"] = JPG_BYTES
        if video:
            self.files[f"{run_id}/run.webm"] = WEBM_BYTES
        # something that exists in the run folder but that Orcha never surfaced
        self.files[f"{run_id}/trace.json"] = b'{"secret": "not for the browser"}'
        return run_id

    def fail(self, rid, error):
        self.request_row(rid).update(status="failed", error=error)

    # ------------------------------------------------------------------ scripted worker
    def script(self, *results):
        """Queue answers for the NEXT requests, in order (see `scripted`)."""
        with self.lock:
            self.scripted_results.extend(results)

    def _answer_scripted(self, rid):
        if not self.scripted_results:
            return
        res = self.scripted_results.pop(0)
        self.answered.append((rid, res))
        if res.get("error"):
            self.fail(rid, res["error"])
        elif res.get("cancel"):
            self.request_row(rid).update(status="cancelled", error="cancelled in Verdikt")
        else:
            self.complete(rid, res["outcome"], res.get("criteria") or [], reason=res.get("reason", ""),
                          evidence=res.get("evidence") or (), video=res.get("video", False))

    # ------------------------------------------------------------------ query executor
    def select(self, ast):
        rows = [dict(r) for r in self.tables.get(ast["table"], [])]
        for f in ast.get("filters") or []:
            col, op, val = f["column"], f["op"], f["value"]
            if op == "eq":
                rows = [r for r in rows if r.get(col) == val]
            elif op == "in":
                rows = [r for r in rows if r.get(col) in val]
            else:
                raise ValueError("unsupported op " + op)
        for o in reversed(ast.get("order") or []):
            rows.sort(key=lambda r: str(r.get(o["column"]) or ""), reverse=not o["ascending"])
        if ast.get("limit"):
            rows = rows[: ast["limit"]]
        sel = ast.get("select") or "*"
        if sel != "*":
            cols = [c.strip() for c in sel.split(",")]
            rows = [{c: r.get(c) for c in cols} for r in rows]
        return rows

    # ------------------------------------------------------------------ http
    def handle(self, method, path, body):
        self.calls.append((method, path, body))
        key = method + " " + path.split("?")[0]
        for pref, n in list(self.fail_next.items()):
            if key.startswith(pref) and n > 0:
                self.fail_next[pref] = n - 1
                return 500, {"error": "boom"}
        u = urlparse(path)
        parts = u.path.strip("/").split("/")
        with self.lock:
            if method == "GET" and u.path == "/api/health":
                return 200, {"ok": True, "worker": {"online": self.worker_online, "lastHeartbeat": None}}
            if method == "POST" and u.path == "/api/db":
                if body.get("op") != "select":
                    return 400, {"error": {"message": "fake is read-only"}}
                if body["table"] not in self.tables:
                    return 400, {"error": {"message": "Unknown table"}}
                return 200, {"data": self.select(body), "error": None}
            if u.path == "/api/scenarios" and method == "GET":
                app_id = parse_qs(u.query).get("app_id", [""])[0]
                return 200, {"scenarios": [s for s in self.tables["scenarios"] if s["app_id"] == app_id]}
            if u.path == "/api/scenarios" and method == "POST":
                if any(s["app_id"] == body["app_id"] and s["name"] == body["name"] for s in self.tables["scenarios"]):
                    return 500, {"error": "UNIQUE constraint failed: scenarios.app_id, scenarios.name"}
                sc = {"id": str(uuid.uuid4()), "app_id": body["app_id"], "name": body["name"],
                      "category": body.get("category"), "criteria": [""], "status": "draft",
                      "target_kind": body.get("target_kind"), "tags": [], "description": None}
                self.tables["scenarios"].append(sc)
                return 201, {"scenario": sc}
            if len(parts) == 3 and parts[:2] == ["api", "scenarios"] and method == "PATCH":
                sc = next((s for s in self.tables["scenarios"] if s["id"] == parts[2]), None)
                if not sc:
                    return 404, {"error": "Not found."}
                sc.update({k: v for k, v in body.items() if k in ("criteria", "description", "tags", "status", "target_kind")})
                return 200, {"scenario": sc, "version": {"version": 1}}
            if u.path == "/api/requests" and method == "POST":
                if body.get("target_kind") == "web" and not str(body.get("locator", "")).startswith("http"):
                    return 400, {"error": "URL must start with http:// or https://.", "field": "locator"}
                req = {"id": str(uuid.uuid4()), "status": "queued", "run_id": None, "error": None,
                       "waiting_reason": None, "parent_request_id": None, "created_at": "2026-09-29T00:00:00Z",
                       "target_kind": body["target_kind"], "locator": body["locator"], "mode": body["mode"],
                       "scenario_ids": json.dumps(body.get("scenario_ids")), "project_id": body.get("project_id")}
                self.tables["run_requests"].append(req)
                answer = dict(req)  # what the queue call itself returns: still queued
                self._answer_scripted(req["id"])
                return 201, {"request": answer, "worker": "w1" if self.worker_online else None}
            if len(parts) == 3 and parts[:2] == ["api", "requests"] and method == "PATCH":
                req = next((r for r in self.tables["run_requests"] if r["id"] == parts[2]), None)
                if not req or req["status"] not in ("queued", "running"):
                    return 409, {"error": "Request is not queued or running."}
                req["status"] = "cancelled" if req["status"] == "queued" else req["status"]
                req["cancel_requested_at"] = "now"
                return 200, {"request": req}
        return 404, {"error": "no route"}

    def start(self, port: int = 0):
        fake = self

        class H(BaseHTTPRequestHandler):
            def _artifact(self):
                """GET /api/artifacts/qa-runs/<path> — bytes from `fake.files`, with Range."""
                key = unquote(urlparse(self.path).path[len(ARTIFACT_PREFIX):])
                fake.calls.append(("GET", self.path, None))
                fake.artifact_requests.append({"path": key, "range": self.headers.get("Range")})
                data = fake.files.get(key)
                if data is None:
                    body = json.dumps({"error": "not found"}).encode()
                    self.send_response(404)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                # Verdikt answers with its own content type; the portal must not trust it
                ext = key.rsplit(".", 1)[-1].lower()
                ctype = fake.artifact_content_type or {"png": "image/png", "jpg": "image/jpeg", "webm": "video/webm",
                                                       "json": "application/json"}.get(ext, "application/octet-stream")
                m = re.match(r"^bytes=(\d*)-(\d*)$", self.headers.get("Range") or "")
                if m and ext in ("webm", "mp4"):  # like Verdikt: only video is rangeable
                    start = int(m.group(1) or 0)
                    end = int(m.group(2)) if m.group(2) else len(data) - 1
                    end = min(end, len(data) - 1)
                    part = data[start:end + 1]
                    self.send_response(206)
                    self.send_header("Content-Type", ctype)
                    self.send_header("Content-Length", str(len(part)))
                    self.send_header("Content-Range", f"bytes {start}-{end}/{len(data)}")
                    self.send_header("Accept-Ranges", "bytes")
                    self.end_headers()
                    self.wfile.write(part)
                    return
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _do(self, method):
                if method == "GET" and self.path.startswith(ARTIFACT_PREFIX):
                    return self._artifact()
                n = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(n) if n else b""
                body = json.loads(raw) if raw else None
                status, payload = fake.handle(method, self.path, body)
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                self._do("GET")

            def do_POST(self):
                self._do("POST")

            def do_PATCH(self):
                self._do("PATCH")

            def log_message(self, *a):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", port), H)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def stop(self):
        if self.server:
            self.server.shutdown()
            self.server.server_close()


def scripted(outcome=None, criteria=None, *, reason="", evidence=(), error=None, cancel=False, video=False):
    """One scripted Verdikt answer: `scripted("fail", [{text, outcome, expected, actual}…])`,
    `scripted(error="worker crashed")` (the run failed to run) or `scripted(cancel=True)`."""
    return {"outcome": outcome, "criteria": list(criteria or []), "reason": reason, "evidence": list(evidence),
            "error": error, "cancel": cancel, "video": video}
