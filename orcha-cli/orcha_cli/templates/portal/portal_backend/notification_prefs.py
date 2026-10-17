"""Fine-grained notification preferences (mig 063) — the ONE decision every delivery path asks.

Design (see the migration header for storage):

  * CATEGORIES are human-meaningful groups built over the typed taxonomy
    (notification_taxonomy._NOTIF_TAXONOMY). Every event kind the stack knows — bus
    event_names, audit event_types that describe a notification-worthy change, push
    outbox kinds and the desktop host's attention kinds — maps to EXACTLY ONE category
    (KIND_TO_CATEGORY); an unknown kind falls back by prefix, then to "tasks".
  * Per category: a SCOPE ("all" | "mine" | "off") and a per-CHANNEL switch
    (in_app, desktop, push, slack).
  * Person-level (global defaults row only): PAUSE (until a time, or until turned back
    on) and QUIET HOURS (a local time range in an IANA zone that holds desktop / push /
    Slack alerts but keeps in-app).
  * Project-level (per member override row): partial category rules + MUTE.
  * CRITICAL kinds (a budget hard-stop) always reach in-app — the budget category's
    in-app switch is LOCKED on (validation refuses turning it off).

`should_notify(prefs, event, channel, now)` is PURE (no DB) and table-tested. The DB
helpers below resolve (a) a member's effective prefs and (b) whether an event is
"mine" for that member, and are called by agent_notification_routes (bell),
push_outbox + push_routes (mobile push), slack_notify (Slack) and the
/notification-prefs/check route (desktop host).

SAFETY RULE: nothing here is consulted by the Needs-you queue. Muting suppresses
alerts; an actionable item still appears where the person acts on it.
"""

import copy
import re
import time
from datetime import datetime, timezone
from typing import Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from portal_backend import sql

# ---------------------------------------------------------------------------- catalog

CATEGORIES = (
    {
        "key": "approvals",
        "label": "Approvals & verifications",
        "description": "Plans waiting for approval, finished work to verify, and decisions on them.",
    },
    {
        "key": "requests",
        "label": "Requests & questions to me",
        "description": "Questions and requests from agents or teammates, and their answers.",
    },
    {
        "key": "escalations",
        "label": "Escalations & blockers",
        "description": "Escalated requests, rejected work and agents that are stuck.",
    },
    {
        "key": "budget",
        "label": "Budget alerts",
        "description": "Spend warnings and hard stops.",
    },
    {
        "key": "tasks",
        "label": "Task assignment & status changes",
        "description": "Tasks assigned, unassigned, ready or re-parented.",
    },
    {
        "key": "messages",
        "label": "Agent messages & mentions",
        "description": "Task-thread messages and messages addressed to you.",
    },
    {
        "key": "routines",
        "label": "Routine runs",
        "description": "Scheduled routines starting, failing or creating work.",
    },
    {
        "key": "verdikt",
        "label": "Verdikt / evidence results",
        "description": "QA runs and evidence attached to finished work.",
    },
    {
        "key": "settings",
        "label": "Membership & settings changes",
        "description": "People joining or leaving, role and permission changes.",
    },
)
CATEGORY_KEYS = tuple(c["key"] for c in CATEGORIES)

CHANNELS = (
    {"key": "in_app", "label": "In-app", "alert": False},
    {"key": "desktop", "label": "Desktop", "alert": True},
    {"key": "push", "label": "Mobile push", "alert": True},
    {"key": "slack", "label": "Slack", "alert": True},
)
CHANNEL_KEYS = tuple(c["key"] for c in CHANNELS)
# Quiet hours hold these; in-app keeps collecting.
ALERT_CHANNELS = tuple(c["key"] for c in CHANNELS if c["alert"])

SCOPES = (
    {"key": "all", "label": "All"},
    {"key": "mine", "label": "Only mine"},
    {"key": "off", "label": "Off"},
)
SCOPE_KEYS = tuple(s["key"] for s in SCOPES)

FALLBACK_CATEGORY = "tasks"

