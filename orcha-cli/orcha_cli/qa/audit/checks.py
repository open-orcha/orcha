"""The per-screen checks: accessibility identifiers, tap targets, bounds, overlap, contrast.

Each is a pure function taking the elements (and, where pixels are needed, the screenshot) and
returning `AuditFinding`s. Nothing here talks to a device, a database or a model.


The light/dark comparison lives in `darkmode.py` because it is the only check that needs two
screens rather than one.
"""

from __future__ import annotations

import io
from typing import Any, Iterable, Sequence

from . import color as colormod
from .geometry import (
    Rect,
    clamp_rect,
    element_rect,
    fraction_outside,
    intersection_area,
    scale_for,
)
from .model import AuditFinding, AuditKind, Severity

# Platform minimum tap targets. Apple's HIG says 44x44pt; Android's Material spec says 48x48dp.
# Both are expressed in the same point/dp unit the accessibility tree reports, so no conversion.
MIN_TAP_IOS_PT = 44.0
MIN_TAP_ANDROID_PT = 48.0
MIN_TAP_WEB_PT = 24.0
"""WCAG 2.2 target-size minimum (2.5.8). Lower than the mobile HIGs because a pointer is more
precise than a fingertip, and holding web pages to 44pt would flood every report with findings
against perfectly usable desktop UI."""

OFF_SCREEN_REPORT_THRESHOLD = 0.02
"""Ignore a sliver: sub-pixel rounding and 1px borders routinely put a fraction of an element
past the edge without anything being wrong."""

OFF_SCREEN_FULLY = 0.999
"""At or above this the element is entirely off-screen, which is usually an inactive carousel
page or an off-canvas drawer — normal, not a defect."""

OVERLAP_REPORT_FRACTION = 0.25
"""Interactive siblings may share a few pixels of padding. A quarter of the smaller control
covered is where a tap genuinely becomes ambiguous."""

_IMAGE_TYPES = frozenset({"Image", "Icon", "img"})


def _text_of(element: Any) -> str:
    return (getattr(element, "label", "") or "").strip()


def _identifier_of(element: Any) -> str:
    return (getattr(element, "identifier", "") or "").strip()


def _is_interactive(element: Any) -> bool:
    return bool(getattr(element, "interactive", False))


def _is_image(element: Any) -> bool:
    return getattr(element, "type", "") in _IMAGE_TYPES


def _enabled(element: Any) -> bool:
    return bool(getattr(element, "enabled", True))


def _describe(element: Any) -> str:
    """Short human handle for a finding's summary: label, else identifier, else type+index."""
    return (
        _text_of(element)
        or _identifier_of(element)
        or f"{getattr(element, 'type', 'element')} #{getattr(element, 'index', '?')}"
    )


def _finding(
    element: Any,
    kind: AuditKind,
    severity: Severity,
    summary: str,
    *,
    measured: float | None = None,
    threshold: float | None = None,
    unit: str = "",
    rect: Rect | None = None,
    appearance: str | None = None,
    confident: bool = True,
    detail: dict[str, Any] | None = None,
) -> AuditFinding:
    return AuditFinding(
        kind=kind,
        severity=severity,
        summary=summary,
        measured=measured,
        threshold=threshold,
        unit=unit,
        rect=rect,
        element_index=getattr(element, "index", None),
        element_label=_text_of(element) or None,
        element_identifier=_identifier_of(element) or None,
        appearance=appearance,
        confident=confident,
        detail=detail or {},
    )


# ---------- accessibility identifiers ----------


