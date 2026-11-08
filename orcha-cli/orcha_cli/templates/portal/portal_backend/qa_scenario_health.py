"""Scenario health: a deterministic audit of a project's scenarios. No model is called; every flag
comes from the scenario's own text, its results and the project's targets.

A suite rots in quiet ways: agent work items imported as scenarios ("Orcha 3c96e42c · Build the
Questions board"), near-identical pairs, a run that fails on the environment every time. The audit
names those and the other ways a scenario stops earning its place:

- **suspicious**: it reads like an agent task, not a user outcome. A check run skips it unless it
  is named, until a person keeps it (`kept_suspicious`).
- **duplicate**: near-identical name or criteria to another scenario on the same platform.
- **env_failing**: its latest checks all stopped on the same infrastructure error.
- **never_passed**: it ran several times and never passed once.
- **flaky**: quarantined, or its passes and fails take turns.
- **stale**: its recorded walk is old and unused, or the checks since keep failing.
- **orphaned**: pinned to a platform the project has no app for.
- **platform_wording**: shared by every platform, but quoting words only one platform's screens
  ever showed.

Each flag carries one plain sentence of reason and the recommended one-click action. Flags are
stored in `qa_scenario_health_flags`, so the badge reads them without running the audit; a person
can dismiss a flag ("this is fine"), which keeps it quiet.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher
from typing import Any, Optional

from fastapi import HTTPException

from portal_backend import qa_map, qa_scenarios, qa_store as qs

FLAG_KINDS = ("suspicious", "env_failing", "orphaned", "duplicate", "never_passed", "stale", "flaky", "platform_wording")

# How many latest results must agree before a scenario is "always failing the same way", and how
# many runs without a pass make "never passed".
ENV_STREAK = 3
NEVER_PASSED_MIN = 3
# A trace recorded this long ago and not replayed for STALE_IDLE_DAYS is stale.
STALE_RECORDED_DAYS = 45
STALE_IDLE_DAYS = 30
STALE_FAILS = 3
# Platform wording: the newest runs per platform whose screens are compared, and how many distinct
# screens a platform needs before "never seen there" counts.
WORDING_RUNS = 25
WORDING_MIN_SCREENS = 10

NO_RESULT_OUTCOMES = frozenset({None, "", "running", "pending", "skipped", "not_reached", "queued"})
PLATFORM_NAMES = {"web": "Web", "ios": "iOS", "android": "Android", "desktop": "Desktop"}

# ---------------------------------------------------------------------------------- suspicious

# "Orcha 3c96e42c ·", "Task 7f3a9b2:", "agent a1b2c3d4 |": a tool or task word, a hex id, a separator.
_TASK_PREFIX_RE = re.compile(r"^\s*([A-Za-z][\w.-]{1,24})\s+([0-9a-f]{6,40})\s*[·•:|–—-]", re.I)
# A bare hash anywhere: 7+ hex characters with at least one digit and one letter ("3c96e42c").
_HASH_RE = re.compile(r"(?<![\w-])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![\w-])", re.I)
# A ticket key: "JIRA-1423", "ENG-42".
_TICKET_RE = re.compile(r"(?<![\w-])[A-Z][A-Z0-9]{1,9}-\d{1,6}(?![\w-])")

# Phrases only a work order uses: nobody "opens a PR" as a user of the app under test.
_WORK_ORDER_PHRASES = (
    "open a pr", "open the pr", "open pr", "open a pull request", "pull request", "do not merge",
    "don't merge", "dont merge", "local branch", "feature branch", "new branch", "push to",
    "push the branch", "and push", "commit the", "commit and", "commit your", "qa issues",
    "merge the pr", "merge to main", "merge into main", "against main", "code review",
    "unit tests", "the codebase",
)
# Verbs a scenario name never starts with: a user does not "fix" or "refactor" the app.
# Not "ship", "debug", "polish" or "migrate": "Ship to a new address", "Debug menu opens" and
# "Polish language" are real scenarios.
_WORK_ORDER_VERBS = ("fix", "fixes", "refactor", "implement", "investigate", "rework", "cleanup", "clean up", "wire up")
# A criterion is an instruction when it starts with a developer verb and names developer things.
# Words users meet too ("main menu", "promo code", "a class", "the branch") are left out.
_INSTRUCTION_VERBS = ("implement", "refactor", "fix", "write", "add", "create", "update", "build", "open", "run", "commit", "push", "merge", "deploy", "rename", "remove", "delete", "install", "wire")
_DEV_NOUNS_RE = re.compile(
    r"\b(component|components|endpoint|endpoints|unit tests?|e2e tests?|tests|test suite|the code|codebase|repo|repository|"
    r"pull request|pr|commit|lint|linter|ci)\b",
    re.I,
)


def _phrase_hits(text: str) -> list[str]:
    low = " " + re.sub(r"\s+", " ", text.lower()) + " "
    hits = []
    for p in _WORK_ORDER_PHRASES:
        if re.search(rf"(?<![a-z]){re.escape(p)}(?![a-z])", low):
            hits.append(p)
    return hits


def _segments(name: str) -> list[str]:
    """The name's parts around separators: "Questions board: fix QA issues" -> both halves."""
    return [s.strip() for s in re.split(r"[·•:|–—]", name) if s.strip()]


