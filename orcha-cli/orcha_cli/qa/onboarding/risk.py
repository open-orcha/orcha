"""How much a screen matters if it breaks, from what the code and the runs show (onboarding's gap
ranking; adapted from `onboarding_map/risk.py` onto plain rows). No model: each signal is
read off the app map and says why in plain words.

- **Money**: the screen's name, route or title, an endpoint it calls or a record it writes speaks
  of checkout, payment, a purchase, a subscription, an order or a refund.
- **Sign-in**: it signs people in or up, resets a password or verifies a code.
- **Data writes**: it writes a record or calls an endpoint that writes one or sends data.
- **Onboarding**: the first screens a new user sees.
- **Reach**: how many screens lead to it (navigation in-degree).
- **API errors seen**: a run saw an endpoint it calls answer 4xx or 5xx.

`score` is 0 to 100. A screen nothing marks scores `BASE`.

A graph here is `Graph(nodes, edges)`: rows of `qa_map_nodes` and `qa_map_edges`, as dicts with
decoded `evidence` and `detail` (each keyed by source).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Optional

BASE = 5
WEIGHTS = {"money": 35, "auth": 25, "writes": 20, "deletes": 10, "onboarding": 15, "errors": 15}
#: Reach: points per screen that leads here (from the second one), capped.
REACH_EACH, REACH_MAX = 3, 15
#: A gap at or above this is "critical" in the summary.
CRITICAL = 50
WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})

_WORDS = {
    "money": re.compile(
        r"\b(?:checkout|check out|payments?|pay|paywall|billing|subscriptions?|subscribe|purchases?|purchase|cart|basket|orders?|"
        r"invoices?|refunds?|wallet|pricing|premium|upgrade|storekit|stripe|tip|donat\w*)\b"),
    "auth": re.compile(
        r"\b(?:sign ?in|sign ?up|log ?in|log ?out|login|logout|signin|signup|register|registration|password|passcode|otp|"
        r"verify|verification|two factor|2fa|auth|authenticate|forgot)\b"),
    "onboarding": re.compile(r"\b(?:onboarding|welcome|get started|getting started|intro|walkthrough|first run|setup)\b"),
}
_SPLIT = re.compile(r"(?<=[a-z0-9])(?=[A-Z])|[^A-Za-z0-9]+")


def words(*texts: Any) -> str:
    """`CheckoutView`, `/payments/[id]`, `sign_in` -> "checkout view payments id sign in"."""
    out: list[str] = []
    for t in texts:
        if t:
            out += [w.lower() for w in _SPLIT.split(str(t)) if w]
    return " ".join(out)


@dataclass
class Risk:
    score: int
    reasons: list[str] = field(default_factory=list)
    signals: set[str] = field(default_factory=set)

    def json(self) -> dict[str, Any]:
        return {"score": self.score, "reasons": list(self.reasons)}


def merged(node: dict[str, Any]) -> dict[str, Any]:
    """One `detail` from a row's source parts: live first, the code on top for what it knows."""
    out: dict[str, Any] = {}
    detail = node.get("detail") or {}
    for source in ("live", "crawl", "agent", "tests", "code"):
        part = detail.get(source)
        if isinstance(part, dict):
            out.update({k: v for k, v in part.items() if v is not None})
    return out


class Graph:
    def __init__(self, nodes: list[dict[str, Any]], edges: list[dict[str, Any]]):
        self.nodes = nodes
        self.edges = edges
        self.by_id = {str(n["id"]): n for n in nodes}
        self.from_node: dict[str, list[dict[str, Any]]] = {}
        for e in edges:
            self.from_node.setdefault(str(e["from_node_id"]), []).append(e)

    def edges_from(self, node_id: str, kind: str) -> list[dict[str, Any]]:
        return [e for e in self.from_node.get(str(node_id), []) if e["kind"] == kind]

    def endpoints(self) -> list[dict[str, Any]]:
        return [n for n in self.nodes if n["kind"] == "endpoint"]


