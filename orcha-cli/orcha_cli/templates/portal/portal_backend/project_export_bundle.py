"""Portable project templates — the bundle format, scrubbing, validation and import PLAN.

Pure logic (no FastAPI, no DB): project_export_routes.py loads rows, calls these helpers
and applies the plan. Keeping the decisions here makes every rule unit-testable.

Bundle format ``orcha.project-template`` v1 (JSON)::

    {
      "format": "orcha.project-template", "version": 1,
      "exported_at": "...Z", "source": {"project_name": "..."},
      "includes": ["roster", "routines", "dod_presets", "skills", "budgets"?],
      "roster": [{alias, role, system_prompt, model, reasoning_effort,
                  auto_wake_interval_secs, autonomy_override,
                  reports_to: {kind: "agent"|"human_seat", ref} | null}],
      "human_seats": [{ref: "human-1", label}],       # managers who are people, anonymised
      "routines": [{title, description, definition_of_done, assignee (AI alias) | null,
                    priority, cron, timezone, enabled, skip_if_open}],
      "dod_presets": [{name, body}],
      "skills": [{name, description, body}],
      "budgets": {"project": {monthly_limit_usd, monthly_limit_tokens} | null,
                  "agents": [{alias, monthly_limit_usd, monthly_limit_tokens}]},   # opt-in
      "scrub": {"redactions": [{field, kinds}], "never_exported": [...]},
      "digest": "sha256:<hex of the canonical JSON of everything else>"
    }

What is NEVER exported: provider / LLM keys, GitHub PATs / app bindings, device, run and
pairing tokens, member identities (human aliases, GitHub logins, git emails, member
roles / grants), and all history (tasks, requests, runs, conversations, spend, budget
overrides). Humans only appear as anonymous ``human_seats`` when an AI reports to one.
Free text (prompts, roles, routine texts, presets, skills) is scrubbed: secret-looking
substrings, e-mail addresses and the project's member identities are replaced and the
field is listed in ``scrub.redactions``.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from portal_backend.agent_config_history_routes import REDACTION
from portal_backend.agent_config_history_routes import redact as _redact_known_secrets
from portal_backend.limits import MAX_DESC_LEN, MAX_DOD_LEN, MAX_NAME_LEN, MAX_PROMPT_LEN
from portal_backend.model_policy import (
    DEFAULT_MODEL,
    MODEL_IDS,
    MODELS_BY_ID,
    REASONING_EFFORT_IDS_BY_MODEL,
)
from portal_backend import routine_schedule as sched

FORMAT = "orcha.project-template"
VERSION = 1
SECTIONS = ("roster", "routines", "dod_presets", "skills", "budgets")

MEMBER = "[member]"
EMAIL = "[email]"

MAX_ROSTER = 100
MAX_ROUTINES = 200
MAX_PRESETS = 200
MAX_SKILLS = 100
MAX_SEATS = 50
PRESET_NAME_MAX = 120
PRESET_BODY_MAX = 4000
SKILL_DESC_MAX = 300
SKILL_BODY_MAX = 20000
SKILL_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
MAX_USD = 1_000_000
MAX_TOKENS = 10_000_000_000_000
MIN_AUTO_WAKE = 60

NEVER_EXPORTED = [
    "provider and LLM API keys",
    "GitHub tokens, PATs and repository bindings",
    "device, pairing and agent run tokens",
    "member identities (human names, GitHub logins, e-mails, roles and permissions)",
    "history: tasks, requests, runs, conversations, memory and spend",
    "budget overrides and notices",
]


# --------------------------------------------------------------------------- scrubbing
# Order matters: `key=value` assignments first (keeps the key name, redacts the value),
# then the well-known key shapes (shared with agent config history), then generic shapes.
_KV_SECRET = re.compile(
    r"(?i)\b(api[_-]?key|secret(?:[_-]?key)?|access[_-]?key|client[_-]?secret|token|"
    r"password|passwd|pwd|auth)(\s*[:=]\s*)(['\"]?)(?!\[redacted)[^\s'\"]{6,}\3"
)
_EXTRA_SECRETS = [
    # JWTs
    re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"),
    # Slack incoming-webhook URLs
    re.compile(r"https://hooks\.slack\.com/services/[A-Za-z0-9/_-]+"),
]
_BEARER = re.compile(r"(?i)\b(bearer\s+)(?!\[redacted)[A-Za-z0-9._~+/=-]{16,}")
_URL_CREDS = re.compile(r"(?i)\b([a-z][a-z0-9+.-]*://)[^\s/:@]+:[^\s/@]+@")
# A long random-looking run (Orcha's own run / device tokens are token_urlsafe(32)):
# >= 32 url-safe chars mixing upper, lower and digits. UUIDs (lowercase hex) never match.
_HIGH_ENTROPY = re.compile(r"(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])")
_EMAIL = re.compile(r"(?i)\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b")


def _is_random(tok: str) -> bool:
    return (
        any(c.isupper() for c in tok)
        and any(c.islower() for c in tok)
        and any(c.isdigit() for c in tok)
    )


def scrub_secrets(text: str) -> str:
    out = _KV_SECRET.sub(lambda m: m.group(1) + m.group(2) + REDACTION, text)
    out, _ = _redact_known_secrets(out)
    for pat in _EXTRA_SECRETS:
        out = pat.sub(REDACTION, out)
    out = _BEARER.sub(lambda m: m.group(1) + REDACTION, out)
    out = _URL_CREDS.sub(lambda m: m.group(1) + "[redacted]@", out)
    out = _HIGH_ENTROPY.sub(lambda m: REDACTION if _is_random(m.group(0)) else m.group(0), out)
    return out


def identity_patterns(identities) -> list[re.Pattern]:
    """Word-bounded, case-insensitive patterns for member identities (aliases, logins,
    e-mails). Anything shorter than 3 chars is ignored (too likely to be a real word)."""
    seen, pats = set(), []
    for ident in sorted({(i or "").strip() for i in identities}, key=len, reverse=True):
        if len(ident) < 3 or ident.lower() in seen:
            continue
        seen.add(ident.lower())
        pats.append(re.compile(r"(?<![\w.-])@?" + re.escape(ident) + r"(?![\w-])", re.I))
    return pats


def scrub_text(value, id_patterns) -> tuple[Optional[str], list[str]]:
    """Scrub one free-text value. Returns (scrubbed, kinds) — kinds ⊆ secret/email/member."""
    if not isinstance(value, str) or not value:
        return value, []
    kinds = []
    out = scrub_secrets(value)
    if out != value:
        kinds.append("secret")
    step = _EMAIL.sub(EMAIL, out)
    if step != out:
        kinds.append("email")
    out = step
    step = out
    for pat in id_patterns:
        step = pat.sub(MEMBER, step)
    if step != out:
        kinds.append("member_identity")
    return step, kinds


def contains_secret(value) -> bool:
    return isinstance(value, str) and bool(value) and scrub_secrets(value) != value


# --------------------------------------------------------------------------- digest
def canonical(obj) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)


def bundle_digest(bundle: dict) -> str:
    body = {k: v for k, v in bundle.items() if k != "digest"}
    return "sha256:" + hashlib.sha256(canonical(body).encode()).hexdigest()


# --------------------------------------------------------------------------- export
def _num(v):
    if v is None:
        return None
    f = float(v)
    return int(f) if f.is_integer() else f


def build_bundle(
    *,
    project_name: Optional[str],
    ai_agents: list[dict],
    humans: list[dict],
    routines: list[dict],
    presets: list[dict],
    skills: list[dict],
    include_budgets: bool = False,
    project_budget: Optional[dict] = None,
    agent_budgets: Optional[list[dict]] = None,
    now: Optional[datetime] = None,
) -> dict:
    """Build a scrubbed v1 bundle from plain rows.

    ai_agents: live AI rows {id, alias, role, system_prompt, model, reasoning_effort,
               auto_wake_interval_secs, autonomy_override, reports_to_agent_id}
    humans:    every human row of the project (live or not) {id, alias, github_login,
               git_email} — used ONLY to recognise and scrub identities / seat refs.
    routines:  live routine rows {title, description, definition_of_done,
               assignee_agent_id, priority, cron, timezone, enabled, skip_if_open}
    """
    ids = []
    for h in humans:
        ids += [h.get("alias"), h.get("github_login"), h.get("git_email")]
    id_pats = identity_patterns(ids)
    redactions: list[dict] = []

    def clean(where: str, value, limit: Optional[int] = None):
        out, kinds = scrub_text(value, id_pats)
        # A placeholder can be LONGER than what it replaced ("token=abc123" →
        # "token=[redacted secret]"), so a near-limit field could leave the export
        # un-importable by its own validation. Trim back to the field's limit.
        if limit is not None and isinstance(out, str) and len(out) > limit:
            out = out[:limit]
            kinds = [*kinds, "trimmed"]
        if kinds:
            redactions.append({"field": where, "kinds": kinds})
        return out

    ai_by_id = {str(a["id"]): a for a in ai_agents}
    human_ids = {str(h["id"]) for h in humans}
    seat_of: dict[str, str] = {}

    def seat(hid: str) -> str:
        if hid not in seat_of:
            seat_of[hid] = f"human-{len(seat_of) + 1}"
        return seat_of[hid]

    roster = []
    for a in ai_agents:
        mgr = str(a["reports_to_agent_id"]) if a.get("reports_to_agent_id") else None
        reports_to = None
        if mgr and mgr in ai_by_id:
            reports_to = {"kind": "agent", "ref": ai_by_id[mgr]["alias"]}
        elif mgr and mgr in human_ids:
            reports_to = {"kind": "human_seat", "ref": seat(mgr)}
        alias = a["alias"]
        roster.append({
            "alias": alias,
            "role": clean(f"roster[{alias}].role", a.get("role"), MAX_NAME_LEN),
            "system_prompt": clean(f"roster[{alias}].system_prompt", a.get("system_prompt"), MAX_PROMPT_LEN),
            "model": a.get("model"),
            "reasoning_effort": a.get("reasoning_effort"),
            "auto_wake_interval_secs": a.get("auto_wake_interval_secs"),
            "autonomy_override": a.get("autonomy_override"),
            "reports_to": reports_to,
        })

    out_routines = []
    for i, r in enumerate(routines):
        tag = f"routines[{i + 1}]"
        asg = str(r["assignee_agent_id"]) if r.get("assignee_agent_id") else None
        out_routines.append({
            "title": clean(f"{tag}.title", r["title"], MAX_NAME_LEN),
            "description": clean(f"{tag}.description", r.get("description"), MAX_DESC_LEN),
            "definition_of_done": clean(f"{tag}.definition_of_done", r["definition_of_done"], MAX_DOD_LEN),
            "assignee": ai_by_id[asg]["alias"] if asg in ai_by_id else None,
            "priority": r.get("priority", 100),
            "cron": r["cron"],
            "timezone": r.get("timezone") or "UTC",
            "enabled": bool(r.get("enabled", True)),
            "skip_if_open": bool(r.get("skip_if_open", True)),
        })

    out_presets = [
        {"name": clean(f"dod_presets[{p['name']}].name", p["name"], PRESET_NAME_MAX),
         "body": clean(f"dod_presets[{p['name']}].body", p["body"], PRESET_BODY_MAX)}
        for p in presets
    ]
    out_skills = [
        {"name": s["name"],
         "description": clean(f"skills[{s['name']}].description", s.get("description"), SKILL_DESC_MAX),
         "body": clean(f"skills[{s['name']}].body", s["body"], SKILL_BODY_MAX)}
        for s in skills
    ]

    bundle = {
        "format": FORMAT,
        "version": VERSION,
        "exported_at": (now or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": {"project_name": project_name},
        "includes": [s for s in SECTIONS if s != "budgets" or include_budgets],
        "roster": roster,
        "human_seats": [
            {"ref": ref, "label": f"Human seat {ref.split('-')[1]}"} for ref in seat_of.values()
        ],
        "routines": out_routines,
        "dod_presets": out_presets,
        "skills": out_skills,
    }
    if include_budgets:
        pb = project_budget or {}
        project = None
        if pb.get("monthly_limit_usd") is not None or pb.get("monthly_limit_tokens") is not None:
            project = {"monthly_limit_usd": _num(pb.get("monthly_limit_usd")),
                       "monthly_limit_tokens": pb.get("monthly_limit_tokens")}
        agents = []
        for b in agent_budgets or []:
            aid = str(b["agent_id"])
            if aid not in ai_by_id:
                continue
            if b.get("monthly_limit_usd") is None and b.get("monthly_limit_tokens") is None:
                continue
            agents.append({"alias": ai_by_id[aid]["alias"],
                           "monthly_limit_usd": _num(b.get("monthly_limit_usd")),
                           "monthly_limit_tokens": b.get("monthly_limit_tokens")})
        bundle["budgets"] = {"project": project, "agents": agents}
    bundle["scrub"] = {"redactions": redactions, "never_exported": list(NEVER_EXPORTED)}
    bundle["digest"] = bundle_digest(bundle)
    return bundle


# --------------------------------------------------------------------------- validation
class _M(BaseModel):
    model_config = ConfigDict(extra="ignore")


def _not_blank(v):
    """Required free text must carry something (a hand-edited bundle can hold "   ",
    which would otherwise create an agent with no prompt or hit a DB CHECK → 500)."""
    if isinstance(v, str) and not v.strip():
        raise ValueError("can't be blank")
    return v


class BundleReportsTo(_M):
    kind: Literal["agent", "human_seat"]
    ref: str = Field(..., min_length=1, max_length=64)


class BundleAgent(_M):
    alias: str = Field(..., min_length=1, max_length=64)
    role: str = Field(..., min_length=1, max_length=MAX_NAME_LEN)
    system_prompt: str = Field(..., min_length=1, max_length=MAX_PROMPT_LEN)
    model: Optional[str] = Field(default=None, max_length=64)
    reasoning_effort: Optional[str] = Field(default=None, max_length=16)
    auto_wake_interval_secs: Optional[int] = Field(default=None, ge=0, le=10_000_000)
    autonomy_override: Optional[Literal["plan", "pr", "full"]] = None
    reports_to: Optional[BundleReportsTo] = None

    @field_validator("alias")
    @classmethod
    def _alias(cls, v):
        v = v.strip()
        if not v:
            raise ValueError("alias is empty")
        return v

    @field_validator("role", "system_prompt")
    @classmethod
    def _text(cls, v):
        return _not_blank(v)


class BundleSeat(_M):
    ref: str = Field(..., min_length=1, max_length=64)
    label: Optional[str] = Field(default=None, max_length=200)


class BundleRoutine(_M):
    title: str = Field(..., min_length=1, max_length=MAX_NAME_LEN)
    description: Optional[str] = Field(default=None, max_length=MAX_DESC_LEN)
    definition_of_done: str = Field(..., min_length=1, max_length=MAX_DOD_LEN)
    assignee: Optional[str] = Field(default=None, max_length=64)
    priority: int = Field(default=100, ge=0, le=100000)
    cron: str = Field(..., min_length=1, max_length=200)
    timezone: str = Field(default="UTC", max_length=64)
    enabled: bool = True
    skip_if_open: bool = True

    @field_validator("title", "definition_of_done", "cron")
    @classmethod
    def _text(cls, v):
        return _not_blank(v)


class BundlePreset(_M):
    name: str = Field(..., min_length=1, max_length=PRESET_NAME_MAX)
    body: str = Field(..., min_length=1, max_length=PRESET_BODY_MAX)

    @field_validator("name", "body")
    @classmethod
    def _text(cls, v):
        return _not_blank(v)


class BundleSkill(_M):
    name: str = Field(..., min_length=1, max_length=63)
    description: Optional[str] = Field(default=None, max_length=SKILL_DESC_MAX)
    body: str = Field(..., min_length=1, max_length=SKILL_BODY_MAX)

    @field_validator("name")
    @classmethod
    def _name(cls, v):
        if not SKILL_NAME_RE.match(v):
            raise ValueError("skill names are lowercase letters, digits and dashes")
        return v

    @field_validator("body")
    @classmethod
    def _body(cls, v):
        return _not_blank(v)


class BundleLimits(_M):
    monthly_limit_usd: Optional[float] = Field(default=None, ge=0, le=MAX_USD)
    monthly_limit_tokens: Optional[int] = Field(default=None, ge=0, le=MAX_TOKENS)


class BundleAgentBudget(BundleLimits):
    alias: str = Field(..., min_length=1, max_length=64)


class BundleBudgets(_M):
    project: Optional[BundleLimits] = None
    agents: list[BundleAgentBudget] = Field(default_factory=list, max_length=MAX_ROSTER)


class BundleSource(_M):
    project_name: Optional[str] = Field(default=None, max_length=MAX_NAME_LEN)


class ProjectTemplateBundle(_M):
    format: Literal["orcha.project-template"]
    version: int
    exported_at: Optional[str] = Field(default=None, max_length=64)
    source: BundleSource = Field(default_factory=BundleSource)
    roster: list[BundleAgent] = Field(default_factory=list, max_length=MAX_ROSTER)
    human_seats: list[BundleSeat] = Field(default_factory=list, max_length=MAX_SEATS)
    routines: list[BundleRoutine] = Field(default_factory=list, max_length=MAX_ROUTINES)
    dod_presets: list[BundlePreset] = Field(default_factory=list, max_length=MAX_PRESETS)
    skills: list[BundleSkill] = Field(default_factory=list, max_length=MAX_SKILLS)
    budgets: Optional[BundleBudgets] = None
    digest: Optional[str] = Field(default=None, max_length=100)

    @field_validator("version")
    @classmethod
    def _version(cls, v):
        if v < 1:
            raise ValueError("version must be >= 1")
        if v > VERSION:
            raise ValueError(
                f"this template is format v{v}, made by a newer Embodent; this Embodent reads v{VERSION}"
            )
        return v


class BundleProblem(ValueError):
    """A bundle that parses but can't be imported as a whole (dupes, cycles)."""


