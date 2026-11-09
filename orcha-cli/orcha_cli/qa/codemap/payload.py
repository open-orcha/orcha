"""The code source as the body of `POST /api/containers/{cid}/qa/map/import` (docs/orcha-qa-plan.md).

`build_payload(repo, platform)` reads the repo once (`code.extract`) and keeps what runs on one
platform (`_Platforms`):

- a SwiftUI / UIKit screen is iOS's, an Android activity or Compose destination Android's, and a
  Next.js or React Router screen the web's;
- a Flutter, Expo Router or React Navigation screen runs on both phones, and an Expo / React
  Native app with `react-native-web` on the web too, unless that platform's UI is written in its
  own framework ("a Flutter screen is both phones', less one written natively");
- a fact read from a `.swift` file (or a Core Data model) is iOS's, from a `.kt` / `.java` file
  Android's, from Dart or JS/TS the platforms of the app (the nearest `package.json` or
  `pubspec.yaml`) it sits in. A JS server's routes and Prisma models are the web's; a script or
  library beside the apps is no platform's.

It is adapted from `build.code_facts` with the feature grouping of `feature_map` done on the
kept screens.

The body (every node and edge end is a node of the same body):

    {"platform": "ios", "source": "code", "replace_source": true,
     "features": [{"key", "name", "summary", "entry", "paths"}],
     "nodes": [{"kind", "key", "label", "feature_key", "state": "declared", "sources": ["code"],
                "evidence": [{"path", "line"}], "detail": {...}}],
     "edges": [{"kind", "from_kind", "from_key", "to_kind", "to_key", "label",
                "sources": ["code"], "evidence": [{"path", "line"}], "detail": {}}]}

`evidence` and `detail` are this source's part; the server keeps them under `evidence["code"]`
and `detail["code"]` beside what other sources said. A web screen's key is its route pattern
(`/listings/*`) and `detail.route` says it.

`detect_platforms(repo)` says which platforms a repo builds for, from its project files alone.
"""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from typing import Any

from orcha_cli.qa.codemap import code, keys
from orcha_cli.qa.codemap import features as fm

PLATFORMS = ("ios", "android", "web")
PHONES = ("ios", "android")
SOURCE = "code"
#: The platform a screen's framework runs on; the others (Expo, React Navigation, Flutter) run
#: where their app does.
FRAMEWORK_PLATFORM = {
    "swiftui": "ios", "uikit": "ios", "android": "android", "compose": "android",
    "next": "web", "pages": "web", "react-router": "web",
}
#: Most places an evidence list keeps, and most items a detail list keeps.
LIST_KEPT = 30
#: Most files a screen's detail lists as its code, and most ways in (deep links, shortcuts).
MAX_SCREEN_FILES = 60
MAX_SCREEN_LINKS = 8
#: Most features a payload carries (the import route takes 30; the ones with the most code stay),
#: and most paths per feature.
MAX_FEATURES = 30
MAX_PATHS = fm.MAX_PATHS
#: The longest key and label the import route takes.
MAX_KEY = 300
MAX_LABEL = 200
MAX_FEATURE_KEY = 120


# ---------- which platform ----------

#: The platforms each kind of app package (`code._package_kind`) runs its code on.
_PACKAGE_RUNS = {
    "flutter": PHONES, "react-native": PHONES, "react-native-web": (*PHONES, "web"),
    "web": ("web",), "server": ("web",),
}
_ALL = frozenset(PLATFORMS)


