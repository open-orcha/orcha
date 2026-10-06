"""Non-code task deliverables: upload (run output or attached), list, versions, preview, diff.

Endpoints (all task-scoped, additive):

  GET  /api/tasks/{tid}/deliverables                         list (latest version each)
  POST /api/tasks/{tid}/deliverables                         upload a file (multipart) —
       creates the deliverable or appends a version when the bytes changed
  GET  /api/tasks/{tid}/deliverables/{did}                   one deliverable + all versions
  GET  /api/tasks/{tid}/deliverables/{did}/versions/{v}/raw  the bytes (images/PDF inline,
       everything else a download; ?download=1 forces a download)
  GET  /api/tasks/{tid}/deliverables/{did}/versions/{v}/text UTF-8 text preview (text kinds)
  GET  /api/tasks/{tid}/deliverables/{did}/diff?from=&to=    text diff between two versions

Authority mirrors attachments: reads are project-scoped (a trusted non-member gets 403);
an upload is a write (viewer / non-member 403). A ``run_id`` upload is the notifier's
machine lane — it is attributed to the run's agent and a trusted human needs the
machine-lane grant to make one. Header-less (self-host / break-glass) is unchanged.
Closed tasks (completed / cancelled) are frozen: the verified evidence never changes.
"""

from __future__ import annotations

import shutil
from typing import Optional

from fastapi import File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse

from portal_backend import sql
from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.deliverables_storage import (
    DIFF_INPUT_MAX_BYTES,
    MAX_DELIVERABLES_PER_TASK,
    MAX_VERSIONS_PER_DELIVERABLE,
    NOTE_MAX_CHARS,
    TEXT_KINDS,
    TEXT_PREVIEW_MAX_BYTES,
    DeliverablePathError,
    allowed_extensions,
    content_type_of,
    deliverable_dir,
    ext_of,
    is_probably_text,
    kind_of,
    looks_like,
    max_deliverable_bytes,
    new_staging_path,
    normalize_path,
    read_text,
    resolve_version_file,
    sha256_file,
    stored_name_for,
    text_diff,
)
from portal_backend.events import publish_event
from portal_backend.guards import require_container_active, require_task, valid_uuid
from portal_backend.identity_routes import (
    require_machine_lane_member,
    require_member_read,
    trusted_actor,
)

CLOSED_STATUSES = ("completed", "cancelled")


# ---- serialization ----------------------------------------------------------------------

def _iso(v):
    return v.isoformat() if v is not None else None


def _base_url(tid: str, did: str) -> str:
    return f"/api/tasks/{tid}/deliverables/{did}"


def _version_json(tid: str, did: str, kind: str, row: dict) -> dict:
    base = _base_url(tid, did)
    v = int(row["version"])
    return {
        "version": v,
        "source": row["source"],
        "run_id": str(row["run_id"]) if row.get("run_id") else None,
        "author_agent_id": str(row["author_agent_id"]) if row.get("author_agent_id") else None,
        "author_alias": row.get("author_alias"),
        "author_kind": row.get("author_kind"),
        "size_bytes": int(row["size_bytes"]),
        "sha256": row["sha256"],
        "content_type": row["content_type"],
        "note": row.get("note"),
        "created_at": _iso(row["created_at"]),
        "raw_url": f"{base}/versions/{v}/raw",
        "text_url": f"{base}/versions/{v}/text" if kind in TEXT_KINDS else None,
    }


def _deliverable_json(d: dict, latest: Optional[dict], version_count: int) -> dict:
    tid, did = str(d["task_id"]), str(d["id"])
    path = d["path"]
    return {
        "id": did,
        "task_id": tid,
        "path": path,
        "name": path.rsplit("/", 1)[-1],
        "kind": d["kind"],
        "latest_version": int(d["latest_version"]),
        "version_count": int(version_count),
        "created_at": _iso(d["created_at"]),
        "updated_at": _iso(d["updated_at"]),
        "latest": _version_json(tid, did, d["kind"], latest) if latest else None,
    }


