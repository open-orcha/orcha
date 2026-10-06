"""Proof-of-work evidence pack — the DB half (assembles + persists; routes live in evidence_routes).

A pack is built from what the task's OWN runs recorded in the current verification round
(runs linked through worker_run_tasks that started after the last rejected verification):

  tests    — test commands found in the run output + their parsed counts (evidence_parse)
  changes  — the captured diff (worker_runs.diff) of each run, or the live checkout for a run
             still going (run_changes_routes, the same read-only reader Live changes uses);
             plain-English summary + risk flags
  dod      — each definition-of-done line: proven / not proven / needs human + evidence line;
             the agent's own report attached as a labelled claim
  links    — Live changes / captured diff per run, the task's Runs tab, PR URLs that appear in
             the recorded output
  verdikt  — the latest Verdikt handoff for the task (merged at read time, never stored here)

The pack is cached in task_evidence_packs keyed by `basis` (a signature of every input); a read
whose basis differs rebuilds it. It never changes task state: a human still verifies.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from typing import Any

from portal_backend import evidence_parse as ep

PACK_VERSION = 2  # bump when the heuristics change: cached packs rebuild on next read
MAX_RUNS = 12
PR_URL = re.compile(r"https://github\.com/[\w.-]+/[\w.-]+/pull/\d+")
URL = re.compile(r"https?://[^\s'\"<>)\]]+")


def _iso(v) -> str | None:
    return v.isoformat() if hasattr(v, "isoformat") else (str(v) if v else None)


def _result_text(result: Any) -> str:
    """The agent's own completion report (tasks.result JSONB {"result": …}) as text."""
    if result is None:
        return ""
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except ValueError:
            return result
    if isinstance(result, dict):
        r = result.get("result")
        if isinstance(r, str):
            return r
        if r is not None:
            return json.dumps(r)
        return ""
    return str(result)


def _round_start(cur, tid: str):
    """When the current verification round began: the last REJECTED verification of the task
    — a person's reject, or the Verdikt auto-fix loop sending it back (mig 068) — whose rework
    runs are what the new claim rests on; else None (all runs count)."""
    cur.execute(
        """SELECT max(created_at) AS at FROM events
            WHERE entity_type='task' AND entity_id=%s
              AND ((event_type='verified' AND coalesce(detail->>'approved','') = 'false')
                   OR event_type='verdikt_auto_rework')""",
        (tid,),
    )
    row = cur.fetchone()
    return row["at"] if row else None


def _round_runs(cur, tid: str) -> list[dict]:
    start = _round_start(cur, tid)
    cur.execute(
        """SELECT wr.run_id, wr.agent_id, wr.status, wr.exit_code, wr.started_at, wr.ended_at,
                  wr.worktree, wr.branch, wr.base_cwd, wr.runtime,
                  coalesce(wr.lane, 'work') AS lane,
                  (wr.diff IS NOT NULL) AS has_diff, length(wr.output) AS out_len,
                  a.alias AS agent_alias
             FROM worker_runs wr
             JOIN worker_run_tasks wrt ON wrt.run_id = wr.run_id
             LEFT JOIN agents a ON a.id = wr.agent_id
            WHERE wrt.task_id=%s AND (%s::timestamptz IS NULL OR wr.started_at >= %s::timestamptz)
            ORDER BY wr.started_at ASC""",
        (tid, start, start),
    )
    rows = [dict(r) for r in cur.fetchall()]
    return rows[-MAX_RUNS:], start


def _line_count(cur, rid) -> int:
    cur.execute("SELECT coalesce(max(seq), 0) AS n FROM worker_run_lines WHERE run_id=%s", (rid,))
    return int(cur.fetchone()["n"] or 0)


