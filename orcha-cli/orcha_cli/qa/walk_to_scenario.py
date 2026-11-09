"""A passed walk becomes a draft scenario (a slimmed port of `workflows/to_scenario.py`).

The walk's recorded steps (`start_seq`..`end_seq` of the session's step trace) are cut into one
window per step the explorer reported: the actions taken since the step before it, and the
screen it settled on (the screens recorded after its last action and before the next one). One
reported step is one criterion:

- its words are one outcome a person can check, said as what is true after the step: the
  explorer's `expected` when it gave one, else made from what the step showed (`result`) and what
  it checked (`checked`), never its log of what it did ("Tapped Save");
- its `Check:` lines name labels its end screen really showed, exactly (`text "..."`, or scoped
  by the role the screen gave the label), only stable ones (no dates, times, counts or ids), at
  most `MAX_CHECKS`; each one is quoted in the criterion. A label gone from the screen the step
  settled on is checked as `appears`. A step that named nothing on screen is checked by the
  screen it reached (its heading, else a text the step brought on);
- its evidence is the frame of its end screen (`verified` when a check's label was on it).

A step that only reached a screen, with nothing to check, folds into the next; at most
`MAX_CRITERIA` criteria (adjacent steps merge). The description says the goal in one sentence,
then lists the real steps (`Tap "Feed"`, `Type "120" into "Amount (ml)"`) folded onto one line. The
flow's persona and data are kept (never a secret), tags are `walked` and the platform. A tap at
screen coordinates names no element: the description says the walk has no replayable path.

`from_walk(walk, flow, steps, platform)` -> `Draft`; `Draft.problem` says why there is none.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Optional

from . import checks as checks_mod
from .scenario_format import MAX_CRITERIA_STORED, MIN_CRITERIA, checks_by_index, one_line

TAG = "walked"
MAX_CRITERIA = 5
MAX_CHECKS = 3
MAX_LABEL_LEN = 80
MAX_CRITERION_LEN = 200
MAX_DESCRIBED_STEPS = 30

ACTION_KINDS = frozenset({"tap", "long_press", "type", "clear", "swipe", "press", "open_url", "launch", "terminate"})
_SECRET_KEY = re.compile(r"pass(word|code)?|secret|token|otp|pin\b|api[_-]?key", re.IGNORECASE)
_VOLATILE = re.compile(
    r"\d{1,2}:\d{2}|\b\d{4}-\d{2}-\d{2}\b|\b(?:today|yesterday|tomorrow|ago|am|pm)\b|"
    r"\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d|\d+\s*(?:%|min|mins|h|hrs?|sec|s)\b|"
    r"\b[0-9a-f]{8,}\b|^\d[\d,.\s]*$",
    re.IGNORECASE,
)
_ERROR = re.compile(r"\b(?:error|failed|exception|went wrong|try again|unavailable|crash)\b", re.IGNORECASE)
_GREETING = re.compile(r"\bgood\s+(?:morning|afternoon|evening|night)\b", re.IGNORECASE)
_STATUS_BAR = re.compile(r"^(?:\d{1,2}:\d{2}|battery|wi-?fi|signal|carrier|lte|5g|4g)\b", re.IGNORECASE)
_DID = re.compile(
    r"^\s*(?:i\s+)?(?:then\s+|and\s+)?(?:tapped|tap|clicked|click|pressed|press|typed|type|entered|enter|swiped|swipe|scrolled|"
    r"scroll|selected|select|chose|choose|opened|open|launched|launch|filled|fill|went|go|navigated|navigate)\b",
    re.IGNORECASE,
)
_QUOTE = re.compile(r"[\"“]([^\"“”]{2,80})[\"”]")
_WORDS = re.compile(r"[a-z0-9]+")
_COORD = re.compile(r"^\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*$")


def _norm(text: Any) -> str:
    return " ".join(_WORDS.findall(str(text or "").lower()))


def _run(inner: str, outer: str) -> bool:
    """`inner`'s words appear, in order and whole, inside `outer`."""
    a, b = _norm(inner), _norm(outer)
    return bool(a) and f" {a} " in f" {b} "


def _clean(text: Any) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()


def _int(value: Any) -> Optional[int]:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _sentence(text: str) -> str:
    text = _clean(text).rstrip(" .;,")
    return (text[:1].upper() + text[1:]) if text else ""


