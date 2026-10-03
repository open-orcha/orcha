"""Orcha → Verdikt handoff: per-project settings, trigger, poll, auto-trigger.

What Orcha sends (one Verdikt scenario per Orcha task, reused on retry):
  * name        "Orcha <short id> · <task title>"   category "Orcha"   tags ["orcha", "orcha-task-<short>"]
  * criteria    the task's definition-of-done lines that a UI tester can check — code-level
                lines (tests pass, a file/migration/doc changed) are proven from the run
                itself, so they are NOT sent (listed as `skipped_items` in the handoff); when
                nothing UI-checkable remains every line is sent
  * description the task description, changed files, branch, PR and preview URL(s)
  * then a `mode:"scenarios"` run request for that scenario against the configured target
    (web URL / iOS bundle id / Android package; a per-trigger URL override wins, then the
    project setting, then — web only — a preview URL the agent reported)

What comes back (polled from the Verdikt site on read, throttled): request status, run id,
per-criterion verdicts mapped back to DoD lines, the scenario verdict + reason, screenshot /
recording links and the report URL. Unreachable Verdikt → `unavailable`; a request error →
`failed`; nothing after `timeout_minutes` → `timeout` (best-effort cancel). All are shown with
Retry. A Verdikt verdict is evidence only: it NEVER verifies the task. With the auto-fix loop
(mig 068, verdikt_autofix) a fail may send the task back to its agent as `system:verdikt`; a pass
leaves it in needs_verification for a human.
"""

from __future__ import annotations

import json
import re
import threading
import urllib.parse
from datetime import datetime, timedelta, timezone
from typing import Any

from portal_backend import evidence_parse as ep
from portal_backend import verdikt_preview as vp
from portal_backend.verdikt_client import (VerdiktClient, VerdiktError, artifact_path_from_url,
                                           safe_artifact_path)

OPEN_STATUSES = ("queued", "running")
POLL_MIN_INTERVAL_S = 3.0
TARGET_KINDS = ("web", "ios", "android")
TRIGGER_MODES = ("manual", "ui_changes", "always")

# test seam: tests replace this with a factory returning a fake client
client_factory = VerdiktClient


# ------------------------------------------------------------------ settings

def settings_row(cur, cid: str) -> dict | None:
    cur.execute("SELECT * FROM container_verdikt_settings WHERE container_id=%s", (cid,))
    row = cur.fetchone()
    return dict(row) if row else None


def settings_public(row: dict | None) -> dict:
    if not row:
        return {"configured": False, "enabled": False, "base_url": None, "verdikt_project": None,
                "target_kind": "web", "target_locator": None, "trigger_mode": "manual",
                "timeout_minutes": 30, "updated_at": None, "updated_by": None, **vp.settings_fields(None),
                **_autofix_fields(None)}
    return {
        "configured": bool(row.get("base_url") and row.get("verdikt_project")),
        "enabled": bool(row["enabled"]),
        "base_url": row.get("base_url"),
        "verdikt_project": row.get("verdikt_project"),
        "target_kind": row.get("target_kind") or "web",
        "target_locator": row.get("target_locator"),
        "trigger_mode": row.get("trigger_mode") or "manual",
        "timeout_minutes": int(row.get("timeout_minutes") or 30),
        "updated_at": row["updated_at"].isoformat() if row.get("updated_at") else None,
        "updated_by": str(row["updated_by"]) if row.get("updated_by") else None,
        **vp.settings_fields(row),
        **_autofix_fields(row),
    }


def _autofix_fields(row: dict | None) -> dict:
    """The auto-fix loop settings (mig 068): on/off + max attempts, and whether the trigger
    mode lets them take effect (only 'ui_changes' / 'always')."""
    from portal_backend import verdikt_autofix as vaf

    f = vaf.settings_fields(row)
    return {**f, "autofix_applies": vaf.mode_applies(row)}


def validate_locator(kind: str, locator: str | None) -> str | None:
    loc = (locator or "").strip()
    if not loc:
        return None
    if kind == "web":
        if not re.match(r"^https?://\S+$", loc, re.I):
            raise ValueError("a web target must be an http(s):// URL")
    elif not re.match(r"^[A-Za-z0-9_.-]+$", loc):
        raise ValueError(f"an {kind} target must be a bundle id / package name (letters, digits, . _ -)")
    return loc


# ------------------------------------------------------------------ serialization

