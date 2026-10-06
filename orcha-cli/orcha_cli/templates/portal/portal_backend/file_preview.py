"""Raw-bytes plumbing for the portal's file previews (images, PDF, media, fonts).

The code viewer and every diff view render non-text files natively in the browser
(`<img>`, `<video>`, `<audio>`, the built-in PDF viewer). They fetch the bytes from the
`/raw` routes in `file_raw_routes`; this module holds what those routes share:

  * `content_type_for(path, data)` — the Content-Type, by extension and confirmed by a
    magic-byte sniff. Text is ALWAYS `text/plain` (an `.html` file is never served as
    HTML on the portal origin), and a "raster image" whose bytes aren't that format is
    downgraded to `application/octet-stream`.
  * `raw_response(...)` — the response with the safe headers: `nosniff` always, a
    `sandbox` CSP on everything but PDF (Chrome's viewer refuses sandboxed documents;
    a PDF isn't HTML), `Content-Disposition: inline` ONLY for inert media types (SVG
    is an attachment, so opening its URL never renders an active document on the
    portal origin — `<img>` ignores the disposition), and single-range support so a
    `<video>` can seek.
  * `git_binary_patch_hunks` / `apply_git_delta` — decode the `GIT binary patch`
    sections `git diff --binary` writes (a captured run diff stores ONLY that text: the
    worktree it came from may be gone), so a finished run's images still render.
"""

from __future__ import annotations

import base64
import re
import zlib

from fastapi import HTTPException, Request
from fastapi.responses import Response

# A preview reads the whole blob into memory (git objects, decoded patches) — bounded.
RAW_MAX_BYTES = 50 * 1024 * 1024

EXT_MIME = {
    # raster images
    "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif",
    "webp": "image/webp", "avif": "image/avif", "bmp": "image/bmp", "ico": "image/x-icon",
    # vector — served as an image, never as an inline document
    "svg": "image/svg+xml",
    "pdf": "application/pdf",
    # video / audio
    "mp4": "video/mp4", "m4v": "video/mp4", "webm": "video/webm", "mov": "video/quicktime",
    "mp3": "audio/mpeg", "wav": "audio/wav", "ogg": "audio/ogg", "oga": "audio/ogg",
    "m4a": "audio/mp4", "flac": "audio/flac", "aac": "audio/aac",
    # fonts
    "ttf": "font/ttf", "otf": "font/otf", "woff": "font/woff", "woff2": "font/woff2",
}

# Types a browser renders inertly (no script) — the only ones served `inline`.
INLINE_SAFE = frozenset({
    "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp",
    "image/x-icon", "application/pdf", "video/mp4", "video/webm", "video/quicktime",
    "audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4", "audio/flac", "audio/aac",
    "font/ttf", "font/otf", "font/woff", "font/woff2",
})

