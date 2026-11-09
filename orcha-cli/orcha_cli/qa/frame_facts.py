"""What a frame says, read once as it is captured: its look in a few characters, whether it is
light or dark, and whether it is blank. The portal stores these with the frame (`qa_frames`) and
never decodes an image, so the Screen atlas needs no Pillow; Pillow comes with the `[qa]` extra
and is imported lazily, so without it a frame simply carries no facts.

- `fingerprint`: a 64-bit difference hash of the frame's content, its mean colour and its size,
  `"<16 hex>-<rrggbb>-<w>x<h>"` (the atlas compares two platforms' looks by it).
- `frame_appearance`: `("light" | "dark", sure)` from the frame's background.
- `is_blank`: every pixel of the app's part of it within `BLANK_LEVELS` of one colour.
"""

from __future__ import annotations

import io
from collections import Counter
from typing import Any, Optional

#: A capture whose every pixel (a phone's status bar and home bar left out) is within this many
#: levels of one colour is blank: an app in secure mode (Android's FLAG_SECURE) is captured solid
#: black, and a screen caught before it drew is one plain colour. It shows nothing of the screen,
#: so it is never a look's picture, never compared and never read as light or dark.
BLANK_LEVELS = 8
#: A frame's background (its most common shade, `BG_SHARE` of it or more) at or below `DARK_AT` is
#: dark, at or above `LIGHT_AT` light (0..255 luminance). Anything between (a dimmed sheet, a photo)
#: says nothing for sure.
DARK_AT = 80
LIGHT_AT = 170
BG_SHARE = 0.3
APPEARANCES = ("light", "dark")
#: A frame at least this square (short side over long side) is a tablet's.
TABLET_RATIO = 0.6


def fingerprint(data: bytes) -> Optional[str]:
    """A frame's look in a few characters: a 64-bit difference hash of its content (the top status
    bar cropped on a phone), its mean colour and its size in pixels. None when it is not an image
    Pillow can read."""
    try:
        from PIL import Image

        with Image.open(io.BytesIO(data)) as img:
            img = img.convert("RGB")
            w, h = img.size
            full = (w, h)
            if h > w * 1.3:  # a phone: leave the status bar out
                img = img.crop((0, int(h * 0.06), w, h))
            small = img.convert("L").resize((9, 8))
            px = small.tobytes()
            bits = 0
            for row in range(8):
                for col in range(8):
                    bits = (bits << 1) | (1 if px[row * 9 + col] > px[row * 9 + col + 1] else 0)
            r, g, b = img.resize((1, 1)).getpixel((0, 0))
    except Exception:  # noqa: BLE001 - a frame that is not an image has no fingerprint
        return None
    return f"{bits:016x}-{r:02x}{g:02x}{b:02x}-{full[0]}x{full[1]}"


def is_blank(data: bytes) -> bool:
    """Whether a frame is blank (`BLANK_LEVELS`): every pixel of the app's part of it within a few
    levels of one colour. Read at an eighth of its size (a JPEG decodes at that scale), which still
    tells a line of text from a plain colour. False when it is not an image Pillow can read."""
    try:
        from PIL import Image

        with Image.open(io.BytesIO(data)) as img:
            img.draft("RGB", (max(1, img.width // 8), max(1, img.height // 8)))
            rgb = img.convert("RGB")
    except Exception:  # noqa: BLE001 - a frame that is not an image is not known to be blank
        return False
    w, h = rgb.size
    if w < 2 or h < 2:
        return False
    if h > w * 1.3:  # a phone: its status bar and home bar are drawn over a secure window too
        rgb = rgb.crop((0, int(h * 0.06), w, int(h * 0.96)))
    return all(hi - lo <= BLANK_LEVELS for lo, hi in rgb.getextrema())


def frame_appearance(data: bytes) -> Optional[tuple[str, bool]]:
    """What a frame shows, `("light" | "dark", sure)`, from its background: the most common shade
    of the frame (a phone's status bar and home bar left out). An iPhone app running on an iPad
    sits in a black frame of its own: on a tablet-shaped frame whose sides are black, only the app
    counts. Not sure when the background is neither dark nor light or covers too little of the
    frame (a dimmed sheet, a hero photo); then the session's setting decides (`resolve_appearance`).
    None when it is not an image Pillow can read."""
    try:
        from PIL import Image

        with Image.open(io.BytesIO(data)) as img:
            img.draft("L", (max(1, img.width // 8), max(1, img.height // 8)))
            g = img.convert("L")
    except Exception:  # noqa: BLE001 - a frame that is not an image says nothing
        return None
    w, h = g.size
    if w < 4 or h < 4:
        return None
    if min(w, h) / max(w, h) >= TABLET_RATIO and h > w:
        g = g.crop((0, int(h * 0.04), w, int(h * 0.93)))
        box = g.point(lambda v: 255 if v > 12 else 0).getbbox()
        gw, _gh = g.size
        # Black on both sides and the app between: an iPhone app in its iPad frame.
        if box and box[0] > gw * 0.12 and gw - box[2] > gw * 0.12:
            g = g.crop(box)
    elif h > w * 1.3:  # a phone: the status bar and the home bar are the system's, not the app's
        g = g.crop((0, int(h * 0.06), w, int(h * 0.96)))
    px = g.resize((48, 48)).tobytes()
    buckets = Counter(v // 16 for v in px)
    shade, n = buckets.most_common(1)[0]
    share = n / len(px)
    bg = sum(v for v in px if v // 16 == shade) / n
    if share >= BG_SHARE and bg <= DARK_AT:
        return "dark", True
    if share >= BG_SHARE and bg >= LIGHT_AT:
        return "light", True
    mean = sum(px) / len(px)
    return ("dark" if mean < 110 else "light"), False


def resolve_appearance(recorded: Optional[str], shown: Optional[tuple[str, bool]]) -> Optional[str]:
    """A look's appearance: what its frame surely shows (an app can ignore the device's setting:
    a splash drawn dark on a light phone is dark), else what the session set, else the frame's
    best guess; None when nothing says."""
    rec = recorded if recorded in APPEARANCES else None
    if shown and shown[1]:
        return shown[0]
    return rec or (shown[0] if shown else None)


def read(data: bytes, recorded: Optional[str] = None, *, secure: bool = False) -> dict[str, Any]:
    """The facts `POST frames` carries for one JPEG: `{fingerprint, appearance, blank}`, only what
    could be read. A blank frame has neither a fingerprint nor an appearance. `secure`: the session
    found the app in secure mode (FLAG_SECURE), which is why it came back blank."""
    if is_blank(data):
        return {"blank": "flag_secure" if secure else "uniform"}
    out: dict[str, Any] = {}
    fp = fingerprint(data)
    if fp:
        out["fingerprint"] = fp
    shade = resolve_appearance(recorded, frame_appearance(data))
    if shade:
        out["appearance"] = shade
    return out
