"""Durable preview/confirm project cleanup, shared by host, CLI and desktop.

Plans and archives are private local files in the project's Git common directory.
No file contents are sent to the portal or attached to a task. A terminal per-item
receipt makes retrying the SAME plan safe after an interrupted command.
"""
from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import time
from uuid import UUID, uuid4

from . import worktree_gc as gc
from . import worktree_lifecycle as lifecycle
from . import worktree_cleanup_scan as scan
from .job_store import atomic_json, read_json, worktree_teardown_guard, _private_directory, _sync_directory

CleanupError = scan.CleanupError


def _read(root, name, default=None):
    p = root / name
    return read_json(p) if p.exists() else default


def _plan_path(root, plan_id):
    return root / (str(UUID(plan_id)) + ".json")


def public(plan):
    """Bounded metadata only; file manifests and hashes stay on disk."""
    rows = [{k: v for k, v in r.items() if k in {
        "path", "name", "branch", "head", "registered", "state", "reason", "size_bytes",
        "unmerged_commits", "output_bytes", "output_count", "outcome", "saved_to", "discarded_caches",
    }} for r in plan.get("items", [])]
    candidates = [r for r in rows if r["state"] == "eligible"]
    removed = [r for r in rows if r.get("outcome") == "removed"]
    return {"ok": plan["status"] != "failed", "plan_id": plan["id"], "status": plan["status"],
            "items": rows, "scanned": len(rows), "total": plan.get("total", 0),
            "candidate_count": len(candidates), "candidate_bytes": sum(r.get("size_bytes") or 0 for r in candidates),
            "unknown_sizes": sum(r.get("size_bytes") is None for r in rows),
            "removed": removed, "kept": [r for r in rows if r.get("outcome") != "removed"],
            "freed_bytes": sum(max(0, (r.get("size_bytes") or 0) - r.get("output_bytes", 0)) for r in removed),
            "error": plan.get("error")}


def status(base, plan_id):
    root = scan.common_dir(base) / "orcha" / "worktree-cleanup"
    return public(read_json(_plan_path(root, plan_id)))


def _activity(activity, rows):
    value = activity(rows)
    if not isinstance(value, dict) or value.get("complete") is not True:
        raise CleanupError("Activity information is unavailable; no folders can be removed")
    return value


def _blocked(row, activity, root, *, check_jobs=True, base=None):
    if row.get("blocked"):
        return row["blocked"]
    if row.get("locked"):
        return "Locked worktree"
    if gc.path_in_use(row["path"], activity.get("busy", ())):
        return "An active task, run, session or preview needs this folder"
    ctx = activity.get("contexts", {}).get(row["path"], {})
    if ctx.get("running") or ctx.get("protected") or ctx.get("task_status") == "in_progress":
        return "An in-progress task or live session needs this folder"
    if row.get("task_ref") and not ctx.get("task_id"):
        return "The owning task could not be verified"
    if lifecycle.recently_provisioned(root, row["path"]):
        return "A worker is starting or recently reused this folder"
    hold = gc.retention_hold(row["path"])
    if hold:
        return hold
    admin = Path(row["admin"]) if row.get("admin") else None
    if admin and any(admin.glob("*.lock")):
        return "Git is changing this checkout"
    if check_jobs:
        with worktree_teardown_guard(base, row["path"]) as retained:
            if retained:
                return retained
    return None


def preview(base, activity, *, progress=None, plan_id=None, measure=scan.bounded_size):
    plan_id = str(UUID(plan_id)) if plan_id else str(uuid4())
    with lifecycle.operation(base, plan_id):
        return _preview(base, activity, progress=progress, plan_id=plan_id, measure=measure)


