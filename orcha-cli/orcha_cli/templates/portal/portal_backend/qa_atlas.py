"""The Screen atlas: every screen of the app at a glance, iOS, Android and web side by side.

A reading of what QA already stored, with no table of its own and nothing written:
`GET /api/containers/{cid}/qa/atlas?since=` (`read_atlas`).

- **Screens across platforms** (`cluster`). Each platform maps its own node. Nodes on different
  platforms are one screen by the same key first, then the same normalised route, then the same
  normalised label within a feature; never two nodes of one platform. Each screen says how it
  was matched (`matched_by`: key, route, label, or null for a single node).
- **Looks.** The `screen` steps of every session, joined to their frames: a look is a distinct
  `screen_hash` of one screen on one platform, device kind, appearance and state, kept with its
  first and last sighting. A step's own words say its state (`look_state`) and what changed.
- **Devices.** A session's device and the frame's shape say what took a look. Whether a frame is
  light or dark, or blank, the CLI read as it took it (`qa_frames.appearance`, `blank`): the portal
  never decodes an image.
- **Similarity.** Two platforms of one screen compare by what each says (half), its structure (a
  fifth) and its look (the rest): `qa_frames.fingerprint`, a perceptual hash and mean colour. Only
  like with like: a pair on two kinds of device or in two appearances gets no score, and says why.
  `same`, `minor` and `different` come from the score, `missing` and `unmatched` from presence.
- **Builds.** A session's `build_label` is a build; `since` is a build or a date.
"""

from __future__ import annotations

import re
from collections import Counter, deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Optional

from portal_backend import qa_map, qa_store as qs
from portal_backend.qa_store import PLATFORMS

PLATFORM_WORD = {"ios": "iOS", "android": "Android", "web": "Web"}
BADGE_WORD = {"same": "Same", "minor": "Minor differences", "different": "Different", "missing": "Not on every platform",
              "unchecked": "Not compared yet", "unmatched": "Not matched yet"}
#: How alike the devices of two looks are, best first: the same kind and appearance; the same kind
#: and the same setting, though one app drew itself the other way (that is the app's doing, so it
#: still compares); the same kind in another appearance; another kind of device.
MATCHES = ("same", "setting", "appearance", "device")
#: Score at or above which two platforms read as the same, or as only slightly different.
SAME_AT = 0.88
MINOR_AT = 0.62
#: A frame fingerprint within this many bits (of 64) is the same look.
SAME_BITS = 6
#: How different two frames must be (bits of 64) before the layout is said to differ.
LAYOUT_BITS = 18
#: Mean colours further apart than this (0..441, RGB distance) read as "the colours differ".
COLOUR_APART = 70.0
#: Why a look has no picture: the session found the app in secure mode, else its capture was one colour.
BLANK_WHY = ("flag_secure", "uniform")
#: How long a pass takes, as the page says it: the high-level one and a fill-in.
PASS_MINUTES = {"overview": 3, "deeper": 10}
#: The most screens one fill-in visits (`crawl_queue.MAX_DEEPER`).
MAX_DEEPER = 25
FORM_WORD = {"phone": "phone", "tablet": "tablet", "desktop": "desktop"}
APPEARANCES = ("light", "dark")
MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
#: "Changed recently" without a date: the last week.
RECENT_DAYS = 7
#: Steps read per container (newest first).
LOOKS_READ = 20000
#: Builds offered for "changed since", and how long a session with no end is taken to have run.
BUILDS_SHOWN = 30
RUN_HOURS = 6
#: A word or route most screens share decides nothing.
BUCKET_MOST = 40
#: A running map session silent for this long no longer counts as a refresh under way.
STALE_MINUTES = 20
#: Words that name a screen's kind, not the screen.
KIND_WORDS = frozenset({"screen", "view", "page", "tab", "controller", "activity", "fragment", "sheet", "route", "coordinator"})
#: Controls each platform draws in its own way: never a change.
CHROME = frozenset({"back", "navigate up", "more options", "close", "done", "menu", "open navigation drawer", "tab bar"})
#: A web session's viewports (`qa_targets.device_name`), as a person names them.
VIEWPORT_WORD = {"desktop": "Chromium 1280×800", "mobile": "Chromium 390×844"}

_ERROR = re.compile(r"\b(error|went wrong|try again|failed|couldn.?t|could not|unable to|no connection|offline)\b", re.I)
_EMPTY = re.compile(r"\b(no \w+( \w+)? yet|is empty|nothing (here|to show|yet)|no results|empty)\b", re.I)
_LOADING = re.compile(r"\b(loading|please wait)\b", re.I)
_PASSWORD = re.compile(r"\bpassword\b", re.I)
_SIGN_IN = re.compile(r"\b(sign ?in|log ?in|login|continue)\b", re.I)
#: A capture of a sign-in form: it says nothing of the screen behind the sign-in.
SIGNIN = "signin"
STATE_WORD = {"loaded": "Loaded", "empty": "Empty", "error": "Error", "loading": "Loading", "keyboard": "Keyboard open",
              "search": "Searching", "menu": "Menu open", SIGNIN: "Sign-in shown"}
_SPACE = re.compile(r"\s+")
_DIGITS = re.compile(r"\d+([.,]\d+)*")
_PUNCT = re.compile(r"[^\w\s#&+'-]")
_HOLE = re.compile(r"(?<![\w*])\*+(?![\w*])")
_HOLES = re.compile(r"…(?:\s*…)+")
_SUFFIX = re.compile(r"(?<=[^\W\d_])\*+(?![\w*])")
_INFLECT = re.compile(r"\^\[([^\]]*)\]\([^)]*\)")
_COUNTED = re.compile(r"^\s*\d+\s+screens?\b(:.*)?$", re.I)
_ROUTE_PARAM = re.compile(r"^(?::.+|\[.+\]|\{.+\}|\*+|<.+>)$")

_TABLET = re.compile(r"\b(ipad|tablet|galaxy tab|tab s\d|pixel c)\b", re.I)
_DESKTOP = re.compile(r"\b(mac|macbook|imac|my mac|desktop)\b", re.I)
_PHONE = re.compile(r"\b(iphone|pixel|galaxy|phone|nexus|oneplus|emulator|simulator)\b", re.I)
#: A device name that is only a serial or a lane, never a name a person knows it by.
_SERIAL = re.compile(r"^(emulator-\d+|[0-9a-f]{8,}|[0-9A-F-]{20,}|localhost:\d+|[\d.]+:\d+)$", re.I)
#: A frame at least this square (short side over long side) is a tablet's; a phone's is about 0.46.
TABLET_RATIO = 0.6



# ---------------------------------------------------------------- words

def norm_text(text: str) -> str:
    """A text as it compares: lower case, numbers as `#`, no punctuation or extra space."""
    t = _DIGITS.sub("#", str(text or "").lower())
    return _SPACE.sub(" ", _PUNCT.sub(" ", t)).strip()


def display_text(text: str) -> str:
    """A text as a person reads it: each hole the code leaves for a value (`*`) as an ellipsis."""
    t = _INFLECT.sub(r"\1", " ".join(str(text or "").split()))
    t = _HOLES.sub("…", _HOLE.sub("…", _SUFFIX.sub("", t)))
    return t if re.search(r"\w", t) else ""


def display_texts(texts: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(t for t in (display_text(x) for x in texts or []) if t))


def comparable(texts: Iterable[str]) -> list[tuple[str, str]]:
    """`(normalised, as written)` in reading order, once each, without a platform's own chrome."""
    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    for t in texts or []:
        n = norm_text(t)
        if len(n.replace("#", "")) < 2 or n in CHROME or n in seen:
            continue
        seen.add(n)
        out.append((n, " ".join(str(t).split())))
    return out


def look_state(texts: Iterable[str], states: Iterable[str] = ()) -> str:
    """What a capture shows: `signin` for a sign-in form, else an overlay it holds (`keyboard`),
    else `error`, `empty`, `loading` from its words, else `loaded`."""
    said = list(texts or [])
    words = " · ".join(str(t) for t in said)
    if _PASSWORD.search(words) and _SIGN_IN.search(words):
        return SIGNIN
    for s in states or ():
        if s:
            return str(s)[:80]
    if _ERROR.search(words):
        return "error"
    if _EMPTY.search(words):
        return "empty"
    if _LOADING.search(words) and len(said) <= 4:
        return "loading"
    return "loaded"


def state_label(state: str) -> str:
    if state.startswith("alert:"):
        return f"Alert: {display_text(state[6:].strip()) or 'a message'}"
    return STATE_WORD.get(state, state[:1].upper() + state[1:])