# Every known kind -> exactly one category. Sources: bus event_names
# (notification_taxonomy + publish_event call sites), audit event_types that describe a
# person-worthy change, push outbox kinds (push_outbox.TITLE_BY_KIND) and the desktop
# host's attention kinds (desktop/src/main/attention.ts).
KIND_TO_CATEGORY = {
    # approvals & verifications
    "task_verify": "approvals",            # push outbox + desktop: a task parked at needs_verification
    "plan_approval": "approvals",          # push outbox: opening plan posted
    "task_plan": "approvals",              # desktop: plan waiting for approval
    "task_verified": "approvals",
    "verdikt_autofix_stopped": "approvals",  # mig 068: auto-fix loop handed the task to a person
    "decision_made": "approvals",
    "agent_suggested": "approvals",
    "agent_suggestion_decided": "approvals",
    "manager_review_recorded": "approvals",
    # requests & questions to me
    "request_created": "requests",
    "request": "requests",                 # push outbox: request opened targeting a human
    "request_answer": "requests",          # desktop: open request waiting on a human
    "request_close": "requests",           # desktop: answered request a human raised
    "request_answered": "requests",
    "request_closed": "requests",
    "task_request_accepted": "requests",
    # escalations & blockers
    "request_escalated": "escalations",
    "task_request_rejected": "escalations",
    "wake_backoff_breaker": "escalations",
    # budget
    "budget_warning": "budget",
    "budget_paused": "budget",
    "budget_updated": "budget",
    "budget_override_granted": "budget",
    "budget_override_revoked": "budget",
    # task assignment & status changes
    "task_assigned": "tasks",
    "task_ready": "tasks",
    "task_unassigned": "tasks",
    "task_created": "tasks",
    "task_created_unassigned": "tasks",
    "task_parent_changed": "tasks",
    "task_deliverable_added": "tasks",
    "worker_run_finished": "tasks",
    # agent messages & mentions
    "task_message": "messages",
    "prompt": "messages",
    "conversation_reply": "messages",
    # routine runs
    "routine_created": "routines",
    "routines_created": "routines",
    "routine_deleted": "routines",
    "routine_failed": "routines",
    "routine_run_requested": "routines",
    "routine_task_created": "routines",
    # verdikt / evidence
    "verdikt_triggered": "verdikt",
    "verdikt_run": "verdikt",
    "verdikt_cancelled": "verdikt",
    # membership & settings
    "member_invited": "settings",
    "member_removed": "settings",
    "member_role_changed": "settings",
    "member_grants_changed": "settings",
    "member_demoted_to_viewer": "settings",
    "github_identity_bound": "settings",
    "verdikt_settings_changed": "settings",
}

# Unknown kinds: first matching prefix wins, else FALLBACK_CATEGORY.
_PREFIX_FALLBACK = (
    ("budget", "budget"),
    ("routine", "routines"),
    ("verdikt", "verdikt"),
    ("evidence", "verdikt"),
    ("member", "settings"),
    ("settings", "settings"),
    ("escalat", "escalations"),
    ("request", "requests"),
    ("plan", "approvals"),
    ("verif", "approvals"),
    ("decision", "approvals"),
    ("message", "messages"),
    ("conversation", "messages"),
    ("task", "tasks"),
)

# A budget HARD STOP: the project stopped spending. Always reaches in-app.
CRITICAL_KINDS = frozenset({"budget_paused"})
# (category, channel) pairs that can't be turned off, with the tooltip text.
LOCKS = {
    ("budget", "in_app"): "Budget hard stops always show in the app, so a paused project never goes unnoticed.",
}

# Which entity an event's ref_id names (for the "Only mine" test).
REF_KIND_BY_KIND = {
    "task_verify": "task",
    "plan_approval": "task",
    "task_plan": "task",
    "request": "request",
    "request_answer": "request",
    "request_close": "request",
}


def category_for(kind: Optional[str]) -> str:
    """The one category a kind belongs to (unknown kinds degrade by prefix)."""
    k = (kind or "").strip().lower()
    if k in KIND_TO_CATEGORY:
        return KIND_TO_CATEGORY[k]
    for prefix, cat in _PREFIX_FALLBACK:
        if k.startswith(prefix):
            return cat
    return FALLBACK_CATEGORY