def basis_for(cur, task: dict) -> tuple[str, list[dict], Any]:
    """(signature, round runs, round start). The signature covers everything the pack is
    derived from, so a pack is rebuilt exactly when one of its inputs changed."""
    runs, start = _round_runs(cur, str(task["id"]))
    parts = [
        f"v{PACK_VERSION}",
        str(task.get("status")),
        hashlib.sha1((task.get("definition_of_done") or "").encode()).hexdigest()[:12],
        hashlib.sha1(_result_text(task.get("result")).encode()).hexdigest()[:12],
        _iso(start) or "-",
    ]
    for r in runs:
        extra = f"{_line_count(cur, r['run_id'])}" if r["status"] == "running" else f"{r['out_len'] or 0}:{int(bool(r['has_diff']))}"
        parts.append(f"{r['run_id']}:{r['status']}:{_iso(r['ended_at']) or '-'}:{extra}")
    return hashlib.sha1("|".join(parts).encode()).hexdigest(), runs, start


def _run_output(cur, run: dict) -> str:
    cur.execute("SELECT output FROM worker_runs WHERE run_id=%s", (run["run_id"],))
    row = cur.fetchone()
    out = (row or {}).get("output") if row else None
    if out:
        return out
    # a run still going (or reaped without a captured output) — its streamed lines
    cur.execute("SELECT line FROM worker_run_lines WHERE run_id=%s ORDER BY seq", (run["run_id"],))
    return "\n".join(r["line"] for r in cur.fetchall())


def _run_changes(cur, run: dict) -> tuple[dict, str]:
    """(changes payload, patch text) for one run: the captured diff for a finished run, the
    live checkout for a running one (read-only; degrades to available:false, never raises)."""
    from portal_backend import run_changes_routes as rc  # lazy: keeps the pure path importable

    cur.execute(
        "SELECT run_id, status, worktree, branch, base_cwd, diff, ended_at FROM worker_runs WHERE run_id=%s",
        (run["run_id"],),
    )
    row = cur.fetchone()
    if not row:
        return {"available": False, "reason": "missing", "files": []}, ""
    row = dict(row)
    try:
        payload = rc._payload(row)
    except Exception:  # noqa: BLE001 — evidence must never 500 on a git surprise
        payload = {"available": False, "reason": "git_error", "files": []}
    return payload, (row.get("diff") or "")