def _quote(text: str, n: int = 40) -> str:
    text = display_text(text) or text
    t = text if len(text) <= n else text[: n - 1].rstrip() + "…"
    return f"“{t}”"


_FP = re.compile(r"([0-9a-f]{16})-([0-9a-f]{6})(?:-(\d{1,5})x(\d{1,5}))?")


def _parts(fp: Optional[str]) -> Optional[tuple[int, tuple[int, int, int]]]:
    m = _FP.fullmatch(fp or "")
    if not m:
        return None
    c = m.group(2)
    return int(m.group(1), 16), (int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16))


def frame_size(fp: Optional[str]) -> Optional[tuple[int, int]]:
    """A frame's size in pixels from its fingerprint."""
    m = _FP.fullmatch(fp or "")
    return (int(m.group(3)), int(m.group(4))) if m and m.group(3) else None


def same_shape(a: Optional[str], b: Optional[str]) -> bool:
    """Two frames of the same device shape (two phones, not an iPad beside a phone): only those
    compare pixel by pixel."""
    sa, sb = frame_size(a), frame_size(b)
    if not sa or not sb:
        return True
    ra, rb = sa[0] / max(1, sa[1]), sb[0] / max(1, sb[1])
    return abs(ra - rb) <= 0.12 * max(ra, rb)


def bits_apart(a: Optional[str], b: Optional[str]) -> Optional[int]:
    pa, pb = _parts(a), _parts(b)
    if pa is None or pb is None:
        return None
    return bin(pa[0] ^ pb[0]).count("1")


def colour_apart(a: Optional[str], b: Optional[str]) -> Optional[float]:
    pa, pb = _parts(a), _parts(b)
    if pa is None or pb is None:
        return None
    return sum((x - y) ** 2 for x, y in zip(pa[1], pb[1])) ** 0.5


def _luma(fp: Optional[str]) -> Optional[float]:
    p = _parts(fp)
    return None if p is None else 0.299 * p[1][0] + 0.587 * p[1][1] + 0.114 * p[1][2]


def _dice(a: set[str], b: set[str]) -> float:
    if not a and not b:
        return 1.0
    return 2 * len(a & b) / (len(a) + len(b)) if (a or b) else 0.0


def _tokens(text: str) -> set[str]:
    return {w for w in text.split() if len(w) > 1}


def _names(platforms: Iterable[str]) -> str:
    words = [PLATFORM_WORD[p] for p in platforms]
    return words[0] if len(words) == 1 else ", ".join(words[:-1]) + " and " + words[-1]


def name_words(label: str) -> set[str]:
    """A name's words, the kind words gone: `ProductDetailView` and "Product detail" agree."""
    words = set()
    for w in norm_text(qs.slug(str(label or "").replace("*", " "), 200).replace("-", " ")).split():
        if w in KIND_WORDS or w == "#":
            continue
        words.add(w[:-1] if len(w) > 3 and w.endswith("s") and not w.endswith("ss") else w)
    return words


def norm_route(route: Optional[str]) -> Optional[str]:
    """A route as it compares: no query or edge slashes, each parameter one `*`, `/` the home."""
    text = str(route or "").split("?", 1)[0].split("#", 1)[0].strip().lower()
    if not text:
        return None
    parts = ["*" if _ROUTE_PARAM.match(p) else p for p in text.split("/") if p]
    return "/".join(parts) or "/"


# ---------------------------------------------------------------- devices

def device_of(platform: str, name: Optional[str], size: Optional[tuple[int, int]]) -> dict[str, Any]:
    """What one look was taken on, for its frame: `{kind, landscape, w, h}`."""
    w, h = size or (None, None)
    landscape = bool(w and h and w > h * 1.05)
    text = str(name or "")
    if platform == "web":
        kind = "browser"
    elif _TABLET.search(text):
        kind = "tablet"
    elif _DESKTOP.search(text):
        kind = "desktop"
    elif _PHONE.search(text):
        kind = "phone"
    elif w and h:
        kind = "tablet" if min(w, h) / max(w, h) >= TABLET_RATIO else "phone"
    else:
        kind = "phone"
    return {"kind": kind, "landscape": landscape, "w": w, "h": h}


def device_form(platform: str, name: Optional[str], size: Optional[tuple[int, int]]) -> str:
    """The kind of device a look was taken on: its name says it first, else its frame's shape."""
    text = str(name or "")
    if platform != "web":
        if _TABLET.search(text):
            return "tablet"
        if _DESKTOP.search(text):
            return "desktop"
        if _PHONE.search(text):
            return "phone"
    w, h = size or (0, 0)
    if not (w and h):
        return "desktop" if platform == "web" else "phone"
    if platform == "web" and w > h:
        return "desktop"
    return "tablet" if min(w, h) / max(w, h) >= TABLET_RATIO else "phone"


def device_label(platform: str, name: Optional[str]) -> Optional[str]:
    """The device as a person names it; None when the session says nothing better than a serial."""
    text = " ".join(str(name or "").split())
    if platform == "web":
        return VIEWPORT_WORD.get(text.lower(), text or None)
    return text if text and not _SERIAL.match(text) and not text.lower().startswith(("sdk_", "sdk ")) else None


# ---------------------------------------------------------------- reading what is stored

def _parse_at(value: Any) -> Optional[datetime]:
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    text = str(value).strip().replace("Z", "+00:00")
    try:
        at = datetime.fromisoformat(text)
    except ValueError:
        return None
    return at if at.tzinfo else at.replace(tzinfo=timezone.utc)


def _iso(at: datetime) -> str:
    return at.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _when(value: Any) -> str:
    """A stored time as text that sorts: both databases, and the cutoff, in one form."""
    at = _parse_at(value)
    return _iso(at) if at else ""


def _frame_url(frame_id: Optional[str]) -> Optional[str]:
    return f"/api/qa/frames/{frame_id}" if frame_id else None


def read_steps(cur, cid: str) -> list[dict]:
    """The `screen` steps placed on a screen, oldest first, each with its frame and session."""
    cur.execute(
        """SELECT st.session_id, st.screen_key, st.screen_hash, st.frame_id, st.at, st.args,
                  f.width, f.height, f.screen_hash AS frame_hash, f.fingerprint, f.appearance, f.blank,
                  s.platform, s.device_name, s.device_appearance, s.build_label
             FROM qa_steps st
             JOIN qa_sessions s ON s.id = st.session_id
             LEFT JOIN qa_frames f ON f.id = st.frame_id
            WHERE st.container_id = %s AND st.kind = 'screen' AND st.screen_key IS NOT NULL
            ORDER BY st.at DESC, st.seq DESC
            LIMIT %s""",
        (cid, LOOKS_READ),
    )
    return [qs.public(r) for r in cur.fetchall()][::-1]


def _step_state(step: dict) -> str:
    args = step.get("args") if isinstance(step.get("args"), dict) else {}
    texts = [str(t) for t in args.get("texts") or []]
    anchors = [str(t) for t in args.get("anchors") or []]
    return look_state(texts, qa_map.clean_capture(texts, anchors).states)


def looks_of(steps: list[dict]) -> list[dict]:
    """The steps as looks: one per screen, platform, device kind, appearance, state and hash,
    each with its first and last sighting and the newest frame that has a picture."""
    states: dict[str, str] = {}
    looks: dict[tuple, dict] = {}
    for st in steps:
        fid = str(st["frame_id"]) if st.get("frame_id") else None
        p, key = str(st["platform"]), str(st["screen_key"])
        digest = str(st.get("screen_hash") or st.get("frame_hash") or fid or "")
        state = states.get(digest) if digest else None
        if state is None:
            state = _step_state(st)
            if digest:
                states[digest] = state
        size = (int(st["width"]), int(st["height"])) if st.get("width") and st.get("height") else None
        name = device_label(p, st.get("device_name"))
        form = device_form(p, name or st.get("device_name"), size)
        blank, shade = st.get("blank"), st.get("appearance")
        at = _when(st.get("at"))
        lk = looks.setdefault((p, key, form, shade, state, digest or at), {
            "id": f"{p}:{key}:{form}:{shade}:{state}:{digest or at}", "platform": p, "screen_key": key, "hash": digest or None,
            "state": state, "device_kind": form, "appearance": shade, "device_appearance": st.get("device_appearance"), "first_seen_at": at,
            "last_seen_at": at, "frame_id": None, "blank": None, "device_name": name, "orientation": None, "screen_w": None,
            "screen_h": None, "run_id": None, "texts": [], "actions": [], "fingerprint": None, "build_label": None,
        })
        lk["last_seen_at"] = at
        lk["run_id"] = str(st["session_id"])
        lk["build_label"] = st.get("build_label") or lk["build_label"]
        lk["device_name"] = name or lk["device_name"]
        args = st.get("args") if isinstance(st.get("args"), dict) else {}
        lk["texts"] = [str(t) for t in args.get("texts") or []] or lk["texts"]
        lk["actions"] = [str(t) for t in args.get("anchors") or []] or lk["actions"]
        if fid and blank:
            lk["blank"] = lk["blank"] or blank
        elif fid:
            lk.update(frame_id=fid, blank=None, fingerprint=st.get("fingerprint") or lk["fingerprint"], screen_w=size[0] if size else None, screen_h=size[1] if size else None,
                      orientation=("landscape" if size and size[0] > size[1] * 1.05 else "portrait") if size else None)
    return list(looks.values())


