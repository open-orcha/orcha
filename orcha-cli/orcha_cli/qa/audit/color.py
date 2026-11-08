"""Colour maths and the foreground/background estimate contrast depends on.

**Why this is an estimate, and why that is stated rather than hidden.** A browser can ask the
DOM for a text colour; we only have pixels. Anti-aliasing blends every glyph edge into its
background, and a gradient or a photo has no single background at all. So the honest method is:
take the two dominant colours in the element's crop, treat the rarer as ink and the commoner as
ground, and *report how confident that reading is* alongside the ratio.

When confidence is low the finding is emitted with `confident=False`, which the report renders
as "needs a look" rather than "fails". That is the rule that keeps the whole audit credible: an
approximate method must not produce confident-sounding claims.

Contrast itself is exact — the WCAG 2.x relative-luminance formula, the same one browsers and
accessibility tooling use — so only the *inputs* are estimated, never the arithmetic.
"""

from __future__ import annotations

from dataclasses import dataclass

RGB = tuple[int, int, int]

# WCAG 2.x minimums. Large text is >=18pt, or >=14pt bold.
CONTRAST_AA_NORMAL = 4.5
CONTRAST_AA_LARGE = 3.0
"""Also the minimum for interactive graphics and meaningful icons (WCAG 1.4.11)."""

LARGE_TEXT_PT = 18.0


def _channel(value: int) -> float:
    """sRGB channel to linear light, per WCAG 2.x."""
    c = value / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def relative_luminance(rgb: RGB) -> float:
    """WCAG relative luminance, 0.0 (black) to 1.0 (white)."""
    r, g, b = rgb
    return 0.2126 * _channel(r) + 0.7152 * _channel(g) + 0.0722 * _channel(b)


def contrast_ratio(a: RGB, b: RGB) -> float:
    """WCAG contrast ratio between two colours: 1.0 (identical) to 21.0 (black on white).

    Order-independent by construction — the lighter colour is always the numerator — so callers
    never have to work out which of the pair is the text.
    """
    la, lb = relative_luminance(a), relative_luminance(b)
    lighter, darker = max(la, lb), min(la, lb)
    return (lighter + 0.05) / (darker + 0.05)


def required_ratio(font_pt: float | None, *, is_graphic: bool = False) -> float:
    """The threshold this element must clear.

    Unknown font size assumes normal text (the stricter 4.5:1). Assuming *large* would let
    small text pass by default, which is the wrong way to be wrong in an accessibility check.
    """
    if is_graphic:
        return CONTRAST_AA_LARGE
    if font_pt is not None and font_pt >= LARGE_TEXT_PT:
        return CONTRAST_AA_LARGE
    return CONTRAST_AA_NORMAL


@dataclass(frozen=True)
class ColorPair:
    """The estimated ink and ground of one element, with the evidence for the estimate."""

    foreground: RGB
    background: RGB
    ratio: float
    foreground_share: float
    """Fraction of sampled pixels that are the ink colour."""
    background_share: float
    distinct_colors: int
    """How many quantised colours the crop contained. High means a photo or gradient."""

    best_ratio: float = 0.0
    """Contrast of the *most* legible non-background colour in the crop.

    `ratio` answers "is anything here hard to read?"; this answers "is anything here readable
    at all?". Both are needed because an element's crop is often more than its text: a settings
    row contains an app icon as well as a label, and a black icon on a dark background scores a
    worse ratio than the white label beside it. Judging the row by `ratio` alone reported
    Apple's own Settings as having invisible text — a false blocker, verified against the crop.
    """

    @property
    def confident(self) -> bool:
        """Whether this crop is simple enough for the two-colour model to describe it.

        Three ways a reading goes soft, each a real screen this has to survive:

        1. **Too busy** — a photo, a gradient or a busy icon has no single ground. Many
           distinct colours after quantisation is the tell.
        2. **Almost no ink** — a mostly-empty container whose few off-background pixels are
           anti-aliasing fringe, not glyphs. The "foreground" is then a blend artefact.
        3. **No clear ground** — nothing dominates, so calling the commonest colour the
           background is arbitrary.
        """
        if self.distinct_colors > MAX_DISTINCT_COLORS:
            return False
        if self.foreground_share < MIN_FOREGROUND_SHARE:
            return False
        if self.background_share < MIN_BACKGROUND_SHARE:
            return False
        return True