def build_pack(cur, task: dict) -> dict:
    """Assemble the evidence pack for `task` (a tasks row as dict). Pure read."""
    tid = str(task["id"])
    basis, runs, start = basis_for(cur, task)
    claim_text = _result_text(task.get("result"))

    # ---- tests
    invocations: list[dict] = []
    outputs: list[str] = []
    for r in runs:
        out = _run_output(cur, r)
        outputs.append(out)
        cmds = ep.extract_commands(out)
        invocations.extend(ep.test_invocations(cmds, run_id=str(r["run_id"])))
    tests = ep.summarize_tests(invocations)
    for inv in tests["latest"]:
        inv.pop("index", None)

    # ---- changes (per path the LATEST run that touched it wins)
    by_path: dict[str, dict] = {}
    patches: list[str] = []
    run_links: list[dict] = []
    unavailable: list[dict] = []
    branch = None
    for r in runs:
        payload, patch = _run_changes(cur, r)
        rid = str(r["run_id"])
        if payload.get("available"):
            for f in payload.get("files") or []:
                by_path[f["path"]] = {**{k: f.get(k) for k in ("path", "status", "additions", "deletions", "binary")},
                                      "run_id": rid}
            if patch:
                patches.append(patch)
            if payload.get("files"):
                run_links.append({
                    "run_id": rid, "agent_id": str(r["agent_id"]), "agent_alias": r.get("agent_alias"),
                    "source": payload.get("source"), "files": len(payload.get("files") or []),
                    "summary": payload.get("summary"),
                })
        elif r.get("lane") == "work":
            unavailable.append({"run_id": rid, "reason": payload.get("reason"),
                                "detail": payload.get("detail")})
        branch = r.get("branch") or payload.get("branch") or branch
    files = sorted(by_path.values(), key=lambda f: f["path"])
    changes = ep.analyze_changes(files, "\n".join(patches))
    changes["list"] = files[:200]
    changes["truncated_list"] = len(files) > 200
    changes["unavailable_runs"] = unavailable

    # ---- links
    pr_urls: list[str] = []
    for text in [claim_text, *outputs]:
        for u in PR_URL.findall(text or ""):
            if u not in pr_urls:
                pr_urls.append(u)
    links = []
    for rl in run_links:
        if rl.get("agent_alias"):
            links.append({
                "kind": "live_changes" if rl["source"] == "live" else "captured_diff",
                "label": ("Live changes" if rl["source"] == "live" else "Captured diff") + f" · run {rl['run_id'][:8]}",
                "href": f"/agents?agent={rl['agent_alias']}&changes={rl['run_id']}",
                "run_id": rl["run_id"],
            })
    links.append({"kind": "runs", "label": f"Runs ({len(runs)})", "href": f"/tasks?task={tid}&tab=runs"})
    for u in pr_urls[:3]:
        links.append({"kind": "pr", "label": "PR #" + u.rsplit("/", 1)[-1], "href": u})
    preview_urls = [u.rstrip(".,") for u in URL.findall(claim_text or "") if not PR_URL.match(u)][:3]

    # ---- DoD (Verdikt verdicts are merged at read time by `with_verdikt`)
    items = ep.split_dod(task.get("definition_of_done") or "")
    changed_paths = [f["path"] for f in files]
    dod_items = ep.assess_dod(items, tests=tests, changes=changes, changed_paths=changed_paths, claim_text=claim_text)

    return {
        "version": PACK_VERSION,
        "task_id": tid,
        "task_status": task.get("status"),
        "basis": basis,
        "built_at": datetime.now(timezone.utc).isoformat(),
        "round_started_at": _iso(start),
        "runs": [{"run_id": str(r["run_id"]), "agent_alias": r.get("agent_alias"), "status": r["status"],
                  "exit_code": r["exit_code"], "lane": r.get("lane"), "runtime": r.get("runtime"),
                  "started_at": _iso(r["started_at"]), "ended_at": _iso(r["ended_at"])} for r in runs],
        "tests": tests,
        "changes": changes,
        "branch": branch,
        "pr_urls": pr_urls,
        "preview_urls": preview_urls,
        "links": links,
        "claim": {"text": claim_text[:4000], "truncated": len(claim_text) > 4000} if claim_text else None,
        "dod_text": task.get("definition_of_done") or "",
        "dod": {"items": dod_items, **ep.dod_summary(dod_items)},
        "flags": changes["flags"],
        "_changed_paths": changed_paths,
    }


def _load_task(cur, tid: str) -> dict | None:
    cur.execute(
        "SELECT id, container_id, title, description, definition_of_done, status, result FROM tasks WHERE id=%s",
        (tid,),
    )
    row = cur.fetchone()
    return dict(row) if row else None


def ensure_pack(cur, task: dict, *, reason: str = "read", force: bool = False) -> tuple[dict, bool]:
    """The task's current pack, rebuilding + persisting when its basis changed (or `force`).
    Returns (pack, rebuilt). Caller commits."""
    tid = str(task["id"])
    cur.execute("SELECT basis, pack FROM task_evidence_packs WHERE task_id=%s", (tid,))
    row = cur.fetchone()
    if row and not force:
        basis, _runs, _start = basis_for(cur, task)
        if basis == row["basis"]:
            return dict(row["pack"]), False
    pack = build_pack(cur, task)
    cur.execute(
        """INSERT INTO task_evidence_packs (task_id, container_id, basis, pack, built_reason, built_at)
           VALUES (%s, %s, %s, %s::jsonb, %s, now())
           ON CONFLICT (task_id) DO UPDATE
             SET basis=EXCLUDED.basis, pack=EXCLUDED.pack, built_reason=EXCLUDED.built_reason,
                 built_at=now()""",
        (tid, str(task["container_id"]), pack["basis"], json.dumps(pack, default=str), reason),
    )
    return pack, True


def _ts(v) -> datetime | None:
    if isinstance(v, datetime):
        return v
    try:
        return datetime.fromisoformat(str(v)) if v else None
    except ValueError:
        return None