# ---------------------------------------------------------------- joining a screen's platforms

@dataclass
class Group:
    """One screen of the atlas: the map nodes that are it, one per platform."""

    nodes: list[dict]
    platforms: dict[str, dict]
    matched_by: Optional[str] = None

    @property
    def lead(self) -> dict:
        return max(self.nodes, key=lambda n: (len(n.get("sources") or []), n.get("state") == "seen", -len(str(n["key"])),
                                              -PLATFORMS.index(str(n["platform"]))))


def node_route(n: dict) -> Optional[str]:
    """A node's route: its code's, its key when that is a route, else a run's."""
    detail = n.get("detail") if isinstance(n.get("detail"), dict) else {}
    code = detail.get("code") if isinstance(detail.get("code"), dict) else {}
    live = detail.get("live") if isinstance(detail.get("live"), dict) else {}
    if code.get("route"):
        return str(code["route"])
    if str(n["key"]).startswith("/"):
        return str(n["key"])
    routes = live.get("routes") or []
    return str(routes[0]) if routes else None


def _agree(a: Optional[str], b: Optional[str]) -> bool:
    return a is None or b is None or a == b


def cluster(nodes: list[dict]) -> list[Group]:
    """Nodes on different platforms that are one screen: the same key, then within a feature the
    same normalised route, then the same normalised label. First match wins, and a screen never
    holds two nodes of one platform."""
    groups = [Group([n], {str(n["platform"]): n}) for n in nodes]
    owner = list(range(len(groups)))

    def find(i: int) -> int:
        while owner[i] != i:
            owner[i] = owner[owner[i]]
            i = owner[i]
        return i

    def feature(g: Group) -> Optional[str]:
        return next((n.get("feature_key") for n in g.nodes if n.get("feature_key")), None)

    def join(i: int, j: int, how: str) -> None:
        a, b = find(i), find(j)
        if a == b or set(groups[a].platforms) & set(groups[b].platforms):
            return
        if how != "key" and not _agree(feature(groups[a]), feature(groups[b])):
            return
        groups[a].nodes += groups[b].nodes
        groups[a].platforms.update(groups[b].platforms)
        groups[a].matched_by = groups[a].matched_by or how
        owner[b] = a

    def label_of(n: dict) -> Optional[str]:
        return " ".join(sorted(name_words(n.get("label") or ""))) or None

    def key_of(n: dict) -> Optional[str]:
        return str(n["key"])

    def route_of(n: dict) -> Optional[str]:
        return norm_route(node_route(n))

    for how, of in (("key", key_of), ("route", route_of), ("label", label_of)):
        buckets: dict[str, list[int]] = {}
        for i, n in enumerate(nodes):
            k = of(n)
            if k:
                buckets.setdefault(k, []).append(i)
        for idx in buckets.values():
            if len(idx) > BUCKET_MOST:
                continue
            for x in range(len(idx)):
                for y in range(x + 1, len(idx)):
                    join(idx[x], idx[y], how)
    return [g for i, g in enumerate(groups) if find(i) == i]


# ---------------------------------------------------------------- like with like

@dataclass
class Side:
    """One platform's version of a screen, as similarity reads it."""

    platform: str
    texts: list[str] = field(default_factory=list)
    fingerprint: Optional[str] = None
    actions: list[str] = field(default_factory=list)
    seen: bool = False
    # Seen live, but only with a sign-in form in front of it: not compared.
    signin_only: bool = False
    # What took the look: its device kind, what it shows, what the device was set to, and the
    # device's name. None: not known, so it matches anything.
    form: Optional[str] = None
    appearance: Optional[str] = None
    set_appearance: Optional[str] = None
    device: Optional[str] = None
    # The look itself, for the frame a pair is wiped across.
    look: Optional[dict] = field(default=None)


def match_of(a: Side, b: Side) -> str:
    """How alike the devices of two looks are (`MATCHES`). Unknowns match anything."""
    if not _agree(a.form, b.form):
        return "device"
    if _agree(a.appearance, b.appearance):
        return "same"
    if a.set_appearance and a.set_appearance == b.set_appearance:
        return "setting"
    return "appearance"


def fair(a: Side, b: Side, match: Optional[str] = None) -> bool:
    """Whether two looks compare like with like: the same kind of device and the same appearance
    (or setting). A pair with the web compares only what each says, never the pictures (a browser
    window is not a phone's shape), so the device and the theme do not matter to it."""
    return "web" in (a.platform, b.platform) or (match or match_of(a, b)) in ("same", "setting")


def _newest(s: Side) -> str:
    return str((s.look or {}).get("last_seen_at") or "")


def pick_pair(xs: list[Side], ys: list[Side], main: Optional[dict[str, tuple]] = None) -> tuple[Side, Side, str]:
    """The two looks two platforms are compared by: the closest match first, then the platforms'
    usual device and appearance, then the newest."""
    def usual(s: Side) -> int:
        kind, ap = (main or {}).get(s.platform) or (None, None)
        return int(kind not in (None, s.form)) * 2 + int(ap not in (None, s.appearance))

    cands = sorted(((x, y) for x in xs for y in ys), key=lambda xy: max(_newest(xy[0]), _newest(xy[1])), reverse=True)
    x, y = min(cands, key=lambda xy: (MATCHES.index(match_of(*xy)), usual(xy[0]) + usual(xy[1])))
    return x, y, match_of(x, y)


def pick_side(options: list[Side], main: Optional[tuple] = None) -> Side:
    """A platform's look when it has no pair: its usual device and appearance, then the newest."""
    kind, ap = main or (None, None)
    newest_first = sorted(options, key=_newest, reverse=True)
    return min(newest_first, key=lambda s: (kind not in (None, s.form), ap not in (None, s.appearance)))


def _with_article(word: str) -> str:
    return ("an " if word[:1].lower() in "aeiou" else "a ") + word


def device_words(platform: str, form: Optional[str], named: bool = True) -> str:
    """A device as a sentence names it: "an iPad", "an Android tablet"."""
    if platform == "ios":
        return {"phone": "an iPhone", "tablet": "an iPad", "desktop": "a Mac"}.get(form or "", "an iPhone")
    if platform == "web":
        return {"phone": "a phone-sized browser", "tablet": "a tablet-sized browser"}.get(form or "", "a desktop browser")
    kind = FORM_WORD.get(form or "", "phone")
    return _with_article(f"{PLATFORM_WORD[platform]} {kind}" if named else kind)


def pair_words(a: Side, b: Side) -> str:
    """Which looks a pair compares: "iPhone 17 Pro vs Pixel 9a, both light"."""
    na = a.device or device_words(a.platform, a.form).split(" ", 1)[1]
    nb = b.device or device_words(b.platform, b.form).split(" ", 1)[1]
    if na == nb:
        na, nb = f"{na} on {PLATFORM_WORD[a.platform]}", f"{nb} on {PLATFORM_WORD[b.platform]}"
    if a.appearance and a.appearance == b.appearance:
        return f"{na} vs {nb}, both {a.appearance}"
    if a.appearance and b.appearance:
        return f"{na} in {a.appearance} vs {nb} in {b.appearance}"
    return f"{na} vs {nb}"