class _Platforms:
    """Which platforms a file's code runs on (see the module docstring), as one platform's
    payload asks it."""

    def __init__(self, facts: code.CodeFacts, platform: str):
        self.platform = platform
        self.packages = dict(facts.packages)
        #: The platforms whose UI is written in their own framework (a SwiftUI app, a Next app).
        self.own = {FRAMEWORK_PLATFORM[s.platform] for s in facts.screens if s.platform in FRAMEWORK_PLATFORM}
        self._cache: dict[str, frozenset[str]] = {}

    def of(self, rel: str) -> frozenset[str]:
        if rel not in self._cache:
            self._cache[rel] = self._of(rel)
        return self._cache[rel]

    def _of(self, rel: str) -> frozenset[str]:
        if rel.endswith((".swift", "/contents")):
            return frozenset({"ios"})
        if rel.endswith((".kt", ".java")):
            return frozenset({"android"})
        if rel.endswith(".prisma"):
            return frozenset({"web"})
        if not rel.endswith((".dart", *code.JS_EXT)):
            return _ALL  # SQL migrations, manifests: what the readers keyed already
        folder = rel.rsplit("/", 1)[0] if "/" in rel else ""
        while True:
            kind = self.packages.get(folder)
            if kind is not None:
                if (kind == "flutter") != rel.endswith(".dart"):
                    return frozenset()
                runs = _PACKAGE_RUNS.get(kind, ())
                if kind in ("web", "server"):
                    return frozenset(runs)
                # A cross-platform app gives way where that platform's UI is written natively.
                return frozenset(p for p in runs if p not in self.own)
            if not folder:
                return frozenset()
            folder = folder.rsplit("/", 1)[0] if "/" in folder else ""

    def keeps(self, rel: str) -> bool:
        return self.platform in self.of(rel)

    def keeps_screen(self, s: code.CodeScreen) -> bool:
        own = FRAMEWORK_PLATFORM.get(s.platform)
        if own is not None:
            return own == self.platform
        return self.keeps(s.path)


# ---------- one source's facts, folded ----------


def _union(old: list[Any], new: list[Any], limit: int = LIST_KEPT) -> list[Any]:
    out = list(old)
    seen = {json.dumps(x, sort_keys=True, default=str) for x in out}
    for x in new:
        k = json.dumps(x, sort_keys=True, default=str)
        if k not in seen:
            seen.add(k)
            out.append(x)
    return out[:limit]


#: Detail keys whose newest value replaces the old one instead of joining it.
_REPLACED = frozenset({"fields", "route", "platform", "side", "handler", "store", "name", "entry", "method", "pattern"})


def _combine_detail(old: dict[str, Any], new: dict[str, Any]) -> dict[str, Any]:
    out = dict(old)
    for k, v in new.items():
        if v is None:
            continue
        cur = out.get(k)
        if k in _REPLACED or cur is None:
            out[k] = v
        elif isinstance(cur, list) and isinstance(v, list):
            out[k] = _union(cur, v)
        else:
            out[k] = v
    return out


class _Facts:
    """Nodes and edges by identity; a node or edge added twice is one, its places joined."""

    def __init__(self) -> None:
        self.nodes: dict[tuple[str, str], dict[str, Any]] = {}
        self.edges: dict[tuple[str, tuple[str, str], tuple[str, str], str], dict[str, Any]] = {}

    def node(self, kind: str, key: str, place: dict[str, Any] | None, label: str | None = None, **detail: Any) -> dict[str, Any] | None:
        if not key or len(key) > MAX_KEY:
            return None
        detail = {k: v for k, v in detail.items() if v is not None}
        have = self.nodes.get((kind, key))
        if have is None:
            have = {
                "kind": kind, "key": key, "label": (label or key)[:MAX_KEY], "feature_key": None, "state": "declared",
                "sources": [SOURCE], "evidence": [], "detail": {},
            }
            self.nodes[(kind, key)] = have
        if place:
            have["evidence"] = _union(have["evidence"], [place])
        have["detail"] = _combine_detail(have["detail"], detail)
        return have

    def edge(self, kind: str, src: tuple[str, str], dst: tuple[str, str], label: str, place: dict[str, Any] | None) -> None:
        if src not in self.nodes or dst not in self.nodes or src == dst:
            return
        label = " ".join(str(label or "").split())[:MAX_LABEL]
        ident = (kind, src, dst, label)
        have = self.edges.get(ident)
        if have is None:
            have = {
                "kind": kind, "from_kind": src[0], "from_key": src[1], "to_kind": dst[0], "to_key": dst[1],
                "label": label, "sources": [SOURCE], "evidence": [], "detail": {},
            }
            self.edges[ident] = have
        if place:
            have["evidence"] = _union(have["evidence"], [place])


