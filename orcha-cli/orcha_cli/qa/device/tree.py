"""The screen's element tree: one flat list of `Element`s, its compact text and its hashes.

Adapted from `recording/tree.py` (+ `compact_capped` from `recording/observation.py`).
iOS gives the tree as idb's `describe-all --json` (a flat node list); Android's uiautomator
hierarchy is mapped into the same node shape first (`android.android_to_raw`), so everything
below is shared.

Each element is named to the agent by a ref, `e<index>` (its position in the tree), e.g.
`e12 Button "Save" id=save (16,90)-(386,134)`; `targets.parse_target("e12")` resolves it back.
A ref is a position in the screen the agent last saw, not a stable id.

Standard library only: this module imports without the `qa` extra.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field

INTERACTIVE_TYPES = frozenset(
    {
        "Button",
        "TextField",
        "SecureTextField",
        "SearchField",
        "TextView",
        "Cell",
        "Link",
        "Switch",
        "Toggle",
        "Tab",
        "TabBar",
        "SegmentedControl",
        "Slider",
        "Stepper",
        "Picker",
        "PickerWheel",
        "MenuItem",
        "Key",
    }
)

#: Visible nodes rendered per screen; past it the text says how many more there are.
MAX_TREE_NODES = 600
TREE_TRUNCATED = "[tree truncated at {n} nodes: {more} more; use find(text) to reach them]"


def ref(index: int) -> str:
    """How the agent names the element at `index`: `e12`."""
    return f"e{index}"


@dataclass
class Element:
    index: int
    type: str
    label: str
    value: str
    identifier: str
    x1: int
    y1: int
    x2: int
    y2: int
    enabled: bool
    traits: list[str] = field(default_factory=list)
    pid: int | None = None

    @property
    def ref(self) -> str:
        return ref(self.index)

    @property
    def center(self) -> tuple[int, int]:
        return ((self.x1 + self.x2) // 2, (self.y1 + self.y2) // 2)

    @property
    def interactive(self) -> bool:
        return self.type in INTERACTIVE_TYPES

    def body(self, with_value: bool = True, with_bounds: bool = True) -> str:
        """The line without its ref: what the hashes and the screen shape compare."""
        parts = [self.type]
        if self.label or self.interactive:
            parts.append(f'"{self.label}"')
        if with_value and self.value:
            parts.append(f'value="{self.value}"')
        if self.identifier:
            parts.append(f"id={self.identifier}")
        if with_bounds:
            parts.append(f"({self.x1},{self.y1})-({self.x2},{self.y2})")
        if not self.enabled:
            parts.append("disabled")
        if "Selected" in self.traits:
            parts.append("selected")
        return " ".join(parts)

    def compact_line(self, with_value: bool = True, with_bounds: bool = True) -> str:
        """`e12 Button "Save" id=save (16,90)-(386,134)`."""
        return f"{self.ref} {self.body(with_value, with_bounds)}"


def _text(node: dict, *keys: str) -> str:
    for key in keys:
        val = node.get(key)
        if val not in (None, ""):
            return str(val)
    return ""


def parse_tree(raw: list[dict]) -> list[Element]:
    elements: list[Element] = []
    for i, node in enumerate(raw):
        frame = node.get("frame") or {}
        x = int(frame.get("x", 0) or 0)
        y = int(frame.get("y", 0) or 0)
        w = int(frame.get("width", 0) or 0)
        h = int(frame.get("height", 0) or 0)
        elements.append(
            Element(
                index=i,
                type=str(node.get("type") or "Unknown"),
                label=_text(node, "AXLabel", "label", "title"),
                value=_text(node, "AXValue", "value"),
                identifier=_text(node, "AXUniqueId", "identifier"),
                x1=x,
                y1=y,
                x2=x + w,
                y2=y + h,
                enabled=bool(node.get("enabled", True)),
                traits=list(node.get("traits") or []),
                pid=node.get("pid"),
            )
        )
    return elements


def _is_noise(e: Element) -> bool:
    if e.type == "Application":
        return True
    return not (e.interactive or e.label or e.value or e.identifier)


def visible_elements(elements: list[Element]) -> list[Element]:
    return [e for e in elements if not _is_noise(e)]


def system_ui(e: Element) -> bool:
    """The device's own chrome (Android's status and navigation bars): never the app's control."""
    return "System" in e.traits