def unfair_words(a: Side, b: Side, xs: list[Side], ys: list[Side]) -> str:
    """Why two platforms are not compared, in plain words."""
    pa, pb = PLATFORM_WORD[a.platform], PLATFORM_WORD[b.platform]
    if not _agree(a.form, b.form):
        fa = sorted({s.form for s in xs if s.form}, key=list(FORM_WORD).index)
        fb = sorted({s.form for s in ys if s.form}, key=list(FORM_WORD).index)
        wa = " and ".join(device_words(a.platform, f, False) for f in fa) or device_words(a.platform, a.form, False)
        wb = " and ".join(device_words(b.platform, f, False) for f in fb) or device_words(b.platform, b.form, False)
        return f"{pa} was only seen on {wa}, {pb} only on {wb}, so Orcha does not compare them yet"
    aa = " and ".join(x for x in APPEARANCES if any(s.appearance == x and s.form == a.form for s in xs)) or a.appearance
    ab = " and ".join(x for x in APPEARANCES if any(s.appearance == x and s.form == b.form for s in ys)) or b.appearance
    one_kind = len({s.form for s in xs + ys if s.form}) <= 1
    where = "" if one_kind else f"On {FORM_WORD.get(a.form or '', 'phone')}s, "
    return f"{where}{pa} was only seen in {aa}, {pb} only in {ab}, so Orcha does not compare them yet"


def seen_json(lk: dict, platform: Optional[str] = None) -> dict:
    """One look as the page shows what took it, with its frame or why it has none."""
    return {"platform": platform or lk.get("platform"), "device": lk.get("device_name"), "form": lk.get("device_kind"),
            "appearance": lk.get("appearance"), "set_appearance": lk.get("device_appearance"), "orientation": lk.get("orientation"),
            "w": lk.get("screen_w"), "h": lk.get("screen_h"), "frame_url": _frame_url(lk.get("frame_id")), "at": lk.get("last_seen_at"),
            "build": lk.get("build_label"), "run_id": lk.get("run_id"), "state": lk.get("state"), "blank": lk.get("blank")}


def side_json(s: Side) -> dict:
    """The look one side of a pair was compared by (its frame is what the pair's wipe shows)."""
    if s.look:
        return seen_json(s.look, s.platform)
    return {"platform": s.platform, "device": s.device, "form": s.form, "appearance": s.appearance, "set_appearance": s.set_appearance,
            "orientation": None, "w": None, "h": None, "frame_url": None, "at": None, "build": None, "run_id": None,
            "state": None, "blank": None}


def blank_of(s: Side) -> Optional[str]:
    """Why one side of a pair has no picture (`BLANK_WHY`), when its look's capture was blank."""
    why = (s.look or {}).get("blank")
    return str(why) if why in BLANK_WHY else None


def blank_words(platform: str, why: str) -> str:
    """Why a platform has no picture of a screen, in the person's words."""
    if why == "flag_secure":
        return f"The {PLATFORM_WORD[platform]} app hides this screen from screenshots"
    return f"{PLATFORM_WORD[platform]}'s screenshot of it came back blank"


def _pairs_swapped(a: list[str], b: list[str]) -> tuple[int, int, Optional[tuple[str, str]]]:
    """Of the texts both say, how many pairs come in the other order, of how many, and the first."""
    common = [t for t in a if t in set(b)]
    pos = {t: i for i, t in enumerate(t for t in b if t in set(common))}
    seq = [pos[t] for t in common]
    swapped, total, first = 0, 0, None
    for i in range(len(seq)):
        for j in range(i + 1, len(seq)):
            total += 1
            if seq[i] > seq[j]:
                swapped += 1
                if first is None:
                    first = (common[i], common[j])
    return swapped, total, first


def _v(who: str, one: str, many: str) -> str:
    """`iOS says`, `iOS and Web say`."""
    return f"{who} {many if ' and ' in who else one}"


def compare(a: Side, b: Side, wa: Optional[str] = None, wb: Optional[str] = None) -> dict:
    """Two platforms of one screen: `{score, reasons}`, the score 0..1 from what each says (half),
    its structure (a fifth) and its look (the rest; only phone beside phone, since a browser
    window is not the shape of a phone). A difference a person would notice keeps it below
    `same`. Reasons are short plain sentences, the biggest difference first; `wa` and `wb` name
    each side when it stands for several platforms ("iOS and Web")."""
    wa, wb = wa or PLATFORM_WORD[a.platform], wb or PLATFORM_WORD[b.platform]
    ta, tb = comparable(a.texts), comparable(b.texts)
    na, nb = [n for n, _ in ta], [n for n, _ in tb]
    written = {n: w for n, w in ta + tb}
    sa, sb = set(na), set(nb)
    reasons: list[str] = []
    scores: list[tuple[float, float]] = []
    if sa or sb:
        text_score = _dice(sa, sb)
        scores.append((0.5, text_score))
        only_a = [n for n in na if n not in sb]
        only_b = [n for n in nb if n not in sa]
        # The same control worded differently: two texts that differ by a word or two.
        used: set[str] = set()
        for x in only_a:
            best = max(only_b, key=lambda y: (_dice(_tokens(x), _tokens(y)), -abs(len(x) - len(y))), default=None)
            if best is not None and best not in used and _dice(_tokens(x), _tokens(best)) >= 0.5:
                used |= {x, best}
                reasons.append(f"{_v(wa, 'says', 'say')} {_quote(written[x])}, {_v(wb, 'says', 'say')} {_quote(written[best])}")
        rest_a = [x for x in only_a if x not in used]
        rest_b = [y for y in only_b if y not in used]
        for who, rest in ((wa, rest_a), (wb, rest_b)):
            if rest:
                more = f" and {len(rest) - 2} more" if len(rest) > 2 else ""
                reasons.append(f"Only {_v(who, 'shows', 'show')} " + ", ".join(_quote(written[x], 30) for x in rest[:2]) + more)
        swapped, total, first = _pairs_swapped(na, nb)
        order = 1.0 - swapped / total if total else 1.0
        count = min(len(na), len(nb)) / max(len(na), len(nb)) if na and nb else 0.0
        scores.append((0.2, (order + count) / 2))
        if first is not None and swapped:
            x, y = first
            buttons = {norm_text(t) for t in a.actions + b.actions}
            what = "Button order differs" if x in buttons or y in buttons or (len(x) <= 24 and len(y) <= 24) else "The order differs"
            reasons.append(f"{what}: {_quote(written[x], 30)} comes before {_quote(written[y], 30)} on {wa}, after it on {wb}")
        diff = len(nb) - len(na)
        if na and nb and abs(diff) >= max(3, int(0.3 * max(len(na), len(nb)))):
            reasons.append(f"{_v(wb if diff > 0 else wa, 'shows', 'show')} {abs(diff)} more items")
    # Frames compare only phone to phone: a browser window and a phone are not the same shape, and
    # neither are an iPad and a phone.
    bits = bits_apart(a.fingerprint, b.fingerprint) if "web" not in (a.platform, b.platform) and same_shape(a.fingerprint, b.fingerprint) else None
    if bits is not None:
        visual = max(0.0, 1.0 - bits / 32)
        apart = colour_apart(a.fingerprint, b.fingerprint) or 0.0
        if apart > COLOUR_APART:
            visual *= 0.7
            la, lb = _luma(a.fingerprint) or 0, _luma(b.fingerprint) or 0
            pa, pb = PLATFORM_WORD[a.platform], PLATFORM_WORD[b.platform]  # the frames are these two's
            reasons.append(f"Colours differ: {pa} looks {'lighter' if la > lb else 'darker'} than {pb}")
        if bits > LAYOUT_BITS:
            reasons.append("The layout looks different")
        elif bits > SAME_BITS * 2:
            reasons.append("Small visual differences")
        scores.append((0.3, visual))
    if not scores:
        return {"score": None, "reasons": []}
    total_w = sum(w for w, _ in scores)
    score = sum(w * s for w, s in scores) / total_w
    # A difference a person would notice (other words, another order, other colours) is never "same".
    notable = any(r != "Small visual differences" for r in reasons)
    if notable and score >= SAME_AT:
        score = SAME_AT - 0.01
    if not reasons and score < SAME_AT:
        reasons.append("Small differences in what each shows")
    return {"score": round(score, 3), "reasons": reasons}


def badge_for(score: Optional[float]) -> str:
    if score is None:
        return "unchecked"
    return "same" if score >= SAME_AT else "minor" if score >= MINOR_AT else "different"


def not_in_code(platform: str) -> str:
    return f"Not in the {PLATFORM_WORD[platform]} code"