def _starts_with(text: str, words: Iterable[str]) -> str | None:
    low = text.lower().lstrip(" -*•(")
    for w in words:
        if low == w or low.startswith(w + " "):
            return w
    return None


def is_instruction(criterion: str) -> bool:
    """A criterion that tells someone what to do to the code, not what the app should show."""
    text = (criterion or "").strip()
    if not text:
        return False
    if _phrase_hits(text):
        return True
    return bool(_starts_with(text, _INSTRUCTION_VERBS) and _DEV_NOUNS_RE.search(text))


def suspicious_reasons(name: str | None, description: str | None = None, criteria: Iterable[Any] | None = None) -> list[dict[str, Any]]:
    """Why a scenario looks like an agent task rather than a user outcome: a list of
    `{code, matched}` with `code` in `task_id`, `work_order`, `instructions` (in that order), empty
    for a scenario that reads like a real one. Pure; shared cases in `db/scenario-health-cases.json`."""
    name = name or ""
    out: list[dict[str, Any]] = []
    m = _TASK_PREFIX_RE.match(name)
    task = f"{m.group(1)} {m.group(2)}" if m and re.search(r"\d", m.group(2)) else None
    if task is None:
        hm = _HASH_RE.search(name) or _TICKET_RE.search(name)
        task = hm.group(0) if hm else None
    if task:
        out.append({"code": "task_id", "matched": [task]})
    words = _phrase_hits(name) + _phrase_hits(description or "")
    for seg in _segments(name):
        verb = _starts_with(seg, _WORK_ORDER_VERBS)
        if verb:
            words.append(verb)
    if words:
        out.append({"code": "work_order", "matched": list(dict.fromkeys(words))})
    texts = [_criterion_text(c) for c in (criteria or [])]
    instructions = [t for t in texts if is_instruction(t)]
    if instructions:
        out.append({"code": "instructions", "matched": instructions[:3]})
    return out


def _quote(items: list[str], n: int = 2) -> str:
    return ", ".join(f'"{i}"' for i in items[:n])


def suspicious_sentence(reasons: list[dict[str, Any]]) -> str:
    parts = []
    for r in reasons:
        if r["code"] == "task_id":
            parts.append(f"a task id in its name ({_quote(r['matched'])})")
        elif r["code"] == "work_order":
            parts.append(f"work-order wording ({_quote(r['matched'])})")
        else:
            parts.append(f"criteria that are instructions ({_quote(r['matched'], 1)})")
    return "Looks like an agent task, not a user outcome: " + "; ".join(parts) + "."


# ---------------------------------------------------------------------------------- duplicates

_STOPWORDS = frozenset(
    "a an the to of on in and or for with is are can user users should be it its from by at as that this when then "
    "web ios android desktop iphone ipad mobile".split()
)


def _stem(word: str) -> str:
    for suffix in ("ing", "ed", "es", "s"):
        if len(word) > 4 and word.endswith(suffix):
            return word[: -len(suffix)]
    return word


def name_tokens(name: str | None) -> frozenset[str]:
    words = re.findall(r"[a-z0-9]+", (name or "").lower())
    return frozenset(_stem(w) for w in words if w not in _STOPWORDS)


def _norm_text(text: str) -> str:
    return " ".join(_stem(w) for w in re.findall(r"[a-z0-9]+", text.lower()) if w not in _STOPWORDS)