def in_round(pack: dict, vrun: dict | None) -> bool:
    """True when `vrun` was handed off in the pack's current verification round (after the
    last rejected verification). A verdict from an earlier round judged the previous claim,
    not the rework, so it must not prove anything now."""
    if not vrun:
        return False
    start, created = _ts(pack.get("round_started_at")), _ts(vrun.get("created_at"))
    return start is None or created is None or created >= start


_UNSET = object()


def with_verdikt(pack: dict, vrun: dict | None, verdict_run: Any = _UNSET) -> dict:
    """The public pack: Verdikt merged into the DoD checklist + summary.
    `vrun` is the task's latest serialized verdikt_runs row (verdikt_integration.run_public)
    or None — it drives the Verdikt section and the summary's Verdikt part.
    `verdict_run` is the run whose per-criterion verdicts feed the DoD checklist: the latest
    COMPLETED run of the current round (a later retry that was cancelled or could not reach
    Verdikt must not erase a real verdict). Defaults to `vrun`. Runs from a previous round
    never count (see `in_round`); a stale latest run is flagged `previous_round`."""
    out = {k: v for k, v in pack.items() if not k.startswith("_")}
    items = [dict(i) for i in (pack.get("dod") or {}).get("items") or []]
    if verdict_run is _UNSET:
        verdict_run = vrun
    if vrun and not in_round(pack, vrun):
        vrun = {**vrun, "previous_round": True}
    if verdict_run and not in_round(pack, verdict_run):
        verdict_run = None
    if verdict_run and verdict_run.get("status") == "completed" and verdict_run.get("criteria"):
        by_item: dict[int, dict] = {}
        for c in verdict_run["criteria"]:
            idx = c.get("dod_index")
            if isinstance(idx, int):
                by_item[idx] = {**c, "run_short": (verdict_run.get("verdikt_run_id") or "")[:8]}
        if by_item:
            tests = pack.get("tests") or {}
            texts = [i["text"] for i in items]
            items = ep.assess_dod(
                texts, tests=tests, changes=pack.get("changes") or {},
                changed_paths=pack.get("_changed_paths") or [f["path"] for f in (pack.get("changes") or {}).get("list") or []],
                claim_text=((pack.get("claim") or {}).get("text") or ""),
                verdikt={"by_item": by_item},
            )
    dod = {"items": items, **ep.dod_summary(items)}
    out["dod"] = dod
    out["verdikt"] = vrun
    # a run from a previous round says nothing about the current claim: keep it out of the line
    vsum = {"status": vrun.get("status"), "verdict": vrun.get("verdict")} if vrun and not vrun.get("previous_round") else None
    out["summary"] = {
        "dod": {k: dod[k] for k in ("total", "proven", "not_proven", "needs_human")},
        "tests": {k: (pack.get("tests") or {}).get(k) for k in ("status", "passed", "failed", "skipped", "errors", "suites")},
        "risk_flags": len(pack.get("flags") or []),
        "verdikt": vsum,
        "line": ep.summary_line(dod, pack.get("tests") or {}, pack.get("flags") or [], vsum),
    }
    return out


def on_task_needs_verification(tid: str, *, background: bool = True) -> None:
    """Best-effort hook for the moment a task enters needs_verification (called AFTER the
    /done commit — never inside it): build + persist the pack, then let the Verdikt
    integration decide whether this project auto-triggers a run. Runs in a daemon thread by
    default so /done never waits on git or Verdikt. Never raises."""
    if background:
        import threading

        threading.Thread(target=on_task_needs_verification, args=(tid,), kwargs={"background": False},
                         name=f"evidence-{str(tid)[:8]}", daemon=True).start()
        return
    try:
        from portal_backend.database import db_cursor

        with db_cursor() as (conn, cur):
            task = _load_task(cur, tid)
            if not task or task["status"] != "needs_verification":
                return
            pack, _ = ensure_pack(cur, task, reason="needs_verification")
            conn.commit()
        from portal_backend import verdikt_autofix as vaf
        from portal_backend import verdikt_integration as vi

        # mig 068: a rework handed back with no code change at all ends the auto-fix loop
        vaf.on_rework_done(tid, pack)
        vi.maybe_auto_trigger(tid, pack)
    except Exception:  # noqa: BLE001 — a hook must never break the transition
        return