def similarity(sides: dict[str, Side], platforms: Iterable[str], absent: Iterable[str] = (),
               options: Optional[dict] = None, main: Optional[dict] = None,
               traced: Iterable[str] = ()) -> Optional[dict]:
    """The badge for one screen across the project's `platforms`: `{badge, label, score,
    reasons, pairs}`. Only platforms seen live are compared (code alone is no evidence of how a
    screen looks). A platform in `absent` (its code is mapped and has nothing like the screen)
    makes it `missing`; a platform the screen is not on and not known to lack it is only not
    matched yet, never a difference. One in `traced` (its code mentions the screen,
    `code_traces`) says so: there it may be part of another screen. None when the project has
    one platform (nothing to compare).

    Like with like: `options` are each platform's looks on every device and appearance it was seen
    on; each pair of platforms is compared by its closest match (`pick_pair`), and says which
    (`words`, "iPhone 17 Pro vs Pixel 9a, both light"). A pair of two kinds of device or two
    appearances gets no score: it says why instead (`unfair_words`), never "different"."""
    wanted = [p for p in PLATFORMS if p in set(platforms)]
    if len(wanted) < 2:
        return None
    have = [p for p in wanted if p in sides]
    gone = [p for p in wanted if p not in sides and p in set(absent)]
    unknown = [p for p in wanted if p not in sides and p not in set(absent)]
    seen = [p for p in have if sides[p].seen]
    pairs: list[dict] = []
    # Sides with no picture (their capture was blank): compared by their words, and said once.
    notes: list[str] = []
    for i, p in enumerate(have):
        for q in have[i + 1:]:
            both = p in seen and q in seen
            xs, ys = (options or {}).get(p) or [sides[p]], (options or {}).get(q) or [sides[q]]
            a, b, match = pick_pair(xs, ys, main) if both else (sides[p], sides[q], match_of(sides[p], sides[q]))
            ok = fair(a, b, match)
            if both and ok:
                c = compare(a, b)
                if match == "setting":
                    # The same setting, yet one app drew itself the other way: that is the app's,
                    # a difference a person notices, so never "same".
                    odd = a if a.appearance != a.set_appearance else b
                    c["reasons"].append(f"{PLATFORM_WORD[odd.platform]} shows it in {odd.appearance} though the device was set to {odd.set_appearance}")
                    if c["score"] is not None and c["score"] >= SAME_AT:
                        c["score"] = SAME_AT - 0.01
                if "web" not in (a.platform, b.platform):
                    # A blank capture has no fingerprint, so `compare` read only the words: said
                    # after the pair's own reasons, never a difference of its own.
                    for s in (a, b):
                        why = blank_of(s)
                        if why:
                            note = f"{blank_words(s.platform, why)}, so Orcha compares the words only"
                            c["reasons"].append(note)
                            notes += [note] if note not in notes else []
            elif both:
                c = {"score": None, "reasons": [unfair_words(a, b, xs, ys)]}
            else:
                c = {"score": None, "reasons": []}
            pairs.append({"a": p, "b": q, "score": c["score"], "badge": badge_for(c["score"]), "reasons": c["reasons"],
                          "match": match, "fair": ok, "words": pair_words(a, b) if both else None,
                          "looks": {"a": side_json(a), "b": side_json(b)} if both else None})
    # iOS beside Android is what the atlas is for; a phone beside the web counts after it.
    pairs.sort(key=lambda x: (0 if "web" not in (x["a"], x["b"]) else 1))
    scored = [x for x in pairs if x["score"] is not None]
    worst = min(scored, key=lambda x: x["score"], default=None)
    # Platforms that read the same are one side ("iOS and Web say ..."), so a difference is said once.
    same_as = {p: [p] for p in have}
    for x in pairs:
        if x["badge"] == "same" and same_as[x["a"]] is not same_as[x["b"]]:
            merged = sorted(same_as[x["a"]] + same_as[x["b"]], key=PLATFORMS.index)
            for p in merged:
                same_as[p] = merged
    reasons = [not_in_code(p) for p in gone]
    told: set[tuple[str, ...]] = set()
    for x in pairs:
        ga, gb = same_as[x["a"]], same_as[x["b"]]
        pair_key = tuple(sorted((ga[0], gb[0])))
        if ga is gb or pair_key in told or x["score"] is None:
            continue
        told.add(pair_key)
        # Said once for platforms that read the same ("iOS and Web say ..."), only when the two
        # standing for them compare like with like; else this pair's own words.
        lead = next((y for y in pairs if {y["a"], y["b"]} == {ga[0], gb[0]}), None)
        merged = (len(ga) > 1 or len(gb) > 1) and lead is not None and lead["fair"] and lead["score"] is not None
        said = compare(sides[ga[0]], sides[gb[0]], _names(ga), _names(gb))["reasons"] if merged else x["reasons"]
        reasons += [r for r in said if r not in reasons]
    if gone:
        badge = "missing"
    elif worst is not None:
        badge = badge_for(worst["score"])
    elif unknown and len(have) == 1:
        badge = "unmatched"
    else:
        badge = "unchecked"
    if worst is not None and badge_for(worst["score"]) == "same":
        compared = [p for p in seen if any(p in (x["a"], x["b"]) for x in scored)]
        # With no picture on a side, only the words were seen to match.
        same = "Reads the same" if notes else "Looks and reads the same"
        reasons = [r for r in reasons if r.startswith("Not in the ")] + [f"{same} on {_names(compared)}"]
    reasons = [r for r in reasons if r not in notes]
    # Seen on both, but never like with like: say so, never call them different.
    reasons += [x["reasons"][0] for x in pairs if x["a"] in seen and x["b"] in seen and not x["fair"] and x["reasons"]]
    gated = [p for p in have if p not in seen and sides[p].signin_only]
    unseen = [p for p in have if p not in seen and p not in gated]
    if gated:
        reasons.append(f"Seen on {_names(gated)} only behind its sign-in, so Orcha cannot compare it there")
    if not seen and len(have) > 1 and not gated:
        reasons.append("Not seen live yet, so there is nothing to compare")
    elif unseen:
        reasons.append(f"Not seen on {_names(unseen)} yet, so Orcha cannot compare it there")
    hinted = [p for p in unknown if p in set(traced)]
    plain = [p for p in unknown if p not in hinted]
    for p in hinted:
        # Its code names something like it: the screen may sit inside another one there.
        word = PLATFORM_WORD[p]
        reasons.append(f"No {word} match found. The {word} code mentions it, so it may be part of another {word} screen")
    if plain:
        only = f"Found on {_names(have)} only so far: " if badge == "unmatched" else ""
        reasons.append(f"{only}Orcha has not matched it on {_names(plain)} yet")
    # Why a side had no picture is never cut off by the others.
    return {"badge": badge, "label": BADGE_WORD[badge], "score": worst["score"] if worst else None,
            "reasons": reasons[:6 - len(notes)] + notes, "pairs": pairs}


# ---------------------------------------------------------------- what changed

def session_builds(cur, cid: str) -> list[dict]:
    """The builds sessions ran on, newest first, as `{id, label, at, made_at}`. `at` is when the
    last session on it ended: "since build 1.4.0" compares with what that build showed, so a look
    first seen in a session on that build is part of it, not a change."""
    cur.execute("""SELECT build_label, started_at, ended_at FROM qa_sessions
                    WHERE container_id=%s AND build_label IS NOT NULL ORDER BY started_at DESC LIMIT 2000""", (cid,))
    ended: dict[str, datetime] = {}
    made: dict[str, datetime] = {}
    for r in cur.fetchall():
        label, start = str(r["build_label"]), _parse_at(r["started_at"])
        end = _parse_at(r["ended_at"]) or (start + timedelta(hours=RUN_HOURS) if start else None)
        if start and (label not in made or start < made[label]):
            made[label] = start
        if end and (label not in ended or end > ended[label]):
            ended[label] = end
    order = sorted(ended, key=lambda b: ended[b], reverse=True)[:BUILDS_SHOWN]
    return [{"id": b, "label": b, "at": _iso(ended[b]), "made_at": _iso(made[b]) if b in made else None} for b in order]


def resolve_since(value: Optional[str], builds: list[dict], now: datetime) -> dict:
    """`?since=` as `{value, kind, label, at, default}`: a build (its id or label), a date, or by
    default the last week."""
    text = str(value or "").strip()
    if text:
        for b in builds:
            if text in (b["id"], b["label"]) and _parse_at(b.get("at")):
                return {"value": b["id"], "kind": "build", "label": f"build {b['label']}", "at": _iso(_parse_at(b["at"])), "default": False}
    at = _parse_at(text) if text else None
    if at is not None:
        return {"value": text, "kind": "date", "label": f"{at.day} {MONTHS[at.month - 1]} {at.year}", "at": _iso(at), "default": False}
    return {"value": None, "kind": "date", "label": f"the last {RECENT_DAYS} days",
            "at": _iso(now - timedelta(days=RECENT_DAYS)), "default": True}


