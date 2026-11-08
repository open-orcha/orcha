"""Rectangles, and the points-to-pixels conversion every pixel check depends on.

**The scale trap.** Element bounds come from the accessibility tree in *points*; screenshots
come back in *pixels*. On the iPhone 17 Pro the screen is 402 points wide and `simctl io
screenshot` returns a 1206-pixel-wide PNG — a 3x factor. Cropping an element's bounds straight
out of the image therefore samples the top-left ninth of the screen and reads the wrong colours
entirely, which would make every contrast and clipping number quietly wrong rather than
visibly broken.

So the scale is **derived per screenshot** by dividing image width by the session's reported
point width, never taken from a hard-coded per-device table (which would rot the moment Apple
ships a new size — as it just did with the iOS 27 device set). Android and web have their own
densities; the same derivation covers all three without knowing which platform it is looking
at.
"""

from __future__ import annotations

from typing import NamedTuple, Protocol


class Rect(NamedTuple):
    """Axis-aligned box. Always inclusive-exclusive: `x2`/`y2` are one past the last pixel, so
    `width`/`height` are plain subtractions and an empty box is `x1 == x2`."""

    x1: int
    y1: int
    x2: int
    y2: int

    @property
    def width(self) -> int:
        return max(0, self.x2 - self.x1)

    @property
    def height(self) -> int:
        return max(0, self.y2 - self.y1)

    @property
    def area(self) -> int:
        return self.width * self.height

    @property
    def empty(self) -> bool:
        return self.area == 0


class HasBounds(Protocol):
    """Just the part of `recording.tree.Element` this package needs, so the audit never imports
    the driver-facing tree model and stays testable with plain stubs."""

    x1: int
    y1: int
    x2: int
    y2: int


def scale_for(image_size: tuple[int, int], screen_points: tuple[int, int] | None) -> float:
    """Pixels per point for this screenshot.

    Derived, not looked up: `image_width / point_width`. Returns 1.0 when the point size is
    unknown or nonsensical, which is the safe default — a wrong scale silently corrupts every
    measurement, so guessing is worse than assuming none.

    Uses width alone and does not cross-check height on purpose: a status-bar crop or a
    letterboxed capture changes the height ratio without changing the density, and rejecting
    those would disable the audit on exactly the screenshots it should still work on.
    """
    if not screen_points:
        return 1.0
    img_w, _ = image_size
    pt_w, _ = screen_points
    if img_w <= 0 or pt_w <= 0:
        return 1.0
    scale = img_w / pt_w
    # Densities are small positive numbers (1, 2, 3, occasionally 2.75 on Android). Anything
    # outside that band means the point size did not belong to this screenshot.
    if not (0.5 <= scale <= 5.0):
        return 1.0
    return scale


def element_rect(element: HasBounds, scale: float = 1.0) -> Rect:
    """The element's bounds as image-pixel coordinates.

    Rounds outward (floor the top-left, ceil the bottom-right) so a crop always covers the
    whole element. Rounding inward would shave the edge pixels, and an element's edge is
    exactly where its border and its background meet — the pixels a contrast check most needs.
    """
    import math

    x1 = math.floor(element.x1 * scale)
    y1 = math.floor(element.y1 * scale)
    x2 = math.ceil(element.x2 * scale)
    y2 = math.ceil(element.y2 * scale)
    return Rect(x1, y1, max(x1, x2), max(y1, y2))


def clamp_rect(rect: Rect, image_size: tuple[int, int]) -> Rect:
    """`rect` trimmed to the image. An element may legitimately extend past the screen (that is
    the `OFF_SCREEN` finding); the *crop* still has to be inside the bitmap."""
    w, h = image_size
    x1 = min(max(0, rect.x1), w)
    y1 = min(max(0, rect.y1), h)
    x2 = min(max(x1, rect.x2), w)
    y2 = min(max(y1, rect.y2), h)
    return Rect(x1, y1, x2, y2)


def intersection_area(a: Rect, b: Rect) -> int:
    """Overlapping area in square pixels, 0 when they do not overlap."""
    x1 = max(a.x1, b.x1)
    y1 = max(a.y1, b.y1)
    x2 = min(a.x2, b.x2)
    y2 = min(a.y2, b.y2)
    if x2 <= x1 or y2 <= y1:
        return 0
    return (x2 - x1) * (y2 - y1)


def fraction_outside(rect: Rect, image_size: tuple[int, int]) -> float:
    """How much of `rect` falls outside the screen, 0.0 (fully visible) to 1.0 (fully off).

    Reported as a fraction rather than a boolean because partly-clipped is the interesting
    case: a button 5% off the edge is a layout bug worth a minor finding, while one entirely
    off-screen is usually an inactive page in a carousel and not a defect at all.
    """
    if rect.empty:
        return 0.0
    w, h = image_size
    visible = intersection_area(rect, Rect(0, 0, w, h))
    return 1.0 - (visible / rect.area)