def _iso(v):
    return v.isoformat() if hasattr(v, "isoformat") else v


def _proxy_base(row: dict) -> str:
    return f"/api/tasks/{row['task_id']}/verdikt/runs/{row['id']}"


def _shot_path(row: dict, shot: dict) -> str | None:
    """A stored screenshot's artifact path: recorded as `path` (new rows) or recovered from the
    server-side URL stored by older builds."""
    p = shot.get("path") or artifact_path_from_url(row.get("base_url"), shot.get("url"))
    return safe_artifact_path(p, row.get("verdikt_run_id"))


def _video_path(row: dict) -> str | None:
    return safe_artifact_path(artifact_path_from_url(row.get("base_url"), row.get("video_url")),
                              row.get("verdikt_run_id"))


def artifact_paths(row: dict) -> set[str]:
    """The allow-list for the artifact proxy: exactly the screenshot / frame / recording paths
    this run recorded (each inside its own Verdikt run folder) — nothing else is fetchable."""
    out = {p for p in (_shot_path(row, s) for s in _as_list(row.get("screenshots")) if isinstance(s, dict)) if p}
    v = _video_path(row)
    if v:
        out.add(v)
    return out


def _public_links(row: dict) -> dict:
    """Browser-safe links. Verdikt's own URLs use the SERVER-side base (e.g.
    http://host.docker.internal:31970 when the portal runs in Docker), which a browser can't
    resolve — so screenshots and the recording are served through the portal's artifact proxy,
    and the report opens through the portal's redirect (which rewrites a container-only host)."""
    base = _proxy_base(row)
    shots = []
    for s in _as_list(row.get("screenshots")):
        if not isinstance(s, dict):
            continue
        p = _shot_path(row, s)
        if not p:
            continue  # never fall back to a server-side URL
        shots.append({**s, "path": p, "url": f"{base}/artifact?path={urllib.parse.quote(p, safe='/')}"})
    v = _video_path(row)
    return {
        "screenshots": shots,
        "video_url": f"{base}/artifact?path={urllib.parse.quote(v, safe='/')}" if v else None,
        "report_url": f"{base}/report" if row.get("report_url") and row.get("verdikt_run_id") else None,
    }


def run_public(row: dict | None) -> dict | None:
    if not row:
        return None
    links = _public_links(row)
    return {
        "id": str(row["id"]),
        "task_id": str(row["task_id"]),
        "trigger": row["trigger"],
        "triggered_by": str(row["triggered_by"]) if row.get("triggered_by") else None,
        "status": row["status"],
        "verdict": row.get("verdict"),
        "reason": row.get("reason"),
        "base_url": row.get("base_url"),
        "verdikt_project_id": row.get("verdikt_project_id"),
        "verdikt_scenario_id": row.get("verdikt_scenario_id"),
        "verdikt_request_id": row.get("verdikt_request_id"),
        "verdikt_run_id": row.get("verdikt_run_id"),
        "target_kind": row.get("target_kind"),
        "locator": row.get("locator"),
        "handoff": row.get("handoff") or {},
        "criteria": row.get("criteria") or [],
        "screenshots": links["screenshots"],
        "report_url": links["report_url"],
        "video_url": links["video_url"],
        "error": row.get("error"),
        "created_at": _iso(row.get("created_at")),
        "updated_at": _iso(row.get("updated_at")),
        "last_polled_at": _iso(row.get("last_polled_at")),
        "finished_at": _iso(row.get("finished_at")),
        # mig 068: auto-triggered while the auto-fix loop applied — its verdict drives the loop
        "autofix": bool(row.get("autofix")),
        # the preview environment behind this run (mig 064), None when the run tested a
        # configured URL. Attached by `with_preview` (rows loaded through this module carry it).
        "preview": vp.public(row.get("_preview")),
    }


def with_preview(cur, row: dict | None) -> dict | None:
    if row is not None and "_preview" not in row:
        row["_preview"] = vp.for_run(cur, row["id"])
    return row


def latest_run(cur, tid: str) -> dict | None:
    cur.execute("SELECT * FROM verdikt_runs WHERE task_id=%s ORDER BY created_at DESC LIMIT 1", (tid,))
    row = cur.fetchone()
    return with_preview(cur, dict(row)) if row else None