def _change_words(before: dict, after: dict) -> list[str]:
    """What changed between two looks of one screen on one platform, in plain words."""
    bt, at = comparable(before.get("texts") or []), comparable(after.get("texts") or [])
    nb, na = [n for n, _ in bt], [n for n, _ in at]
    written = dict(bt + at)
    gone = [n for n in nb if n not in set(na)]
    new = [n for n in na if n not in set(nb)]
    out: list[str] = []
    used: set[str] = set()
    for x in new:
        best = max(gone, key=lambda y: _dice(_tokens(x), _tokens(y)), default=None)
        if best is not None and best not in used and _dice(_tokens(x), _tokens(best)) >= 0.5:
            used |= {x, best}
            out.append(f"Now says {_quote(written[x])} instead of {_quote(written[best])}")
    added = [x for x in new if x not in used]
    removed = [y for y in gone if y not in used]
    if added:
        out.append("New: " + ", ".join(_quote(written[x], 30) for x in added[:3]) + (f" and {len(added) - 3} more" if len(added) > 3 else ""))
    if removed:
        out.append("Gone: " + ", ".join(_quote(written[y], 30) for y in removed[:3]) + (f" and {len(removed) - 3} more" if len(removed) > 3 else ""))
    return out or ([] if before.get("blank") or after.get("blank") else ["It looks different"])


def change_of(looks: list[dict], cutoff: str, alike: Optional[list[dict]] = None) -> Optional[dict]:
    """One platform's change since `cutoff`: the look current then and the newest one, when they
    differ; `new` when the screen was first seen after it. With `alike` (the looks of one device
    kind and appearance), the before and after are both from those."""
    if not looks:
        return None
    pool = alike if alike else looks
    main = [lk for lk in pool if lk.get("state") == "loaded"] or pool
    after = max(main, key=lambda lk: str(lk.get("last_seen_at") or ""))
    if str(after.get("first_seen_at") or "") <= cutoff:
        return None
    earlier = [lk for lk in main if str(lk.get("first_seen_at") or "") <= cutoff and lk["id"] != after["id"]]
    if not earlier:
        if any(str(lk.get("first_seen_at") or "") <= cutoff for lk in looks):
            return None
        return {"kind": "new", "after": after, "before": None, "what": ["First seen since then"]}
    before = max(earlier, key=lambda lk: str(lk.get("first_seen_at") or ""))
    what = _change_words(before, after)
    return {"kind": "changed", "after": after, "before": before, "what": what} if what else None


def _look_json(lk: Optional[dict]) -> Optional[dict]:
    if not lk:
        return None
    return {"frame_url": _frame_url(lk.get("frame_id")), "at": lk.get("last_seen_at"), "first_at": lk.get("first_seen_at"),
            "build": lk.get("build_label"), "run_id": lk.get("run_id"), "state": lk.get("state"), "blank": lk.get("blank")}


# ---------------------------------------------------------------- the storyboard order

def area_summary(summary: Any) -> Optional[str]:
    """An area's summary for its row, unless it is only a count of screens the row says better."""
    text = " ".join(str(summary or "").split())
    return None if not text or _COUNTED.match(text) else text


def storyboard_order(ids: list[str], nav: dict[str, list[str]], inbound_outside: Counter, names: dict[str, str],
                     routes: dict[str, Optional[str]]) -> list[str]:
    """An area's screens in the order a person walks them: from its way in (the home route, else
    the screen other areas lead to most, else the one that leads furthest), breadth first along
    its navigation, then the rest by name."""
    if not ids:
        return []
    mine = set(ids)
    inbound = Counter(t for s in ids for t in nav.get(s, []) if t in mine and t != s)

    def entry_key(i: str) -> tuple:
        return (-int(routes.get(i) == "/"), -inbound_outside.get(i, 0), inbound.get(i, 0),
                -len([t for t in nav.get(i, []) if t in mine]), names.get(i, ""))

    out: list[str] = []
    left = sorted(ids, key=entry_key)
    while left:
        queue = deque([left[0]])
        placed = {left[0]}
        while queue:
            cur = queue.popleft()
            out.append(cur)
            for nxt in sorted((t for t in nav.get(cur, []) if t in mine and t not in placed and t not in out), key=lambda t: names.get(t, "")):
                placed.add(nxt)
                queue.append(nxt)
        left = [i for i in left if i not in out]
        left.sort(key=lambda i: (-inbound.get(i, 0), names.get(i, "")))
    return out


def area_order(area_ids: dict[Optional[str], list[str]], flows: list[dict], by_id: dict[str, dict],
               listed: list[str]) -> list[Optional[str]]:
    """The storyboard's rows: from the area that holds the app's way in, along the navigation
    between areas, the biggest first where nothing decides; screens no area claims last."""
    keys = [k for k in area_ids if k is not None]
    if not keys:
        return [None] if None in area_ids else []
    rank = {k: i for i, k in enumerate(listed)}
    links: dict[str, Counter] = {}
    for f in flows:
        a, b = by_id[f["from"]]["area"], by_id[f["to"]]["area"]
        if a and b and a != b:
            links.setdefault(a, Counter())[b] += max(1, int(f["count"] or 0))
    size = {k: len(area_ids[k]) for k in keys}
    home = next((by_id[i]["area"] for k in keys for i in area_ids[k] if by_id[i]["route"] == "/"), None)

    def tie(k: str) -> tuple:
        return (-size[k], rank.get(k, len(rank)), k)

    out: list[Optional[str]] = []
    left = sorted(keys, key=tie)
    while left:
        start = home if home in left else max(left, key=lambda k: (sum((links.get(k) or Counter()).values()), size[k], -rank.get(k, len(rank))))
        queue = deque([start])
        while queue:
            cur = queue.popleft()
            if cur in out:
                continue
            out.append(cur)
            queue.extend(sorted((k for k in (links.get(cur) or {}) if k not in out and k in left), key=lambda k: (-links[cur][k], *tie(k))))
        left = [k for k in left if k not in out]
    if None in area_ids:
        out.append(None)
    return out


# ---------------------------------------------------------------- the atlas

def _slot(lk: dict) -> tuple:
    return lk.get("device_kind"), lk.get("appearance")


def usual_devices(looks: list[dict]) -> dict[str, tuple]:
    """Each platform's usual device kind and appearance: what most of its looks with a frame were
    taken on, so a screen is shown and paired on it first."""
    kinds: dict[str, Counter] = {}
    shades: dict[str, Counter] = {}
    for lk in looks:
        if not lk.get("frame_id") or lk.get("state") == SIGNIN:
            continue
        p = str(lk["platform"])
        if lk.get("device_kind"):
            kinds.setdefault(p, Counter())[str(lk["device_kind"])] += 1
        if lk.get("appearance"):
            shades.setdefault(p, Counter())[str(lk["appearance"])] += 1
    out: dict[str, tuple] = {}
    for p in set(kinds) | set(shades):
        k, s = kinds.get(p), shades.get(p)
        out[p] = (k.most_common(1)[0][0] if k else None, max(s, key=lambda a: (s[a], a == "light")) if s else None)
    return out


def coverage_of(items: list[dict]) -> list[dict]:
    """Which device kinds and appearances the atlas has seen each platform on, phones first."""
    seen: dict[str, dict[str, set]] = {}
    for it in items:
        for s in it.get("seen_on") or []:
            if not s.get("form") or not s.get("frame_url"):
                continue
            shade = seen.setdefault(str(s["form"]), {}).setdefault(str(s["platform"]), set())
            if s.get("appearance"):
                shade.add(str(s["appearance"]))
    return [{"form": f, "platforms": {p: [a for a in APPEARANCES if a in seen[f][p]] for p in PLATFORMS if p in seen[f]}}
            for f in ("phone", "tablet", "desktop") if f in seen]


def platform_devices(items: list[dict], platforms: list[str], latest: dict[str, str]) -> dict[str, dict]:
    """The frame each platform's column is drawn with: the kind most of its looks were taken on;
    a platform with no look yet, its newest session's device."""
    out: dict[str, dict] = {}
    for p in platforms:
        kinds: Counter = Counter()
        for it in items:
            v = it["variants"].get(p)
            dev = v.get("device") if v else None
            if dev and v.get("frame_url"):
                kinds[(dev["kind"], dev["landscape"] and dev["kind"] == "tablet")] += 1
        if kinds:
            (kind, landscape), _ = kinds.most_common(1)[0]
        else:
            kind, landscape = device_of(p, latest.get(p), None)["kind"], False
        out[p] = {"kind": kind, "landscape": landscape}
    return out


