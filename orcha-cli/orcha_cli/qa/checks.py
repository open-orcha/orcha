"""The `Check:` grammar scenario criteria use (a subset of `verdicts/checks.py`).

Only what parsing, rendering and linting need: no evaluation against a live screen here.

    check    = subject [matcher] ["within" N "s"] ["[warning]"]
    subject  = "text" textpat | ROLE textpat | "id=" ident | "url" | "title"
             | "count" ROLE [textpat] | "screen"
    textpat  = '"..."'            exact after whitespace collapse, case-sensitive
             | '~"..."'           case-insensitive substring
             | "/re/" ["i"]       regex
    matcher  = visible (default) | appears | absent | enabled | disabled | checked | unchecked
             | selected | focused | value TEXTPAT | contains TEXTPAT | matches /re/
             | equals TEXTPAT | (== | >= | <=) N  (count) | unchanged | changed  (screen)

`appears` is for a transient state (a toast, a dialog the next tap answers): it holds when the
element showed at any moment of its window. Delta checks (`api ...`, `query ...`) and read-backs
(`saved ...`, from `Saved:` lines) are passed through untouched (`subject` "delta" / "saved").
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Optional, Union

MAX_TIMEOUT_S = 60.0
WARNING_SUFFIX = "[warning]"

INTERACTIVE_TYPES = frozenset({
    "Button", "TextField", "SecureTextField", "SearchField", "TextView", "Cell", "Link", "Switch",
    "Toggle", "Tab", "TabBar", "SegmentedControl", "Slider", "Stepper", "Picker", "PickerWheel",
    "MenuItem", "Key",
})
ROLE_WORDS = frozenset(set(INTERACTIVE_TYPES) | {"StaticText", "Heading", "Image", "Radio", "Dialog"})
POSITIVE = frozenset({"visible", "appears", "enabled", "disabled", "checked", "unchecked", "selected", "focused", "value", "contains", "matches", "equals"})
ELEMENT_MATCHERS = frozenset(POSITIVE | {"absent"})
COUNT_OPS = frozenset({"==", ">=", "<="})

#: Roles a drafted check does not scope by: a text check holds them as well and survives a
#: platform that reports the same words under another role.
UNSCOPED_ROLES = frozenset({"Cell", "StaticText", "Other", "Unknown", "GenericElement", "Application"})

_LINE = re.compile(r"^\s*check:\s*", re.IGNORECASE)
_DELTA = re.compile(r"^\s*(?:check:\s*)?(api|query)\s+", re.IGNORECASE)
_SAVED = re.compile(r"^\s*(?:check:\s*)?saved:?\s+", re.IGNORECASE)
SAVED_PREFIX = "saved "


def normalise(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


@dataclass(frozen=True)
class TextPat:
    kind: str  # exact | contains | regex
    text: str
    flags: str = ""

    def render(self) -> str:
        if self.kind == "regex":
            return f"/{self.text}/{self.flags}"
        escaped = self.text.replace('"', '\\"')
        if self.kind == "contains":
            return f'~"{escaped}"'
        return f'"{escaped}"'

    def matches(self, value: Optional[str]) -> bool:
        value = normalise(value or "")
        if self.kind == "regex":
            try:
                return re.search(self.text, value, re.IGNORECASE if "i" in self.flags else 0) is not None
            except re.error:
                return False
        if self.kind == "contains":
            return normalise(self.text).casefold() in value.casefold()
        return value == normalise(self.text)


@dataclass(frozen=True)
class Check:
    raw: str
    subject: str = ""  # text | role | id | url | title | count | screen | delta | saved
    role: Optional[str] = None
    pattern: Optional[TextPat] = None
    ident: Optional[str] = None
    matcher: str = "visible"
    arg: Any = None
    timeout_s: Optional[float] = None
    warning: bool = False
    problems: tuple[str, ...] = ()

    @property
    def label(self) -> Optional[str]:
        """The label a text/role check names (None for a regex or another subject)."""
        if self.subject in ("text", "role") and self.pattern is not None and self.pattern.kind != "regex":
            return self.pattern.text
        return None

    def render(self) -> str:
        if self.problems or self.subject in ("delta", "saved"):
            return self.raw.strip()
        parts: list[str] = []
        if self.subject == "text":
            parts += ["text", self.pattern.render()]  # type: ignore[union-attr]
        elif self.subject == "role":
            parts += [self.role or "", self.pattern.render()]  # type: ignore[union-attr]
        elif self.subject == "id":
            parts.append(f"id={self.ident}")
        elif self.subject == "count":
            parts += ["count", self.role or ""]
            if self.pattern is not None:
                parts.append(self.pattern.render())
        else:
            parts.append(self.subject)
        if self.matcher in COUNT_OPS:
            parts += [self.matcher, str(self.arg)]
        elif self.matcher in ("value", "contains", "matches", "equals"):
            parts += [self.matcher, self.arg.render()]  # type: ignore[union-attr]
        elif self.matcher != "visible" or self.subject == "screen":
            parts.append(self.matcher)
        if self.timeout_s is not None:
            parts.append(f"within {self.timeout_s:g}s")
        if self.warning:
            parts.append(WARNING_SUFFIX)
        return " ".join(p for p in parts if p)


def _tokens(text: str) -> list[str]:
    """Split a check line into tokens, keeping quoted strings and /regex/ together."""
    out: list[str] = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c.isspace():
            i += 1
            continue
        if c == '"' or (c == "~" and i + 1 < n and text[i + 1] == '"'):
            start = i
            i += 2 if c == "~" else 1
            while i < n and text[i] != '"':
                i += 2 if text[i] == "\\" else 1
            i += 1
            out.append(text[start:i])
            continue
        if c == "/":
            start = i
            i += 1
            while i < n and text[i] != "/":
                i += 2 if text[i] == "\\" else 1
            i += 1
            while i < n and text[i].isalpha():
                i += 1
            out.append(text[start:i])
            continue
        if c == "[":
            j = text.find("]", i)
            j = n - 1 if j == -1 else j
            out.append(text[i: j + 1])
            i = j + 1
            continue
        start = i
        while i < n and not text[i].isspace():
            i += 1
        out.append(text[start:i])
    return out


def _textpat(tok: Optional[str]) -> Optional[TextPat]:
    if not tok:
        return None
    if tok.startswith('~"') and tok.endswith('"') and len(tok) >= 3:
        return TextPat("contains", tok[2:-1].replace('\\"', '"'))
    if tok.startswith('"') and tok.endswith('"') and len(tok) >= 2:
        return TextPat("exact", tok[1:-1].replace('\\"', '"'))
    m = re.fullmatch(r"/(.*)/([a-z]*)", tok, re.DOTALL)
    if m:
        try:
            re.compile(m.group(1))
        except re.error:
            return None
        return TextPat("regex", m.group(1), m.group(2))
    return None


def is_delta(line: str) -> bool:
    return bool(_DELTA.match(line or ""))


def is_saved(line: str) -> bool:
    return bool(_SAVED.match(line or ""))


def stored_saved(line: str) -> str:
    """A `Saved:` line in the form it is stored among the checks: `saved <body>`."""
    return SAVED_PREFIX + _SAVED.sub("", line or "", count=1).strip()


def parse_check(line: str) -> Check:
    """Parse one `Check:` line. A line with problems is kept with `problems` set."""
    raw = _LINE.sub("", line or "").strip()
    if is_delta(raw):
        return Check(raw=raw, subject="delta", warning=raw.lower().endswith(WARNING_SUFFIX))
    if is_saved(raw):
        return Check(raw=stored_saved(raw), subject="saved", warning=raw.lower().endswith(WARNING_SUFFIX))
    toks = _tokens(raw)
    problems: list[str] = []
    warning = False
    timeout: Optional[float] = None
    if toks and toks[-1].lower() == WARNING_SUFFIX:
        warning = True
        toks = toks[:-1]
    if len(toks) >= 2 and toks[-2].lower() == "within":
        m = re.fullmatch(r"(\d+(?:\.\d+)?)s", toks[-1].lower())
        if m:
            timeout = min(float(m.group(1)), MAX_TIMEOUT_S)
        else:
            problems.append(f"within needs a number of seconds like 10s, got {toks[-1]!r}")
        toks = toks[:-2]
    if not toks:
        return Check(raw=raw, problems=("empty check",))
    head, rest = toks[0], toks[1:]
    subject, role, pattern, ident = "", None, None, None
    if head == "text":
        subject = "text"
        pattern = _textpat(rest[0] if rest else None)
        if pattern is None:
            problems.append('text needs a quoted string, ~"substring" or /regex/')
        rest = rest[1:]
    elif head.startswith("id="):
        subject, ident = "id", head[3:]
        if not ident:
            problems.append("id= needs an identifier")
    elif head in ("url", "title", "screen"):
        subject = head
    elif head == "count":
        subject = "count"
        role = rest[0] if rest else None
        if role not in ROLE_WORDS:
            problems.append(f"count needs a role word ({', '.join(sorted(ROLE_WORDS))})")
        rest = rest[1:]
        if rest and _textpat(rest[0]) is not None:
            pattern = _textpat(rest[0])
            rest = rest[1:]
    elif head in ROLE_WORDS:
        subject, role = "role", head
        pattern = _textpat(rest[0] if rest else None)
        if pattern is None:
            problems.append(f'{head} needs a label: a quoted string, ~"substring" or /regex/')
        rest = rest[1:]
    else:
        problems.append(f"unknown subject {head!r}: use text, id=, url, title, count, screen or a role ({', '.join(sorted(ROLE_WORDS))})")
    matcher, arg = "visible", None
    if rest:
        word = rest[0]
        if word in COUNT_OPS:
            matcher = word
            try:
                arg = int(rest[1])
            except (IndexError, ValueError):
                problems.append(f"{word} needs a whole number")
            rest = rest[2:]
        elif word in ("value", "contains", "matches", "equals"):
            matcher = word
            arg = _textpat(rest[1] if len(rest) > 1 else None)
            if arg is None or (word == "matches" and arg.kind != "regex"):
                problems.append(f"{word} needs {'a /regex/' if word == 'matches' else 'a quoted string, ~substring or /regex/'}")
            rest = rest[2:]
        else:
            matcher = word
            rest = rest[1:]
    if rest:
        problems.append(f"unexpected text after the matcher: {' '.join(rest)!r}")
    if not problems:
        if subject == "count" and matcher not in COUNT_OPS:
            problems.append("count needs ==, >= or <= and a number")
        elif subject != "count" and matcher in COUNT_OPS:
            problems.append(f"{matcher} only applies to count")
        elif subject == "screen" and matcher not in ("unchanged", "changed"):
            problems.append("screen needs unchanged or changed")
        elif subject in ("url", "title") and matcher not in ("contains", "matches", "equals"):
            problems.append(f"{subject} needs contains, matches or equals")
        elif subject in ("text", "role", "id") and matcher not in ELEMENT_MATCHERS:
            problems.append(f"unknown matcher {matcher!r}: use {', '.join(sorted(ELEMENT_MATCHERS))}")
    return Check(
        raw=raw, subject=subject, role=role, pattern=pattern, ident=ident, matcher=matcher,
        arg=arg, timeout_s=timeout, warning=warning, problems=tuple(problems),
    )


def render(line: str) -> str:
    return parse_check(line).render()


def text_check(label: str, role: Optional[str] = None, *, matcher: str = "visible") -> str:
    """`Button "Save"` when `role` is one a check can name, else `text "Save"` (plain text, a cell
    or an unknown role reads the same on both platforms as text)."""
    pat = TextPat("exact", normalise(label))
    if role and role in ROLE_WORDS and role not in UNSCOPED_ROLES:
        c = Check(raw="", subject="role", role=role, pattern=pat, matcher=matcher)
    else:
        c = Check(raw="", subject="text", pattern=pat, matcher=matcher)
    return c.render()


def rewrite_check(check: Union[Check, str], *, matcher: Optional[str] = None, timeout_s: Optional[float] = None) -> str:
    """`check` re-rendered with another matcher or timeout, everything else kept."""
    c = parse_check(check) if isinstance(check, str) else check
    if c.problems or c.subject in ("delta", "saved"):
        return c.render()
    changed = Check(
        raw=c.raw, subject=c.subject, role=c.role, pattern=c.pattern, ident=c.ident,
        matcher=matcher or c.matcher, arg=c.arg,
        timeout_s=timeout_s if timeout_s is not None else c.timeout_s, warning=c.warning,
    )
    return changed.render()


# ---------- transient states ----------

TRANSIENT_CRITERION = re.compile(
    r"\b(?:toasts?|snack ?bars?|flash(?: message)?|briefly|(?:confirmation|success|saved) (?:message|banner|toast|notice)"
    r"|confirm(?:ation)? (?:dialog|alert|prompt|pop-?up|modal)|asks? (?:to|for) confirm\w*|(?:an?|the) alert|pop-?ups?"
    r"|spinners?|progress (?:bar|indicator)|loading (?:state|indicator)"
    r"|while (?:it )?(?:signing|logging|saving|loading|submitting|sending|uploading|processing|deleting|creating|updating))\b",
    re.IGNORECASE,
)
PROGRESS_LABEL = re.compile(
    r"^(?!(?:some|no|any|every)thing\b)\w+ing\b[^.…]*(?:…|\.\.\.)\s*$"
    r"|^(?:loading|saving|signing (?:in|out|up)|logging (?:in|out)|submitting|sending|uploading|please wait)\b",
    re.IGNORECASE,
)
TRANSIENT_ROLES = frozenset({"Dialog"})


def transient_check(check: Union[Check, str], criterion: str = "") -> bool:
    """A check on a state gone by the time the criterion is reported, written without `appears`:
    a progress label ("Signing in…"), a dialog, or a plain visibility check of a criterion about a
    toast, an alert, a pop-up or a loading state."""
    if isinstance(check, str):
        check = parse_check(check)
    if check.problems or check.subject not in ("text", "role") or check.pattern is None:
        return False
    if check.matcher in ("visible", "enabled", "disabled") and check.pattern.kind != "regex":
        if PROGRESS_LABEL.search(normalise(check.pattern.text)):
            return True
    if check.matcher != "visible":
        return False
    return check.role in TRANSIENT_ROLES or bool(TRANSIENT_CRITERION.search(criterion or ""))


def _label_key(check: Check) -> Optional[str]:
    if check.problems or check.subject not in ("text", "role") or check.pattern is None or check.pattern.kind == "regex":
        return None
    return normalise(check.pattern.text).casefold()


def contradictions(lines: list[str]) -> list[tuple[str, str]]:
    """Pairs of one criterion's lines that can never hold together: a label checked as shown and
    the same label checked `absent`."""
    parsed = [parse_check(x) for x in lines]
    out: list[tuple[str, str]] = []
    for a in parsed:
        if a.matcher in ("absent", "appears") or a.matcher not in ELEMENT_MATCHERS:
            continue
        key = _label_key(a)
        if key is None:
            continue
        for b in parsed:
            if b.matcher == "absent" and _label_key(b) == key and (b.subject == "text" or (a.subject == "role" and b.role == a.role)):
                out.append((a.render(), b.render()))
    return out


def resolve_placeholders(line: str, data: Optional[dict[str, str]]) -> str:
    if not data or "{{" not in line:
        return line
    return re.sub(r"\{\{\s*([\w.\-]+)\s*\}\}", lambda m: str(data.get(m.group(1), m.group(0))), line)