def check_accessibility(elements: Iterable[Any], *, appearance: str | None = None) -> list[AuditFinding]:
    """Missing or useless accessibility metadata.

    The tree is what VoiceOver and TalkBack read aloud, so an unlabelled control is literally
    unusable with a screen reader — not a style preference. These are also the most trendable
    numbers in the whole audit: unambiguous, countable, and directly comparable between app
    versions.
    """
    out: list[AuditFinding] = []
    for el in elements:
        label, ident = _text_of(el), _identifier_of(el)

        if _is_interactive(el) and not label:
            out.append(
                _finding(
                    el,
                    AuditKind.EMPTY_LABEL,
                    Severity.MAJOR,
                    f"Interactive {getattr(el, 'type', 'element')} has no accessibility label, "
                    "so a screen reader announces nothing.",
                    appearance=appearance,
                )
            )
        elif label and ident and label == ident:
            # A raw identifier read aloud ("btn_submit_2") is noise, not a name.
            out.append(
                _finding(
                    el,
                    AuditKind.LABEL_EQUALS_IDENTIFIER,
                    Severity.MINOR,
                    f'Label is the raw identifier ("{label}"), which reads as code rather than '
                    "a name.",
                    appearance=appearance,
                )
            )

        if _is_image(el) and not label:
            out.append(
                _finding(
                    el,
                    AuditKind.IMAGE_WITHOUT_LABEL,
                    Severity.MINOR,
                    "Image has no accessibility label.",
                    appearance=appearance,
                )
            )

        if _is_interactive(el) and not ident:
            # Not an end-user defect — a testability one. Without a stable id, every automated
            # test has to target by text or index, and both break on the next copy change.
            out.append(
                _finding(
                    el,
                    AuditKind.MISSING_IDENTIFIER,
                    Severity.COSMETIC,
                    f"{_describe(el)} has no stable identifier, so tests must target it by "
                    "text or position.",
                    appearance=appearance,
                )
            )
    return out


# ---------- reachability ----------


def min_tap_size(target_kind: str | None) -> float:
    return {
        "ios": MIN_TAP_IOS_PT,
        "android": MIN_TAP_ANDROID_PT,
        "web": MIN_TAP_WEB_PT,
    }.get(target_kind or "", MIN_TAP_IOS_PT)


def check_tap_targets(
    elements: Iterable[Any],
    *,
    target_kind: str | None = None,
    appearance: str | None = None,
) -> list[AuditFinding]:
    """Interactive controls smaller than the platform minimum.

    Invisible to a functional test that drives by identifier — the driver taps the centre point
    and always hits — but a real thumb misses. That gap is exactly why this belongs in an
    automated usability audit rather than in the functional suite.

    Disabled controls are skipped: nobody is trying to hit them.
    """
    minimum = min_tap_size(target_kind)
    out: list[AuditFinding] = []
    for el in elements:
        if not _is_interactive(el) or not _enabled(el):
            continue
        w = max(0, el.x2 - el.x1)
        h = max(0, el.y2 - el.y1)
        if w == 0 or h == 0:
            continue  # zero-size elements are off-screen/collapsed, covered by other checks
        smallest = float(min(w, h))
        if smallest < minimum:
            out.append(
                _finding(
                    el,
                    AuditKind.TAP_TARGET_TOO_SMALL,
                    Severity.MINOR,
                    f"{_describe(el)} is {w}x{h}pt, below the {minimum:g}pt minimum tap target.",
                    measured=smallest,
                    threshold=minimum,
                    unit="pt",
                    appearance=appearance,
                    detail={"width_pt": w, "height_pt": h},
                )
            )
    return out


def check_bounds(
    elements: Iterable[Any],
    *,
    screen_points: tuple[int, int],
    appearance: str | None = None,
) -> list[AuditFinding]:
    """Elements pushed partly off the screen.

    Only *partly*: fully off-screen is normal (an inactive carousel page, a closed drawer),
    while partly off-screen is a layout bug that clips real content.
    """
    w, h = screen_points
    out: list[AuditFinding] = []
    for el in elements:
        rect = Rect(el.x1, el.y1, el.x2, el.y2)
        if rect.empty:
            continue
        outside = fraction_outside(rect, (w, h))
        if OFF_SCREEN_REPORT_THRESHOLD < outside < OFF_SCREEN_FULLY:
            out.append(
                _finding(
                    el,
                    AuditKind.OFF_SCREEN,
                    Severity.MAJOR if outside > 0.5 else Severity.MINOR,
                    f"{_describe(el)} is {outside:.0%} outside the screen.",
                    measured=outside,
                    threshold=OFF_SCREEN_REPORT_THRESHOLD,
                    unit="fraction",
                    appearance=appearance,
                )
            )
    return out