@dataclass
class WalkStep:
    index: int
    text: str
    reached: bool
    result: str
    checked: list[str]
    expected: str
    finding_id: Optional[str]
    frame_id: Optional[str]
    seq: Optional[int]


def walk_steps(walk: dict[str, Any]) -> list[WalkStep]:
    """The walk's reported steps in index order (a step reported again: the last report)."""
    by_index: dict[int, WalkStep] = {}
    for i, raw in enumerate(walk.get("steps") or []):
        if not isinstance(raw, dict):
            continue
        checked = raw.get("checked") or []
        if isinstance(checked, str):
            checked = [checked]
        index = _int(raw.get("index")) or (i + 1)
        by_index[index] = WalkStep(
            index=index, text=_clean(raw.get("text")), reached=raw.get("reached") is not False,
            result=_clean(raw.get("result")), checked=[_clean(c) for c in checked if _clean(c)],
            expected=_clean(raw.get("expected")), finding_id=str(raw["finding_id"]) if raw.get("finding_id") else None,
            frame_id=str(raw["frame_id"]) if raw.get("frame_id") else None, seq=_int(raw.get("seq")),
        )
    return [by_index[k] for k in sorted(by_index)]


def recorded_steps(steps: list[dict[str, Any]], start_seq: Any, end_seq: Any) -> list[dict[str, Any]]:
    lo, hi = _int(start_seq), _int(end_seq)
    out = []
    for s in steps or []:
        seq = _int(s.get("seq")) if isinstance(s, dict) else None
        if seq is None or (lo is not None and seq < lo) or (hi is not None and seq > hi):
            continue
        out.append({**s, "seq": seq, "args": s.get("args") if isinstance(s.get("args"), dict) else {}})
    return sorted(out, key=lambda s: s["seq"])


def screen_texts(screen: dict[str, Any]) -> list[str]:
    args = screen.get("args") or {}
    out: list[str] = []
    for t in [args.get("title"), *(args.get("texts") or []), *(args.get("anchors") or [])]:
        t = _clean(t)
        if t and t not in out:
            out.append(t)
    return out


def _roles(screen: dict[str, Any]) -> dict[str, str]:
    roles = (screen.get("args") or {}).get("roles") or {}
    return {_norm(k): str(v) for k, v in roles.items()} if isinstance(roles, dict) else {}


@dataclass
class Window:
    step: WalkStep
    actions: list[dict[str, Any]]
    end: list[dict[str, Any]]  # screens the step settled on
    before: list[str]  # texts of the screen before its first action
    labels: list[str] = field(default_factory=list)
    lines: list[str] = field(default_factory=list)
    criterion: str = ""
    named: bool = False

    @property
    def end_texts(self) -> list[str]:
        out: list[str] = []
        for sc in self.end:
            for t in screen_texts(sc):
                if t not in out:
                    out.append(t)
        return out

    @property
    def settled_texts(self) -> list[str]:
        return screen_texts(self.end[-1]) if self.end else []

    @property
    def frame_id(self) -> Optional[str]:
        for sc in reversed(self.end):
            if sc.get("frame_id"):
                return str(sc["frame_id"])
        return self.step.frame_id


def windows(rec: list[dict[str, Any]], steps: list[WalkStep]) -> list[Window]:
    acts = [s for s in rec if s.get("kind") in ACTION_KINDS]
    screens = [s for s in rec if s.get("kind") == "screen"]
    hi = rec[-1]["seq"] if rec else 0
    lo = (rec[0]["seq"] - 1) if rec else 0
    bounds: list[int] = []
    nxt = hi
    for s in reversed(steps):  # a step with no seq is checked with the next one that has one
        nxt = s.seq if s.seq is not None else nxt
        bounds.append(nxt)
    bounds.reverse()
    out: list[Window] = []
    prev = lo
    for s, b in zip(steps, bounds):
        b = max(min(b, hi), prev)
        own = [a for a in acts if prev < a["seq"] <= b]
        upto = [a for a in acts if a["seq"] <= b]
        last = own[-1]["seq"] if own else (upto[-1]["seq"] if upto else None)
        if last is not None:
            following = next((a["seq"] for a in acts if a["seq"] > last), None)
            ends = [sc for sc in screens if sc["seq"] > last and (following is None or sc["seq"] < following)]
            if not ends:
                ends = [sc for sc in screens if sc["seq"] <= b][-1:]
            first = own[0]["seq"] if own else last
            befores = [sc for sc in screens if sc["seq"] < first][-1:]
        else:
            ends = [sc for sc in screens if sc["seq"] <= b][-1:]
            befores = []
        out.append(Window(step=s, actions=own, end=ends, before=[t for sc in befores for t in screen_texts(sc)]))
        prev = b
    return out