def refresh_info(cur, cid: str, looks: list[dict], nodes: dict[tuple, str], now: datetime) -> dict:
    """How the newest map session is going. While it runs, `targets` are the map nodes its queue
    aims at, `shots` the ones it has seen, `platform` the one it maps on and `depth` its focus, so
    the page can show which frames are being captured."""
    cur.execute("""SELECT id, platform, status, started_at, last_seen_at, crawl_queue FROM qa_sessions
                    WHERE container_id=%s AND kind='map' ORDER BY started_at DESC LIMIT 1""", (cid,))
    row = qs.public(cur.fetchone())
    out: dict[str, Any] = {"minutes": PASS_MINUTES["overview"], "fill_minutes": PASS_MINUTES["deeper"], "fill_most": MAX_DEEPER,
                           "state": "idle", "note": None, "targets": [], "shots": [], "platform": None, "depth": None}
    if not row:
        return out
    if row["status"] == "running":
        heard = _parse_at(row.get("last_seen_at") or row.get("started_at"))
        if heard is None or now - heard <= timedelta(minutes=STALE_MINUTES):
            word = PLATFORM_WORD.get(str(row["platform"]), "a device")
            sid = str(row["id"])
            shots = [nodes.get((lk["platform"], lk["screen_key"])) for lk in looks if lk.get("run_id") == sid]
            queue = row.get("crawl_queue") if isinstance(row.get("crawl_queue"), dict) else {}
            aimed = [nodes.get((row["platform"], t.get("key"))) for t in queue.get("targets") or [] if isinstance(t, dict)]
            out.update(state="running", note=f"Mapping the app on {word}", platform=row["platform"], depth=queue.get("focus"),
                       targets=list(dict.fromkeys(a for a in aimed if a)), shots=list(dict.fromkeys(s for s in shots if s)))
        return out
    out["state"] = {"done": "done", "failed": "failed"}.get(str(row["status"]), "skipped")
    return out