def check_bundle(b: ProjectTemplateBundle) -> None:
    lower = [a.alias.lower() for a in b.roster]
    dupes = sorted({x for x in lower if lower.count(x) > 1})
    if dupes:
        raise BundleProblem(f"the template lists the same agent twice: {', '.join(dupes)}")
    for kind, items in (("DoD preset", [p.name.strip().lower() for p in b.dod_presets]),
                        ("skill", [s.name for s in b.skills])):
        d = sorted({x for x in items if items.count(x) > 1})
        if d:
            raise BundleProblem(f"the template lists the same {kind} twice: {', '.join(d)}")
    by_alias = {a.alias.lower(): a for a in b.roster}
    for a in b.roster:  # reporting cycles among the template's own agents
        seen, cur = {a.alias.lower()}, a
        while cur.reports_to and cur.reports_to.kind == "agent":
            nxt = by_alias.get(cur.reports_to.ref.lower())
            if nxt is None:
                break
            if nxt.alias.lower() in seen:
                raise BundleProblem(f"the template's reporting lines form a cycle at '{a.alias}'")
            seen.add(nxt.alias.lower())
            cur = nxt


# --------------------------------------------------------------------------- import plan
class CollisionChoice(_M):
    action: Literal["rename", "skip"] = "skip"
    rename_to: Optional[str] = Field(default=None, max_length=64)