def _name(n: dict[str, Any]) -> str:
    return str(n.get("label") or n["key"])


def code_calls(graph: Graph) -> dict[str, list[dict[str, Any]]]:
    """File -> the endpoint nodes the code declares in it (a client call or a server route)."""
    out: dict[str, list[dict[str, Any]]] = {}
    for ep in graph.endpoints():
        for e in (ep.get("evidence") or {}).get("code") or []:
            if isinstance(e, dict) and e.get("path"):
                out.setdefault(str(e["path"]), []).append(ep)
    return out


def screen_files(n: dict[str, Any]) -> list[str]:
    own = [str(e.get("path")) for e in ((n.get("evidence") or {}).get("code") or []) if isinstance(e, dict) and e.get("path")]
    part = (n.get("detail") or {}).get("code")
    part = part if isinstance(part, dict) else {}
    return list(dict.fromkeys(own + [str(f) for f in part.get("files") or []]))


def screen_calls(graph: Graph, n: dict[str, Any], by_file: Optional[dict[str, list[dict[str, Any]]]] = None) -> list[dict[str, Any]]:
    """The endpoints a screen calls: the calls runs saw (`calls` edges), and the client calls its
    own code makes (a call in one of the screen's files)."""
    out: dict[str, dict[str, Any]] = {}
    for e in graph.edges_from(str(n["id"]), "calls"):
        ep = graph.by_id.get(str(e["to_node_id"]))
        if ep is not None:
            out[str(ep["id"])] = ep
    if by_file is not None:
        for f in screen_files(n):
            for ep in by_file.get(f, ()):
                if (merged(ep).get("side") or "client") != "server":
                    out.setdefault(str(ep["id"]), ep)
    return sorted(out.values(), key=lambda ep: ep["key"])


def screen_risk(graph: Graph, n: dict[str, Any], in_degree: Optional[dict[str, set[str]]] = None,
                by_file: Optional[dict[str, list[dict[str, Any]]]] = None) -> Risk:
    """One screen's risk with its reasons, strongest first."""
    d = merged(n)
    own = words(n["key"], n.get("label"), d.get("route"), d.get("title"), d.get("name"))
    calls = screen_calls(graph, n, by_file)
    written: list[tuple[str, str]] = []  # (entity label, through what)
    for e in graph.edges_from(str(n["id"]), "writes"):
        ent = graph.by_id.get(str(e["to_node_id"]))
        if ent is not None:
            written.append((_name(ent), "on the device"))
    sends: list[str] = []
    deletes: list[str] = []
    errors: list[tuple[str, int]] = []
    for ep in calls:
        info = merged(ep)
        method = str(info.get("method") or ep["key"].split(" ", 1)[0]).upper()
        for e in graph.edges_from(str(ep["id"]), "writes"):
            ent = graph.by_id.get(str(e["to_node_id"]))
            if ent is not None:
                written.append((_name(ent), ep["key"]))
        if method in WRITE_METHODS:
            (deletes if method == "DELETE" else sends).append(ep["key"])
        bad = sorted({int(s) for s in info.get("statuses") or [] if str(s).isdigit() and int(s) >= 400})
        if bad:
            errors.append((ep["key"], bad[-1]))
    call_words = words(*(ep["key"] for ep in calls), *(w for w, _ in written))
    score = BASE
    reasons: list[str] = []
    signals: set[str] = set()

    def hit(kind: str) -> Optional[str]:
        if _WORDS[kind].search(own):
            return "own"
        if _WORDS[kind].search(call_words):
            return "calls"
        return None

    money = hit("money")
    if money:
        signals.add("money")
        score += WEIGHTS["money"]
        if money == "own":
            reasons.append("Handles money: checkout, payment or a purchase")
        else:
            ep = next((c["key"] for c in calls if _WORDS["money"].search(words(c["key"]))), None)
            reasons.append(f"Handles money: it calls {ep}" if ep else "Handles money: it saves an order or a payment")
    auth = hit("auth")
    if auth:
        signals.add("auth")
        score += WEIGHTS["auth"]
        ep = next((c["key"] for c in calls if _WORDS["auth"].search(words(c["key"]))), None)
        reasons.append("Signs people in or up" + (f" (calls {ep})" if auth == "calls" and ep else ""))
    if written or sends:
        signals.add("writes")
        score += WEIGHTS["writes"]
        if written:
            names = list(dict.fromkeys(w for w, _ in written))
            reasons.append("Saves data: " + ", ".join(names[:3]) + (f" and {len(names) - 3} more" if len(names) > 3 else ""))
        else:
            more = len(sends) - 1
            reasons.append(f"Sends data: {sends[0]}" + (f" and {more} more call{'s' if more != 1 else ''}" if more else ""))
    if deletes:
        signals.add("deletes")
        score += WEIGHTS["deletes"]
        reasons.append(f"Deletes data: {deletes[0]}")
    if _WORDS["onboarding"].search(own):
        signals.add("onboarding")
        score += WEIGHTS["onboarding"]
        reasons.append("Part of the first run a new user sees")
    sources = (in_degree or {}).get(str(n["id"]), set())
    if len(sources) >= 2:
        signals.add("reach")
        score += min(REACH_MAX, REACH_EACH * (len(sources) - 1))
        reasons.append(f"Reached from {len(sources)} screens")
    if errors:
        signals.add("errors")
        score += WEIGHTS["errors"]
        key, status = errors[0]
        reasons.append(f"A run saw {key} answer {status}")
    if not reasons:
        reasons.append("Nothing in the code marks it as risky")
    return Risk(min(100, score), reasons, signals)


