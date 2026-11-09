"""Which element an action means, and whether a touch there can land on it.

Adapted from `recording/targets.py`. A `Target` names an element by its ref from the
last screen (`e12`), its accessibility id, its text (label or value), or a point/box on the
screen. Resolution order: bounds/point -> ref -> id -> text.

`parse_target` reads the forms the agent writes:

- `"e12"` (or `"[12]"`): the element with that ref on the last screen;
- `"id=save_button"`: the accessibility identifier (exact);
- `"text=Save"` or plain `"Save"`: label or value, case-insensitive exact match; a dict
  `{"text": "Save", "text_index": 1}` picks the second of several;
- `"120,340"`: a point; `"10,20,110,60"`: a box (its centre);
- `""` / `None`: no locator (`type_text`/`clear_text` then use the focused field).

Standard library only: this module imports without the `qa` extra.
"""

from __future__ import annotations

import difflib
import math
import re
from dataclasses import dataclass
from typing import Any

from orcha_cli.qa.device.tree import Element, visible_elements

Point = tuple[int, int]

_REF = re.compile(r"^\s*(?:e|\[)(\d+)\]?\s*$")
_NUMS = re.compile(r"^\s*-?\d+(?:\.\d+)?(?:\s*,\s*-?\d+(?:\.\d+)?)*\s*$")


@dataclass
class Target:
    index: int | None = None  # the `e<index>` ref from the last screen
    id: str | None = None  # accessibility identifier (exact)
    text: str | None = None  # label or value (case-insensitive exact)
    text_index: int = 0  # which match when several share the text
    bounds: str | None = None  # explicit "x1,y1,x2,y2" in screen units (a point is "x,y,x,y")

    def to_dict(self) -> dict[str, Any]:
        """The target as a step records it (no empty fields; `ref` instead of `index`)."""
        out: dict[str, Any] = {}
        if self.index is not None:
            out["ref"] = f"e{self.index}"
        if self.id:
            out["id"] = self.id
        if self.text:
            out["text"] = self.text
            if self.text_index:
                out["text_index"] = self.text_index
        if self.bounds:
            out["bounds"] = self.bounds
        return out

    @property
    def has_locator(self) -> bool:
        return self.index is not None or bool(self.id or self.text or self.bounds)

    def describe(self) -> str:
        """How a result names it: `e12`, `id=save`, `"Save"`, `(120,340)`."""
        if self.bounds:
            parts = self.bounds.split(",")
            return f"({parts[0]},{parts[1]})" if len(parts) == 4 and parts[:2] == parts[2:] else f"({self.bounds})"
        if self.index is not None:
            return f"e{self.index}"
        if self.id:
            return f"id={self.id}"
        if self.text:
            return repr(self.text)
        return "the focused field"


def parse_target(spec: Any) -> Target:
    """A `Target` from what the agent wrote: a string (see the module doc), a dict with any of
    `ref`/`index`/`id`/`text`/`text_index`/`bounds`/`x`+`y`, a `Target`, or None."""
    if isinstance(spec, Target):
        return spec
    if spec is None:
        return Target()
    if isinstance(spec, dict):
        t = Target(
            id=str(spec["id"]) if spec.get("id") else None,
            text=str(spec["text"]) if spec.get("text") not in (None, "") else None,
            text_index=int(spec.get("text_index") or 0),
            bounds=str(spec["bounds"]) if spec.get("bounds") else None,
        )
        r = spec.get("ref")
        if r not in (None, ""):
            m = _REF.match(str(r))
            if not m:
                raise ValueError(f"ref must look like e12, got {r!r}")
            t.index = int(m.group(1))
        elif spec.get("index") is not None:
            t.index = int(spec["index"])
        if spec.get("x") is not None and spec.get("y") is not None and not t.bounds:
            x, y = int(float(spec["x"])), int(float(spec["y"]))
            t.bounds = f"{x},{y},{x},{y}"
        return t
    s = str(spec)
    if not s.strip():
        return Target()
    m = _REF.match(s)
    if m:
        return Target(index=int(m.group(1)))
    if s.startswith("id="):
        return Target(id=s[3:])
    if s.startswith("text="):
        return Target(text=s[5:])
    if _NUMS.match(s):
        parts = [int(float(p)) for p in s.split(",")]
        if len(parts) == 2:
            return Target(bounds=f"{parts[0]},{parts[1]},{parts[0]},{parts[1]}")
        if len(parts) == 4:
            return Target(bounds=",".join(str(p) for p in parts))
    return Target(text=s)


def has_locator(target: dict | None) -> bool:
    """Whether a recorded target dict names an element."""
    t = target or {}
    return t.get("index") is not None or bool(t.get("ref") or t.get("id") or t.get("text") or t.get("bounds"))


