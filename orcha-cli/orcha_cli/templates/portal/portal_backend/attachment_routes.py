"""Upload and serve task and conversation attachments."""

import asyncio
import uuid

from fastapi import File, HTTPException, UploadFile
from fastapi.responses import FileResponse

from portal_backend.application import app
from portal_backend.attachment_config import MAX_ATTACHMENT_BYTES
from portal_backend.attachment_references import (
    attachment_ref as _attachment_ref,
    conv_attachment_ref as _conv_attachment_ref,
    conversation_attachments_dir as _conversation_attachments_dir,
    resolve_stored_attachment as _resolve_stored_attachment,
    resolve_stored_conv_attachment as _resolve_stored_conv_attachment,
    task_attachments_dir as _task_attachments_dir,
)
from portal_backend.attachment_storage import (
    ATTACHMENT_INLINE_EXT as _ATTACHMENT_INLINE_EXT,
    ATTACHMENT_TYPES as _ATTACHMENT_TYPES,
    attachment_ext as _attachment_ext,
    contained_path as _contained_path,
    sanitize_attachment_name as _sanitize_attachment_name,
)
from portal_backend.database import db_cursor
from portal_backend.guards import (
    require_container_active as _require_container_active,
    require_task as _require_task,
    valid_uuid as _valid_uuid,
)
from portal_backend.provider_keys import container_llm_key as _container_llm_key


def _default_max_attachment_bytes():
    return MAX_ATTACHMENT_BYTES


_max_attachment_bytes = _default_max_attachment_bytes


def configure_compatibility(max_attachment_bytes):
    """Bind the facade-owned size limit used by legacy monkeypatch tests."""
    global _max_attachment_bytes
    _max_attachment_bytes = max_attachment_bytes