def _rule(scope: str, *on: str) -> dict:
    return {"scope": scope, "channels": {c: (c in on) for c in CHANNEL_KEYS}}


_ALL = CHANNEL_KEYS

# Shipped defaults: every channel that fired before mig 063 stays on (no regression):
# push + desktop + Slack for approvals/requests, desktop for follow-ups.
BUILTIN_RULES = {
    "approvals": _rule("all", *_ALL),
    "requests": _rule("all", *_ALL),
    "escalations": _rule("all", *_ALL),
    "budget": _rule("all", *_ALL),
    "tasks": _rule("mine", "in_app", "desktop"),
    "messages": _rule("mine", "in_app", "desktop"),
    "routines": _rule("all", "in_app"),
    "verdikt": _rule("all", "in_app", "desktop"),
    "settings": _rule("all", "in_app"),
}

PRESETS = (
    {
        "key": "everything",
        "label": "Everything",
        "description": "Every category, on every channel.",
        "rules": {k: _rule("all", *_ALL) for k in CATEGORY_KEYS},
    },
    {
        "key": "needs_me",
        "label": "Only what needs me",
        "description": "Approvals, requests, escalations and budget that are yours; the rest stays quiet.",
        "rules": {
            "approvals": _rule("mine", *_ALL),
            "requests": _rule("mine", *_ALL),
            "escalations": _rule("mine", *_ALL),
            "budget": _rule("mine", *_ALL),
            "tasks": _rule("mine", "in_app"),
            "messages": _rule("mine", "in_app"),
            "routines": _rule("off", "in_app"),
            "verdikt": _rule("off", "in_app"),
            "settings": _rule("off", "in_app"),
        },
    },
    {
        "key": "critical",
        "label": "Nothing but critical",
        "description": "Only budget alerts. Everything else still waits in Needs you.",
        "rules": {
            **{k: _rule("off", "in_app") for k in CATEGORY_KEYS},
            "budget": _rule("all", *_ALL),
        },
    },
)


def builtin_rules() -> dict:
    return copy.deepcopy(BUILTIN_RULES)


def catalog() -> dict:
    """The static vocabulary the UI renders from (served on GET)."""
    return {
        "categories": [dict(c) for c in CATEGORIES],
        "channels": [dict(c) for c in CHANNELS],
        "scopes": [dict(s) for s in SCOPES],
        "presets": copy.deepcopy(list(PRESETS)),
        "locks": [
            {"category": cat, "channel": ch, "reason": why} for (cat, ch), why in LOCKS.items()
        ],
        "kinds": dict(KIND_TO_CATEGORY),
    }


# ------------------------------------------------------------------------- validation


class PrefsError(ValueError):
    """A plain-words validation failure (the routes turn it into a 422)."""


_HHMM = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
MAX_PAUSE_SECONDS = 366 * 24 * 3600


def validate_rules(raw, *, require_complete: bool = False) -> dict:
    """Validate a {category: {scope?, channels?}} map. Returns a clean copy.

    A project override may carry only some fields of a category (merged over the
    defaults at resolve time); the defaults row is stored complete."""
    if not isinstance(raw, dict):
        raise PrefsError("rules must be an object keyed by category")
    out = {}
    for cat, rule in raw.items():
        if cat not in CATEGORY_KEYS:
            raise PrefsError(f"unknown notification category '{cat}'")
        if not isinstance(rule, dict):
            raise PrefsError(f"the rule for '{cat}' must be an object")
        unknown = sorted(k for k in rule if k not in ("scope", "channels"))
        if unknown:
            raise PrefsError(f"unknown field(s) for '{cat}': {', '.join(unknown)}")
        clean = {}
        if "scope" in rule:
            if rule["scope"] not in SCOPE_KEYS:
                raise PrefsError(f"scope for '{cat}' must be one of: all, mine, off")
            clean["scope"] = rule["scope"]
        if "channels" in rule:
            chans = rule["channels"]
            if not isinstance(chans, dict):
                raise PrefsError(f"channels for '{cat}' must be an object")
            cleanc = {}
            for ch, on in chans.items():
                if ch not in CHANNEL_KEYS:
                    raise PrefsError(f"unknown channel '{ch}'")
                if not isinstance(on, bool):
                    raise PrefsError(f"channel '{ch}' for '{cat}' must be true or false")
                if not on and (cat, ch) in LOCKS:
                    raise PrefsError(LOCKS[(cat, ch)] + " It can't be turned off.")
                cleanc[ch] = on
            clean["channels"] = cleanc
        out[cat] = clean
    if require_complete:
        full = builtin_rules()
        for cat, rule in out.items():
            full[cat] = _merge_rule(full[cat], rule)
        out = full
    return out


