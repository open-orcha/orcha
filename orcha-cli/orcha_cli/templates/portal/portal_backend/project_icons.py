"""D14 project-icon validation — the one shape the portal and the desktop share.

A project icon is cosmetic: nothing server-side reads it. The shape mirrors
desktop/src/renderer/src/host/projectIcons.ts and the portal's
cloud/projects/prefs.ts ``ProjectIconValue``:

  {"kind": "emoji", "value": "🚀"}
  {"kind": "glyph", "value": <one of PROJECT_ICON_GLYPHS>, "color": 0-9 | null}

``color`` is a slot of the shared avatar palette (AVATAR_HUES, D13), so a colour
means the same hue in both apps. Anything else is rejected with a 422.
"""

import unicodedata

from fastapi import HTTPException

PROJECT_ICON_GLYPHS = (
    "box", "folder", "code", "terminal", "rocket", "globe", "smartphone", "server",
    "database", "cloud", "cpu", "bot", "zap", "flask", "shield", "book", "briefcase",
    "cart", "gamepad", "music", "camera", "palette", "heart", "star", "leaf", "wrench",
    "chart", "mail",
)
PROJECT_ICON_COLORS = 10  # len(AVATAR_HUES)
EMOJI_MAX_UTF16 = 16


def _utf16_len(value: str) -> int:
    return len(value.encode("utf-16-le")) // 2


def is_emoji(value) -> bool:
    """Short text with at least one pictographic code point (flags = regional
    indicators, keycaps = U+20E3) — never a word, never markup."""
    if not isinstance(value, str) or not value or _utf16_len(value) > EMOJI_MAX_UTF16:
        return False
    if any(ch.isascii() and ch.isalpha() for ch in value):
        return False
    if any(ch in "<>&\"'" for ch in value):
        return False
    if "️" in value:  # emoji presentation selector: ‼️ ℹ️ ❤️ …
        return True
    for ch in value:
        cp = ord(ch)
        if 0x1F1E6 <= cp <= 0x1F1FF or cp == 0x20E3:
            return True
        if unicodedata.category(ch) == "So" and cp >= 0x2000:
            return True
    return False


def validate_project_icon(icon):
    """Normalize one icon (None passes through = clear); 422 on anything malformed."""
    if icon is None:
        return None
    if not isinstance(icon, dict):
        raise HTTPException(422, "icon must be an object or null")
    kind = icon.get("kind")
    if kind == "emoji":
        if not is_emoji(icon.get("value")):
            raise HTTPException(422, "icon value must be one emoji")
        return {"kind": "emoji", "value": icon["value"]}
    if kind == "glyph":
        if icon.get("value") not in PROJECT_ICON_GLYPHS:
            raise HTTPException(422, f"unknown icon glyph {icon.get('value')!r}")
        color = icon.get("color")
        if color is not None and (
            isinstance(color, bool)
            or not isinstance(color, int)
            or not 0 <= color < PROJECT_ICON_COLORS
        ):
            raise HTTPException(
                422, f"icon color must be null or 0-{PROJECT_ICON_COLORS - 1}"
            )
        return {"kind": "glyph", "value": icon["value"], "color": color}
    raise HTTPException(422, "icon kind must be 'emoji' or 'glyph'")