_VERSION_SELECT = """
    SELECT v.*, a.alias AS author_alias, a.kind AS author_kind
      FROM task_deliverable_versions v
      LEFT JOIN agents a ON a.id = v.author_agent_id
"""


def _limits() -> dict:
    return {
        "max_bytes": max_deliverable_bytes(),
        "max_deliverables_per_task": MAX_DELIVERABLES_PER_TASK,
        "max_versions_per_deliverable": MAX_VERSIONS_PER_DELIVERABLE,
        "allowed_extensions": allowed_extensions(),
        "outputs_folder": ".orcha/outputs",
    }


# ---- lookups ------------------------------------------------------------------------------

def _require_uuid(value: str, what: str) -> None:
    if not valid_uuid(value):
        raise HTTPException(400, f"{what} is not a valid UUID")


def _read_task(cur, request: Request, tid: str) -> dict:
    _require_uuid(tid, "task_id")
    task = require_task(cur, tid)
    require_member_read(cur, request, str(task["container_id"]))
    return task


def _require_deliverable(cur, tid: str, did: str) -> dict:
    _require_uuid(did, "deliverable_id")
    cur.execute(
        "SELECT * FROM task_deliverables WHERE id=%s AND task_id=%s", (did, tid)
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, "deliverable not found")
    return row


def _require_version(cur, did: str, version: int) -> dict:
    cur.execute(
        _VERSION_SELECT + " WHERE v.deliverable_id=%s AND v.version=%s",
        (did, version),
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, "deliverable version not found")
    return row


def _version_file(tid: str, did: str, row: dict):
    p = resolve_version_file(tid, did, row["stored_name"])
    if p is None:
        raise HTTPException(410, "the stored file for this version is missing")
    return p


# ---- list / detail ---------------------------------------------------------------------------

@app.get("/api/tasks/{tid}/deliverables")
def list_task_deliverables(tid: str, request: Request):
    """Every deliverable on the task, newest-updated first, each with its latest version."""
    with db_cursor() as (_, cur):
        _read_task(cur, request, tid)
        cur.execute(
            """SELECT d.*, (SELECT count(*) FROM task_deliverable_versions x
                             WHERE x.deliverable_id = d.id) AS version_count
                 FROM task_deliverables d
                WHERE d.task_id=%s
                ORDER BY d.updated_at DESC, d.path""",
            (tid,),
        )
        rows = cur.fetchall()
        latest: dict = {}
        if rows:
            cur.execute(
                _VERSION_SELECT
                + """ JOIN task_deliverables d ON d.id = v.deliverable_id
                                            AND d.latest_version = v.version
                       WHERE d.task_id=%s""",
                (tid,),
            )
            latest = {str(r["deliverable_id"]): r for r in cur.fetchall()}
    return {
        "task_id": tid,
        "deliverables": [
            _deliverable_json(r, latest.get(str(r["id"])), r["version_count"])
            for r in rows
        ],
        "limits": _limits(),
    }


@app.get("/api/tasks/{tid}/deliverables/{did}")
def get_task_deliverable(tid: str, did: str, request: Request):
    """One deliverable with its full version history (newest first)."""
    with db_cursor() as (_, cur):
        _read_task(cur, request, tid)
        d = _require_deliverable(cur, tid, did)
        cur.execute(
            _VERSION_SELECT + " WHERE v.deliverable_id=%s ORDER BY v.version DESC",
            (did,),
        )
        versions = cur.fetchall()
    latest = versions[0] if versions else None
    out = _deliverable_json(d, latest, len(versions))
    out["versions"] = [_version_json(tid, did, d["kind"], v) for v in versions]
    return out


# ---- upload -------------------------------------------------------------------------------