def in_degrees(graph: Graph) -> dict[str, set[str]]:
    """Screen row id -> the other screens that lead to it."""
    out: dict[str, set[str]] = {}
    for e in graph.edges:
        if e["kind"] == "navigates" and str(e["from_node_id"]) != str(e["to_node_id"]):
            out.setdefault(str(e["to_node_id"]), set()).add(str(e["from_node_id"]))
    return out


def rank(graph: Graph, screens: list[dict[str, Any]]) -> dict[str, Risk]:
    """Screen row id -> its risk, for every screen given."""
    deg = in_degrees(graph)
    by_file = code_calls(graph)
    return {str(n["id"]): screen_risk(graph, n, deg, by_file) for n in screens}


def link_tests(tests: list[Any], screens: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """Screen key -> the UI tests that talk about it, each with why: the test's name, path or body
    says the screen's title, or its name and file say the screen's name. `tests` are
    `tests_scan.SourceTest`s; a test can reach several screens."""
    out: dict[str, list[dict[str, Any]]] = {}
    for n in screens:
        d = merged(n)
        title = str(d.get("title") or "").strip()
        name = words(n["key"]).strip() if not str(n["key"]).startswith(("/", "seen-")) else ""
        route = str(n["key"]) if str(n["key"]).startswith("/") and "*" not in str(n["key"]) and n["key"] != "/" else ""
        for t in tests:
            where = words(t.name, t.path)
            why = None
            if name and len(name) >= 4 and re.search(rf"\b{re.escape(name)}\b", where):
                why = f"Its name says {n.get('label') or n['key']}"
            elif title and len(title) >= 4 and (f'"{title}"' in t.body or f"'{title}'" in t.body):
                why = f'It looks for "{title}"'
            elif route and (f'"{route}"' in t.body or f"'{route}'" in t.body or f"`{route}`" in t.body):
                why = f"It opens {route}"
            if why:
                out.setdefault(str(n["key"]), []).append(
                    {"framework": t.framework, "name": t.name, "path": t.path, "line": t.line, "evidence": why})
    return out
