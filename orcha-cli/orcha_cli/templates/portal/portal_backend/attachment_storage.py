"""Validate attachment paths, media types, names, and extracted-text caches."""

import json
import os
import pathlib
import re
from typing import Optional

from portal_backend.attachment_config import (
    MAX_EXTRACTED_TEXT_CHARS,
    attachments_dir,
)

try:
    import llm_util
except ImportError:
    from orcha_cli import llm_util

ATTACHMENT_TYPES = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "webp": "image/webp",
    "pdf": "application/pdf",
    "txt": "text/plain; charset=utf-8",
    "md": "text/markdown; charset=utf-8",
    "csv": "text/csv; charset=utf-8",
    "log": "text/plain; charset=utf-8",
    "json": "application/json",
}
ATTACHMENT_INLINE_EXT = {"png", "jpg", "jpeg", "gif", "webp"}
SAFE_STORED_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def contained_path(base_dir: pathlib.Path, *parts: str) -> Optional[pathlib.Path]:
    """Join path segments while refusing traversal outside the requested store."""
    base = os.path.realpath(base_dir)
    candidate = os.path.realpath(os.path.join(base, *parts))
    if not candidate.startswith(base + os.sep):
        return None
    return pathlib.Path(candidate)


def attachment_ext(name: str) -> Optional[str]:
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    return ext if ext in ATTACHMENT_TYPES else None


def sanitize_attachment_name(name: str) -> str:
    base = os.path.basename(name or "").strip() or "file"
    base = re.sub(r"[^A-Za-z0-9._-]", "_", base)
    return (base.lstrip(".") or "file")[:120]


def attachment_content_type(stored_name: str) -> str:
    return ATTACHMENT_TYPES.get(
        attachment_ext(stored_name) or "",
        "application/octet-stream",
    )


def attachment_kind(stored_name: str) -> str:
    ext = attachment_ext(stored_name) or ""
    return "image" if ext in ATTACHMENT_INLINE_EXT else "file"


def attachment_text_cache_path(
    scope: str,
    owner_id: str,
    stored_name: str,
) -> Optional[pathlib.Path]:
    if not stored_name or not SAFE_STORED_NAME.match(stored_name):
        return None
    return contained_path(
        attachments_dir() / ".extracted-text",
        scope,
        owner_id,
        f"{stored_name}.json",
    )


def read_cached_attachment_text(
    scope: str,
    owner_id: str,
    stored_name: str,
) -> str:
    path = attachment_text_cache_path(scope, owner_id, stored_name)
    if path is None:
        return ""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return ""
    text = raw.get("text") if isinstance(raw, dict) else None
    return str(text or "").strip()[:MAX_EXTRACTED_TEXT_CHARS]


def write_cached_attachment_text(
    scope: str,
    owner_id: str,
    stored_name: str,
    text: str,
) -> None:
    clean = (text or "").strip()[:MAX_EXTRACTED_TEXT_CHARS]
    path = attachment_text_cache_path(scope, owner_id, stored_name)
    if not clean or path is None:
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps({"text": clean}, ensure_ascii=False),
            encoding="utf-8",
        )
    except OSError:
        pass


def attachment_extracted_text(
    scope: str,
    owner_id: str,
    stored_name: str,
    path: Optional[pathlib.Path],
    *,
    api_key: Optional[str] = None,
) -> str:
    """Return cached media text, failing open when extraction is unavailable."""
    content_type = attachment_content_type(stored_name)
    if not llm_util.can_describe(content_type):
        return ""
    cached = read_cached_attachment_text(scope, owner_id, stored_name)
    if cached:
        return cached
    if api_key is None or path is None:
        return ""
    try:
        text = llm_util.describe_image(
            path.read_bytes(),
            content_type,
            api_key=api_key,
        )
    except Exception:
        return ""
    if text:
        write_cached_attachment_text(scope, owner_id, stored_name, text)
        return text.strip()[:MAX_EXTRACTED_TEXT_CHARS]
    return ""


def resolve_stored_in(
    base_dir: pathlib.Path,
    stored_name: str,
) -> Optional[pathlib.Path]:
    if not stored_name or not SAFE_STORED_NAME.match(stored_name):
        return None
    path = contained_path(base_dir, stored_name)
    if path is None:
        return None
    try:
        if os.path.dirname(path) != os.path.realpath(base_dir) or not path.is_file():
            return None
    except OSError:
        return None
    return path