class ImportOptions(_M):
    sections: dict[str, bool] = Field(default_factory=dict)
    collisions: dict[str, CollisionChoice] = Field(default_factory=dict)
    human_seats: Literal["me", "unassigned"] = "me"
    enable_routines: bool = False


def _suggest(base: str, taken: set[str], sep: str = "-", limit: int = 64) -> str:
    n = 2
    while True:
        suffix = f"{sep}{n}"
        cand = base[: limit - len(suffix)] + suffix
        if cand.lower() not in taken:
            return cand
        n += 1


def _imported_name(base: str, taken: set[str], *, skill: bool) -> str:
    if skill:
        stem = base[:50] + "-imported"
        cand, n = stem, 2
        while cand in taken:
            cand = f"{stem}-{n}"
            n += 1
        return cand
    stem = base[: PRESET_NAME_MAX - 16] + " (imported)"
    cand, n = stem, 2
    while cand.lower() in taken:
        cand = f"{base[: PRESET_NAME_MAX - 16]} (imported {n})"
        n += 1
    return cand


def plan_import(b: ProjectTemplateBundle, opts: ImportOptions, target: dict) -> dict:
    """Compute exactly what an import would do — the preview IS this plan, and apply
    re-computes it and refuses when it differs from what the human confirmed.

    target = {
      "actor": {"id", "alias"},
      "can_autonomy": bool,            # owner or manage_autonomy (autonomy/wake/budgets)
      "agents": [{"id", "alias", "kind", "live"}],   # every agent row (aliases are unique)
      "routine_titles": [str],          # live routines
      "presets": {lower(name): body}, "skills": {name: body},
      "project_budget_set": bool,
    }
    """
    wanted = {s: bool(opts.sections.get(s, True)) for s in SECTIONS}
    if b.budgets is None:
        wanted["budgets"] = False
    errors: list[dict] = []
    warnings: list[str] = []
    can_auto = bool(target.get("can_autonomy"))

    existing = {a["alias"].lower(): a for a in target["agents"]}
    bundle_aliases = {a.alias.lower() for a in b.roster}
    taken = set(existing) | bundle_aliases

    # ---- roster
    roster, by_src = [], {}
    if wanted["roster"]:
        planned_finals: set[str] = set()
        for a in b.roster:
            notes: list[str] = []
            coll = existing.get(a.alias.lower())
            suggested = _suggest(a.alias, taken | planned_finals) if coll else None
            item = {"alias": a.alias, "final_alias": a.alias, "action": "create",
                    "collision": bool(coll), "suggested_alias": suggested, "notes": notes}
            if coll:
                choice = opts.collisions.get(a.alias) or CollisionChoice()
                if choice.action == "skip":
                    item["action"] = "skip"
                    item["final_alias"] = coll["alias"]
                    item["existing"] = {"id": coll["id"], "kind": coll["kind"], "live": coll["live"]}
                    notes.append(f"'{coll['alias']}' already exists here — kept as is")
                else:
                    new = (choice.rename_to or suggested or "").strip()
                    item["action"] = "rename"
                    item["final_alias"] = new
                    if not new or len(new) > 64:
                        errors.append({"section": "roster", "alias": a.alias,
                                       "message": "a new name is 1–64 characters"})
                    elif new.lower() in existing or new.lower() in planned_finals or (
                        new.lower() in bundle_aliases and new.lower() != a.alias.lower()
                    ):
                        errors.append({"section": "roster", "alias": a.alias,
                                       "message": f"'{new}' is already taken — pick another name"})
            if item["action"] != "skip":
                planned_finals.add(item["final_alias"].lower())
                model = a.model
                if not model:
                    model = DEFAULT_MODEL
                elif model not in MODEL_IDS:
                    notes.append(f"model '{a.model}' isn't available here — uses {MODELS_BY_ID[DEFAULT_MODEL]['name']}")
                    model = DEFAULT_MODEL
                effort = a.reasoning_effort
                if effort is not None and effort not in REASONING_EFFORT_IDS_BY_MODEL.get(model, set()):
                    notes.append(f"reasoning effort '{effort}' isn't supported by this model — left unset")
                    effort = None
                wake = a.auto_wake_interval_secs
                if wake is not None and wake < MIN_AUTO_WAKE:
                    notes.append("auto-wake under 60 s isn't allowed — left off")
                    wake = None
                override = a.autonomy_override
                if not can_auto and (wake is not None or override is not None):
                    notes.append("autonomy override / auto-wake need the Autonomy permission — not applied")
                    wake, override = None, None
                item.update({
                    "role": a.role,
                    "model": model,
                    "reasoning_effort": effort,
                    "auto_wake_interval_secs": wake,
                    "autonomy_override": override,
                    "prompt_chars": len(a.system_prompt),
                })
                if contains_secret(a.system_prompt) or contains_secret(a.role):
                    warnings.append(f"{a.alias}'s prompt contains something that looks like a secret — review it after import")
            roster.append(item)
            by_src[a.alias.lower()] = item

    # ---- reporting lines (only for agents this import creates)
    lines = []
    if wanted["roster"]:
        seats = {s.ref for s in b.human_seats}
        for a in b.roster:
            item = by_src[a.alias.lower()]
            if item["action"] == "skip" or a.reports_to is None:
                continue
            rt = a.reports_to
            line = {"alias": item["final_alias"], "action": "set", "manager": None, "note": None}
            if rt.kind == "human_seat":
                if rt.ref not in seats and b.human_seats:
                    line.update(action="skip", note=f"unknown human seat '{rt.ref}'")
                elif opts.human_seats == "me":
                    line["manager"] = {"kind": "actor", "id": target["actor"]["id"],
                                       "alias": target["actor"]["alias"], "label": "you"}
                else:
                    line.update(action="skip", note="reported to a person — left unassigned")
            else:
                mgr = by_src.get(rt.ref.lower())
                if mgr is None:
                    line.update(action="skip", note=f"manager '{rt.ref}' isn't in the template")
                elif mgr["action"] == "skip":
                    ex = mgr["existing"]
                    if ex["live"]:
                        line["manager"] = {"kind": "existing", "id": ex["id"],
                                           "alias": mgr["final_alias"], "label": mgr["final_alias"]}
                    else:
                        line.update(action="skip", note=f"'{mgr['final_alias']}' here is retired — left unassigned")
                else:
                    line["manager"] = {"kind": "new", "alias": mgr["final_alias"],
                                       "label": mgr["final_alias"]}
            lines.append(line)

    # ---- routines
    routines = []
    if wanted["routines"]:
        titles = {t.strip().lower() for t in target.get("routine_titles", [])}
        for r in b.routines:
            item = {"title": r.title, "action": "create", "assignee": None,
                    "cron": r.cron, "timezone": r.timezone,
                    "enabled": bool(opts.enable_routines and r.enabled), "notes": []}
            try:
                sched.validate(r.cron, r.timezone)
            except sched.ScheduleError as err:
                item["action"] = "skip"
                item["notes"].append(f"schedule can't be used: {err}")
            if item["action"] == "create" and r.title.strip().lower() in titles:
                item["action"] = "skip"
                item["notes"].append("a routine with this title already exists here")
            if r.assignee:
                src = by_src.get(r.assignee.lower()) if wanted["roster"] else None
                ex = existing.get(r.assignee.lower())
                if src and src["action"] != "skip":
                    item["assignee"] = {"kind": "new", "alias": src["final_alias"]}
                elif ex and ex["live"] and ex["kind"] == "ai":
                    item["assignee"] = {"kind": "existing", "id": ex["id"], "alias": ex["alias"]}
                else:
                    item["notes"].append(f"assignee '{r.assignee}' isn't available — normal assignment")
            if item["action"] == "create" and r.enabled and not opts.enable_routines:
                item["notes"].append("imported paused — turn it on when ready")
            routines.append(item)
            titles.add(r.title.strip().lower())

    # ---- DoD presets + skills (auto-renamed on a differing clash, skipped when identical)
    presets = []
    if wanted["dod_presets"]:
        have = dict(target.get("presets", {}))
        for p in b.dod_presets:
            name = p.name.strip()
            item = {"name": name, "final_name": name, "action": "create", "notes": []}
            cur = have.get(name.lower())
            same = next((k for k, v in have.items() if v.strip() == p.body.strip()), None)
            if same is not None:
                item["action"] = "skip"
                item["notes"].append("already here with the same text"
                                     + ("" if same == name.lower() else " (under another name)"))
            elif cur is not None:
                item["action"] = "rename"
                item["final_name"] = _imported_name(name, set(have), skill=False)
                item["notes"].append("a different preset has this name — imported under a new name")
            if item["action"] != "skip":
                have[item["final_name"].lower()] = p.body
            presets.append(item)
    skills = []
    if wanted["skills"]:
        have = dict(target.get("skills", {}))
        for s in b.skills:
            item = {"name": s.name, "final_name": s.name, "action": "create", "notes": []}
            cur = have.get(s.name)
            same = next((k for k, v in have.items() if v.strip() == s.body.strip()), None)
            if same is not None:
                item["action"] = "skip"
                item["notes"].append("already here with the same text"
                                     + ("" if same == s.name else f" (as '{same}')"))
            elif cur is not None:
                item["action"] = "rename"
                item["final_name"] = _imported_name(s.name, set(have), skill=True)
                item["notes"].append("a different skill has this name — imported under a new name")
            if item["action"] != "skip":
                have[item["final_name"]] = s.body
            skills.append(item)

    # ---- budgets (opt-in in the bundle; owner / manage_autonomy)
    budgets = []
    if wanted["budgets"] and b.budgets is not None:
        def limits(x):
            return {"monthly_limit_usd": x.monthly_limit_usd,
                    "monthly_limit_tokens": x.monthly_limit_tokens}
        pb = b.budgets.project
        if pb is not None and (pb.monthly_limit_usd is not None or pb.monthly_limit_tokens is not None):
            item = {"scope": "project", "action": "set", **limits(pb), "note": None}
            if not can_auto:
                item.update(action="skip", note="budgets need the Autonomy permission")
            elif target.get("project_budget_set"):
                item.update(action="skip", note="this project already has a budget — kept")
            budgets.append(item)
        for ab in b.budgets.agents:
            if ab.monthly_limit_usd is None and ab.monthly_limit_tokens is None:
                continue
            src = by_src.get(ab.alias.lower()) if wanted["roster"] else None
            item = {"scope": "agent", "alias": src["final_alias"] if src else ab.alias,
                    "action": "set", **limits(ab), "note": None}
            if not can_auto:
                item.update(action="skip", note="budgets need the Autonomy permission")
            elif src is None:
                item.update(action="skip", note="agent isn't imported")
            elif src["action"] == "skip":
                item.update(action="skip", note="existing agent's budget left unchanged")
            budgets.append(item)

    def count(items, key="action"):
        c = {"create": 0, "skip": 0}
        for i in items:
            k = "create" if i[key] in ("create", "rename", "set") else "skip"
            c[k] += 1
        return c

    plan = {
        "sections": {
            "roster": roster,
            "reporting_lines": lines,
            "routines": routines,
            "dod_presets": presets,
            "skills": skills,
            "budgets": budgets,
        },
        "included": wanted,
        "counts": {
            "roster": count(roster),
            "reporting_lines": count(lines),
            "routines": count(routines),
            "dod_presets": count(presets),
            "skills": count(skills),
            "budgets": count(budgets),
        },
        "errors": errors,
        "warnings": warnings,
        "options": {
            "human_seats": opts.human_seats,
            "enable_routines": opts.enable_routines,
        },
    }
    plan["changes"] = sum(v["create"] for v in plan["counts"].values())
    # how many of the template's agents report to a person (the "human seat" option applies)
    plan["human_seat_lines"] = sum(
        1 for a in b.roster if a.reports_to is not None and a.reports_to.kind == "human_seat"
    ) if wanted["roster"] else 0
    return plan


def plan_digest(bundle_raw: dict, plan: dict) -> str:
    """What the human confirmed: the bundle content + the computed plan."""
    return "sha256:" + hashlib.sha256(
        canonical({"bundle": bundle_digest(bundle_raw), "plan": plan}).encode()
    ).hexdigest()