def compact(elements: list[Element]) -> str:
    return "\n".join(e.compact_line() for e in visible_elements(elements))


def compact_capped(elements: list[Element], max_nodes: int = MAX_TREE_NODES) -> str:
    """`compact` with at most `max_nodes` lines and a line saying how many were left out."""
    vis = visible_elements(elements)
    body = "\n".join(e.compact_line() for e in vis[:max_nodes])
    if len(vis) > max_nodes:
        body += "\n" + TREE_TRUNCATED.format(n=max_nodes, more=len(vis) - max_nodes)
    return body


def has_unlabeled_or_ambiguous_nodes(elements: list[Element]) -> bool:
    """True when an interactive node has no label and no identifier, or two visible nodes share
    a label: the tree text alone cannot name it, so the screenshot is worth sending."""
    visible = visible_elements(elements)
    labels: dict[str, int] = {}
    for e in visible:
        if e.interactive and not e.label and not e.identifier:
            return True
        if e.label:
            labels[e.label] = labels.get(e.label, 0) + 1
    return any(count > 1 for count in labels.values())


def to_json_dict(elements: list[Element]) -> list[dict]:
    """Visible elements as plain dicts."""
    return [
        {
            "ref": e.ref,
            "index": e.index,
            "type": e.type,
            "label": e.label,
            "value": e.value,
            "identifier": e.identifier,
            "bounds": [e.x1, e.y1, e.x2, e.y2],
            "enabled": e.enabled,
            "traits": e.traits,
        }
        for e in visible_elements(elements)
    ]


def _app_elements(elements: list[Element]) -> list[Element]:
    """Visible elements without the device's chrome: a status bar's clock or signal strength
    never makes two looks at the app different screens."""
    return [e for e in visible_elements(elements) if not system_ui(e)]


def tree_hash(elements: list[Element]) -> str:
    """Labels and structure (no values, no bounds, no device chrome): a scrolled list keeps its hash."""
    stable = "\n".join(e.body(with_value=False, with_bounds=False) for e in _app_elements(elements))
    return hashlib.sha1(stable.encode()).hexdigest()[:12]


def tree_value_hash(elements: list[Element]) -> str:
    """`tree_hash` with values: a toggled switch ("0" -> "1") or a stepper's count changes it."""
    stable = "\n".join(e.body(with_value=True, with_bounds=False) for e in _app_elements(elements))
    return hashlib.sha1(stable.encode()).hexdigest()[:12]


CLOCK_PATTERN = re.compile(r"\b\d{1,2}:\d{2}(?::\d{2})?\b")


def screen_shape(elements: list[Element]) -> str:
    """What the screen looks like whichever capture looked at it: every visible line without
    ref and bounds, values kept (a typed character counts), clock-like text masked and the
    device's chrome left out, so a ticking timer or a status bar never ends a change wait early
    or keeps a stillness check from passing."""
    lines = (e.body(with_value=True, with_bounds=False) for e in _app_elements(elements))
    return CLOCK_PATTERN.sub("<time>", "\n".join(lines))


def find(elements: list[Element], text: str, role: str | None = None) -> list[Element]:
    needle = text.lower()
    return [
        e
        for e in elements
        if (needle in e.label.lower() or needle in e.value.lower() or needle in e.identifier.lower())
        and (role is None or e.type == role)
    ]


def foreground_app(elements: list[Element]) -> tuple[str | None, int | None]:
    for e in elements:
        if e.type == "Application":
            return (e.label or None, e.pid)
    return (None, None)


def screen_size(elements: list[Element]) -> tuple[int, int]:
    for e in elements:
        if e.type == "Application":
            return (e.x2 - e.x1, e.y2 - e.y1)
    return (0, 0)