def _preview(base, activity, *, progress, plan_id, measure):
    with lifecycle.locked(base) as root:
        target = _plan_path(root, plan_id)
        existing = _read(root, target.name)
        if existing and existing["status"] not in ("scanning", "failed"):
            return public(existing)
        known = _read(root, "known.json", {})
    rows = scan.discover(base, known)
    plan = {"id": plan_id, "project": str(scan.common_dir(base)), "status": "scanning",
            "items": [], "total": len(rows), "created_at": time.time()}
    atomic_json(target, plan)
    def publish():
        atomic_json(target, plan)
        if progress:
            progress(public(plan))
    publish()
    try:
        facts = _activity(activity, rows)
        refs = gc.base_refs(str(base))
        for row in rows:
            row = dict(row, state="kept", output_count=0, output_bytes=0, size_bytes=None)
            row["reason"] = _blocked(row, facts, root, base=base)
            if not row["reason"]:
                try:
                    snapshot = scan.snapshot(row)
                    snapshot_name = f"{plan_id}-snapshot-{len(plan['items'])}.json"
                    atomic_json(root / snapshot_name, snapshot)
                    row["snapshot_file"] = snapshot_name
                    row["discarded_caches"] = snapshot["generated_roots"]
                    if row.get("head"):
                        code, count = gc.git(["rev-list", "--count", row["head"], "--not", *refs], str(base))
                        row["unmerged_commits"] = int(count.strip()) if code == 0 else None
                    row["output_count"] = len(snapshot["files"])
                    row["output_bytes"] = sum(f.get("size", 0) for f in snapshot["files"].values())
                    row["state"] = "eligible"
                    row["reason"] = "Save files and keep commits before removing this checkout"
                except (OSError, CleanupError) as exc:
                    row["reason"] = str(exc) if isinstance(exc, CleanupError) else "Files could not be inspected"
            row["size_bytes"] = measure(row["path"])
            plan["items"].append(row)
            publish()
        with lifecycle.locked(base):
            known = _read(root, "known.json", {})
            for row in rows:
                if row.get("registered") and not row.get("blocked"):
                    known[row["path"]] = {k: row[k] for k in ("identity", "head", "branch")}
            atomic_json(root / "known.json", known)
        plan["status"] = "ready"
    except (OSError, CleanupError) as exc:
        plan.update(status="failed", error=str(exc) if isinstance(exc, CleanupError) else "Preview could not be saved")
    publish()
    return public(plan)


def _preserve(base, root, plan_id, row, snapshot):
    key = str(uuid4())
    dest = root / "saved" / plan_id / key
    for parent in (dest.parent.parent, dest.parent, dest):
        _private_directory(parent)
    files = snapshot["files"]
    for rel, meta in files.items():
        source, target = Path(row["path"]) / rel, dest / "files" / rel
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if meta["kind"] == "symlink":
            # Store link values in the manifest; do not create traversable archive links.
            continue
        if source.is_symlink():
            raise CleanupError("A file changed into a link while saving")
        with open(source, "rb") as src, open(target, "xb") as out:
            os.chmod(target, 0o600)
            shutil.copyfileobj(src, out)
            out.flush()
            os.fsync(out.fileno())
        if scan.digest_file(target) != meta["sha256"]:
            raise CleanupError("Saved content did not match the preview")
    if row.get("head"):
        scan.checked_git(base, "update-ref", f"refs/orcha/cleanup/{plan_id}/{key}/head", row["head"])
    if row.get("admin"):
        code, patch = gc.git(["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD", "--"], row["path"])
        if code:
            raise CleanupError("Tracked changes could not be preserved")
        with open(dest / "tracked.patch", "x", encoding="utf-8", errors="surrogateescape") as out:
            os.chmod(dest / "tracked.patch", 0o600)
            out.write(patch)
    if row.get("admin") and snapshot["index"]:
        index = Path(row["admin"]) / "index"
        shutil.copyfile(index, dest / "index")
        os.chmod(dest / "index", 0o600)
        if scan.digest_file(dest / "index") != snapshot["index"]:
            raise CleanupError("Staged changes changed while saving")
        temporary_index = dest / "tree-index"
        shutil.copyfile(index, temporary_index)
        os.chmod(temporary_index, 0o600)
        env = dict(os.environ, GIT_INDEX_FILE=str(temporary_index))
        proc = subprocess.run(["git", "write-tree"], cwd=row["path"], env=env,
                              capture_output=True, text=True, timeout=60)
        if proc.returncode:
            raise CleanupError("Unresolved staged changes prevent safe preservation")
        tree = proc.stdout.strip()
        # Reachable tree preserves even staged-only blobs after the checkout is gone.
        scan.checked_git(base, "update-ref", f"refs/orcha/cleanup/{plan_id}/{key}/index", tree)
    atomic_json(dest / "manifest.json", {"path": row["path"], "head": row.get("head"),
                                         "branch": row.get("branch"), **snapshot})
    for directory, _, names in os.walk(dest):
        for name in names:
            with open(Path(directory) / name, "rb") as stream:
                os.fsync(stream.fileno())
        _sync_directory(Path(directory))
    _sync_directory(dest.parent)
    _sync_directory(dest.parent.parent)
    return str(dest)