@app.post("/api/tasks/{tid}/attachments", status_code=201)
async def upload_attachment(tid: str, file: UploadFile = File(...)):
    """#301: upload ONE file to a task's local attachment store and return its ref.

    Two-step, mirroring Claude-Code/Codex pasted-image handling: the client uploads each
    staged file HERE first (getting a stored `id` back), then references those ids in the
    POST .../messages body. Bytes are written to the host bind-mount under a per-task subdir
    (NO DB blobs); only the path/metadata ref is later persisted on the message row.

    Guards: task must exist + container active (parity with posting a message); extension must
    be on the allowlist (SVG/HTML excluded — never served renderable); size ≤ MAX_ATTACHMENT_BYTES
    (enforced while streaming, so an oversize upload is rejected without buffering it all). The
    stored basename is uuid-prefixed + sanitized so it's collision-free and path-traversal-safe."""
    if not _valid_uuid(tid):
        raise HTTPException(400, "task_id is not a valid UUID")
    with db_cursor() as (_, cur):
        t = _require_task(cur, tid)
        _require_container_active(cur, str(t["container_id"]), None)
        llm_key = _container_llm_key(cur, str(t["container_id"]))
    display = _sanitize_attachment_name(file.filename or "file")
    if _attachment_ext(display) is None:
        raise HTTPException(
            400,
            "unsupported file type — allowed: " + ", ".join(sorted(_ATTACHMENT_TYPES)),
        )
    stored = uuid.uuid4().hex + "_" + display
    tdir = _task_attachments_dir(tid)
    try:
        tdir.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise HTTPException(500, f"attachment store unavailable: {e}")
    dest = _contained_path(tdir, stored)
    if dest is None:  # unreachable: `stored` is uuid-hex + sanitized basename
        raise HTTPException(400, "invalid attachment name")
    size = 0
    try:
        with open(dest, "wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > _max_attachment_bytes():
                    out.close()
                    dest.unlink(missing_ok=True)
                    raise HTTPException(
                        413,
                        f"file too large (max {_max_attachment_bytes() // (1024 * 1024)} MiB)",
                    )
                out.write(chunk)
    except HTTPException:
        raise
    except OSError as e:
        dest.unlink(missing_ok=True)
        raise HTTPException(500, f"could not store attachment: {e}")
    if size == 0:
        dest.unlink(missing_ok=True)
        raise HTTPException(400, "empty file")
    # Build the ref off-thread: on a first-upload cache miss this may run a blocking
    # sync vision/OCR call (describe_image, up to 45s); keep it off the single event loop
    # so notifier polls, SSE streams, and concurrent agent calls aren't stalled.
    return await asyncio.to_thread(
        _attachment_ref, tid, stored, display, size, dest, api_key=llm_key
    )


@app.get("/api/tasks/{tid}/attachments/{stored_name}")
def serve_attachment(tid: str, stored_name: str):
    """#301: stream a stored attachment from disk. Path-traversal-safe (see
    _resolve_stored_attachment: the name is regex-gated and the resolved parent must equal the
    task's dir). ONLY raster images are served inline; every other allowed type is forced to
    download (Content-Disposition: attachment) so a served file never renders in the portal
    origin. X-Content-Type-Options: nosniff stops the browser from re-sniffing a download into
    something executable."""
    if not _valid_uuid(tid):
        raise HTTPException(400, "task_id is not a valid UUID")
    p = _resolve_stored_attachment(tid, stored_name)
    if p is None:
        raise HTTPException(404, "attachment not found")
    ext = _attachment_ext(stored_name) or ""
    media = _ATTACHMENT_TYPES.get(ext, "application/octet-stream")
    inline = ext in _ATTACHMENT_INLINE_EXT
    # strip the uuid prefix for the downloaded filename (show the original display name)
    display = stored_name.split("_", 1)[1] if "_" in stored_name else stored_name
    disposition = ("inline" if inline else "attachment") + f'; filename="{display}"'
    return FileResponse(
        p,
        media_type=media,
        headers={
            "Content-Disposition": disposition,
            "X-Content-Type-Options": "nosniff",
        },
    )


@app.post("/api/conversations/{conv_id}/attachments", status_code=201)
async def upload_conversation_attachment(conv_id: str, file: UploadFile = File(...)):
    """#338: upload ONE file to a conversation's local attachment store and return its ref.

    Exact mirror of the task-message upload (#301/#330) with a conversation-scoped dir: the client
    uploads each staged file HERE first (getting a stored `id` back), then references those ids in
    the POST .../turns body. Bytes are written to the host bind-mount under
    .../conversations/<conv-id>/ (NO DB blobs); only the path/metadata ref is later persisted on
    the turn row and fed to the agent. Same guards: conversation must exist + container active;
    extension on the allowlist; size ≤ MAX_ATTACHMENT_BYTES (streamed); uuid-prefixed safe name."""
    if not _valid_uuid(conv_id):
        raise HTTPException(400, "conversation_id is not a valid UUID")
    with db_cursor() as (_, cur):
        cur.execute("SELECT container_id FROM conversations WHERE id=%s", (conv_id,))
        conv = cur.fetchone()
        if not conv:
            raise HTTPException(404, f"conversation {conv_id} not found")
        _require_container_active(cur, str(conv["container_id"]), None)
        llm_key = _container_llm_key(cur, str(conv["container_id"]))
    display = _sanitize_attachment_name(file.filename or "file")
    if _attachment_ext(display) is None:
        raise HTTPException(
            400,
            "unsupported file type — allowed: " + ", ".join(sorted(_ATTACHMENT_TYPES)),
        )
    stored = uuid.uuid4().hex + "_" + display
    cdir = _conversation_attachments_dir(conv_id)
    try:
        cdir.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise HTTPException(500, f"attachment store unavailable: {e}")
    dest = _contained_path(cdir, stored)
    if dest is None:  # unreachable: `stored` is uuid-hex + sanitized basename
        raise HTTPException(400, "invalid attachment name")
    size = 0
    try:
        with open(dest, "wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > _max_attachment_bytes():
                    out.close()
                    dest.unlink(missing_ok=True)
                    raise HTTPException(
                        413,
                        f"file too large (max {_max_attachment_bytes() // (1024 * 1024)} MiB)",
                    )
                out.write(chunk)
    except HTTPException:
        raise
    except OSError as e:
        dest.unlink(missing_ok=True)
        raise HTTPException(500, f"could not store attachment: {e}")
    if size == 0:
        dest.unlink(missing_ok=True)
        raise HTTPException(400, "empty file")
    # Off-thread for the same reason as the task-upload route: a first-upload cache miss
    # can trigger a blocking sync vision/OCR call inside the ref builder.
    return await asyncio.to_thread(
        _conv_attachment_ref, conv_id, stored, display, size, dest, api_key=llm_key
    )


@app.get("/api/conversations/{conv_id}/attachments/{stored_name}")
def serve_conversation_attachment(conv_id: str, stored_name: str):
    """#338: stream a stored conversation attachment from disk. Path-traversal-safe (see
    _resolve_stored_conv_attachment: the name is regex-gated and the resolved parent must equal
    the conversation's dir). Disposition + nosniff identical to the task serve route."""
    if not _valid_uuid(conv_id):
        raise HTTPException(400, "conversation_id is not a valid UUID")
    p = _resolve_stored_conv_attachment(conv_id, stored_name)
    if p is None:
        raise HTTPException(404, "attachment not found")
    ext = _attachment_ext(stored_name) or ""
    media = _ATTACHMENT_TYPES.get(ext, "application/octet-stream")
    inline = ext in _ATTACHMENT_INLINE_EXT
    display = stored_name.split("_", 1)[1] if "_" in stored_name else stored_name
    disposition = ("inline" if inline else "attachment") + f'; filename="{display}"'
    return FileResponse(
        p,
        media_type=media,
        headers={
            "Content-Disposition": disposition,
            "X-Content-Type-Options": "nosniff",
        },
    )