def chrome(rec: list[dict[str, Any]]) -> set[str]:
    """Texts on every recorded screen (a tab bar, the app's title): they prove no step."""
    sets = [{_norm(t) for t in screen_texts(s)} for s in rec if s.get("kind") == "screen"]
    sets = [x for x in sets if x]
    if len(sets) < 2:
        return set()
    out = set(sets[0])
    for x in sets[1:]:
        out &= x
    return out


def usable(text: str, avoid: set[str] = frozenset()) -> bool:  # type: ignore[assignment]
    """A label a check may name: stable across runs (no date, time, count or id), no error word,
    short, with a letter in it, not the status bar."""
    t = _clean(text)
    if not (2 <= len(t) <= MAX_LABEL_LEN) or not re.search(r"[^\W\d_]", t) or '"' in t or "{{" in t:
        return False
    if _VOLATILE.search(t) or _ERROR.search(t) or _GREETING.search(t) or _STATUS_BAR.match(t):
        return False
    return _norm(t) not in avoid


def labels_for(w: Window, chrome_texts: set[str]) -> tuple[list[str], bool]:
    """(labels, named): what the step's end screen showed that the explorer named (quoted, or a
    screen text its words contain), most telling first; else the screen it reached."""
    pool: list[str] = []
    for t in w.end_texts:
        if usable(t) and _norm(t) not in {_norm(x) for x in pool}:
            pool.append(t)
    phrases = [p for p in (w.step.expected, *w.step.checked, w.step.result) if p]
    picked: list[str] = []

    def add(t: str) -> None:
        if _norm(t) not in {_norm(x) for x in picked}:
            picked.append(t)

    for phrase in [*w.step.checked, w.step.expected, w.step.result]:
        for q in [*(m.group(1) for m in _QUOTE.finditer(phrase or "")), *([phrase] if phrase in w.step.checked else [])]:
            exact = next((t for t in pool if _norm(t) == _norm(q)), None)
            if exact is not None:
                add(exact)
    before = {_norm(t) for t in w.before}
    named = [t for t in pool if len(_norm(t)) >= 3 and any(_run(t, p) for p in phrases)]
    named.sort(key=lambda t: (_norm(t) in chrome_texts, _norm(t) in before, -len(t)))
    for t in named:
        add(t)
    picked = [t for t in picked if not any(o is not t and len(_norm(o)) > len(_norm(t)) and _run(t, o) for o in picked)]
    useful = [t for t in picked if _norm(t) not in chrome_texts]
    picked = useful or picked
    if picked:
        return picked[:MAX_CHECKS], True
    roles = {}
    for sc in w.end:
        roles.update(_roles(sc))
    for t in pool:  # the screen it reached: its heading, else the first new text
        if roles.get(_norm(t)) in ("Heading", "NavigationBar", "Dialog") and _norm(t) not in chrome_texts:
            return [t], False
    for t in pool:
        if len(_norm(t)) >= 3 and _norm(t) not in chrome_texts and _norm(t) not in before:
            return [t], False
    return [], False


def check_lines(w: Window) -> list[str]:
    roles: dict[str, str] = {}
    for sc in w.end:
        roles.update(_roles(sc))
    settled = {_norm(t) for t in w.settled_texts}
    out = []
    for label in w.labels:
        role = roles.get(_norm(label))
        line = checks_mod.text_check(label, role)
        if settled and _norm(label) not in settled and not any(_run(label, t) for t in w.settled_texts):
            line = checks_mod.rewrite_check(line, matcher="appears")
        elif checks_mod.transient_check(line, w.step.expected or w.step.result):
            line = checks_mod.rewrite_check(line, matcher="appears")
        out.append(line)
    return out


def _quote_in(text: str, label: str) -> str:
    """`text` with `label` quoted where its words appear unquoted (once)."""
    if f'"{label}"' in text:
        return text
    pat = re.compile(r"(?<![\w\"])" + re.escape(label) + r"(?![\w\"])", re.IGNORECASE)
    m = pat.search(text)
    if m:
        return text[: m.start()] + f'"{text[m.start():m.end()]}"' + text[m.end():]
    return text


