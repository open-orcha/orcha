"""Build and validate canonical task and conversation attachment references."""

import pathlib
from typing import Optional

from fastapi import HTTPException

from portal_backend.attachment_config import (
    MAX_ATTACHMENTS_PER_MESSAGE,
    MAX_EXTRACTED_TEXT_CHARS,
    attachments_dir,
)
from portal_backend.attachment_storage import (
    attachment_content_type,
    attachment_extracted_text,
    attachment_kind,
    contained_path,
    resolve_stored_in,
    sanitize_attachment_name,
)


def attachment_ref_for(
    url_prefix: str,
    stored_name: str,
    display_name: str,
    size: int,
    *,
    extracted_text: str = "",
) -> dict:
    ref = {
        "id": stored_name,
        "name": display_name,
        "size": size,
        "content_type": attachment_content_type(stored_name),
        "kind": attachment_kind(stored_name),
        "url": f"{url_prefix}/{stored_name}",
    }
    text = (extracted_text or "").strip()[:MAX_EXTRACTED_TEXT_CHARS]
    if text:
        ref["extracted_text"] = text
    return ref


def validate_refs_in(
    base_dir: pathlib.Path,
    ref_builder,
    refs: Optional[list],
    *,
    api_key: Optional[str] = None,
) -> list[dict]:
    """Canonicalize only refs backed by safe files in the scoped store."""
    if not refs:
        return []
    if len(refs) > MAX_ATTACHMENTS_PER_MESSAGE:
        raise HTTPException(
            400,
            f"too many attachments (max {MAX_ATTACHMENTS_PER_MESSAGE})",
        )
    out = []
    for ref in refs:
        if not isinstance(ref, dict):
            raise HTTPException(400, "each attachment must be an object")
        stored = str(ref.get("id") or "")
        path = resolve_stored_in(base_dir, stored)
        if path is None:
            raise HTTPException(
                400,
                f"attachment not found on disk: {stored!r} (upload it first)",
            )
        display = sanitize_attachment_name(str(ref.get("name") or stored))
        out.append(
            ref_builder(
                stored,
                display,
                path.stat().st_size,
                path,
                api_key=api_key,
            )
        )
    return out


def task_attachments_dir(task_id: str) -> pathlib.Path:
    path = contained_path(attachments_dir(), task_id)
    if path is None:
        raise HTTPException(400, "invalid task id")
    return path


def resolve_stored_attachment(
    task_id: str,
    stored_name: str,
) -> Optional[pathlib.Path]:
    return resolve_stored_in(task_attachments_dir(task_id), stored_name)


def attachment_ref(
    task_id: str,
    stored_name: str,
    display_name: str,
    size: int,
    path: Optional[pathlib.Path] = None,
    *,
    api_key: Optional[str] = None,
) -> dict:
    source = path or resolve_stored_attachment(task_id, stored_name)
    extracted = attachment_extracted_text(
        "tasks",
        task_id,
        stored_name,
        source,
        api_key=api_key,
    )
    return attachment_ref_for(
        f"/api/tasks/{task_id}/attachments",
        stored_name,
        display_name,
        size,
        extracted_text=extracted,
    )


def validate_attachment_refs(
    task_id: str,
    refs: Optional[list],
    *,
    api_key: Optional[str] = None,
) -> list[dict]:
    return validate_refs_in(
        task_attachments_dir(task_id),
        lambda stored, display, size, path, *, api_key=None: attachment_ref(
            task_id,
            stored,
            display,
            size,
            path,
            api_key=api_key,
        ),
        refs,
        api_key=api_key,
    )


def conversation_attachments_dir(conversation_id: str) -> pathlib.Path:
    path = contained_path(attachments_dir() / "conversations", conversation_id)
    if path is None:
        raise HTTPException(400, "invalid conversation id")
    return path


def resolve_stored_conv_attachment(
    conversation_id: str,
    stored_name: str,
) -> Optional[pathlib.Path]:
    return resolve_stored_in(
        conversation_attachments_dir(conversation_id),
        stored_name,
    )


def conv_attachment_ref(
    conversation_id: str,
    stored_name: str,
    display_name: str,
    size: int,
    path: Optional[pathlib.Path] = None,
    *,
    api_key: Optional[str] = None,
) -> dict:
    source = path or resolve_stored_conv_attachment(conversation_id, stored_name)
    extracted = attachment_extracted_text(
        "conversations",
        conversation_id,
        stored_name,
        source,
        api_key=api_key,
    )
    return attachment_ref_for(
        f"/api/conversations/{conversation_id}/attachments",
        stored_name,
        display_name,
        size,
        extracted_text=extracted,
    )


def validate_conv_attachment_refs(
    conversation_id: str,
    refs: Optional[list],
    *,
    api_key: Optional[str] = None,
) -> list[dict]:
    return validate_refs_in(
        conversation_attachments_dir(conversation_id),
        lambda stored, display, size, path, *, api_key=None: conv_attachment_ref(
            conversation_id,
            stored,
            display,
            size,
            path,
            api_key=api_key,
        ),
        refs,
        api_key=api_key,
    )


def render_attachment_feed_line(attachments: Optional[list]) -> str:
    """Render file names, fetch paths, and extracted text for an agent feed."""
    refs = [ref for ref in (attachments or []) if isinstance(ref, dict)]
    if not refs:
        return ""
    parts = []
    for ref in refs:
        name = ref.get("name") or ref.get("id") or "file"
        kind = ref.get("kind") or "file"
        detail = f"{name} ({kind}; GET {ref.get('url') or ''})"
        text = (ref.get("extracted_text") or "").strip()
        if text:
            detail += f"; auto-transcribed text: {text[:MAX_EXTRACTED_TEXT_CHARS]}"
        parts.append(detail)
    return (
        f" — 📎 {len(refs)} attached file(s): "
        + "; ".join(parts)
        + " — fetch each via GET on your Orcha API (e.g. curl), then read/view it "
        "with your tools. Text-only runtimes should use any auto-transcribed text "
        "above for image/PDF content."
    )