def check_overlap(
    elements: Sequence[Any],
    *,
    appearance: str | None = None,
) -> list[AuditFinding]:
    """Interactive controls covering one another, so a tap is ambiguous.

    Compared against the *smaller* control's area: a small button lost under a large card is
    the real defect, and dividing by the larger area would round that down to nothing.

    Containment is skipped. A `Cell` legitimately contains its `Button`, and a tab bar contains
    its tabs — reporting every nested control would bury the genuine collisions.
    """
    out: list[AuditFinding] = []
    items = [el for el in elements if _is_interactive(el) and _enabled(el)]
    for i, a in enumerate(items):
        ra = Rect(a.x1, a.y1, a.x2, a.y2)
        if ra.empty:
            continue
        for b in items[i + 1 :]:
            rb = Rect(b.x1, b.y1, b.x2, b.y2)
            if rb.empty:
                continue
            overlap = intersection_area(ra, rb)
            if overlap == 0:
                continue
            smaller = min(ra.area, rb.area)
            if overlap >= smaller * 0.995:
                continue  # one contains the other: normal nesting
            fraction = overlap / smaller
            if fraction >= OVERLAP_REPORT_FRACTION:
                out.append(
                    _finding(
                        a,
                        AuditKind.OVERLAPPING_CONTROLS,
                        Severity.MAJOR,
                        f"{_describe(a)} and {_describe(b)} overlap by {fraction:.0%} of the "
                        "smaller control, so a tap there is ambiguous.",
                        measured=fraction,
                        threshold=OVERLAP_REPORT_FRACTION,
                        unit="fraction",
                        appearance=appearance,
                        detail={"other_index": getattr(b, "index", None), "other_label": _text_of(b)},
                    )
                )
    return out


# ---------- contrast ----------


def _pixels_of(image: Any) -> list[colormod.RGB]:
    """Every pixel of `image` as RGB tuples.

    `Image.getdata()` is deprecated and goes away in Pillow 14 (Oct 2027), but
    `get_flattened_data()` only exists in newer releases — so prefer the new name and fall
    back, rather than pinning this package to one Pillow generation.
    """
    getter = getattr(image, "get_flattened_data", None)
    return list(getter() if callable(getter) else image.getdata())


def _crop_pixels(image: Any, rect: Rect, max_samples: int = 4000) -> list[colormod.RGB]:
    """Pixels inside `rect`, subsampled to at most `max_samples`.

    A full-screen crop on a 3x device is ~3M pixels; colour *proportions* are what the estimate
    needs, and those are preserved by an even stride. Sampling keeps a whole-screen audit fast
    enough to run on every step without changing the answer.
    """
    if rect.empty:
        return []
    region = image.crop((rect.x1, rect.y1, rect.x2, rect.y2)).convert("RGB")
    pixels = _pixels_of(region)
    if len(pixels) <= max_samples:
        return pixels
    stride = len(pixels) // max_samples + 1
    return pixels[::stride]


def check_contrast(
    png: bytes,
    elements: Iterable[Any],
    *,
    screen_points: tuple[int, int] | None = None,
    appearance: str | None = None,
    font_pt_of: Any = None,
) -> list[AuditFinding]:
    """Text and controls whose contrast falls below the WCAG AA minimum.

    Only elements that carry a label are examined: a container with no text has nothing to
    read, and measuring it would report the contrast of a background against a border.

    Low-confidence readings (photos, gradients, near-empty crops) are still returned, flagged
    `confident=False`, so the report can show them as "needs a look" rather than dropping
    evidence or overstating it.
    """
    from PIL import Image as PILImage

    image = PILImage.open(io.BytesIO(png))
    scale = scale_for(image.size, screen_points)

    out: list[AuditFinding] = []
    for el in elements:
        label = _text_of(el)
        graphic = _is_image(el)
        if not label and not graphic:
            continue

        rect = clamp_rect(element_rect(el, scale), image.size)
        if rect.empty:
            continue

        pair = colormod.dominant_pair(_crop_pixels(image, rect))
        if pair is None or pair.foreground == pair.background:
            continue  # flat block: nothing to read

        font_pt = font_pt_of(el) if callable(font_pt_of) else None
        required = colormod.required_ratio(font_pt, is_graphic=graphic and not label)
        if pair.ratio >= required:
            continue

        out.append(
            _finding(
                el,
                AuditKind.LOW_CONTRAST,
                Severity.MINOR if pair.confident else Severity.INFO,
                (
                    f'"{_describe(el)}" has {pair.ratio:.1f}:1 contrast, below the '
                    f"{required:g}:1 minimum."
                    if pair.confident
                    else (
                        f'"{_describe(el)}" measures {pair.ratio:.1f}:1, below {required:g}:1, '
                        "but sits over a photo or gradient — needs a human look."
                    )
                ),
                measured=round(pair.ratio, 2),
                threshold=required,
                unit="ratio",
                rect=rect,
                appearance=appearance,
                confident=pair.confident,
                detail={
                    "foreground": colormod.hex_of(pair.foreground),
                    "background": colormod.hex_of(pair.background),
                    "distinct_colors": pair.distinct_colors,
                },
            )
        )
    return out