def _place(path: str, line: int) -> dict[str, Any]:
    return {"path": path, "line": int(line or 1)}


# ---------- screens and features ----------


def _platform_screens(facts: code.CodeFacts, phones: _Platforms) -> tuple[list[code.CodeScreen], set[int]]:
    """One screen per key that runs on the platform (its own phone's declaration first), and the
    ids of the kept ones that are a twin (their texts were read for the other phone's)."""
    twins = {id(t) for t in facts.twins}
    by_key: dict[str, code.CodeScreen] = {}
    for s in facts.screens:
        if not phones.keeps_screen(s):
            continue
        phone = FRAMEWORK_PLATFORM.get(s.platform)
        have = by_key.get(s.key)
        if have is None or (FRAMEWORK_PLATFORM.get(have.platform) != phones.platform and phone == phones.platform):
            by_key[s.key] = s
    kept = sorted(by_key.values(), key=lambda s: (s.path, s.line, s.key))
    return kept, {id(s) for s in kept if id(s) in twins}


def _features(screens: list[code.CodeScreen]) -> tuple[list[dict[str, Any]], dict[str, str | None]]:
    """The features the screens make (`features._group`'s rules on the code screens: a state or
    chrome screen is no feature, keys that differ only in their separators are one), and each
    screen key's feature key (None when it is in none)."""
    groups: dict[str, list[code.CodeScreen]] = {}
    by_compact: dict[str, str] = {}
    of_screen: dict[str, str | None] = {}
    for s in screens:
        k = s.feature_key
        if not k or fm.is_non_feature(k) or len(k) > MAX_FEATURE_KEY:
            of_screen[s.key] = None
            continue
        k = by_compact.setdefault(fm.compact_key(k), k)
        groups.setdefault(k, []).append(s)
        of_screen[s.key] = k
    out = []
    for key, members in groups.items():
        stem = key.rstrip("s").replace("-", "")

        def rank(s: code.CodeScreen) -> tuple[Any, ...]:
            text = s.route or s.entry or s.name
            return ("*" in text or "{" in text or "[" in text, fm.PLATFORM_RANK.get(s.platform, 9),
                    stem not in text.lower().replace("-", ""), len(text), text)

        entry = min(members, key=rank)
        names = list(dict.fromkeys(_screen_label(s) for s in members))
        n = len(members)
        summary = f"{n} screen{'s' if n != 1 else ''}" + (f": {', '.join(names[:6])}" if n > 1 else "")
        paths = sorted({s.path for s in members if s.path})[:MAX_PATHS]
        out.append({"key": key, "name": fm.feature_name(key), "summary": summary, "entry": entry.route or entry.entry or entry.name, "paths": paths})
    out.sort(key=lambda f: (-len(f["paths"]), f["key"]))
    out = out[:MAX_FEATURES]
    kept = {f["key"] for f in out}
    out.sort(key=lambda f: (f["key"] != "home", f["name"].lower(), f["key"]))
    return out, {k: (v if v in kept else None) for k, v in of_screen.items()}


def _screen_label(s: code.CodeScreen) -> str:
    return code.route_name(s.route) if s.route and s.key.startswith("/") else keys.humanize(s.name)


# ---------- the payload ----------


