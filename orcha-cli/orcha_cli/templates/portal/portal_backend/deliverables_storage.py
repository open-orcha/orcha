"""Non-code task deliverables: path confinement, type policy, on-disk store, text diff.

A deliverable is a file a task produces that is not a code change (a report, a CSV
export, a memo, a chart). Bytes live on disk under the attachment store —
``<attachments>/deliverables/<task_id>/<deliverable_id>/v<N>.<ext>`` — and the DB
carries only metadata (migration 061). Everything here is pure / filesystem-only so
the route module stays thin and the policy is unit-testable without a database.
"""

from __future__ import annotations

import difflib
import hashlib
import os
import pathlib
import re
import uuid
from typing import Optional

from portal_backend.attachment_config import attachments_dir
from portal_backend.attachment_storage import contained_path

# ---- limits ---------------------------------------------------------------------------
# Per-file cap (env-tunable for self-hosters; the default mirrors attachments).
DEFAULT_MAX_DELIVERABLE_BYTES = 10 * 1024 * 1024
MAX_DELIVERABLES_PER_TASK = 100
MAX_VERSIONS_PER_DELIVERABLE = 50
MAX_PATH_SEGMENTS = 4
MAX_PATH_CHARS = 200
# Previews / diffs read at most this many bytes of a text version.
TEXT_PREVIEW_MAX_BYTES = 256 * 1024
DIFF_INPUT_MAX_BYTES = 1024 * 1024
DIFF_MAX_OUTPUT_LINES = 4000
NOTE_MAX_CHARS = 500


def max_deliverable_bytes() -> int:
    raw = os.environ.get("ORCHA_DELIVERABLE_MAX_BYTES", "").strip()
    try:
        value = int(raw) if raw else DEFAULT_MAX_DELIVERABLE_BYTES
    except ValueError:
        value = DEFAULT_MAX_DELIVERABLE_BYTES
    return value if value > 0 else DEFAULT_MAX_DELIVERABLE_BYTES


# ---- type policy ----------------------------------------------------------------------
# ext -> (kind, served content type). SVG / HTML are deliberately absent: they can carry
# script and must never be served renderable from the portal origin.
DELIVERABLE_TYPES: dict[str, tuple[str, str]] = {
    "md": ("markdown", "text/markdown; charset=utf-8"),
    "markdown": ("markdown", "text/markdown; charset=utf-8"),
    "txt": ("text", "text/plain; charset=utf-8"),
    "log": ("text", "text/plain; charset=utf-8"),
    "yaml": ("text", "text/plain; charset=utf-8"),
    "yml": ("text", "text/plain; charset=utf-8"),
    "csv": ("csv", "text/csv; charset=utf-8"),
    "tsv": ("csv", "text/tab-separated-values; charset=utf-8"),
    "json": ("json", "application/json"),
    "pdf": ("pdf", "application/pdf"),
    "png": ("image", "image/png"),
    "jpg": ("image", "image/jpeg"),
    "jpeg": ("image", "image/jpeg"),
    "gif": ("image", "image/gif"),
    "webp": ("image", "image/webp"),
}
TEXT_KINDS = frozenset({"markdown", "text", "csv", "json"})

_MAGIC = {
    "png": (b"\x89PNG\r\n\x1a\n",),
    "jpg": (b"\xff\xd8\xff",),
    "jpeg": (b"\xff\xd8\xff",),
    "gif": (b"GIF87a", b"GIF89a"),
    "pdf": (b"%PDF-",),
}

_SEGMENT_BAD = re.compile(r"[^A-Za-z0-9._-]")
STORED_NAME = re.compile(r"^v([1-9][0-9]{0,5})\.([a-z0-9]{1,8})$")


class DeliverablePathError(ValueError):
    """The requested logical path is unsafe or not an allowed deliverable type."""


def ext_of(path: str) -> str:
    name = path.rsplit("/", 1)[-1]
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


def kind_of(path: str) -> Optional[str]:
    entry = DELIVERABLE_TYPES.get(ext_of(path))
    return entry[0] if entry else None


def content_type_of(path: str) -> str:
    entry = DELIVERABLE_TYPES.get(ext_of(path))
    return entry[1] if entry else "application/octet-stream"


def allowed_extensions() -> list[str]:
    return sorted(DELIVERABLE_TYPES)