def criterion_text(w: Window, n: int) -> str:
    base = w.step.expected or ""
    if not base and w.step.result and not _DID.match(w.step.result):
        base = w.step.result
    if not base and w.step.checked:
        base = "The screen shows " + ", ".join(f'"{c}"' if '"' not in c else c for c in w.step.checked[:MAX_CHECKS])
    if not base and w.labels:
        base = f"Step {n} reaches the screen showing \"{w.labels[0]}\""
    if not base:
        base = w.step.result or w.step.text or f"Step {n} completes"
    base = _sentence(base)
    missing = []
    for label in w.labels:
        quoted = _quote_in(base, label)
        if quoted != base or f'"{label}"' in base:
            base = quoted
        else:
            missing.append(label)
    if missing:
        base += ", showing " + " and ".join(f'"{m}"' for m in missing)
    if len(base) > MAX_CRITERION_LEN:  # cut at a clause, never mid-word
        cut = base[:MAX_CRITERION_LEN]
        cut = cut[: max(cut.rfind(","), cut.rfind(";"), cut.rfind(" "))].rstrip(" ,;")
        base = cut
    return base


def _merge(a: Window, b: Window) -> Window:
    """`a` folded into `b`: b's outcome, both their actions."""
    return Window(step=b.step, actions=a.actions + b.actions, end=b.end, before=a.before, labels=b.labels or a.labels,
                  named=b.named or a.named)


def fold(ws: list[Window], limit: int = MAX_CRITERIA) -> list[Window]:
    """A step that only reached a screen (nothing named, no expected) folds into the next; then
    adjacent steps merge until at most `limit` remain (the earliest unnamed first)."""
    out: list[Window] = []
    carry: Optional[Window] = None
    for i, w in enumerate(ws):
        if carry is not None:
            w = _merge(carry, w)
            carry = None
        last = i == len(ws) - 1
        keeps_enough = len(out) + (len(ws) - i - 1) >= MIN_CRITERIA
        if not last and not w.named and not w.step.expected and keeps_enough:
            carry = w
            continue
        out.append(w)
    if carry is not None:
        out.append(carry)
    while len(out) > limit:
        idx = next((i for i, w in enumerate(out[:-1]) if not w.named), 0)
        out[idx: idx + 2] = [_merge(out[idx], out[idx + 1])]
    return out


def _target_text(target: Any) -> str:
    if isinstance(target, dict):
        target = target.get("label") or target.get("text") or target.get("spec") or target.get("id") or ""
    return _clean(target)


def describe(action: dict[str, Any]) -> str:
    """One recorded action as the step a person reads (`Tap "Save"`)."""
    kind, args = action.get("kind"), action.get("args") or {}
    target = _target_text(args.get("target"))
    shown = f'"{target}"' if target and not _COORD.match(target) else (f"at {target}" if target else "")
    if kind in ("tap", "long_press"):
        verb = "Long-press" if (kind == "long_press" or args.get("long_press_ms")) else "Tap"
        return f"{verb} {shown}".strip()
    if kind in ("type", "clear"):
        if kind == "clear" or args.get("clear"):
            return f"Clear {shown}".strip()
        text = "<secret>" if args.get("secret") else str(args.get("text") or "")
        return f'Type "{text}"' + (f" into {shown}" if shown else "")
    if kind == "swipe":
        if args.get("direction"):
            return f"Swipe {args['direction']}"
        return "Swipe"
    if kind == "press":
        return f"Press {args.get('key') or ''}".strip()
    if kind == "open_url":
        return f"Open {args.get('url') or 'a link'}"
    if kind == "launch":
        return "Launch the app"
    if kind == "terminate":
        return "Close the app"
    return str(kind or "")


def unrepeatable(rec: list[dict[str, Any]]) -> Optional[str]:
    for a in rec:
        if a.get("kind") in ("tap", "long_press"):
            t = _target_text((a.get("args") or {}).get("target"))
            if _COORD.match(t):
                return f"a tap at screen coordinates ({t}) names no element, so this draft has no replayable path"
    return None


def scenario_data(data: Any) -> dict[str, str]:
    """The flow's data as the scenario's Data, without secrets."""
    if not isinstance(data, dict):
        return {}
    return {str(k): str(v) for k, v in data.items() if not _SECRET_KEY.search(str(k)) and "<secret" not in str(v)}