def execute(base, plan_id, activity, *, progress=None):
    with lifecycle.operation(base, plan_id):
        return _execute(base, plan_id, activity, progress=progress)


def _execute(base, plan_id, activity, *, progress=None):
    with lifecycle.locked(base) as root:
        target = _plan_path(root, plan_id)
        plan = read_json(target)
        if plan["project"] != str(scan.common_dir(base)):
            raise CleanupError("The preview belongs to another project")
        if plan["status"] not in ("ready", "executing", "done"):
            raise CleanupError("A complete preview must be confirmed first")
        if plan["status"] == "done":
            return public(plan)
        plan["status"] = "executing"
        atomic_json(target, plan)
    def publish():
        atomic_json(target, plan)
        if progress:
            progress(public(plan))
    for row in plan["items"]:
        if row.get("outcome") or row["state"] != "eligible":
            continue
        try:
            # Durable per-checkout reservation blocks reuse without blocking unrelated work.
            with lifecycle.cleanup_claim(base, row["path"], plan_id):
                current = {r["path"]: r for r in scan.discover(base, _read(root, "known.json", {}), only_path=row["path"])}
                fresh = current.get(row["path"])
                if row.get("removing") and not Path(row["path"]).exists() and not fresh:
                    row.update(outcome="removed", reason="Recovered the saved removal result")
                    publish()
                    continue
                if not fresh or any(fresh.get(k) != row.get(k) for k in ("identity", "head", "branch", "registered")):
                    raise CleanupError("The checkout changed since the preview")
                facts = _activity(activity, [fresh])
                # Already holding the managed-job lock: avoid recursively acquiring it.
                why = _blocked_without_job(fresh, facts, root)
                if why:
                    raise CleanupError(why)
                expected = read_json(root / row["snapshot_file"])
                if scan.snapshot(fresh) != expected:
                    raise CleanupError("Files changed since the preview; retained")
                row["saved_to"] = _preserve(base, root, plan["id"], row, expected)
                # Recheck content, commits and activity after potentially slow copying.
                if scan.snapshot(fresh) != expected:
                    raise CleanupError("Files changed while saving; retained")
                latest = {r["path"]: r for r in scan.discover(base, _read(root, "known.json", {}), only_path=row["path"])}.get(row["path"])
                if latest != fresh or _blocked_without_job(fresh, _activity(activity, [fresh]), root):
                    raise CleanupError("Checkout ownership or activity changed; retained")
                row["removing"] = True
                publish()  # Durable intent before the irreversible filesystem operation.
                if row["registered"]:
                    code, _ = gc.git(["worktree", "remove", "--force", "--", row["path"]], str(base), timeout=300)
                    if code:
                        raise CleanupError("Git did not finish removal; inspect this folder before retrying")
                else:
                    # Owned orphan only; snapshot rejected nested repos and never follows links.
                    if not shutil.rmtree.avoids_symlink_attacks:
                        raise CleanupError("This platform cannot safely remove an orphan folder")
                    shutil.rmtree(row["path"])
                row.update(outcome="removed", reason="Files saved privately; commits and branches retained")
        except (OSError, CleanupError, subprocess.SubprocessError) as exc:
            row.update(outcome="kept", reason=str(exc) if isinstance(exc, CleanupError) else "Could not safely finish; folder retained")
        publish()
    plan["status"] = "done"
    publish()
    return public(plan)


def _blocked_without_job(row, activity, root):
    # The durable checkout claim already fences managed-command starts.
    return _blocked(row, activity, root, check_jobs=False)