def read_atlas(cur, cid: str, since: Optional[str] = None, now: Optional[datetime] = None) -> dict:
    """The container's atlas, in the shape the page's `parseAtlas` reads."""
    now = now or qs.now()
    cur.execute("SELECT name FROM containers WHERE id=%s", (cid,))
    container = cur.fetchone()
    cur.execute("SELECT platform, app_name FROM qa_targets WHERE container_id=%s", (cid,))
    targets = [dict(r) for r in cur.fetchall()]
    cur.execute("SELECT key, name, summary FROM qa_features WHERE container_id=%s ORDER BY name", (cid,))
    feats = {str(r["key"]): dict(r) for r in cur.fetchall()}
    cur.execute("SELECT * FROM qa_map_nodes WHERE container_id=%s AND kind IN ('screen', 'flow') ORDER BY key, platform", (cid,))
    rows = [qs.public(r) for r in cur.fetchall()]
    screens = [n for n in rows if n["kind"] == "screen"]
    node_by_id = {str(n["id"]): n for n in rows}
    cur.execute("SELECT * FROM qa_map_edges WHERE container_id=%s AND kind IN ('navigates', 'steps') ORDER BY label", (cid,))
    edges = [qs.public(r) for r in cur.fetchall()]

    looks = looks_of(read_steps(cur, cid))
    usual = usual_devices(looks)
    platforms = [p for p in PLATFORMS if p in {t["platform"] for t in targets} | {n["platform"] for n in screens} | {lk["platform"] for lk in looks}]
    by_key_plat: dict[tuple, list[dict]] = {}
    for lk in looks:
        by_key_plat.setdefault((lk["screen_key"], lk["platform"]), []).append(lk)
    # A platform whose code was mapped: a screen known from code that is not there is absent.
    mapped = {n["platform"] for n in screens if "code" in (n.get("sources") or [])}
    builds = session_builds(cur, cid)
    since_info = resolve_since(since, builds, now)
    cutoff = since_info["at"]

    gid_of: dict[str, str] = {}
    items: list[dict] = []
    for g in cluster(screens):
        lead = g.lead
        gid = str(lead["id"])
        for n in g.nodes:
            gid_of[str(n["id"])] = gid
        variants: dict[str, dict] = {}
        sides: dict[str, Side] = {}
        gated: dict[str, bool] = {}
        states: dict[str, dict] = {}
        changes: list[dict] = []
        options: dict[str, list[Side]] = {}
        mine_of: dict[str, list[dict]] = {}
        seen_on: list[dict] = []
        last_at: Optional[str] = None
        last_build: Optional[str] = None
        ordered = sorted(g.platforms.items(), key=lambda kv: PLATFORMS.index(kv[0]))
        for p, n in ordered:
            mine = sorted(by_key_plat.get((n["key"], p), []), key=lambda lk: str(lk.get("last_seen_at") or ""))
            mine_of[p] = mine
            open_looks = [lk for lk in mine if lk.get("state") != SIGNIN]
            if mine and not open_looks:
                gated[p] = True
            seen = bool(mine) or n["state"] == "seen"
            code = (n.get("detail") or {}).get("code") if isinstance((n.get("detail") or {}).get("code"), dict) else {}
            # Unseen, a platform speaks through its code.
            spoken = [str(t) for t in code.get("texts") or []]
            actions = [str(t) for t in code.get("actions") or []]
            by_slot: dict[tuple, list[dict]] = {}
            for lk in open_looks or mine:
                by_slot.setdefault(_slot(lk), []).append(lk)
            opts = []
            for slot_looks in by_slot.values():
                pool = [lk for lk in slot_looks if lk.get("state") == "loaded"] or slot_looks
                newest = ([lk for lk in pool if lk.get("frame_id")] or pool)[-1]
                opts.append(Side(p, list(newest.get("texts") or []) or spoken, newest.get("fingerprint"),
                                 list(newest.get("actions") or []) or actions, seen, form=newest.get("device_kind"),
                                 appearance=newest.get("appearance"), set_appearance=newest.get("device_appearance"),
                                 device=newest.get("device_name"), look=newest))
                if (newest.get("frame_id") or newest.get("blank")) and p not in gated:
                    seen_on.append(seen_json(newest, p))
            options[p] = opts or [Side(p, spoken, None, actions, seen)]
            for lk in mine:
                st = states.setdefault(str(lk["state"]), {"state": lk["state"], "label": state_label(str(lk["state"])), "platforms": [],
                                                          "frame_url": None, "at": None, "device_name": None, "w": None, "h": None, "blank": None})
                if p not in st["platforms"]:
                    st["platforms"].append(p)
                if (bool(lk.get("frame_id")), str(lk.get("last_seen_at") or "")) >= (bool(st["frame_url"]), str(st["at"] or "")):
                    st.update(at=lk.get("last_seen_at"), frame_url=_frame_url(lk.get("frame_id")), blank=lk.get("blank"),
                              device_name=lk.get("device_name"), w=lk.get("screen_w"), h=lk.get("screen_h"))
        # Like with like: each platform is shown by the look its closest pair compares, iOS and
        # Android first; a platform with no pair by its usual device and appearance.
        chosen: dict[str, Side] = {}
        order = [(p, q) for i, p in enumerate(PLATFORMS) for q in PLATFORMS[i + 1:] if p in options and q in options]
        order.sort(key=lambda pq: "web" in pq)
        for want_fair in (True, False):
            for p, q in order:
                if not (options[p][0].seen and options[q][0].seen and options[p][0].look and options[q][0].look):
                    continue
                x, y, match = pick_pair(options[p], options[q], usual)
                if fair(x, y, match) or not want_fair:
                    chosen.setdefault(p, x)
                    chosen.setdefault(q, y)
        for p, opts in options.items():
            chosen.setdefault(p, pick_side(opts, usual.get(p)))
        for p, n in ordered:
            side, mine = chosen[p], mine_of[p]
            newest = side.look
            frame = newest.get("frame_id") if newest else None
            blank = newest.get("blank") if newest else None
            # The map's own frame stands in only when no look was kept.
            if frame is None and not mine and n.get("frame_id"):
                frame = str(n["frame_id"])
            seen = side.seen
            at = newest.get("last_seen_at") if newest else (_when(n.get("last_seen_at")) or None if seen else None)
            sides[p] = side
            alike = [lk for lk in mine if newest is not None and _slot(lk) == _slot(newest)]
            ch = change_of(mine, cutoff, alike)
            if ch:
                changes.append({"platform": p, "kind": ch["kind"], "what": ch["what"], "before": _look_json(ch["before"]), "after": _look_json(ch["after"])})
            newest_any = str(mine[-1].get("last_seen_at") or "") if mine else None
            for when in (newest_any, at):
                if when and str(when) > str(last_at or ""):
                    last_at = str(when)
                    last_build = (mine[-1].get("build_label") if mine else None) or last_build
            size = (int(newest["screen_w"]), int(newest["screen_h"])) if newest and newest.get("screen_w") and newest.get("screen_h") else None
            device = device_of(p, side.device, size)
            if newest and newest.get("device_kind") and p != "web":
                device["kind"] = str(newest["device_kind"])
            form = side.form or ((device["kind"] if device["kind"] in FORM_WORD else "desktop") if frame else None)
            device.update({"name": side.device, "form": form, "appearance": side.appearance, "set_appearance": side.set_appearance,
                           "orientation": (newest or {}).get("orientation")})
            variants[p] = {"platform": p, "node": str(n["id"]), "seen": seen, "frame_url": _frame_url(frame), "last_seen_at": at,
                           "build": (newest or {}).get("build_label"), "run_id": (newest or {}).get("run_id"), "route": node_route(n), "looks": len(mine),
                           "device": device, "blank": None if frame else blank}
        # A platform seen only behind a sign-in form beside one seen open is not compared: its
        # look is the sign-in, not this screen.
        if gated and any(p not in gated and sides[p].seen for p in sides):
            for p in gated:
                sides[p].seen, sides[p].signin_only = False, True
                variants[p]["signin_only"] = True
        code_backed = any("code" in (n.get("sources") or []) for n in g.nodes)
        absent = {p for p in platforms if p not in variants and p in mapped and code_backed}
        presence = {p: ("seen" if variants[p]["seen"] else "unseen") if p in variants else "absent" if p in absent else "unknown"
                    for p in platforms}
        sim = similarity(sides, platforms, absent, options, usual)
        route = next((v["route"] for v in variants.values() if v.get("route")), None)
        code_parts = [(n.get("detail") or {}).get("code") for n in g.nodes]
        code_texts = next((list(c.get("texts") or []) for c in code_parts if isinstance(c, dict) and c.get("texts")), [])
        ids = {str(n["id"]) for n in g.nodes}
        flows = sorted({str(node_by_id[str(e["from_node_id"])].get("label")) for e in edges
                        if e["kind"] == "steps" and str(e["to_node_id"]) in ids and str(e["from_node_id"]) in node_by_id})
        items.append({
            "id": gid, "name": display_text(lead.get("label") or "") or str(lead.get("label") or lead["key"]),
            "area": lead.get("feature_key") or next((n.get("feature_key") for n in g.nodes if n.get("feature_key")), None),
            "route": route, "nodes": [str(n["id"]) for n in g.nodes], "matched_by": g.matched_by,
            "platforms": [p for p in PLATFORMS if p in variants], "variants": variants, "presence": presence, "similarity": sim,
            "states": sorted(states.values(), key=lambda s: (s["state"] != "loaded", s["label"])),
            "last_seen_at": last_at, "last_build": last_build, "never_seen": not any(v["seen"] for v in variants.values()),
            "code_only": all(set(n.get("sources") or []) <= {"code", "tests"} for n in g.nodes),
            "code_texts": display_texts(code_texts)[:8], "flows": flows[:12], "from": [], "to": [], "seen_on": seen_on,
            "change": {"platforms": changes, "kind": "new" if changes and all(c["kind"] == "new" for c in changes) else "changed"} if changes else None,
            "blocked_reason": next((n.get("blocked_reason") for n in g.nodes if n.get("blocked_reason")), None),
        })

    # The flow between screens: one arrow per pair, labelled with the busiest move.
    by_id = {it["id"]: it for it in items}
    pair: dict[tuple, dict] = {}
    for e in edges:
        if e["kind"] != "navigates":
            continue
        a, b = gid_of.get(str(e["from_node_id"])), gid_of.get(str(e["to_node_id"]))
        if not a or not b or a == b:
            continue
        cur_pair = pair.setdefault((a, b), {"from": a, "to": b, "label": e.get("label") or "", "count": 0, "seen": False, "_best": -1})
        cur_pair["count"] += int(e.get("count") or 0)
        cur_pair["seen"] = cur_pair["seen"] or "live" in (e.get("sources") or [])
        if int(e.get("count") or 0) > cur_pair["_best"]:
            cur_pair["_best"], cur_pair["label"] = int(e.get("count") or 0), e.get("label") or ""
    flows_out = []
    for f in sorted(pair.values(), key=lambda f: (-f["count"], f["from"], f["to"])):
        f.pop("_best", None)
        flows_out.append(f)
        by_id[f["from"]]["to"].append({"id": f["to"], "label": f["label"]})
        by_id[f["to"]]["from"].append({"id": f["from"], "label": f["label"]})
    for it in items:
        it["from"], it["to"] = it["from"][:8], it["to"][:8]

    # Areas as rows, each in walking order.
    nav: dict[str, list[str]] = {}
    for f in flows_out:
        nav.setdefault(f["from"], []).append(f["to"])
    outside = Counter(f["to"] for f in flows_out if by_id[f["from"]]["area"] != by_id[f["to"]]["area"])
    names = {it["id"]: it["name"].lower() for it in items}
    routes = {it["id"]: it["route"] for it in items}
    area_ids: dict[Optional[str], list[str]] = {}
    for it in items:
        area_ids.setdefault(it["area"], []).append(it["id"])
    areas = []
    for k in area_order(area_ids, flows_out, by_id, list(feats)):
        f = feats.get(k or "") or {}
        ids = storyboard_order(area_ids[k], nav, outside, names, routes)
        areas.append({"key": k or "other", "name": f.get("name") or (qa_map.humanize(k) if k else "Other screens"),
                      "summary": area_summary(f.get("summary")), "screens": ids,
                      "differs": sum(1 for i in ids if (by_id[i]["similarity"] or {}).get("badge") in ("minor", "different", "missing")),
                      "seen": sum(1 for i in ids if not by_id[i]["never_seen"])})
        for i in ids:
            by_id[i]["area"] = k or "other"
    ordered_items = [by_id[i] for a in areas for i in a["screens"]]

    cur.execute("""SELECT platform, device_name FROM qa_sessions
                    WHERE container_id=%s AND device_name IS NOT NULL ORDER BY started_at DESC LIMIT 200""", (cid,))
    latest: dict[str, str] = {}
    for r in cur.fetchall():
        latest.setdefault(str(r["platform"]), str(r["device_name"]))
    node_of = {(n["platform"], n["key"]): str(n["id"]) for n in screens}
    badges = Counter((it["similarity"] or {}).get("badge") for it in ordered_items)
    # A name a person gave the app, else the project's: a name the code scan found says what the
    # repository was once called, not what this project is.
    cur.execute("SELECT found FROM qa_onboarding WHERE container_id=%s", (cid,))
    found = qs._json((cur.fetchone() or {}).get("found"), {}) or {}
    scanned = {str(p.get("name")) for p in found.get("platforms") or [] if p.get("name")}
    app_name = next((t["app_name"] for t in targets if t.get("app_name") and t["app_name"] not in scanned), None)
    matched = Counter(it["matched_by"] for it in ordered_items if it["matched_by"])
    return {
        "project_id": cid, "slug": None, "name": app_name or (container["name"] if container else None), "generated_at": _iso(now),
        "platforms": platforms, "devices": platform_devices(ordered_items, platforms, latest), "coverage": coverage_of(ordered_items),
        "counts": {
            "screens": len(ordered_items), "seen": sum(1 for it in ordered_items if not it["never_seen"]),
            "never_seen": sum(1 for it in ordered_items if it["never_seen"]), "changed": sum(1 for it in ordered_items if it["change"]),
            "differs": badges["minor"] + badges["different"] + badges["missing"], "same": badges["same"],
            "minor": badges["minor"], "different": badges["different"], "missing": badges["missing"], "areas": len(areas),
            "unchecked": badges["unchecked"], "unmatched": badges["unmatched"],
            "matched": sum(1 for it in ordered_items if len(it["platforms"]) > 1), "looks": len(looks),
        },
        "matching": {"key": matched["key"], "route": matched["route"], "label": matched["label"]},
        "areas": areas, "screens": ordered_items, "flows": flows_out, "since": since_info, "builds": builds,
        "refresh": refresh_info(cur, cid, looks, node_of, now),
    }