# Raster/PDF formats whose leading bytes we can confirm.
_RASTER_EXTS = {"png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "pdf"}

SANDBOX_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox"


def ext_of(path: str) -> str:
    name = (path or "").rsplit("/", 1)[-1]
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


def sniff_mime(head: bytes) -> "str | None":
    """The format a file's leading bytes prove, or None."""
    h = head[:32]
    if h.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if h.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if h.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if h[:4] == b"RIFF" and h[8:12] == b"WEBP":
        return "image/webp"
    if h[:4] == b"RIFF" and h[8:12] == b"WAVE":
        return "audio/wav"
    if h.startswith(b"BM") and len(h) >= 6:
        return "image/bmp"
    if h.startswith(b"\x00\x00\x01\x00"):
        return "image/x-icon"
    if h.startswith(b"%PDF-"):
        return "application/pdf"
    if h[4:8] == b"ftyp":
        brand = h[8:12]
        if brand in (b"avif", b"avis"):
            return "image/avif"
        if brand == b"qt  ":
            return "video/quicktime"
        if brand in (b"M4A ", b"M4B "):
            return "audio/mp4"
        return "video/mp4"
    if h.startswith(b"\x1a\x45\xdf\xa3"):
        return "video/webm"
    if h.startswith(b"OggS"):
        return "audio/ogg"
    if h.startswith(b"fLaC"):
        return "audio/flac"
    if h.startswith(b"ID3") or (len(h) > 1 and h[0] == 0xFF and (h[1] & 0xE0) == 0xE0 and h[1] not in (0xFF,)):
        return "audio/mpeg"
    if h.startswith(b"wOF2"):
        return "font/woff2"
    if h.startswith(b"wOFF"):
        return "font/woff"
    if h.startswith(b"PK\x03\x04"):
        return "application/zip"
    return None


def is_probably_binary(data: bytes) -> bool:
    return b"\x00" in data[:8192]


def content_type_for(path: str, data: bytes) -> str:
    """Extension first, confirmed by the bytes; unknown extensions are sniffed; text is
    always text/plain (never an active type)."""
    ext = ext_of(path)
    sniffed = sniff_mime(data[:32])
    mime = EXT_MIME.get(ext)
    if mime:
        if ext in _RASTER_EXTS and sniffed != mime and not (ext == "ico" and sniffed == "image/bmp"):
            return "application/octet-stream"
        if mime == "image/svg+xml" and is_probably_binary(data):
            return "application/octet-stream"
        return mime
    if sniffed:
        return sniffed
    if is_probably_binary(data):
        return "application/octet-stream"
    try:
        data[:65536].decode("utf-8")
    except UnicodeDecodeError as exc:
        # a cut mid-character at the probe boundary is still text
        if exc.start < len(data[:65536]) - 4:
            return "application/octet-stream"
    return "text/plain; charset=utf-8"


def _filename_header(path: str, disposition: str) -> str:
    name = (path or "file").rsplit("/", 1)[-1] or "file"
    ascii_name = re.sub(r'[^A-Za-z0-9._ -]', "_", name)[:120] or "file"
    from urllib.parse import quote

    return f"{disposition}; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(name)}"


def _parse_range(header: str, size: int) -> "tuple[int, int] | None":
    m = re.fullmatch(r"\s*bytes=(\d*)-(\d*)\s*", header or "")
    if not m or (not m.group(1) and not m.group(2)):
        return None
    if m.group(1):
        start = int(m.group(1))
        end = int(m.group(2)) if m.group(2) else size - 1
    else:
        length = int(m.group(2))
        start, end = max(0, size - length), size - 1
    end = min(end, size - 1)
    if start > end or start >= size:
        return None
    return start, end


def raw_response(request: "Request | None", data: bytes, path: str, *, download: bool = False,
                 cache: str = "private, max-age=60") -> Response:
    """The bytes with preview-safe headers (see module docstring)."""
    if len(data) > RAW_MAX_BYTES:
        raise HTTPException(413, f"file is larger than the {RAW_MAX_BYTES // (1024 * 1024)} MB preview cap")
    mime = content_type_for(path, data)
    base_mime = mime.split(";", 1)[0]
    inline = (not download) and base_mime in INLINE_SAFE
    headers = {
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": _filename_header(path, "inline" if inline else "attachment"),
        "Cache-Control": cache,
        "Accept-Ranges": "bytes",
        "X-Orcha-Size": str(len(data)),
    }
    if base_mime != "application/pdf":
        headers["Content-Security-Policy"] = SANDBOX_CSP
    rng = request.headers.get("range") if request is not None else None
    if rng and data:
        span = _parse_range(rng, len(data))
        if span is None:
            return Response(status_code=416, headers={**headers, "Content-Range": f"bytes */{len(data)}"})
        start, end = span
        headers["Content-Range"] = f"bytes {start}-{end}/{len(data)}"
        return Response(content=data[start:end + 1], status_code=206, media_type=mime, headers=headers)
    return Response(content=data, media_type=mime, headers=headers)


# ---------------------------------------------------------------- git binary patches

_B85 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~"


def _line_len(ch: str) -> int:
    if "A" <= ch <= "Z":
        return ord(ch) - ord("A") + 1
    if "a" <= ch <= "z":
        return ord(ch) - ord("a") + 27
    raise ValueError("bad binary patch line length")


def _decode_b85_lines(lines: list) -> bytes:
    out = bytearray()
    for line in lines:
        n = _line_len(line[0])
        body = line[1:]
        if len(body) % 5:
            raise ValueError("bad binary patch line")
        # git's base85 alphabet is RFC 1924's, the one base64.b85decode uses
        out += base64.b85decode(body)[:n]
    return bytes(out)


def git_binary_patch_hunks(section: str) -> list:
    """`GIT binary patch` → [(kind, size, inflated_bytes)] in patch order: the forward
    hunk (old → new) then the reverse one (new → old). `kind` is "literal" (the whole
    blob) or "delta" (a git delta against the other side). [] when the section has no
    binary patch."""
    lines = section.split("\n")
    try:
        i = next(k for k, ln in enumerate(lines) if ln.startswith("GIT binary patch"))
    except StopIteration:
        return []
    hunks = []
    j = i + 1
    while j < len(lines) and len(hunks) < 2:
        m = re.match(r"^(literal|delta) (\d+)$", lines[j])
        if not m:
            if lines[j].startswith("diff --git "):
                break
            j += 1
            continue
        kind, size = m.group(1), int(m.group(2))
        j += 1
        body = []
        while j < len(lines) and lines[j] != "":
            body.append(lines[j])
            j += 1
        raw = zlib.decompress(_decode_b85_lines(body))
        if len(raw) != size:  # both hunk kinds state their INFLATED size
            raise ValueError("binary patch size mismatch")
        hunks.append((kind, size, raw))
    return hunks


def _varint(buf: bytes, pos: int) -> "tuple[int, int]":
    value = shift = 0
    while True:
        b = buf[pos]
        pos += 1
        value |= (b & 0x7F) << shift
        shift += 7
        if not b & 0x80:
            return value, pos


def apply_git_delta(base: bytes, delta: bytes) -> bytes:
    """Apply a git pack delta (the `delta` hunk of a binary patch) to `base`."""
    src_size, pos = _varint(delta, 0)
    dst_size, pos = _varint(delta, pos)
    if src_size != len(base):
        raise ValueError("delta base size mismatch")
    out = bytearray()
    while pos < len(delta):
        op = delta[pos]
        pos += 1
        if op & 0x80:
            off = size = 0
            for bit in range(4):
                if op & (1 << bit):
                    off |= delta[pos] << (8 * bit)
                    pos += 1
            for bit in range(3):
                if op & (0x10 << bit):
                    size |= delta[pos] << (8 * bit)
                    pos += 1
            if size == 0:
                size = 0x10000
            out += base[off:off + size]
        elif op:
            out += delta[pos:pos + op]
            pos += op
        else:
            raise ValueError("bad delta opcode")
    if len(out) != dst_size:
        raise ValueError("delta result size mismatch")
    return bytes(out)


_INDEX_RE = re.compile(r"^index ([0-9a-f]{4,64})\.\.([0-9a-f]{4,64})(?: \d+)?$", re.M)
_ZERO = re.compile(r"^0+$")


def index_ids(section: str) -> "tuple[str | None, str | None]":
    """The (old, new) blob ids from a section's `index <old>..<new>` header (None for
    the all-zero id of an added/deleted side)."""
    m = _INDEX_RE.search(section)
    if not m:
        return None, None
    old, new = m.group(1), m.group(2)
    return (None if _ZERO.match(old) else old), (None if _ZERO.match(new) else new)


def blob_from_section(section: str, side: str, fetch_blob) -> "bytes | None":
    """One side ("old" | "new") of a diff section's file, reconstructed from what the
    text carries: a literal binary-patch hunk, a delta against the other side, or the
    blob id in the `index` header looked up through `fetch_blob(oid) -> bytes|None`
    (the project's object store). None when nothing can produce it."""
    old_id, new_id = index_ids(section)
    want_id = old_id if side == "old" else new_id
    if want_id is None and _INDEX_RE.search(section):
        return None  # the all-zero id: this side doesn't exist (added / deleted file)
    try:
        hunks = git_binary_patch_hunks(section)
    except (ValueError, zlib.error, IndexError):
        hunks = []

    def by_id(oid):
        return fetch_blob(oid) if oid else None

    if len(hunks) == 1 and side == "new" and hunks[0][0] == "literal":
        return hunks[0][2]
    if len(hunks) == 2:
        fwd, rev = hunks
        mine, other = (rev, fwd) if side == "old" else (fwd, rev)
        if mine[0] == "literal":
            return mine[2]
        # mine is a delta against the other side
        base = None
        if other[0] == "literal":
            base = other[2]
        else:
            base = by_id(new_id if side == "old" else old_id)
        if base is not None:
            try:
                return apply_git_delta(base, mine[2])
            except (ValueError, IndexError):
                pass
    found = by_id(want_id)
    if found is None and not hunks:
        found = _whole_file_from_text_hunk(section, side)
    return found


def _whole_file_from_text_hunk(section: str, side: str) -> "bytes | None":
    """An ADDED (new side) or DELETED (old side) text file's whole content is its one
    hunk's +/- lines — e.g. a text-encoded PDF or an SVG an agent wrote."""
    lines = section.split("\n")
    if side == "new" and not any(ln.startswith("new file mode") for ln in lines):
        return None
    if side == "old" and not any(ln.startswith("deleted file mode") for ln in lines):
        return None
    try:
        start = next(i for i, ln in enumerate(lines) if ln.startswith("@@"))
    except StopIteration:
        return None
    mark = "+" if side == "new" else "-"
    out, no_eol = [], False
    for ln in lines[start + 1:]:
        if ln.startswith("@@") or ln.startswith("diff --git "):
            return None  # more than one hunk: not a whole-file add/delete
        if ln.startswith("\\"):
            no_eol = True
        elif ln.startswith(mark):
            out.append(ln[1:])
    text = "\n".join(out) + ("" if no_eol else "\n")
    return text.encode("utf-8")