def _resolve_author(cur, request: Request, task: dict, run_id, author_agent_id):
    """Return (author_agent_id, source, run_id) under the attachment authority rules."""
    cid = str(task["container_id"])
    if run_id:
        _require_uuid(run_id, "run_id")
        require_machine_lane_member(cur, request, cid)  # PS-07 machine lane
        cur.execute(
            """SELECT wr.run_id, wr.agent_id, wr.task_id, a.container_id
                 FROM worker_runs wr JOIN agents a ON a.id = wr.agent_id
                WHERE wr.run_id=%s""",
            (run_id,),
        )
        run = cur.fetchone()
        if not run:
            raise HTTPException(404, f"worker run {run_id} not found")
        if str(run["container_id"]) != cid:
            raise HTTPException(403, "that run belongs to another project")
        if run["task_id"] is not None and str(run["task_id"]) != str(task["id"]):
            raise HTTPException(409, "that run worked a different task")
        return str(run["agent_id"]), "run_output", str(run["run_id"])
    if author_agent_id:
        _require_uuid(author_agent_id, "author_agent_id")
    actor = trusted_actor(cur, request, cid, author_agent_id)
    if actor:
        cur.execute("SELECT container_id FROM agents WHERE id=%s", (actor,))
        a = cur.fetchone()
        if not a:
            raise HTTPException(404, f"agent {actor} not found")
        if str(a["container_id"]) != cid:
            raise HTTPException(403, "that agent belongs to another project")
    return (str(actor) if actor else None), "attached", None