def payload_from_facts(facts: code.CodeFacts, platform: str) -> dict[str, Any]:
    """The import body for `platform` from facts already read (see the module docstring)."""
    if platform not in PLATFORMS:
        raise ValueError(f"platform must be one of {', '.join(PLATFORMS)}, not {platform!r}")
    out = _Facts()
    phones = _Platforms(facts, platform)
    screens, twin_ids = _platform_screens(facts, phones)
    features, feature_of = _features(screens)
    texts = {t.key: t for t in facts.texts}

    for s in screens:
        said = texts.get(s.key) if id(s) not in twin_ids else None
        node = out.node(
            "screen", s.key, _place(s.path, s.line), _screen_label(s),
            route=s.route, platform=platform, framework=s.platform, name=s.name, entry=s.entry,
            title=said.title if said else None, texts=list(said.texts) or None if said else None,
            alerts=list(said.alerts) or None if said else None, texts_own=said.own if said else None,
        )
        if node is not None:
            node["feature_key"] = feature_of.get(s.key)

    files: dict[str, list[str]] = {}
    for key, rel in facts.files:
        if phones.keeps(rel):
            files.setdefault(key, []).append(rel)
    for key, rels in files.items():
        node = out.nodes.get(("screen", key))
        if node is not None:
            node["detail"]["files"] = sorted(rels)[:MAX_SCREEN_FILES]
    for link in facts.links:
        node = out.nodes.get(("screen", link.screen_key)) if link.screen_key and link.platform == platform else None
        if node is not None:
            node["detail"]["links"] = [*(node["detail"].get("links") or []), link.public()][:MAX_SCREEN_LINKS]

    for n in facts.navigation:
        if phones.keeps(n.path):
            out.edge("navigates", ("screen", n.from_key), ("screen", n.to_key), n.label, _place(n.path, n.line))

    endpoints = [e for e in facts.endpoints if phones.keeps(e.path)]
    known = {code.endpoint_key(e.method, e.pattern) for e in endpoints if e.method != "*"}

    def endpoint_of(method: str, pattern: str) -> str:
        return keys.resolve_endpoint(method, pattern, known) if method == "*" else code.endpoint_key(method, pattern)

    sides: dict[str, set[str]] = {}
    for e in endpoints:
        key = endpoint_of(e.method, e.pattern)
        method, pattern = keys.split_endpoint_key(key)
        sides.setdefault(key, set()).add(e.side)
        out.node("endpoint", key, _place(e.path, e.line), key, method=method, pattern=pattern, handler=e.handler)
    for key, found in sides.items():
        if ("endpoint", key) in out.nodes:
            out.nodes[("endpoint", key)]["detail"]["side"] = "both" if len(found) > 1 else next(iter(found))
    for screen_key, e, path, line in facts.calls:
        if phones.keeps(path):
            out.edge("calls", ("screen", screen_key), ("endpoint", endpoint_of(e.method, e.pattern)), "", _place(path, line))

    for m in facts.entities:
        if phones.keeps(m.path):
            out.node("entity", m.key, _place(m.path, m.line), m.name, store=m.store, fields=list(m.fields))
    for a in facts.access:
        if a.mode not in ("reads", "writes") or not phones.keeps(a.path):
            continue
        if keys.is_endpoint_key(a.source):
            m, pattern = keys.split_endpoint_key(a.source)
            origin = ("endpoint", endpoint_of(m, pattern))
        else:
            origin = ("screen", a.source)
        out.edge(a.mode, origin, ("entity", a.entity_key), "", _place(a.path, a.line))

    _vote_features(out)
    return {
        "platform": platform,
        "source": SOURCE,
        "replace_source": True,
        "features": features,
        "nodes": sorted(out.nodes.values(), key=lambda n: (n["kind"], n["key"])),
        "edges": sorted(out.edges.values(), key=lambda e: (e["kind"], e["from_kind"], e["from_key"], e["to_kind"], e["to_key"], e["label"])),
    }


def _vote_features(out: _Facts) -> None:
    """An endpoint takes the feature most of the screens that call it are in; an entity the one
    most of the screens and endpoints that read or write it are in (`assign_features`)."""
    for kinds, target in ((("calls",), "endpoint"), (("reads", "writes"), "entity")):
        votes: dict[str, Counter[str]] = {}
        for e in out.edges.values():
            if e["kind"] in kinds and e["to_kind"] == target:
                src = out.nodes[(e["from_kind"], e["from_key"])]
                if src["feature_key"]:
                    votes.setdefault(e["to_key"], Counter())[src["feature_key"]] += 1
        for key, counter in votes.items():
            node = out.nodes[(target, key)]
            if not node["feature_key"]:
                node["feature_key"] = min(counter, key=lambda k: (-counter[k], k))