def validate_pause(raw, now: Optional[float] = None):
    """None (not paused) or {"until": epoch-seconds | None (until turned back on)}."""
    if raw is None:
        return None
    if not isinstance(raw, dict) or set(raw) - {"until"}:
        raise PrefsError("pause must be null or {until: <time> | null}")
    until = raw.get("until")
    if until is None:
        return {"until": None}
    if isinstance(until, bool) or not isinstance(until, (int, float)):
        raise PrefsError("pause until must be a time (seconds since epoch) or null")
    now = time.time() if now is None else now
    if until <= now:
        raise PrefsError("pause must end in the future")
    if until > now + MAX_PAUSE_SECONDS:
        raise PrefsError("pause can't be longer than a year — choose 'until I turn it back on'")
    return {"until": float(until)}


def validate_quiet_hours(raw):
    """None (off) or {start: "HH:MM", end: "HH:MM", tz: IANA zone}."""
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise PrefsError("quiet hours must be null or {start, end, tz}")
    unknown = sorted(set(raw) - {"start", "end", "tz"})
    if unknown:
        raise PrefsError(f"unknown quiet-hours field(s): {', '.join(unknown)}")
    start, end, tz = raw.get("start"), raw.get("end"), raw.get("tz")
    for name, v in (("start", start), ("end", end)):
        if not isinstance(v, str) or not _HHMM.match(v):
            raise PrefsError(f"quiet hours {name} must be a 24-hour time like 22:00")
    if start == end:
        raise PrefsError("quiet hours need a start and an end that differ")
    if not isinstance(tz, str) or not tz.strip():
        raise PrefsError("quiet hours need a time zone")
    try:
        ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError):
        raise PrefsError(f"'{tz}' isn't a time zone we recognise (use e.g. Europe/London)")
    return {"start": start, "end": end, "tz": tz}


# ------------------------------------------------------------------------- resolution


def _merge_rule(base: dict, over: Optional[dict]) -> dict:
    out = {"scope": base["scope"], "channels": dict(base["channels"])}
    if over:
        if "scope" in over:
            out["scope"] = over["scope"]
        out["channels"].update(over.get("channels") or {})
    return out


def _safe_rules(raw) -> dict:
    """Tolerant read of a stored rules map: drop anything no longer valid."""
    out = {}
    if not isinstance(raw, dict):
        return out
    for cat, rule in raw.items():
        if isinstance(rule, dict) and isinstance(rule.get("channels"), dict):
            # a locked channel stored as off is read as on — never drop the whole rule
            rule = {**rule, "channels": {
                ch: (True if (cat, ch) in LOCKS else on) for ch, on in rule["channels"].items()
            }}
        try:
            out.update(validate_rules({cat: rule}))
        except PrefsError:
            continue
    return out


def resolve(defaults_doc: Optional[dict], project_doc: Optional[dict]) -> dict:
    """Effective prefs: built-in ← person defaults ← project override."""
    d = defaults_doc or {}
    p = project_doc or {}
    rules = builtin_rules()
    for layer in (_safe_rules(d.get("rules")), _safe_rules(p.get("rules"))):
        for cat, over in layer.items():
            rules[cat] = _merge_rule(rules[cat], over)
    for (cat, ch) in LOCKS:
        rules[cat]["channels"][ch] = True
    try:
        quiet = validate_quiet_hours(d.get("quiet_hours"))
    except PrefsError:
        quiet = None
    pause = d.get("pause")
    if not (isinstance(pause, dict) and (pause.get("until") is None or isinstance(pause.get("until"), (int, float)))):
        pause = None
    return {
        "rules": rules,
        "pause": pause,
        "quiet_hours": quiet,
        "muted": bool(p.get("muted")),
    }