def normalize_path(raw: str) -> str:
    """Return the confined logical path for a deliverable, or raise DeliverablePathError.

    Rules: forward slashes only; no absolute paths, no ``..``; empty / ``.`` segments
    dropped; each segment sanitized to ``[A-Za-z0-9._-]`` with leading dots stripped
    (no hidden files); at most MAX_PATH_SEGMENTS deep and MAX_PATH_CHARS long; the
    extension must be on the allowlist. The logical path is a KEY (same path in a later
    upload = a new version), never used directly as a filesystem path."""
    text = (raw or "").strip().replace("\\", "/")
    if not text:
        raise DeliverablePathError("path is required")
    if "\x00" in text:
        raise DeliverablePathError("path contains a NUL byte")
    if text.startswith("/") or re.match(r"^[A-Za-z]:", text):
        raise DeliverablePathError("path must be relative to the outputs folder")
    segments = []
    for seg in text.split("/"):
        seg = seg.strip()
        if seg in ("", "."):
            continue
        if seg == "..":
            raise DeliverablePathError("path must not contain '..'")
        clean = _SEGMENT_BAD.sub("_", seg).lstrip(".")[:120]
        if not clean:
            raise DeliverablePathError("path has an empty segment after sanitizing")
        segments.append(clean)
    if not segments:
        raise DeliverablePathError("path is required")
    if len(segments) > MAX_PATH_SEGMENTS:
        raise DeliverablePathError(
            f"path is nested too deep (max {MAX_PATH_SEGMENTS} segments)"
        )
    path = "/".join(segments)
    if len(path) > MAX_PATH_CHARS:
        raise DeliverablePathError(f"path is too long (max {MAX_PATH_CHARS} chars)")
    if kind_of(path) is None:
        raise DeliverablePathError(
            "unsupported deliverable type — allowed: " + ", ".join(allowed_extensions())
        )
    return path


def looks_like(ext: str, head: bytes) -> bool:
    """True when the leading bytes match the extension's magic (or it has none to check)."""
    if ext == "webp":
        return head[:4] == b"RIFF" and head[8:12] == b"WEBP"
    magics = _MAGIC.get(ext)
    if not magics:
        return True
    return any(head.startswith(m) for m in magics)


def is_probably_text(data: bytes) -> bool:
    if b"\x00" in data[:8192]:
        return False
    try:
        data[:8192].decode("utf-8")
        return True
    except UnicodeDecodeError as exc:
        # a multi-byte char cut at the 8 KiB boundary is still text
        return exc.start >= 8192 - 4


# ---- on-disk store ---------------------------------------------------------------------

def deliverables_root() -> pathlib.Path:
    return attachments_dir() / "deliverables"


def deliverable_dir(task_id: str, deliverable_id: str) -> Optional[pathlib.Path]:
    return contained_path(deliverables_root(), str(task_id), str(deliverable_id))


def staging_dir() -> pathlib.Path:
    return deliverables_root() / ".staging"


def new_staging_path() -> pathlib.Path:
    d = staging_dir()
    d.mkdir(parents=True, exist_ok=True)
    return d / (uuid.uuid4().hex + ".part")


def stored_name_for(version: int, path: str) -> str:
    return f"v{int(version)}.{ext_of(path)}"


def resolve_version_file(
    task_id: str, deliverable_id: str, stored_name: str
) -> Optional[pathlib.Path]:
    """Resolve a stored version file, refusing anything outside its deliverable dir."""
    if not stored_name or not STORED_NAME.match(stored_name):
        return None
    base = deliverable_dir(task_id, deliverable_id)
    if base is None:
        return None
    p = contained_path(base, stored_name)
    if p is None:
        return None
    try:
        if os.path.dirname(p) != os.path.realpath(base) or not p.is_file():
            return None
    except OSError:
        return None
    return p


def sha256_file(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def read_text(path: pathlib.Path, limit: int = TEXT_PREVIEW_MAX_BYTES) -> tuple[str, bool]:
    """Read up to ``limit`` bytes as UTF-8 (lossy); returns (text, truncated)."""
    with open(path, "rb") as fh:
        data = fh.read(limit + 1)
    truncated = len(data) > limit
    if truncated:
        data = data[:limit]
    return data.decode("utf-8", errors="replace"), truncated


# ---- text diff --------------------------------------------------------------------------

def text_diff(
    path: str,
    old_text: str,
    new_text: str,
    *,
    old_label: str,
    new_label: str,
    max_lines: int = DIFF_MAX_OUTPUT_LINES,
) -> dict:
    """A git-style unified diff (so the portal's FilesChanged viewer renders it as-is).

    Returns {diff, added, removed, identical, truncated, from_label, to_label}. The header
    uses the logical path on both sides (``diff --git a/<path> b/<path>``); the version
    labels ride alongside in the response (the viewer parses the path off ``+++ b/``, so
    nothing may trail it)."""
    old_lines = old_text.splitlines()
    new_lines = new_text.splitlines()
    body = list(
        difflib.unified_diff(old_lines, new_lines, lineterm="", n=3)
    )[2:]  # drop difflib's own ---/+++ header; we write a git-shaped one
    added = sum(1 for l in body if l.startswith("+"))
    removed = sum(1 for l in body if l.startswith("-"))
    truncated = len(body) > max_lines
    if truncated:
        body = body[:max_lines]
    header = [
        f"diff --git a/{path} b/{path}",
        f"--- a/{path}",
        f"+++ b/{path}",
    ]
    return {
        "diff": "\n".join(header + body) if body else "",
        "added": added,
        "removed": removed,
        "identical": not body,
        "truncated": truncated,
        "from_label": old_label,
        "to_label": new_label,
    }
