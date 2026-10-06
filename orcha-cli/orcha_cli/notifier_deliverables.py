"""Collect a run's non-code deliverables from its outputs folder and upload them.

An agent working a task writes deliverables (a report, a CSV, a chart, a PDF) to
``<run cwd>/.orcha/outputs/``. When the run is reaped, the notifier scans that folder and
uploads every allowed file to ``POST /api/tasks/<task>/deliverables`` with the run's id.
The portal versions a file per logical path and deduplicates identical bytes, so a
re-scan (the task worktree is reused by the next run) is idempotent: only files the run
actually changed become a new version.

Confinement: symlinks are never followed, hidden files/dirs are skipped, the walk is
depth- and count-capped, and every candidate's realpath must sit inside the outputs
folder. Size/type caps mirror the portal's (the portal re-validates everything).
Best-effort: this never raises into the reaper.
"""

from __future__ import annotations

import json
import mimetypes
import os
import pathlib
import urllib.error
import urllib.request
import uuid
from typing import Callable, Optional

OUTPUTS_RELATIVE = pathlib.Path(".orcha") / "outputs"
ALLOWED_EXTENSIONS = frozenset({
    "md", "markdown", "txt", "log", "yaml", "yml", "csv", "tsv", "json",
    "pdf", "png", "jpg", "jpeg", "gif", "webp",
})
MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_FILES_PER_RUN = 50
MAX_DEPTH = 4

# One sentence the wake/persona prompt can carry so agents know where deliverables go.
DELIVERABLES_GUIDANCE = (
    "## Deliverables\n"
    "If this task asks for a document, report, table, chart or other non-code output, "
    "write each file to `.orcha/outputs/` in your working directory (markdown, txt, csv, "
    "json, pdf, png/jpg; max 10 MiB each; sub-folders allowed). Orcha attaches them to the "
    "task when your run ends — keep the same file name to publish a new version of it."
)


def outputs_dir(cwd) -> pathlib.Path:
    return pathlib.Path(cwd) / OUTPUTS_RELATIVE


def ensure_outputs_dir(cwd) -> Optional[pathlib.Path]:
    """Create the outputs folder with a self-ignoring .gitignore (deliverables are stored
    by Orcha, not committed with the code). Returns the folder, or None on failure."""
    try:
        d = outputs_dir(cwd)
        d.mkdir(parents=True, exist_ok=True)
        gi = d / ".gitignore"
        if not gi.exists():
            gi.write_text("*\n", encoding="utf-8")
        return d
    except OSError:
        return None


def scan_outputs(cwd) -> tuple[list[tuple[str, pathlib.Path]], list[dict]]:
    """Return ([(logical_path, file)], [skipped{path, reason}]) for the outputs folder."""
    root = outputs_dir(cwd)
    found: list[tuple[str, pathlib.Path]] = []
    skipped: list[dict] = []
    try:
        if root.is_symlink() or not root.is_dir():
            return found, skipped
        real_root = os.path.realpath(root)
    except OSError:
        return found, skipped
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        rel_dir = os.path.relpath(dirpath, root)
        depth = 0 if rel_dir == "." else rel_dir.count(os.sep) + 1
        # prune hidden + too-deep dirs in place (os.walk honours the mutation)
        dirnames[:] = sorted(
            d for d in dirnames
            if not d.startswith(".") and depth + 1 < MAX_DEPTH
        )
        for name in sorted(filenames):
            if name.startswith("."):
                continue
            full = pathlib.Path(dirpath) / name
            logical = name if rel_dir == "." else f"{rel_dir.replace(os.sep, '/')}/{name}"
            try:
                if full.is_symlink():
                    skipped.append({"path": logical, "reason": "symlink"})
                    continue
                real = os.path.realpath(full)
                if not real.startswith(real_root + os.sep) or not full.is_file():
                    skipped.append({"path": logical, "reason": "outside outputs"})
                    continue
                ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
                if ext not in ALLOWED_EXTENSIONS:
                    skipped.append({"path": logical, "reason": "unsupported type"})
                    continue
                size = full.stat().st_size
                if size == 0:
                    skipped.append({"path": logical, "reason": "empty"})
                    continue
                if size > MAX_FILE_BYTES:
                    skipped.append({"path": logical, "reason": "too large"})
                    continue
            except OSError:
                skipped.append({"path": logical, "reason": "unreadable"})
                continue
            if len(found) >= MAX_FILES_PER_RUN:
                skipped.append({"path": logical, "reason": "file cap reached"})
                continue
            found.append((logical, full))
    return found, skipped