def latest_completed_run(cur, tid: str, since=None) -> dict | None:
    """The newest run of the task that Verdikt answered with a verdict (optionally only runs
    handed off at/after `since`, the current verification round's start)."""
    cur.execute(
        """SELECT * FROM verdikt_runs WHERE task_id=%s AND status='completed'
             AND (%s::timestamptz IS NULL OR created_at >= %s::timestamptz)
           ORDER BY created_at DESC LIMIT 1""",
        (tid, since, since),
    )
    row = cur.fetchone()
    return dict(row) if row else None


def runs_for_task(cur, tid: str, limit: int = 20) -> list[dict]:
    cur.execute("SELECT * FROM verdikt_runs WHERE task_id=%s ORDER BY created_at DESC LIMIT %s", (tid, limit))
    return [with_preview(cur, dict(r)) for r in cur.fetchall()]


# ------------------------------------------------------------------ handoff payload

def is_code_level(item: str) -> bool:
    """A DoD line the run itself proves (tests / named files / migrations / docs) — not
    something a UI tester can check."""
    if ep._TEST_ITEM.search(item) and (ep._TEST_PASS.search(item) or ep._TEST_WRITE.search(item)):
        return True
    toks = [a or b for a, b in ep._PATHLIKE.findall(item)]
    if any(("/" in t or "." in t) and " " not in t.strip() for t in toks):
        return True
    if re.search(r"\bmigrations?\b", item, re.I) or ep._DOC_ITEM.search(item):
        return True
    return False


def select_criteria(dod_text: str) -> tuple[list[dict], list[dict]]:
    """([{dod_index, text}] to send, [{dod_index, text, why}] skipped)."""
    items = ep.split_dod(dod_text)
    send, skipped = [], []
    for i, t in enumerate(items):
        if is_code_level(t):
            skipped.append({"dod_index": i, "text": t, "why": "code-level — proven from the run itself"})
        else:
            send.append({"dod_index": i, "text": t})
    if not send and items:
        send = [{"dod_index": i, "text": t} for i, t in enumerate(items)]
        skipped = []
    return send, skipped


def build_handoff(task: dict, pack: dict, *, kind: str, locator: str) -> dict:
    tid = str(task["id"])
    short = tid[:8]
    send, skipped = select_criteria(task.get("definition_of_done") or "")
    files = [f["path"] for f in (pack.get("changes") or {}).get("list") or []]
    lines = [f"From Orcha task {short}: {task.get('title') or ''}".strip()]
    if task.get("description"):
        lines += ["", str(task["description"]).strip()[:2000]]
    if files:
        lines += ["", f"Changed files ({len(files)}): " + ", ".join(files[:25]) + (" …" if len(files) > 25 else "")]
    if pack.get("branch"):
        lines.append(f"Branch: {pack['branch']}")
    for u in pack.get("pr_urls") or []:
        lines.append(f"PR: {u}")
    for u in pack.get("preview_urls") or []:
        lines.append(f"Preview URL (from the agent's report): {u}")
    lines.append(f"Target: {kind}:{locator}")
    name = f"Orcha {short} · {task.get('title') or 'task'}"
    name = re.sub(r"[\r\n]+", " ", name)[:120]
    return {
        "scenario_name": name,
        "criteria": send,
        "skipped_items": skipped,
        "description": "\n".join(lines),
        "tags": ["orcha", f"orcha-task-{short}"],
        "changed_files": files[:100],
        "branch": pack.get("branch"),
        "pr_urls": pack.get("pr_urls") or [],
        "preview_urls": pack.get("preview_urls") or [],
        "task_title": task.get("title"),
        "round_started_at": pack.get("round_started_at"),
    }


def resolve_locator(settings: dict, pack: dict, override: str | None) -> str | None:
    kind = settings.get("target_kind") or "web"
    if override:
        return validate_locator(kind, override)
    if settings.get("target_locator"):
        return settings["target_locator"]
    if kind == "web":
        for u in pack.get("preview_urls") or []:
            try:
                return validate_locator("web", u)
            except ValueError:
                continue
    return None


# ------------------------------------------------------------------ trigger

