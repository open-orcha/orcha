"""Usability measurements over a screenshot and an element tree (see `measure_screen`).

Everything here is a pure function of (screenshot bytes, elements): no device, no network, no
model. A finding is measured ("this label's contrast is 2.1:1, below 4.5:1, here is the crop"),
reproducible and trendable across sessions. What an agent judges is a finding of its own and is
never mixed in here.
"""

from __future__ import annotations

import hashlib
from typing import Any, Optional

from . import checks
from .model import AuditFinding, AuditKind, Severity

__all__ = ["AuditFinding", "AuditKind", "Severity", "fingerprint", "measure_screen"]


def fingerprint(row: dict[str, Any], screen_key: Optional[str]) -> str:
    """The same problem on the same screen, across steps and across sessions."""
    who = row.get("element_identifier") or row.get("element_label") or ""
    raw = f"{row.get('kind')}|{screen_key or ''}|{who}|{row.get('appearance') or ''}"
    return hashlib.sha256(raw.encode()).hexdigest()[:24]


def measure_screen(shot: Any, *, target_kind: Optional[str]) -> list[dict[str, Any]]:
    """Every single-screen check against a screen (`.elements`, `.png`, `.size` in points), as
    flat rows. A check that cannot run on this screen is skipped; the others still report."""
    elements = list(getattr(shot, "elements", None) or [])
    if not elements:
        return []
    from ..device.tree import visible_elements

    try:
        elements = list(visible_elements(elements))
    except Exception:  # noqa: BLE001 - the plain list does
        pass
    size = getattr(shot, "size", None)
    screen = (int(size[0]), int(size[1])) if size and size[0] and size[1] else None
    png = getattr(shot, "png", None)
    runs: list[Any] = [
        lambda: checks.check_accessibility(elements),
        lambda: checks.check_tap_targets(elements, target_kind=target_kind),
        lambda: checks.check_overlap(elements),
    ]
    if screen:
        runs.append(lambda: checks.check_bounds(elements, screen_points=screen))
    if png:
        runs.append(lambda: checks.check_contrast(png, elements, screen_points=screen))
    out: list[AuditFinding] = []
    for run in runs:
        try:
            out += run()
        except Exception:  # noqa: BLE001 - a measurement never stops a session
            continue
    return [f.as_row() for f in out]