def _jaccard(a: frozenset[str] | set[str], b: frozenset[str] | set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def _criterion_text(c: Any) -> str:
    if isinstance(c, dict):
        return str(c.get("text") or c.get("criterion") or "")
    return str(c or "")


def _loads(value: Any) -> Any:
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            return value
    return value


def _criteria(row: dict[str, Any]) -> list[str]:
    raw = _loads(row.get("criteria"))
    return [t for t in (_criterion_text(c) for c in raw) if t] if isinstance(raw, list) else []


def same_platform(a: str | None, b: str | None) -> bool:
    """Two scenarios overlap on a platform when they share it, or either runs everywhere."""
    return not a or not b or a == b


def duplicate_score(a: dict[str, Any], b: dict[str, Any]) -> str | None:
    """Why `a` and `b` are the same scenario ("name", "criteria"), or None."""
    if not same_platform(a.get("target_kind"), b.get("target_kind")):
        return None
    ta, tb = name_tokens(a.get("name")), name_tokens(b.get("name"))
    na, nb = " ".join(sorted(ta)), " ".join(sorted(tb))
    if na and na == nb:
        return "name"
    # "Root scenario 01" and "Root scenario 02", "Plan 3 users" and "Plan 30 users": a differing
    # number is a different scenario however alike the rest reads.
    numbered = any(re.search(r"\d", t) for t in ta ^ tb)
    if not numbered and len(ta) >= 2 and len(tb) >= 2 and (_jaccard(ta, tb) >= 0.8 or SequenceMatcher(None, _norm_text(a.get("name") or ""), _norm_text(b.get("name") or "")).ratio() >= 0.92):
        return "name"
    ca = {_norm_text(c) for c in _criteria(a)} - {""}
    cb = {_norm_text(c) for c in _criteria(b)} - {""}
    # Two generic criteria ("The page loads", "No error appears") are shared by many different
    # scenarios: with fewer than three, the names must overlap too.
    if len(ca) >= 2 and len(cb) >= 2 and _jaccard(ca, cb) >= 0.8 and (min(len(ca), len(cb)) >= 3 or _jaccard(ta, tb) >= 0.34):
        return "criteria"
    return None


def _canonical_key(row: dict[str, Any]) -> tuple[int, str, str]:
    """The scenario to keep of a duplicate pair: validated first, then the older, then by name."""
    return (0 if qa_scenarios.counts_for_coverage(row) else 1, str(row.get("created_at") or ""), str(row.get("name") or ""))


def find_duplicates(scenarios: list[dict[str, Any]]) -> dict[str, tuple[dict[str, Any], str]]:
    """`{scenario id: (the scenario to merge it into, why)}`. Each pair flags only the one to
    merge away (the draft, else the newer), never both, and chains point at the first kept one."""
    ordered = sorted(scenarios, key=_canonical_key)
    out: dict[str, tuple[dict[str, Any], str]] = {}
    for i, keep in enumerate(ordered):
        if keep["id"] in out:
            continue
        for other in ordered[i + 1:]:
            if other["id"] in out:
                continue
            why = duplicate_score(keep, other)
            if why:
                out[other["id"]] = (keep, why)
    return out


# ------------------------------------------------------------------------ results: env/never

_INFRA_RE = re.compile(
    r"connection refused|econnrefused|err_connection|err_name_not_resolved|enotfound|net::err|did not answer|not answering|"
    r"unreachable|timed out|timeout|qa-run exited|exited \d+|replay failed|no device|device .*unavailable|simulator|emulator|"
    r"build (is )?missing|no build|could not launch|failed to launch|not installed|bad gateway|\b50[234]\b|rate limit|quota|"
    r"credit balance|api key|authentication_error|overloaded|worker (died|lost|stopped)|target_unreachable|device_unavailable|build_missing",
    re.I,
)


def error_signature(error: str | None, code: str | None = None) -> str:
    """One failure's identity: the error code when there is one, else the first line of the
    message with numbers, ids and paths flattened, so "port 8010 refused (attempt 2)" and
    "(attempt 3)" are the same failure."""
    if code:
        return str(code).strip().upper()
    line = (error or "").strip().split("\n")[0].lower()
    line = re.sub(r"[0-9a-f]{8}-[0-9a-f-]{27,}", "#", line)
    line = re.sub(r"\b[0-9a-f]{7,}\b", "#", line)
    line = re.sub(r"\d+", "#", line)
    line = re.sub(r"\s+", " ", line)
    return line[:160]


@dataclass
class Attempt:
    """One run of one scenario: its outcome, when, and the error it stopped on (if any)."""

    at: str
    outcome: str
    error: str | None = None
    code: str | None = None

    @property
    def passed(self) -> bool:
        # A warning is a pass with notes: the run page and the batch say "Passed".
        return self.outcome in ("pass", "warning")

    @property
    def infra(self) -> bool:
        if self.code:
            return True
        if self.outcome in ("errored", "unprocessable"):
            return True
        return bool(self.error and _INFRA_RE.search(self.error))


def env_failing(attempts: list[Attempt], streak: int = ENV_STREAK) -> dict[str, Any] | None:
    """`{error, code, count}` when the latest `streak` attempts all failed on the same
    infrastructure error, else None. `count` is how far back the same failure goes."""
    latest = sorted(attempts, key=lambda a: a.at, reverse=True)
    if len(latest) < streak:
        return None
    head = latest[:streak]
    if any(a.passed or not a.infra for a in head):
        return None
    sig = error_signature(head[0].error, head[0].code)
    if not sig or any(error_signature(a.error, a.code) != sig for a in head):
        return None
    count = 0
    for a in latest:
        if a.passed or error_signature(a.error, a.code) != sig:
            break
        count += 1
    return {"error": (head[0].error or head[0].code or "").split("\n")[0][:200], "code": head[0].code, "count": count}


def never_passed(attempts: list[Attempt], minimum: int = NEVER_PASSED_MIN) -> int | None:
    """How many runs, when the scenario ran at least `minimum` times and never passed. A run that
    ended on a blocked code (the target was not there, the device died) never judged the scenario:
    it is not one of those runs."""
    ran = [a for a in attempts if a.outcome != "errored"]
    if len(ran) < minimum or any(a.passed for a in attempts):
        return None
    return len(ran)


# ------------------------------------------------------------------------------------- stale


def _parse_time(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def stale_reason(traces: list[dict[str, Any]], now: datetime) -> str | None:
    """Why the scenario's replay trace no longer matches the app, or None. The newest trace per
    platform is judged: a replay that drifted, a replay that keeps failing, or an old unreplayed one."""
    newest: dict[str, dict[str, Any]] = {}
    for t in traces:
        key = str(t.get("target_kind") or "")
        if key not in newest or str(t.get("recorded_at") or "") > str(newest[key].get("recorded_at") or ""):
            newest[key] = t
    for t in newest.values():
        if t.get("last_stop_reason"):
            return f"Its last replay drifted ({t['last_stop_reason']}): the screens it recorded have changed."
        fails, oks = int(t.get("replay_fail_count") or 0), int(t.get("replay_ok_count") or 0)
        if fails >= STALE_FAILS and fails > oks:
            return f"Its recorded replay failed {fails} times and passed {oks}: the app has moved on."
        recorded = _parse_time(t.get("recorded_at"))
        replayed = _parse_time(t.get("last_replayed_at")) or recorded
        if recorded and replayed and now - recorded > timedelta(days=STALE_RECORDED_DAYS) and now - replayed > timedelta(days=STALE_IDLE_DAYS):
            return f"Recorded {(now - recorded).days} days ago and not replayed for {(now - replayed).days} days."
    return None


# ------------------------------------------------------------------------------------- audit


def _flag(scenario_id: str, kind: str, reason: str, action: str, **detail: Any) -> dict[str, Any]:
    return {"scenario_id": scenario_id, "kind": kind, "reason": reason, "action": action, "detail": {k: v for k, v in detail.items() if v is not None}}


def compute_flags(
    scenarios: list[dict[str, Any]],
    *,
    target_kinds: set[str],
    attempts: dict[str, list[Attempt]] | None = None,
    traces: dict[str, list[dict[str, Any]]] | None = None,
    screens: dict[str, list[Any]] | None = None,
    now: datetime | None = None,
) -> dict[str, list[dict[str, Any]]]:
    """Every flag of every (non-archived) scenario: `{scenario id: [flag]}`, healthy ones absent.
    Pure: rows in, flags out. `screens` are the screens the project's recent runs saw, by
    platform (`ScreenInfo`), for `platform_wording`."""
    now = now or datetime.now(timezone.utc)
    attempts = attempts or {}
    traces = traces or {}
    live = [s for s in scenarios if qa_scenarios.effective(s) != "retired"]
    dups = find_duplicates(live)
    out: dict[str, list[dict[str, Any]]] = {}
    for s in live:
        sid = s["id"]
        flags: list[dict[str, Any]] = []
        reasons = suspicious_reasons(s.get("name"), s.get("description"), _criteria(s))
        if reasons:
            # A validated one is costing runs: set it aside. A draft one already does not run.
            flags.append(_flag(sid, "suspicious", suspicious_sentence(reasons), "drafts" if s.get("status") in ("validated", "paused") else "archive",
                               reasons=[r["code"] for r in reasons], matched=[m for r in reasons for m in r["matched"]]))
        tries = attempts.get(sid, [])
        env = env_failing(tries)
        if env:
            flags.append(_flag(sid, "env_failing", f'Failed the same way on its last {env["count"]} runs ("{env["error"][:90]}"). That is the environment, not the app.',
                               "fix_env", error=env["error"], code=env["code"], count=env["count"]))
        kind = s.get("target_kind")
        if kind and target_kinds and kind not in target_kinds:
            label = PLATFORM_NAMES.get(kind, kind)
            flags.append(_flag(sid, "orphaned", f"Pinned to {label}, and this project has no {label} target.", "fix_env", target_kind=kind))
        if sid in dups:
            keep, why = dups[sid]
            what = "name" if why == "name" else "criteria"
            flags.append(_flag(sid, "duplicate", f'Same {what} as "{keep.get("name")}" on the same platform.', "merge",
                               duplicate_of=keep["id"], duplicate_name=keep.get("name"), match=why))
        runs = never_passed(tries) if not env else None
        if runs:
            flags.append(_flag(sid, "never_passed", f"Ran {runs} times and never passed.", "open", count=runs))
        stale = stale_reason(traces.get(sid, []), now)
        if stale:
            flags.append(_flag(sid, "stale", stale, "open"))
        wording = _platform_wording(s, screens, target_kinds)
        if wording:
            flags.append(wording)
        if s.get("quarantined_at") and not s.get("quarantine_released_at"):
            flags.append(_flag(sid, "flaky", f"In flaky quarantine ({s.get('quarantine_reason') or 'flaky'}). It runs but never fails a check.", "open"))
        elif s.get("health") == "flaky":
            flags.append(_flag(sid, "flaky", "Passes and fails on recent runs without a change.", "open"))
        if flags:
            out[sid] = flags
    return out


def _quoted(s: dict[str, Any]) -> list[str]:
    """The labels a scenario quotes: quoted text in its criteria, then each check's label."""
    out: dict[str, str] = {}
    lines = [_criterion_text(c) for c in _loads(s.get("criteria")) or []]
    lines += [str(c.get("line") or "") for c in _loads(s.get("checks")) or [] if isinstance(c, dict)]
    for line in lines:
        for m in re.finditer(r'"([^"]{2,})"|“([^”]{2,})”', line):
            text = (m.group(1) or m.group(2)).strip()
            if text and not text.startswith("{{"):
                out.setdefault(text.lower(), text)
    return list(out.values())


def wording_only_on(s: dict[str, Any], pool: dict[str, list[list[str]]], min_screens: int) -> dict[str, list[str]]:
    """`{platform: [label, ...]}`: the quoted labels only that platform's screens showed, while
    another platform that walked the same journey never did. A platform counts as having walked
    it when it has `min_screens` screens and shows at least one of the scenario's labels. Empty
    when fewer than two platforms walked it (nothing to compare)."""
    quoted = _quoted(s)
    seen = {p: {t.lower() for screen in screens for t in screen} for p, screens in pool.items()}
    where = {text: {p for p, have in seen.items() if text.lower() in have} for text in quoted}
    walked = {p for p, ss in pool.items() if len(ss) >= min_screens and any(p in ps for ps in where.values())}
    if len(walked) < 2:
        return {}
    out: dict[str, list[str]] = {}
    for text in quoted:
        ps = where[text] & walked
        if len(ps) == 1:
            out.setdefault(next(iter(ps)), []).append(text)
    return out


def split_suggestion(name: str, only_on: dict[str, list[str]], kinds: Iterable[str]) -> str:
    """One sentence: how to split a shared scenario whose wording belongs to one platform."""
    kinds = sorted(set(kinds))
    owners = sorted(only_on)
    rest = [k for k in kinds if k not in owners]
    label = lambda k: PLATFORM_NAMES.get(k, k)  # noqa: E731
    words = "; ".join(", ".join(f'"{t}"' for t in only_on[p][:3]) + f" only on {label(p)}" for p in owners)
    if len(owners) == 1 and rest:
        return f'{words}. Pin "{name}" to {label(owners[0])} and draft a {", ".join(label(k) for k in rest)} version from what that platform shows.'
    return f'{words}. Split "{name}" into one scenario per platform, each quoting that platform\'s own words.'


def _platform_wording(s: dict[str, Any], screens: dict[str, list[Any]] | None, target_kinds: set[str]) -> dict[str, Any] | None:
    """The `platform_wording` flag of a shared scenario, or None."""
    if s.get("target_kind") or len(target_kinds) < 2 or not screens:
        return None
    pool = {k: v for k, v in screens.items() if k in target_kinds}
    only = wording_only_on(s, pool, WORDING_MIN_SCREENS)
    if not only:
        return None
    return _flag(s["id"], "platform_wording", split_suggestion(str(s.get("name") or ""), only, target_kinds),
                 "open", only_on=only, suggested_kind=next(iter(only)) if len(only) == 1 else None)


# ------------------------------------------------------------------------------- from the rows

ACTIONS = ("drafts", "archive", "dismiss", "restore", "rename", "merge")


def _flagged(row: dict[str, Any]) -> dict[str, Any]:
    """A stored or computed row in the shape the audit's rules read."""
    pub = qs.public(row)
    return {**pub, "target_kind": None if pub.get("shared") else pub.get("platform")}


def load_attempts(cur: Any, cid: str, rows: list[dict[str, Any]]) -> dict[str, list[Attempt]]:
    """One attempt per check of each scenario. Blocked reads as a run that errored, inconclusive
    as one that could not be judged: neither says the app is wrong."""
    cur.execute("SELECT * FROM qa_verdicts WHERE container_id=%s ORDER BY created_at DESC", (cid,))
    by: dict[str, dict[str, list[dict]]] = {}
    for v in cur.fetchall():
        by.setdefault(str(v["scenario_id"]), {}).setdefault(str(v["session_id"]), []).append(qs.public(v))
    words = {"blocked": "errored", "inconclusive": "unprocessable"}
    out: dict[str, list[Attempt]] = {}
    for r in rows:
        tries = qa_scenarios.attempts_of(len(r.get("criteria") or []), by.get(r["id"], {}))
        out[r["id"]] = [Attempt(at=a["at"], outcome=words.get(a["outcome"], str(a["outcome"])), error=a["note"]) for a in tries]
    return out


def load_traces(cur: Any, cid: str, rows: list[dict[str, Any]], attempts: dict[str, list[Attempt]]) -> dict[str, list[dict[str, Any]]]:
    """Each scenario's recorded walk as the audit reads a trace: when it was walked and how the
    checks since went."""
    out: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        walk = r.get("walk_id")
        if not walk:
            continue
        cur.execute("SELECT id, ended_at, started_at FROM qa_walks WHERE id=%s", (str(walk),))
        w = cur.fetchone()
        if not w:
            continue
        recorded = qs.iso(w["ended_at"] or w["started_at"])
        since = [a for a in attempts.get(r["id"], []) if a.at >= str(recorded)]
        out[r["id"]] = [{"target_kind": r.get("platform"), "recorded_at": recorded, "last_replayed_at": since[0].at if since else None,
                         "replay_ok_count": sum(1 for a in since if a.passed), "replay_fail_count": sum(1 for a in since if a.outcome == "fail"),
                         "last_stop_reason": None}]
    return out


def load_platform_screens(cur: Any, cid: str, kinds: set[str]) -> dict[str, list[list[str]]]:
    """Each platform's seen screens as their labels: what the app there really shows."""
    out: dict[str, list[list[str]]] = {}
    for kind in kinds:
        for n in qa_map.read_map(cur, cid, kind)["nodes"]:
            if n.get("kind") != "screen" or n.get("state") != "seen":
                continue
            ev, det = n.get("evidence") or {}, n.get("detail") or {}
            live = ev.get("live") if isinstance(ev.get("live"), dict) else {}
            labels = [str(x) for key in ("texts", "anchors") for x in (live.get(key) or det.get(key) or []) if isinstance(x, str)]
            if labels:
                out.setdefault(kind, []).append(labels)
    return out


def stored_flags(cur: Any, cid: str) -> dict[tuple[str, str], dict[str, Any]]:
    cur.execute("SELECT * FROM qa_scenario_health_flags WHERE container_id=%s", (cid,))
    return {(str(r["scenario_id"]), str(r["kind"])): qs.public(r) for r in cur.fetchall()}


def sync_flags(cur: Any, cid: str, flags: dict[str, list[dict[str, Any]]], stored: dict[tuple[str, str], dict[str, Any]]) -> None:
    """Store the audit: upsert current flags (keeping `first_seen_at` and a dismissal), delete the
    ones no longer found unless dismissed, so "this is fine" survives a flag coming and going."""
    at = qs.now()
    current = set()
    for fl in flags.values():
        for f in fl:
            key = (f["scenario_id"], f["kind"])
            current.add(key)
            if key in stored:
                cur.execute("UPDATE qa_scenario_health_flags SET reason=%s, action=%s, detail=%s, seen_at=%s WHERE scenario_id=%s AND kind=%s",
                            (f["reason"], f["action"], qs.dumps(f.get("detail") or {}), at, *key))
            else:
                cur.execute("""INSERT INTO qa_scenario_health_flags (container_id, scenario_id, kind, reason, action, detail, first_seen_at, seen_at)
                               VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
                            (cid, *key, f["reason"], f["action"], qs.dumps(f.get("detail") or {}), at, at))
    for key, row in stored.items():
        if key not in current and not row.get("dismissed_at"):
            cur.execute("DELETE FROM qa_scenario_health_flags WHERE scenario_id=%s AND kind=%s", key)


def audit(cur: Any, cid: str, now: Optional[datetime] = None) -> dict[str, Any]:
    """The project's audit as the Health board shows it; the flags and the time are stored."""
    now = now or datetime.now(timezone.utc)
    cur.execute("SELECT * FROM qa_scenarios WHERE container_id=%s", (cid,))
    rows = [_flagged(r) for r in cur.fetchall()]
    live = [s for s in rows if qa_scenarios.effective(s) != "retired"]
    cur.execute("SELECT platform FROM qa_targets WHERE container_id=%s AND app_id IS NOT NULL", (cid,))
    kinds = {str(r["platform"]) for r in cur.fetchall()}
    attempts = load_attempts(cur, cid, live)
    for s in live:
        tries = [a.outcome for a in attempts.get(s["id"], [])[:qa_scenarios.HEALTH_WINDOW] if a.outcome in ("pass", "fail")]
        s["health"] = "flaky" if sum(1 for a, b in zip(tries, tries[1:]) if a != b) >= 2 else None
    shared = len(kinds) > 1 and any(not s.get("target_kind") for s in live)
    screens = load_platform_screens(cur, cid, kinds) if shared else None
    flags = compute_flags(live, target_kinds=kinds, attempts=attempts, traces=load_traces(cur, cid, live, attempts), screens=screens, now=now)
    stored = stored_flags(cur, cid)
    sync_flags(cur, cid, flags, stored)
    by_id = {s["id"]: s for s in live}
    counts: dict[str, int] = {}
    out = []
    for sid, fl in flags.items():
        for f in fl:
            f["dismissed_at"] = (stored.get((sid, f["kind"])) or {}).get("dismissed_at")
            if not f["dismissed_at"]:
                counts[f["kind"]] = counts.get(f["kind"], 0) + 1
        s = by_id[sid]
        out.append({"id": sid, "name": s.get("name"), "status": s.get("status"), "target_kind": s.get("target_kind"), "flags": fl})
    out.sort(key=lambda r: str(r["name"] or "").lower())
    computed = now.isoformat().replace("+00:00", "Z")
    cur.execute("DELETE FROM qa_scenario_health_audits WHERE container_id=%s", (cid,))
    cur.execute("INSERT INTO qa_scenario_health_audits (container_id, computed_at, total, counts) VALUES (%s,%s,%s,%s)",
                (cid, qs.now(), len(live), qs.dumps(counts)))
    return {"project_id": cid, "computed_at": computed, "total": len(live), "counts": counts, "scenarios": out}


def stale_audit(cur: Any, cid: str, max_age_s: float = 600) -> bool:
    cur.execute("SELECT computed_at FROM qa_scenario_health_audits WHERE container_id=%s", (cid,))
    row = cur.fetchone()
    at = _parse_time(qs.iso(row["computed_at"])) if row else None
    return at is None or (datetime.now(timezone.utc) - at).total_seconds() > max_age_s


def kept_suspicious(cur: Any, cid: str) -> set[str]:
    """Scenarios whose `suspicious` flag a person dismissed ("keep it"): check runs cover them."""
    cur.execute("SELECT scenario_id FROM qa_scenario_health_flags WHERE container_id=%s AND kind='suspicious' AND dismissed_at IS NOT NULL", (cid,))
    return {str(r["scenario_id"]) for r in cur.fetchall()}


def mark_suspicious(cur: Any, cid: str, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """`suspicious` on each row that reads like an agent task and nobody kept: a check run leaves
    it out unless it is named."""
    kept = kept_suspicious(cur, cid)
    for r in rows:
        r["suspicious"] = bool(suspicious_reasons(r.get("name"), r.get("description"), r.get("criteria"))) and r["id"] not in kept
    return rows


def set_dismissed(cur: Any, cid: str, who: dict, sid: str, kind: str, dismissed: bool) -> None:
    at = qs.now() if dismissed else None
    by = who["id"] if dismissed else None
    cur.execute("SELECT 1 AS one FROM qa_scenario_health_flags WHERE scenario_id=%s AND kind=%s", (sid, kind))
    if cur.fetchone():
        cur.execute("UPDATE qa_scenario_health_flags SET dismissed_at=%s, dismissed_by_agent_id=%s WHERE scenario_id=%s AND kind=%s", (at, by, sid, kind))
    elif dismissed:
        cur.execute("""INSERT INTO qa_scenario_health_flags (container_id, scenario_id, kind, reason, action, first_seen_at, seen_at, dismissed_at, dismissed_by_agent_id)
                       VALUES (%s,%s,%s,'Kept by a person.','dismiss',%s,%s,%s,%s)""", (cid, sid, kind, at, at, at, by))


def _norm(text: Any) -> str:
    return " ".join(str(text or "").lower().split())


def apply_action(cur: Any, cid: str, who: dict, action: str, ids: list[str], *, kind: Optional[str] = None,
                 name: Optional[str] = None, into: Optional[str] = None) -> int:
    """The Health board's one-click actions, single or bulk. People only (the route checks)."""
    rows = [dict(qs.load_scenario(cur, i)) for i in dict.fromkeys(ids)]
    if any(str(r["container_id"]) != cid for r in rows):
        raise HTTPException(404, "a scenario is not in this project")
    sids = [str(r["id"]) for r in rows]
    if action == "archive":
        qa_scenarios.set_status(cur, cid, who, sids, "retired", "Set aside from Scenarios › Health")
    elif action == "drafts":
        qa_scenarios.set_status(cur, cid, who, sids, "draft", None)
    elif action in ("dismiss", "restore"):
        if kind not in FLAG_KINDS:
            raise HTTPException(400, f"kind must be one of {', '.join(FLAG_KINDS)}")
        for sid in sids:
            set_dismissed(cur, cid, who, sid, kind, action == "dismiss")
    elif action == "rename":
        if len(sids) != 1 or not (name or "").strip():
            raise HTTPException(400, "rename takes one scenario and a name")
        qa_scenarios.revise(cur, rows[0], who, {"name": " ".join(name.split())}, None, None, None)
    elif action == "merge":
        if not into:
            raise HTTPException(400, "merge takes `into`")
        qs.require_uuid(into, "into")
        target = dict(qs.load_scenario(cur, into))
        if str(target["container_id"]) != cid:
            raise HTTPException(400, "Merge scenarios of the same project only.")
        criteria = list(qs._json(target.get("criteria"), []))
        seen = {_norm(c) for c in criteria}
        for s in rows:
            for c in qs._json(s.get("criteria"), []):
                if _norm(c) not in seen:
                    seen.add(_norm(c))
                    criteria.append(c)
        if len(criteria) > 12:
            raise HTTPException(400, "Merged, it would have more than 12 criteria. Trim one of them first.")
        qa_scenarios.revise(cur, target, who, {"criteria": criteria}, None, None, None)
        # Whatever depended on a merged scenario now depends on the one it was merged into.
        cur.execute("SELECT id, depends_on FROM qa_scenarios WHERE container_id=%s", (cid,))
        names = {_norm(s["name"]) for s in rows}
        for p in cur.fetchall():
            deps = qs._json(p.get("depends_on"), [])
            hit = [d for d in deps if d in sids or _norm(d) in names]
            if not hit or str(p["id"]) in sids:
                continue
            next_deps = list(dict.fromkeys(str(target["id"]) if d in hit else d for d in deps))
            next_deps = [d for d in next_deps if d != str(p["id"])]
            cur.execute("UPDATE qa_scenarios SET depends_on=%s, updated_at=%s WHERE id=%s", (qs.dumps(next_deps), qs.now(), str(p["id"])))
        qa_scenarios.set_status(cur, cid, who, sids, "retired", f'Merged into "{target["name"]}"', replaced_by=str(target["id"]))
    else:
        raise HTTPException(400, f"action must be one of {', '.join(ACTIONS)}")
    return len(sids)