class TriggerRefused(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


def _update(cur, rid: str, **fields):
    if not fields:
        return
    cols, vals = [], []
    for k, v in fields.items():
        if k in ("handoff", "criteria", "screenshots"):
            cols.append(f"{k}=%s::jsonb")
            vals.append(json.dumps(v, default=str))
        else:
            cols.append(f"{k}=%s")
            vals.append(v)
    cols.append("updated_at=now()")
    cur.execute(f"UPDATE verdikt_runs SET {', '.join(cols)} WHERE id=%s", (*vals, rid))


def create_run(cur, task: dict, settings: dict, pack: dict, *, trigger: str, actor_id: str | None,
               locator_override: str | None = None, allow_open: bool = False) -> dict:
    """Insert the verdikt_runs row (status queued, no Verdikt ids yet) under a per-task lock.
    Raises TriggerRefused for a project without Verdikt, a missing target, or an open run."""
    if not settings or not settings.get("enabled"):
        raise TriggerRefused(409, "Verdikt is not enabled for this project — set it up in Settings → Integrations")
    if not settings.get("base_url") or not settings.get("verdikt_project"):
        raise TriggerRefused(409, "Verdikt settings are incomplete — a Verdikt URL and project are required")
    tid = str(task["id"])
    cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", ("verdikt:" + tid,))
    if not allow_open:
        cur.execute("SELECT id FROM verdikt_runs WHERE task_id=%s AND status IN ('queued','running') LIMIT 1", (tid,))
        if cur.fetchone():
            raise TriggerRefused(409, "a Verdikt run for this task is already in progress")
    kind = settings.get("target_kind") or "web"
    preview = vp.wants_preview(settings, locator_override)
    if preview:
        # the task's change gets built + served first (mig 064): Verdikt is handed the preview's
        # URL once the notifier reports it ready — until then the run has no target yet
        locator = ""
    else:
        try:
            locator = resolve_locator(settings, pack, locator_override)
        except ValueError as e:
            raise TriggerRefused(400, str(e)) from e
        if not locator:
            raise TriggerRefused(400, "no target to test — set a web URL / app id in Verdikt settings or pass one")
    handoff = build_handoff(task, pack, kind=kind, locator=locator or "(the preview, once it is ready)")
    cur.execute(
        """INSERT INTO verdikt_runs (task_id, container_id, trigger, triggered_by, status, base_url,
                                     target_kind, locator, handoff)
           VALUES (%s, %s, %s, %s, 'queued', %s, %s, %s, %s::jsonb) RETURNING *""",
        (tid, str(task["container_id"]), trigger, actor_id, settings["base_url"], kind, locator,
         json.dumps(handoff, default=str)),
    )
    row = dict(cur.fetchone())
    row["_preview"] = vp.create(cur, task, settings, row) if preview else None
    return row


def send_to_verdikt(run: dict, settings: dict) -> dict:
    """Do the HTTP handoff for a freshly created run row. Returns the fields to store
    (status/ids/error). Never raises."""
    h = run.get("handoff") or {}
    if isinstance(h, str):
        h = json.loads(h)
    try:
        client = client_factory(settings["base_url"])
        health = client.health()
        project = client.project_by_slug(settings["verdikt_project"])
        if not project:
            names = ", ".join(p.get("slug") for p in client.projects()[:10] if p.get("slug")) or "none"
            return {"status": "failed", "error": f"Verdikt has no project '{settings['verdikt_project']}' (projects: {names})",
                    "finished_at": datetime.now(timezone.utc)}
        if project.get("archived_at"):
            return {"status": "failed", "error": f"Verdikt project '{settings['verdikt_project']}' is archived",
                    "finished_at": datetime.now(timezone.utc)}
        app_id = project["id"]
        existing = next((s for s in client.scenarios(app_id) if s.get("name") == h["scenario_name"]), None)
        sc = existing or client.create_scenario(app_id, h["scenario_name"], category="Orcha",
                                                target_kind=run["target_kind"])
        client.update_scenario(sc["id"], {
            "criteria": [c["text"] for c in h["criteria"]],
            "description": h["description"],
            "tags": h["tags"],
            "status": "validated",
            "target_kind": run["target_kind"],
        })
        queued = client.queue_request({
            "target_kind": run["target_kind"],
            "locator": run["locator"],
            "mode": "scenarios",
            "scenario_ids": [sc["id"]],
            "project_id": app_id,
            "mobile": False,
        })
        req = queued["request"]
        worker_online = bool(queued.get("worker")) or bool((health.get("worker") or {}).get("online"))
        h2 = {**h, "verdikt_project": {"id": app_id, "slug": project.get("slug"), "name": project.get("name")},
              "worker_online_at_queue": worker_online, "scenario_reused": bool(existing)}
        return {"status": "queued", "verdikt_project_id": app_id, "verdikt_scenario_id": sc["id"],
                "verdikt_request_id": req["id"], "handoff": h2,
                "error": None if worker_online else "queued — no Verdikt worker is online to run it yet"}
    except VerdiktError as e:
        return {"status": "unavailable" if e.unreachable else "failed", "error": str(e),
                "finished_at": datetime.now(timezone.utc)}
    except Exception as e:  # noqa: BLE001
        return {"status": "failed", "error": f"handoff failed: {type(e).__name__}: {e}",
                "finished_at": datetime.now(timezone.utc)}


# ------------------------------------------------------------------ poll

def _as_list(v) -> list:
    if isinstance(v, str):
        try:
            v = json.loads(v)
        except ValueError:
            return []
    return v if isinstance(v, list) else []


def _norm(t: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (t or "").lower().replace("[warning]", ""))


def map_criteria(sent: list[dict], results: list) -> list[dict]:
    """Verdikt's criterion results → [{dod_index, text, outcome, expected, actual, from_step,
    to_step, evidence_seq}], matched to what Orcha sent by normalised text, else position."""
    results = [r if isinstance(r, dict) else {"text": str(r)} for r in results]
    by_text = {_norm(r.get("text") or ""): r for r in results}
    out = []
    for pos, s in enumerate(sent):
        r = by_text.get(_norm(s["text"]))
        if r is None and pos < len(results):
            r = results[pos]
        r = r or {}
        out.append({
            "dod_index": s["dod_index"], "text": s["text"],
            "outcome": r.get("outcome"),
            "expected": r.get("expected"), "actual": r.get("actual"),
            "from_step": r.get("from_step"), "to_step": r.get("to_step"),
            "evidence_seq": r.get("evidence_seq"),
        })
    return out


def poll_once(run: dict) -> dict:
    """Ask Verdikt about an open run. Returns the fields to store. Never raises."""
    now = datetime.now(timezone.utc)
    fields: dict[str, Any] = {"last_polled_at": now}
    try:
        client = client_factory(run["base_url"])
        req = client.request(run["verdikt_request_id"])
        if not req:
            return {**fields, "status": "failed", "error": "the Verdikt request no longer exists", "finished_at": now}
        st = req.get("status")
        if st in ("queued", "running"):
            fields["status"] = st
            if st == "running":
                fields["error"] = None
            elif req.get("waiting_reason"):
                fields["error"] = f"waiting: {req['waiting_reason']}"
            else:
                # still queued: keep saying so honestly while no Verdikt worker is online
                try:
                    online = bool(((client.health() or {}).get("worker") or {}).get("online"))
                except VerdiktError:
                    online = True  # unknown — don't claim the worker is offline
                fields["error"] = None if online else "queued — no Verdikt worker is online to run it yet"
            if req.get("run_id"):
                fields["verdikt_run_id"] = req["run_id"]
                fields["report_url"] = client.report_url(req["run_id"])
            return fields
        if st == "cancelled":
            return {**fields, "status": "cancelled", "error": req.get("error") or "cancelled in Verdikt",
                    "finished_at": now}
        # terminal: completed / failed — collect runs (the request's, its fan-out children's,
        # and any run linked back by runs.request_id) and the scenario's verdict
        owners = [req["id"]] + [c["id"] for c in client.child_requests(req["id"])]
        run_ids = [r for r in [req.get("run_id")] if r]
        run_ids += [r["id"] for r in client.runs_for_requests(owners) if r["id"] not in run_ids]
        results = client.scenario_results(run_ids, run["verdikt_scenario_id"]) if run_ids else []
        best = None
        for r in results:  # a real verdict beats blocked/unprocessable; later run wins ties
            key = (r.get("outcome") in ("pass", "fail", "warning"), run_ids.index(r["run_id"]) if r["run_id"] in run_ids else -1)
            if best is None or key >= best[0]:
                best = (key, r)
        sent = (run.get("handoff") or {}).get("criteria") or []
        if best is None:
            err = req.get("error") or ("Verdikt finished without a verdict for this scenario" if st == "completed"
                                       else "the Verdikt run failed")
            fields.update(status="failed", error=err, finished_at=now)
            if run_ids:
                fields.update(verdikt_run_id=run_ids[-1], report_url=client.report_url(run_ids[-1]))
            return fields
        res = best[1]
        vrid = res["run_id"]
        criteria = map_criteria(sent, _as_list(res.get("criteria")))
        shots = []
        for e in client.evidence(vrid):
            if e.get("png_path"):
                shots.append({"url": client.artifact_url(e["png_path"]), "path": e["png_path"],
                              "label": e.get("label") or f"Evidence {e['seq']}",
                              "severity": e.get("severity"), "seq": e.get("seq"), "kind": "evidence"})
        if not shots:
            for f in client.frames(vrid, limit=3):
                if f.get("frame_path"):
                    shots.append({"url": client.artifact_url(f["frame_path"]), "path": f["frame_path"],
                                  "label": f"Step {f['seq']}", "seq": f.get("seq"), "kind": "frame"})
        vrow = next((r for r in client.runs([vrid])), {})
        fields.update(
            status="completed", verdict=res.get("outcome"), reason=res.get("reason"),
            verdikt_run_id=vrid, report_url=client.report_url(vrid), criteria=criteria, screenshots=shots,
            video_url=client.artifact_url(vrow["video_path"]) if vrow.get("video_path") else None,
            error=None if st == "completed" else (req.get("error") or None), finished_at=now,
        )
        return fields
    except VerdiktError as e:
        # transient: keep the run open; the timeout closes it for good
        return {**fields, "error": f"last check failed: {e}"}
    except Exception as e:  # noqa: BLE001
        return {**fields, "error": f"last check failed: {type(e).__name__}: {e}"}


def refresh_run(cur, run: dict, *, timeout_minutes: int = 30, force: bool = False) -> dict:
    """Poll an open run (throttled) and persist. Returns the updated row."""
    if run["status"] not in OPEN_STATUSES:
        return run
    now = datetime.now(timezone.utc)
    if not run.get("verdikt_request_id"):
        prev = run.get("_preview") if "_preview" in run else vp.for_run(cur, run["id"])
        if prev:
            # preview-backed: Verdikt gets the run once the preview is ready (mig 064)
            return with_preview(cur, vp.reconcile(cur, run, prev, timeout_minutes=timeout_minutes))
        # the handoff never completed (crash between insert and send) — close it honestly
        if now - run["created_at"] > timedelta(minutes=2):
            _update(cur, str(run["id"]), status="failed", error="the handoff to Verdikt did not complete",
                    finished_at=now)
            cur.execute("SELECT * FROM verdikt_runs WHERE id=%s", (run["id"],))
            return dict(cur.fetchone())
        return run
    if now - run["created_at"] > timedelta(minutes=timeout_minutes):
        # Polling is read-driven: a verdict may have landed while nobody was looking. Ask once
        # before giving up, and keep a real terminal answer instead of overwriting it as timeout.
        fields = poll_once(run)
        if fields.get("status") and fields["status"] not in OPEN_STATUSES:
            _update(cur, str(run["id"]), **fields)
            vp.stop_for_run(cur, run["id"], f"the Verdikt run is {fields['status']}")
            cur.execute("SELECT * FROM verdikt_runs WHERE id=%s", (run["id"],))
            return with_preview(cur, dict(cur.fetchone()))
        try:
            client_factory(run["base_url"]).cancel_request(run["verdikt_request_id"])
        except Exception:  # noqa: BLE001 — best effort
            pass
        _update(cur, str(run["id"]), status="timeout",
                error=f"no result from Verdikt within {timeout_minutes} min", finished_at=now)
        vp.stop_for_run(cur, run["id"], "the Verdikt run timed out")
        cur.execute("SELECT * FROM verdikt_runs WHERE id=%s", (run["id"],))
        return with_preview(cur, dict(cur.fetchone()))
    last = run.get("last_polled_at")
    if not force and last and (now - last).total_seconds() < POLL_MIN_INTERVAL_S:
        return run
    fields = poll_once(run)
    _update(cur, str(run["id"]), **fields)
    cur.execute("SELECT * FROM verdikt_runs WHERE id=%s", (run["id"],))
    row = dict(cur.fetchone())
    if row["status"] not in OPEN_STATUSES:
        vp.stop_for_run(cur, row["id"], f"the Verdikt run is {row['status']}")
    return with_preview(cur, row)


def refresh_latest(cur, task: dict, *, force: bool = False) -> dict | None:
    run = latest_run(cur, str(task["id"]))
    if run and run["status"] in OPEN_STATUSES:
        s = settings_row(cur, str(task["container_id"])) or {}
        run = refresh_run(cur, run, timeout_minutes=int(s.get("timeout_minutes") or 30), force=force)
    return run


# ------------------------------------------------------------------ orchestration

def trigger(task: dict, *, trigger_kind: str, actor_id: str | None, locator_override: str | None = None,
            pack: dict | None = None) -> dict:
    """Create + send a run. Raises TriggerRefused. Returns the stored row (serialized)."""
    from portal_backend.database import db_cursor
    from portal_backend import evidence_pack

    with db_cursor() as (conn, cur):
        settings = settings_row(cur, str(task["container_id"]))
        if pack is None:
            pack, _ = evidence_pack.ensure_pack(cur, task, reason="verdikt")
        row = create_run(cur, task, settings or {}, pack, trigger=trigger_kind, actor_id=actor_id,
                         locator_override=locator_override)
        if trigger_kind == "auto":
            # mig 068: an automatic run started while auto-fix applies drives the loop
            from portal_backend import verdikt_autofix as vaf

            row["autofix"] = vaf.mark_run(cur, task, row["id"])
        from portal_backend.agent_status import log_event

        log_event(cur, str(task["container_id"]), "human" if actor_id else "system", actor_id, "task",
                  str(task["id"]), "verdikt_triggered",
                  {"verdikt_run": str(row["id"]), "trigger": trigger_kind,
                   "target": f"{row['target_kind']}:{row['locator']}" if row["locator"] else "preview"})
        prev = row.get("_preview")
        if prev is not None:
            # preview-backed: the notifier builds + serves the change first; the handoff to
            # Verdikt happens when it reports the preview ready (verdikt_preview_routes)
            if prev["status"] == "failed":
                vp.fail_run(cur, row, "Preview failed: " + (prev.get("error") or "unknown error"))
            cur.execute("SELECT * FROM verdikt_runs WHERE id=%s", (row["id"],))
            row = with_preview(cur, dict(cur.fetchone()))
            conn.commit()
            return run_public(row)
        conn.commit()
    fields = send_to_verdikt(row, settings)
    with db_cursor() as (conn, cur):
        _update(cur, str(row["id"]), **fields)
        cur.execute("SELECT * FROM verdikt_runs WHERE id=%s", (row["id"],))
        row = dict(cur.fetchone())
        row["_preview"] = None
        conn.commit()
    return run_public(row)


def should_auto_trigger(settings: dict | None, pack: dict) -> bool:
    if not settings or not settings.get("enabled") or not settings.get("base_url") or not settings.get("verdikt_project"):
        return False
    mode = settings.get("trigger_mode") or "manual"
    if mode == "always":
        return True
    if mode == "ui_changes":
        return bool((pack.get("changes") or {}).get("ui_touching"))
    return False


def maybe_auto_trigger(tid: str, pack: dict, *, background: bool = False) -> dict | None:
    """Auto-trigger per the project's policy, at most once per verification round. Never raises."""
    def _go():
        try:
            from portal_backend.database import db_cursor
            with db_cursor() as (conn, cur):
                cur.execute("SELECT id, container_id, title, description, definition_of_done, status, result "
                            "FROM tasks WHERE id=%s", (tid,))
                task = cur.fetchone()
                if not task or task["status"] != "needs_verification":
                    return None
                task = dict(task)
                settings = settings_row(cur, str(task["container_id"]))
                from portal_backend import verdikt_autofix as vaf

                # a running auto-fix loop always checks the rework (it may touch no UI file)
                if not should_auto_trigger(settings, pack) and not (
                        vaf.mode_applies(settings) and vaf.force_trigger(cur, tid)):
                    return None
                start = pack.get("round_started_at")
                cur.execute(
                    """SELECT 1 FROM verdikt_runs WHERE task_id=%s AND trigger='auto'
                         AND (%s::timestamptz IS NULL OR created_at >= %s::timestamptz) LIMIT 1""",
                    (tid, start, start),
                )
                if cur.fetchone():
                    return None
            return trigger(task, trigger_kind="auto", actor_id=None, pack=pack)
        except TriggerRefused as e:
            # a running auto-fix loop can't continue without a run: hand it to a person
            from portal_backend import verdikt_autofix as vaf

            vaf.stop_unstartable(tid, e.detail)
            return None
        except Exception:  # noqa: BLE001 — auto-trigger must never break the caller
            return None

    if background:
        threading.Thread(target=_go, name=f"verdikt-auto-{tid[:8]}", daemon=True).start()
        return None
    return _go()