def _parse_bounds(s: str) -> Point | None:
    try:
        x1, y1, x2, y2 = (int(float(p)) for p in s.split(","))
    except ValueError:
        return None
    return ((x1 + x2) // 2, (y1 + y2) // 2)


def _text_matches(target: Target, elements: list[Element]) -> list[Element]:
    needle = (target.text or "").lower()
    return [e for e in elements if e.label.lower() == needle or e.value.lower() == needle]


def resolve(target: Target, elements: list[Element]) -> tuple[Point | None, str]:
    """Return (tap point, strategy) or (None, error message)."""
    if target.bounds:
        point = _parse_bounds(target.bounds)
        if point is None:
            return None, f"error: bounds must be 'x1,y1,x2,y2' or a point 'x,y', got {target.bounds!r}"
        return point, "bounds"

    if target.index is not None:
        if 0 <= target.index < len(elements):
            return elements[target.index].center, "ref"
        top = f"e{len(elements) - 1}" if elements else "none"
        return None, f"error: ref e{target.index} is not on the screen (e0..{top}); look again and pick a ref from it"

    if target.id:
        for e in elements:
            if e.identifier == target.id:
                return e.center, "id"

    if target.text:
        matches = _text_matches(target, elements)
        if target.text_index < len(matches):
            return matches[target.text_index].center, "text"
        if matches:
            return (
                None,
                f"error: text {target.text!r} has {len(matches)} matches, "
                f"text_index {target.text_index} out of range",
            )

    if target.id or target.text:
        tried = ", ".join(
            p for p in [f"id={target.id}" if target.id else "", f"text={target.text}" if target.text else ""] if p
        )
        return None, f"error: no element matched ({tried})"

    return None, "error: no locator given (need a ref like e12, id=..., a text, or x,y)"


# ---------- a point outside the screen ----------

#: How much of a swipe's length the content moves, about.
SWIPE_CARRY = 0.75
#: The swipe the advice stops at, as a percent of the screen; a longer way is that many swipes.
SWIPE_MAX_PERCENT = 80


def off_screen(point: Point, width: int, height: int, *, what: str = "target", unit: str = "pt") -> str | None:
    """Why `point` cannot be acted on when it is outside the visible `width` x `height` screen,
    with how far it is and which way to swipe to bring it in (the session's `swipe` direction:
    up scrolls down). None when it is on screen or the screen size is unknown. A simulator does
    not drop such a tap: it lands at the screen's edge on whatever is drawn there."""
    if width <= 0 or height <= 0:
        return None
    x, y = point
    if 0 <= x < width and 0 <= y < height:
        return None
    if y >= height:
        where, way, size, travel = f"{y - height + 1} {unit} below the bottom edge", "up", height, y - height * 3 // 4
    elif y < 0:
        where, way, size, travel = f"{-y} {unit} above the top edge", "down", height, height // 4 - y
    elif x >= width:
        where, way, size, travel = f"{x - width + 1} {unit} past the right edge", "left", width, x - width * 3 // 4
    else:
        where, way, size, travel = f"{-x} {unit} past the left edge", "right", width, width // 4 - x
    percent = math.ceil(travel * 100 / (size * SWIPE_CARRY))
    if percent <= SWIPE_MAX_PERCENT:
        swipe = f"swipe {way} (distance_percent {max(percent, 20)})"
    else:
        times = math.ceil(percent / SWIPE_MAX_PERCENT)
        swipe = f"swipe {way} {times} times (distance_percent {SWIPE_MAX_PERCENT})"
    return (
        f"the {what} is off screen at ({x}, {y}), {where} of the {width}x{height} screen, so nothing "
        f"there can be touched; {swipe} to scroll it into view, then look again"
    )


def chosen(target: Target, elements: list[Element]) -> Element | None:
    """The element a ref/id/text target picks on `elements` (None for bounds or no match)."""
    if target.bounds:
        return None
    if target.index is not None:
        return elements[target.index] if 0 <= target.index < len(elements) else None
    if target.id:
        hit = next((e for e in elements if e.identifier == target.id), None)
        if hit is not None:
            return hit
    if target.text:
        matches = _text_matches(target, elements)
        return matches[target.text_index] if target.text_index < len(matches) else None
    return None


def refind(seen: Element, live: list[Element]) -> Element | None:
    """`seen` (from the screen the agent decided on) on the screen as it is now: a list that
    loaded, a toast or a keyboard can move it between the look and the action. Match by
    identity: type and identifier, then the same place and label, else the nearest element
    with the same label or value, else the only element with its identifier."""
    same = [e for e in live if e.type == seen.type and e.identifier == seen.identifier]
    box = (seen.x1, seen.y1, seen.x2, seen.y2)
    for e in same:
        if (e.x1, e.y1, e.x2, e.y2) == box and e.label == seen.label:
            return e
    cx, cy = seen.center
    for attr in ("label", "value"):
        want = getattr(seen, attr)
        hits = [e for e in same if want and getattr(e, attr) == want]
        if hits:
            return min(hits, key=lambda e: (e.center[0] - cx) ** 2 + (e.center[1] - cy) ** 2)
    if seen.identifier and len(same) == 1:
        return same[0]
    return None


def identity(e: Element) -> str:
    """What makes a ref "the same element" across two reads: a control by its type and label;
    a static text by its type and place (its words are its content)."""
    if e.interactive:
        return e.body(with_value=False, with_bounds=False)
    return f"{e.type}@{e.x1 // 8},{e.y1 // 8}"


# ---------- what a tap would hit ----------


@dataclass(frozen=True)
class Layer:
    """One thing on screen as the obstruction check sees it: its box, its place in the drawing
    order (`z`, compared as a tuple, later on top; the tree order stands in for it), its parent
    when known, whether it would take a touch, and how to name it."""

    index: int
    box: tuple[int, int, int, int]
    z: tuple[int, ...]
    parent: int | None = None
    touchable: bool = True
    name: str = ""


#: The scrim UIKit lays under a context menu: a tap on it closes the menu. It is listed after
#: the menu yet drawn under it.
CONTEXT_MENU_SCRIM = "dismiss context menu"


def is_menu_scrim(e: Element) -> bool:
    return e.type == "Button" and e.label.strip().lower() == CONTEXT_MENU_SCRIM


def describe(e: Element) -> str:
    """`Button "Close sheet"`: an element as a refusal names it."""
    return f'{e.type} "{e.label}"' if e.label else e.type


def tree_order_layers(elements: list[Element]) -> list[Layer]:
    """Layers from a flat tree: the tree order as the drawing order, an enabled interactive
    element as the only thing that takes a touch. A context menu's scrim is drawn just above
    its app's root (it is listed after the menu but drawn under it)."""
    layers, root = [], -1
    for e in elements:
        if e.type == "Application":
            root = e.index
        if not (e.x2 > e.x1 and e.y2 > e.y1):
            continue
        z = (root, 0) if is_menu_scrim(e) else (e.index,)
        layers.append(
            Layer(e.index, (e.x1, e.y1, e.x2, e.y2), z, None, e.interactive and e.enabled and e.type != "Application", describe(e))
        )
    return layers


def covering(target: Layer, layers: list[Layer], point: Point | None = None, *, whole: bool = False) -> Layer | None:
    """The topmost layer that would take a tap meant for `target` at `point` (its centre by
    default): one drawn after it that takes touches and holds the point, and is neither one of
    its ancestors nor inside it (a control's own label). `whole`: only a layer that covers the
    target's whole box counts (a sheet, a scrim, a dialog): with the tree order standing in for
    the drawing order, a partial overlap is too weak a sign to refuse a tap on."""
    tx1, ty1, tx2, ty2 = target.box
    px, py = point or ((tx1 + tx2) // 2, (ty1 + ty2) // 2)
    by_index = {layer.index: layer for layer in layers}

    def chain(layer: Layer) -> set[int]:
        out: set[int] = set()
        p = layer.parent
        while p is not None and p >= 0 and p not in out:
            out.add(p)
            p = by_index[p].parent if p in by_index else None
        return out

    ancestors = chain(target)
    best: Layer | None = None
    for layer in layers:
        if layer.index == target.index or not layer.touchable or layer.index in ancestors or layer.z <= target.z:
            continue
        x1, y1, x2, y2 = layer.box
        if not (x1 <= px < x2 and y1 <= py < y2) or layer.box == target.box:
            continue
        if whole and not (x1 <= tx1 and y1 <= ty1 and tx2 <= x2 and ty2 <= y2):
            continue
        if layer.parent is not None:
            if target.index in chain(layer):
                continue  # drawn inside the target: part of it
        elif tx1 <= x1 and ty1 <= y1 and x2 <= tx2 and y2 <= ty2:
            continue  # no parents known: a box inside the target is taken for its own
        if best is None or layer.z > best.z:
            best = layer
    return best


def covered(target: Target, elements: list[Element], point: Point) -> str | None:
    """What is drawn over the element `target` names, judged on the tree order (only a layer
    over the whole element counts). None for explicit bounds and when nothing covers it."""
    if target.bounds:
        return None
    seen = chosen(target, elements)
    if seen is None:
        return None
    layers = tree_order_layers(elements)
    mine = next((layer for layer in layers if layer.index == seen.index), None)
    hit = covering(mine, layers, point, whole=True) if mine is not None else None
    return hit.name if hit else None


def nearest(needle: str, elements: list[Element], n: int = 5) -> list[Element]:
    """The `n` visible elements whose label, value or id reads most like `needle`: what a target
    that matched nothing is shown with, so the agent need not look again."""
    want = needle.strip().lower()
    if not want:
        return []

    def score(e: Element) -> float:
        texts = [t.lower() for t in (e.label, e.value, e.identifier) if t]
        best = 0.0
        for t in texts:
            r = difflib.SequenceMatcher(None, want, t).ratio()
            if want in t or t in want:
                r = max(r, 0.8)
            best = max(best, r)
        return best

    scored = [(score(e), e) for e in visible_elements(elements)]
    scored = [(s, e) for s, e in scored if s >= 0.4]
    scored.sort(key=lambda se: -se[0])
    return [e for _, e in scored[:n]]
