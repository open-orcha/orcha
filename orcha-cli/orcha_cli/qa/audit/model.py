"""The shape every audit check returns.

One type for all checks, so the report, the database and the UI never have to branch per
check. A finding always carries three things a reader can act on:

1. **What was measured** (`measured`) and **what was required** (`threshold`) — so the claim is
   arguable on its merits rather than on trust. A finding with no number is an impression, and
   impressions do not belong in this package (see the package docstring).
2. **Where to look** (`rect`) — the crop that proves it, in *image pixels*, ready to cut out of
   the screenshot with no further conversion.
3. **What it is** (`kind`) — a stable machine key, so counts trend across app versions. Never
   renumber or reword these: a renamed kind silently breaks every historical comparison.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from .geometry import Rect


class AuditKind(str, Enum):
    """Stable machine keys. Renaming one breaks version-over-version trends — don't."""

  
    DARK_MODE_TEXT_VANISHES = "dark_mode_text_vanishes"
    DARK_MODE_NO_CHANGE = "dark_mode_no_change"
    DARK_MODE_ELEMENT_MISSING = "dark_mode_element_missing"
    DARK_MODE_IMAGE_VANISHES = "dark_mode_image_vanishes"

  
    LOW_CONTRAST = "low_contrast"
    CLIPPED_TEXT = "clipped_text"
    OFF_SCREEN = "off_screen"
    OVERLAPPING_CONTROLS = "overlapping_controls"

  
    TAP_TARGET_TOO_SMALL = "tap_target_too_small"
    UNDER_SYSTEM_INSET = "under_system_inset"

  
    INCONSISTENT_SCREEN = "inconsistent_screen"

  
    EMPTY_LABEL = "empty_label"
    LABEL_EQUALS_IDENTIFIER = "label_equals_identifier"
    IMAGE_WITHOUT_LABEL = "image_without_label"
    MISSING_IDENTIFIER = "missing_identifier"


class Severity(str, Enum):
    """Matches the severities findings already use, so an
    audit finding can sit beside a functional one without a second vocabulary."""

    BLOCKER = "blocker"
    MAJOR = "major"
    MINOR = "minor"
    COSMETIC = "cosmetic"
    INFO = "info"


@dataclass(frozen=True)
class AuditFinding:
    """One measured defect.

    `measured` and `threshold` are deliberately floats with a free-text `unit` rather than a
    per-check union type: every check is "a number against a limit" (a ratio, a point size, a
    pixel count, a fraction), and one shape keeps the report renderer and the DB row simple.

    `confident` is False when the measurement is sound but the *interpretation* is not — a
    contrast reading over a photo or a gradient, say. Those are reported as "needs a look"
    rather than as failures, which is what keeps this package honest: an approximate method
    must not produce confident-sounding claims.
    """

    kind: AuditKind
    severity: Severity
    summary: str
    """One sentence, present tense, naming the thing and the problem."""

    measured: float | None = None
    threshold: float | None = None
    unit: str = ""
    rect: Rect | None = None
    """Crop that proves it, in image pixels. None for whole-screen findings."""

    element_index: int | None = None
    element_label: str | None = None
    element_identifier: str | None = None

    appearance: str | None = None
    """"light"/"dark" when the finding is mode-specific."""

    confident: bool = True
    """False -> report as "needs more information", never as a failure."""

    detail: dict[str, Any] = field(default_factory=dict)
    """Check-specific extras (e.g. both colours for a contrast finding)."""

    def as_row(self) -> dict[str, Any]:
        """Flat dict for storage/JSON. Keys are stable — they are the report's schema."""
        return {
            "kind": self.kind.value,
            "severity": self.severity.value,
            "summary": self.summary,
            "measured": self.measured,
            "threshold": self.threshold,
            "unit": self.unit,
            "rect": list(self.rect) if self.rect else None,
            "element_index": self.element_index,
            "element_label": self.element_label,
            "element_identifier": self.element_identifier,
            "appearance": self.appearance,
            "confident": self.confident,
            "detail": self.detail or {},
        }