def build_payload(repo: Path | str, platform: str) -> dict[str, Any]:
    """The `POST .../qa/map/import` body (source `code`, features included) for what the code at
    `repo` declares on `platform` (`ios` | `android`). Reads only; never raises for an odd repo
    (a repo with nothing recognisable gives empty lists)."""
    if platform not in PLATFORMS:
        raise ValueError(f"platform must be one of {', '.join(PLATFORMS)}, not {platform!r}")
    return payload_from_facts(code.extract(Path(repo).expanduser()), platform)


def counts(payload: dict[str, Any]) -> dict[str, int]:
    """How much a payload says: screens, endpoints, entities, features and edges by kind."""
    nodes = Counter(n["kind"] for n in payload.get("nodes") or [])
    edges = Counter(e["kind"] for e in payload.get("edges") or [])
    return {
        "screens": nodes["screen"], "endpoints": nodes["endpoint"], "entities": nodes["entity"],
        "features": len(payload.get("features") or []), "edges": sum(edges.values()),
        **{f"edges_{k}": v for k, v in sorted(edges.items())},
    }


# ---------- which phones ----------

_XCODE_GLOBS = ("*.xcodeproj", "*/*.xcodeproj", "*/*/*.xcodeproj", "*.xcworkspace", "*/*.xcworkspace")


def _read(path: Path, limit: int = 256 * 1024) -> str:
    try:
        if path.stat().st_size <= limit:
            return path.read_text(errors="replace")
    except OSError:
        pass
    return ""


def detect_platforms(repo: Path | str) -> list[str]:
    """The platforms the repo at `repo` builds an app for (`ios`, `android`, `web`, in that order),
    from its project files: an Xcode project, an `Info.plist` or a SwiftUI `App` / `AppDelegate`
    for iOS; an `AndroidManifest.xml` for Android; a Flutter `pubspec.yaml` or a React Native /
    Expo `package.json` for the phones whose folder (`ios/`, `android/`) sits beside it, or both
    when neither does (an Expo managed app), and the web too when it names `react-native-web`; a
    `package.json` naming a web framework (Next, React DOM, React Router, Vite, Vue, ...) for the
    web. A Node server alone is no app. Empty when the repo is none of these."""
    root = Path(repo).expanduser()
    if not root.is_dir():
        return []
    files, _ = fm._walk(root)
    found: set[str] = set()
    try:
        if any(next(iter(root.glob(g)), None) is not None for g in _XCODE_GLOBS):
            found.add("ios")
    except OSError:
        pass
    for rel in files:
        name = rel.rsplit("/", 1)[-1]
        folder = rel.rsplit("/", 1)[0] if "/" in rel else ""
        if name in ("Info.plist", "AppDelegate.swift") or (name.endswith("App.swift") and "Tests" not in rel):
            found.add("ios")
        elif name == "AndroidManifest.xml":
            found.add("android")
        elif name in ("pubspec.yaml", "package.json"):
            if any(part in code.SKIP_PARTS for part in rel.split("/")[:-1]):
                continue  # a vendored library under `public/` or `assets/` is no app
            text = _read(root / rel)
            if name == "pubspec.yaml":
                kind = "flutter" if ("flutter:" in text and "sdk: flutter" in text) else "other"
            else:
                kind = code._package_kind(text)
            if kind == "web":
                found.add("web")
                continue
            if kind not in ("flutter", "react-native", "react-native-web"):
                continue
            here = root / folder
            phones = [p for p in PHONES if (here / p).is_dir()]
            found.update(phones or PHONES)
            if kind == "react-native-web":
                found.add("web")
    return [p for p in PLATFORMS if p in found]


def _main() -> None:  # pragma: no cover - a manual check: `python -m orcha_cli.qa.codemap.payload <repo> [platform]`
    import sys

    root = Path(sys.argv[1])
    for platform in sys.argv[2:] or detect_platforms(root):
        print(platform, json.dumps(counts(build_payload(root, platform))))


if __name__ == "__main__":  # pragma: no cover
    _main()


__all__ = ["build_payload", "counts", "detect_platforms", "payload_from_facts"]