def _epoch(now) -> float:
    if now is None:
        return time.time()
    if isinstance(now, datetime):
        if now.tzinfo is None:
            now = now.replace(tzinfo=timezone.utc)
        return now.timestamp()
    return float(now)


def is_paused(prefs: dict, now=None) -> bool:
    pause = (prefs or {}).get("pause")
    if not pause:
        return False
    until = pause.get("until")
    return until is None or _epoch(now) < float(until)


def in_quiet_hours(quiet: Optional[dict], now=None) -> bool:
    """Is `now` inside the [start, end) local-time window? Handles windows that cross
    midnight (22:00→07:00) and any IANA zone (DST-correct via zoneinfo)."""
    if not quiet:
        return False
    try:
        tz = ZoneInfo(quiet["tz"])
        sh, sm = (int(x) for x in quiet["start"].split(":"))
        eh, em = (int(x) for x in quiet["end"].split(":"))
    except Exception:
        return False
    local = datetime.fromtimestamp(_epoch(now), tz)
    t = local.hour * 60 + local.minute
    start, end = sh * 60 + sm, eh * 60 + em
    if start == end:
        return False
    if start < end:
        return start <= t < end
    return t >= start or t < end


def decide(prefs: dict, event: dict, channel: str, now=None) -> tuple[bool, str]:
    """(notify?, reason). PURE. `prefs` is an EFFECTIVE prefs dict (resolve()).

    event: {"kind": str, "category"?: str, "mine"?: bool, "critical"?: bool}
      - mine: the event is about the person (assigned to them, their request, their
        review, or they manage the agent involved). Absent = not known to be theirs.
      - critical defaults from CRITICAL_KINDS.
    Order: critical in-app lock → project mute → pause → category scope → channel
    switch → quiet hours (alert channels only)."""
    if channel not in CHANNEL_KEYS:
        return False, "unknown_channel"
    prefs = prefs if prefs and "rules" in prefs else resolve(None, None)
    kind = event.get("kind")
    category = event.get("category") or category_for(kind)
    if category not in CATEGORY_KEYS:
        category = FALLBACK_CATEGORY
    critical = bool(event.get("critical", (kind or "") in CRITICAL_KINDS))
    if critical and channel == "in_app":
        return True, "critical"
    if prefs.get("muted"):
        return False, "project_muted"
    if is_paused(prefs, now):
        return False, "paused"
    rule = prefs["rules"].get(category) or BUILTIN_RULES[category]
    if rule["scope"] == "off":
        return False, "category_off"
    if rule["scope"] == "mine" and not event.get("mine", False):
        return False, "not_mine"
    if not rule["channels"].get(channel, False):
        return False, "channel_off"
    if channel in ALERT_CHANNELS and in_quiet_hours(prefs.get("quiet_hours"), now):
        return False, "quiet_hours"
    return True, "allowed"


def should_notify(prefs: dict, event: dict, channel: str, now=None) -> bool:
    """THE decision every delivery path asks (bell, push, Slack, desktop)."""
    return decide(prefs, event, channel, now)[0]


# ---------------------------------------------------------------------- DB helpers

LOCAL_IDENTITY = "__local__"  # the self-host single-operator sentinel (as user_pref_routes)


def identity_key(member) -> str:
    login = (member or {}).get("github_login")
    return login.strip().lower() if login and login.strip() else LOCAL_IDENTITY


def tables_ready(cur) -> bool:
    """False on a half-migrated stack — delivery then behaves exactly as pre-063."""
    cur.execute(
        f"SELECT {sql.table_exists('notification_prefs')} AS a,"
        f" {sql.table_exists('notification_pref_defaults')} AS b"
    )
    row = cur.fetchone()
    return bool(row and row["a"] and row["b"])


def load_docs(cur, member) -> tuple[Optional[dict], Optional[dict]]:
    cur.execute(
        "SELECT prefs FROM notification_pref_defaults WHERE identity_key=%s",
        (identity_key(member),),
    )
    d = cur.fetchone()
    cur.execute(
        "SELECT prefs FROM notification_prefs WHERE member_agent_id=%s",
        (str(member["id"]),),
    )
    p = cur.fetchone()
    return (d["prefs"] if d else None), (p["prefs"] if p else None)