async def _stage_upload(file: UploadFile, cap: int):
    """Stream the upload to a staging file under the cap; returns (path, size, head)."""
    staging = new_staging_path()
    size = 0
    head = b""
    try:
        with open(staging, "wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                if len(head) < 8192:
                    head += chunk[: 8192 - len(head)]
                size += len(chunk)
                if size > cap:
                    raise HTTPException(
                        413, f"file too large (max {cap // (1024 * 1024)} MiB)"
                    )
                out.write(chunk)
    except BaseException:
        staging.unlink(missing_ok=True)
        raise
    if size == 0:
        staging.unlink(missing_ok=True)
        raise HTTPException(400, "empty file")
    return staging, size, head


@app.post("/api/tasks/{tid}/deliverables", status_code=201)
async def upload_task_deliverable(
    tid: str,
    request: Request,
    file: UploadFile = File(...),
    path: Optional[str] = Form(default=None),
    run_id: Optional[str] = Form(default=None),
    author_agent_id: Optional[str] = Form(default=None),
    note: Optional[str] = Form(default=None),
):
    """Add a deliverable file to a task, or a new version of one.

    ``path`` is the logical path within the task's outputs (default: the file name);
    uploading the same path again appends version N+1 — unless the bytes are identical
    to the latest version (sha256), which is a no-op returning ``deduplicated: true``
    (so the notifier can re-sync an outputs folder idempotently)."""
    _require_uuid(tid, "task_id")
    try:
        logical = normalize_path(path or file.filename or "")
    except DeliverablePathError as exc:
        raise HTTPException(400, str(exc))
    kind = kind_of(logical)
    ext = ext_of(logical)
    note_clean = (note or "").strip()[:NOTE_MAX_CHARS] or None

    with db_cursor() as (_, cur):
        task = require_task(cur, tid)
        if task["is_root"]:
            raise HTTPException(400, "the project's root task cannot hold deliverables")
        if task["status"] in CLOSED_STATUSES:
            raise HTTPException(
                409, f"task is {task['status']} — its deliverables are frozen"
            )
        author, source, run = _resolve_author(cur, request, task, run_id, author_agent_id)
        require_container_active(cur, str(task["container_id"]), None)

    staging, size, head = await _stage_upload(file, max_deliverable_bytes())
    try:
        if kind in TEXT_KINDS and not is_probably_text(head):
            raise HTTPException(400, f"'{logical}' is not UTF-8 text")
        if kind in ("image", "pdf") and not looks_like(ext, head):
            raise HTTPException(400, f"'{logical}' is not a valid .{ext} file")
        sha = sha256_file(staging)
        result = _commit_version(
            tid, task, logical, kind, source, run, author, note_clean, staging, size, sha
        )
    finally:
        staging.unlink(missing_ok=True)
    return result


def _commit_version(tid, task, logical, kind, source, run, author, note, staging, size, sha):
    cid = str(task["container_id"])
    final = None
    try:
        with db_cursor() as (conn, cur):
            cur.execute(
                "SELECT count(*) AS n FROM task_deliverables WHERE task_id=%s AND path<>%s",
                (tid, logical),
            )
            if int(cur.fetchone()["n"]) >= MAX_DELIVERABLES_PER_TASK:
                raise HTTPException(
                    409,
                    f"task already has {MAX_DELIVERABLES_PER_TASK} deliverables (the cap)",
                )
            # upsert + row lock serializes concurrent uploads of the same path
            cur.execute(
                """INSERT INTO task_deliverables (container_id, task_id, path, kind, latest_version)
                   VALUES (%s, %s, %s, %s, 0)
                   ON CONFLICT (task_id, path) DO UPDATE SET path = EXCLUDED.path
                   RETURNING id""",
                (cid, tid, logical, kind),
            )
            did = str(cur.fetchone()["id"])
            cur.execute("SELECT * FROM task_deliverables WHERE id=%s " + sql.for_update(), (did,))
            d = cur.fetchone()
            prev = None
            if d["latest_version"] > 0:
                prev = _require_version(cur, did, int(d["latest_version"]))
            if prev is not None and prev["sha256"] == sha:
                conn.rollback()  # nothing to record; keep updated_at honest
                return {
                    "created": False,
                    "deduplicated": True,
                    "deliverable": _deliverable_json(d, prev, int(d["latest_version"])),
                    "version": _version_json(tid, did, d["kind"], prev),
                }
            version = int(d["latest_version"]) + 1
            if version > MAX_VERSIONS_PER_DELIVERABLE:
                raise HTTPException(
                    409,
                    f"'{logical}' already has {MAX_VERSIONS_PER_DELIVERABLE} versions (the cap)",
                )
            stored = stored_name_for(version, logical)
            ddir = deliverable_dir(tid, did)
            if ddir is None:  # unreachable: uuids only
                raise HTTPException(400, "invalid deliverable location")
            ddir.mkdir(parents=True, exist_ok=True)
            final = ddir / stored
            shutil.copyfile(staging, final)
            cur.execute(
                """INSERT INTO task_deliverable_versions
                     (deliverable_id, version, source, run_id, author_agent_id,
                      stored_name, size_bytes, sha256, content_type, note)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                (did, version, source, run, author, stored, size, sha,
                 content_type_of(logical), note),
            )
            cur.execute(
                """UPDATE task_deliverables SET latest_version=%s, updated_at=now()
                    WHERE id=%s RETURNING *""",
                (version, did),
            )
            d = cur.fetchone()
            row = _require_version(cur, did, version)
            detail = {
                "deliverable_id": did,
                "path": logical,
                "version": version,
                "source": source,
                "run_id": run,
                "size_bytes": size,
            }
            log_event(
                cur, cid, "agent" if source == "run_output" else "human",
                author, "task", tid, "deliverable_version_added", detail,
            )
            publish_event(cur, cid, None, "task_deliverable_added", {"task_id": tid, **detail})
            conn.commit()
    except BaseException:
        if final is not None:
            final.unlink(missing_ok=True)
        raise
    return {
        "created": True,
        "deduplicated": False,
        "deliverable": _deliverable_json(d, row, version),
        "version": _version_json(tid, did, d["kind"], row),
    }


# ---- bytes / preview / diff --------------------------------------------------------------------

@app.get("/api/tasks/{tid}/deliverables/{did}/versions/{version}/raw")
def serve_deliverable_version(
    tid: str, did: str, version: int, request: Request, download: bool = False
):
    """Stream one version. Raster images and a real PDF render inline (the preview);
    every other type — and anything with ?download=1 — is a download. nosniff always."""
    with db_cursor() as (_, cur):
        _read_task(cur, request, tid)
        d = _require_deliverable(cur, tid, did)
        row = _require_version(cur, did, version)
    p = _version_file(tid, did, row)
    name = d["path"].rsplit("/", 1)[-1]
    if version != int(d["latest_version"]):
        stem, dot, ext = name.rpartition(".")
        name = f"{stem}.v{version}.{ext}" if dot else f"{name}.v{version}"
    inline = (not download) and d["kind"] in ("image", "pdf")
    if inline:
        with open(p, "rb") as fh:
            inline = looks_like(ext_of(d["path"]), fh.read(16))
    headers = {
        "Content-Disposition": ("inline" if inline else "attachment") + f'; filename="{name}"',
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=3600, immutable",
    }
    return FileResponse(p, media_type=row["content_type"], headers=headers)


@app.get("/api/tasks/{tid}/deliverables/{did}/versions/{version}/text")
def deliverable_version_text(tid: str, did: str, version: int, request: Request):
    """The UTF-8 text of a text-kind version (markdown / text / CSV / JSON), capped."""
    with db_cursor() as (_, cur):
        _read_task(cur, request, tid)
        d = _require_deliverable(cur, tid, did)
        row = _require_version(cur, did, version)
    if d["kind"] not in TEXT_KINDS:
        raise HTTPException(415, f"a {d['kind']} deliverable has no text preview")
    text, truncated = read_text(_version_file(tid, did, row), TEXT_PREVIEW_MAX_BYTES)
    return {
        "deliverable_id": did,
        "version": version,
        "kind": d["kind"],
        "path": d["path"],
        "size_bytes": int(row["size_bytes"]),
        "text": text,
        "truncated": truncated,
        "max_bytes": TEXT_PREVIEW_MAX_BYTES,
    }


@app.get("/api/tasks/{tid}/deliverables/{did}/diff")
def deliverable_diff(
    tid: str,
    did: str,
    request: Request,
    from_version: Optional[int] = Query(default=None, alias="from"),
    to_version: Optional[int] = Query(default=None, alias="to"),
):
    """Diff two versions (default: the previous version → the latest). Text kinds get a
    git-style unified diff; binary kinds report whether the bytes changed (sha/size)."""
    with db_cursor() as (_, cur):
        _read_task(cur, request, tid)
        d = _require_deliverable(cur, tid, did)
        latest = int(d["latest_version"])
        to_v = to_version if to_version is not None else latest
        from_v = from_version if from_version is not None else to_v - 1
        if from_v < 1:
            raise HTTPException(409, "this deliverable has only one version — nothing to compare")
        if from_v == to_v:
            raise HTTPException(400, "pick two different versions")
        a = _require_version(cur, did, from_v)
        b = _require_version(cur, did, to_v)
    out = {
        "deliverable_id": did,
        "path": d["path"],
        "kind": d["kind"],
        "from": _version_json(tid, did, d["kind"], a),
        "to": _version_json(tid, did, d["kind"], b),
        "binary": d["kind"] not in TEXT_KINDS,
        "bytes_changed": a["sha256"] != b["sha256"],
    }
    if out["binary"]:
        return out
    old_text, old_trunc = read_text(_version_file(tid, did, a), DIFF_INPUT_MAX_BYTES)
    new_text, new_trunc = read_text(_version_file(tid, did, b), DIFF_INPUT_MAX_BYTES)
    diff = text_diff(
        d["path"], old_text, new_text, old_label=f"v{from_v}", new_label=f"v{to_v}"
    )
    diff["truncated"] = diff["truncated"] or old_trunc or new_trunc
    out.update(diff)
    return out


__all__ = [
    "list_task_deliverables",
    "get_task_deliverable",
    "upload_task_deliverable",
    "serve_deliverable_version",
    "deliverable_version_text",
    "deliverable_diff",
]