def encode_multipart(fields: dict, file_name: str, data: bytes) -> tuple[bytes, str]:
    """Encode form fields + one ``file`` part; returns (body, content-type header)."""
    boundary = "orcha-" + uuid.uuid4().hex
    ctype = mimetypes.guess_type(file_name)[0] or "application/octet-stream"
    body = bytearray()
    for key, value in fields.items():
        if value is None:
            continue
        value = str(value).replace("\r", " ").replace("\n", " ")
        body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n"
                 f"{value}\r\n").encode()
    safe_name = file_name.replace('"', "_").replace("\r", "_").replace("\n", "_")
    body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; "
             f"filename=\"{safe_name}\"\r\nContent-Type: {ctype}\r\n\r\n").encode()
    body += data + f"\r\n--{boundary}--\r\n".encode()
    return bytes(body), f"multipart/form-data; boundary={boundary}"


def _post_multipart(url: str, fields: dict, file_name: str, data: bytes,
                    timeout: float = 30.0) -> tuple[int, Optional[dict]]:
    body, content_type = encode_multipart(fields, file_name, data)
    req = urllib.request.Request(
        url, data=body, method="POST", headers={"Content-Type": content_type},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read() or b"null")
    except urllib.error.HTTPError as exc:
        return exc.code, None
    except (urllib.error.URLError, ValueError, OSError):
        return 0, None


def collect_run_deliverables(
    api_base: str,
    task_id,
    run_id,
    cwd,
    *,
    post_multipart: Callable[..., tuple[int, Optional[dict]]] = _post_multipart,
) -> dict:
    """Upload a run's outputs folder to its task. Returns a summary dict; never raises."""
    summary = {"uploaded": [], "unchanged": [], "failed": [], "skipped": []}
    if not (api_base and task_id and cwd):
        return summary
    try:
        files, skipped = scan_outputs(cwd)
    except Exception:
        return summary
    summary["skipped"] = skipped
    for logical, full in files:
        try:
            data = full.read_bytes()
        except OSError:
            summary["failed"].append({"path": logical, "status": 0})
            continue
        status, res = post_multipart(
            f"{api_base}/api/tasks/{task_id}/deliverables",
            {"path": logical, "run_id": str(run_id) if run_id else None},
            full.name,
            data,
        )
        if status == 201 and isinstance(res, dict):
            (summary["unchanged"] if res.get("deduplicated") else summary["uploaded"]).append(logical)
        else:
            summary["failed"].append({"path": logical, "status": status})
    return summary


def collect_for_worker(api_base: str, worker: dict, *, quiet: bool = True, **kw) -> Optional[dict]:
    """Reaper hook: collect for a finished task-bound worker (no-op otherwise)."""
    try:
        task_id = (worker.get("respawn_ctx") or {}).get("task_id")
        cwd = worker.get("worktree") or worker.get("base_cwd")
        if not task_id or not cwd or not outputs_dir(cwd).is_dir():
            return None
        ensure_outputs_dir(cwd)  # self-ignoring: the checkpoint commit must not sweep them in
        summary = collect_run_deliverables(api_base, task_id, worker.get("run_id"), cwd, **kw)
        if not quiet and (summary["uploaded"] or summary["failed"]):
            print(
                f"[notifier] deliverables for task {task_id}: "
                f"{len(summary['uploaded'])} new, {len(summary['unchanged'])} unchanged, "
                f"{len(summary['failed'])} failed"
            )
        return summary
    except Exception:
        return None