def effective_for_member(cur, member) -> dict:
    if not tables_ready(cur):
        return resolve(None, None)
    return resolve(*load_docs(cur, member))


def container_humans(cur, container_id) -> list:
    cur.execute(
        """SELECT id, alias, github_login, member_role, container_id FROM agents
           WHERE container_id=%s AND kind='human' AND terminated_at IS NULL
           ORDER BY created_at ASC, id ASC""",
        (str(container_id),),
    )
    return cur.fetchall()


def _manager_ids(cur, agent_id) -> set:
    from portal_backend.org_chart import manager_chain

    try:
        return {str(m["id"]) for m in manager_chain(cur, agent_id)}
    except Exception:
        return set()


def _task_is_mine(cur, member, task_id) -> bool:
    me = str(member["id"])
    cur.execute(
        "SELECT reviewer_agent_id, created_by_agent_id FROM tasks WHERE id=%s",
        (str(task_id),),
    )
    t = cur.fetchone()
    if not t:
        return False
    if str(t.get("reviewer_agent_id") or "") == me or str(t.get("created_by_agent_id") or "") == me:
        return True
    cur.execute(
        """SELECT agent_id FROM agent_tasks WHERE task_id=%s
             AND assignment_status IN ('assigned','accepted','working','done')""",
        (str(task_id),),
    )
    assignees = [str(r["agent_id"]) for r in cur.fetchall()]
    if me in assignees:
        return True
    if any(me in _manager_ids(cur, a) for a in assignees):
        return True
    # no named reviewer: the project's owners are the default verifiers
    return t.get("reviewer_agent_id") is None and member.get("member_role") == "owner"


def _request_is_mine(cur, member, request_id) -> bool:
    me = str(member["id"])
    cur.execute(
        "SELECT target_id, requester_id FROM requests WHERE id=%s", (str(request_id),)
    )
    r = cur.fetchone()
    if not r:
        return False
    target, requester = str(r.get("target_id") or ""), str(r.get("requester_id") or "")
    if me in (target, requester):
        return True
    if not target and member.get("member_role") == "owner":
        return True  # unspecified target resolves to the human (Orcha#30)
    return bool(requester) and me in _manager_ids(cur, requester)


def is_mine(cur, member, kind, ref_id=None, ref_kind=None) -> bool:
    """Is this event about `member`? (assigned to me, my request, my review, or I manage
    the agent involved). Project-level events (budget, routines, settings) belong to the
    project's owners."""
    ref_kind = ref_kind or REF_KIND_BY_KIND.get(kind)
    try:
        if ref_id and ref_kind == "task":
            return _task_is_mine(cur, member, ref_id)
        if ref_id and ref_kind == "request":
            return _request_is_mine(cur, member, ref_id)
    except Exception:
        return False
    return member.get("member_role") == "owner"


def allowed_members(cur, container_id, kind, ref_id, channel, now=None, *,
                    ref_kind=None, members=None, extra_event=None) -> list:
    """The container's live human members whose prefs let this event through `channel`."""
    members = container_humans(cur, container_id) if members is None else members
    if not members:
        return []
    ready = tables_ready(cur)
    out = []
    for m in members:
        prefs = resolve(*load_docs(cur, m)) if ready else resolve(None, None)
        event = {"kind": kind, "mine": is_mine(cur, m, kind, ref_id, ref_kind)}
        if extra_event:
            event.update(extra_event)
        if should_notify(prefs, event, channel, now):
            out.append(m)
    return out


def container_wants(cur, container_id, kind, ref_id, channel, now=None, *, ref_kind=None) -> bool:
    """For a SHARED channel (the project's Slack webhook): post when at least one member
    wants it. A project with no human members keeps the pre-063 behaviour (post)."""
    members = container_humans(cur, container_id)
    if not members:
        return True
    return bool(allowed_members(cur, container_id, kind, ref_id, channel, now,
                                ref_kind=ref_kind, members=members))