@dataclass
class Draft:
    name: str = ""
    category: Optional[str] = None
    persona: Optional[str] = None
    description: str = ""
    criteria: list[str] = field(default_factory=list)
    checks: list[dict[str, Any]] = field(default_factory=list)
    data: dict[str, str] = field(default_factory=dict)
    tags: list[str] = field(default_factory=list)
    evidence: list[dict[str, Any]] = field(default_factory=list)
    note: Optional[str] = None
    problem: Optional[str] = None

    def body(self) -> dict[str, Any]:
        """The fields `POST C/scenarios` takes (the caller adds platform, source, walk and session)."""
        out = {"name": self.name, "category": self.category, "persona": self.persona, "description": self.description,
               "criteria": self.criteria, "checks": self.checks, "data": self.data, "tags": self.tags}
        return {k: v for k, v in out.items() if v not in (None, "")}


def _category(flow: dict[str, Any]) -> str:
    for key in ("category", "feature", "feature_key"):
        if flow.get(key):
            return _sentence(str(flow[key]).replace("_", " ").replace("-", " "))
    return "Walked flows"


def from_walk(walk: dict[str, Any], flow: Optional[dict[str, Any]], steps: list[dict[str, Any]], platform: str) -> Draft:
    """A draft from a passed walk (see the module doc). Never raises."""
    try:
        return _from_walk(walk, flow or {}, steps, platform)
    except Exception as e:  # noqa: BLE001 - a walk is kept even when no draft can be made
        return Draft(problem=f"walk to scenario failed: {type(e).__name__}: {e}")


def _from_walk(walk: dict[str, Any], flow: dict[str, Any], steps: list[dict[str, Any]], platform: str) -> Draft:
    reported = walk_steps(walk)
    if not reported:
        return Draft(problem="the walk reported no steps")
    if not all(s.reached for s in reported):
        return Draft(problem="not every step of the walk was reached")
    rec = recorded_steps(steps, walk.get("start_seq"), walk.get("end_seq"))
    chrome_texts = chrome(rec)
    ws = windows(rec, reported)
    for w in ws:
        w.labels, w.named = labels_for(w, chrome_texts)
    ws = fold(ws)
    if len(ws) < MIN_CRITERIA:
        return Draft(problem=f"the walk gives {len(ws)} criterion; a scenario needs at least {MIN_CRITERIA} (report each step with walk_step)")
    ws = ws[:MAX_CRITERIA_STORED]
    criteria: list[str] = []
    crit_checks: dict[int, list[str]] = {}
    evidence: list[dict[str, Any]] = []
    for n, w in enumerate(ws, start=1):
        w.lines = check_lines(w)
        w.criterion = criterion_text(w, n)
        criteria.append(w.criterion)
        if w.lines:
            crit_checks[n - 1] = w.lines
        shown = {_norm(t) for t in w.end_texts}
        verified = bool(w.labels) and all(_norm(lab) in shown or any(_run(lab, t) for t in w.end_texts) for lab in w.labels)
        evidence.append({
            "criterion_index": n - 1, "status": "verified" if verified and w.frame_id else "unconfirmed",
            "frame_id": w.frame_id, "note": f"walk step {w.step.index}: {one_line(w.step.result)[:200]}" if w.step.result else f"walk step {w.step.index}",
        })
    name = _clean(flow.get("name") or walk.get("name") or "Walked flow")
    persona = _clean(flow.get("persona")) or None
    goal = flow.get("goal") or flow.get("summary") or ""
    head = _sentence(goal) if goal else (f"As {persona}, {name[:1].lower() + name[1:]}" if persona else name)
    actions = [a for a in rec if a.get("kind") in ACTION_KINDS]
    described = [describe(a) for a in actions][:MAX_DESCRIBED_STEPS]
    note = unrepeatable(rec)
    desc = head.rstrip(".") + "."
    if described:
        desc += " Steps: " + " ".join(f"{i}. {d}." for i, d in enumerate(described, start=1))
    desc += f" {note[:1].upper() + note[1:]}." if note else " Replays as walked."
    return Draft(
        name=name, category=_category(flow), persona=persona, description=one_line(desc), criteria=criteria,
        checks=checks_by_index(crit_checks), data=scenario_data(flow.get("data")), tags=[TAG, platform],
        evidence=evidence, note=note,
    )