# Tuned against real screenshots rather than derived: a flat control settles into a handful of
# quantised colours, while a photo or gradient runs to dozens.
MAX_DISTINCT_COLORS = 24
MIN_FOREGROUND_SHARE = 0.02
"""Below ~2% the off-background pixels are anti-aliasing fringe, not glyphs."""
MIN_BACKGROUND_SHARE = 0.45
"""Below this nothing is really "the background" — it is a three-way split, and naming the
commonest colour the ground would be arbitrary. Set just under half rather than at a majority
so a dense screen of text over a genuine single ground still reads as confident."""

_QUANTISE_STEP = 16
"""Bucket width per channel. Collapses anti-aliasing noise into the colour it belongs to
without merging genuinely different greys (a 16-step keeps #222 and #333 apart)."""


def _quantise_channel(v: int) -> int:
    """Snap one channel to the coarse grid, but keep the two ends exact.

    Naive bucket-centre rounding moves 0 to 8 and 255 to 248, which costs about 2 points of
    contrast on pure black text over pure white — the single commonest combination there is.
    Under-reporting the *easiest* case would undermine every number in the report, so the
    extreme buckets report their true endpoint instead of their midpoint.
    """
    bucket = v // _QUANTISE_STEP
    if bucket == 0:
        return 0
    if v >= 256 - _QUANTISE_STEP:
        return 255
    return bucket * _QUANTISE_STEP + _QUANTISE_STEP // 2


def _quantise(rgb: RGB) -> RGB:
    """Snap to a coarse grid so near-identical anti-aliased pixels count as one colour."""
    return tuple(_quantise_channel(v) for v in rgb)  # type: ignore[return-value]


def dominant_pair(pixels: list[RGB]) -> ColorPair | None:
    """Estimate (ink, ground) from a crop's pixels.

    The commonest quantised colour is the ground. The ink is the *least* contrasting colour
    among the rest — the hardest thing on this element to read.

    Two rules that both had to be got right, and the second was got wrong first:

    - Not "second commonest": on a button whose faint label is a few hundred pixels against a
      heavy border of a few thousand, second-commonest picks the border and reports a
      flattering ratio for text that is actually unreadable.
    - Not "most contrasting" either, which was the first attempt here and is backwards. On a
      white card a dark border contrasts *more* than the faint grey label, so maximising
      contrast finds the border and passes the element — hiding exactly the defect being looked
      for. An accessibility check asks "is anything here hard to read?", so it must take the
      worst reading, which is the minimum ratio.

    Stray pixels are excluded first (`MIN_FOREGROUND_SHARE`), otherwise the minimum would
    always be some single anti-aliased pixel one shade off the background.
    """
    if not pixels:
        return None

    counts: dict[RGB, int] = {}
    for px in pixels:
        q = _quantise(px)
        counts[q] = counts.get(q, 0) + 1

    total = len(pixels)
    ordered = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)
    background, bg_count = ordered[0]

    if len(ordered) == 1:
        # A single flat colour: no text, nothing to read, so nothing to report.
        return ColorPair(background, background, 1.0, 0.0, 1.0, 1, best_ratio=1.0)

    # Hardest-to-read colour that is still a real presence, not a stray anti-aliased pixel.
    candidates = [
        (c, n) for c, n in ordered[1:] if n / total >= MIN_FOREGROUND_SHARE
    ] or [ordered[1]]
    foreground, fg_count = min(candidates, key=lambda kv: contrast_ratio(kv[0], background))

    best = max(candidates, key=lambda kv: contrast_ratio(kv[0], background))
    return ColorPair(
        foreground=foreground,
        background=background,
        ratio=contrast_ratio(foreground, background),
        foreground_share=fg_count / total,
        background_share=bg_count / total,
        distinct_colors=len(counts),
        best_ratio=contrast_ratio(best[0], background),
    )


def hex_of(rgb: RGB) -> str:
    """`#rrggbb`, for putting the measured colours in the report."""
    return "#{:02x}{:02x}{:02x}".format(*rgb)
