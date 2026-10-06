"""Agent config history + rollback: immutable per-agent revisions of human-controlled config.

Idea credit: Paperclip's agent config revisions / rollback
(https://github.com/paperclipai/paperclip, MIT). This is an independent implementation on
Orcha's own write paths — no Paperclip code is copied.

Semantics
---------
* CAPTURE — every existing config write path (PATCH /api/agents/{aid}, POST .../model,
  POST .../reasoning-effort, PATCH .../auto-wake) calls two tiny hooks inside its own
  transaction: ``before = config_before(cur, aid)`` ahead of its UPDATE, then
  ``record_config_change(cur, aid, before, source=..., actor_agent_id=...)`` after it. A
  write that changes nothing records nothing. The first recorded change also records an
  'initial' revision from the pre-change state, so history always starts at a real baseline.
* IMMUTABLE — rows are append-only (a DB trigger refuses UPDATE). A restore NEVER rewrites
  history: it re-applies an old snapshot THROUGH THE SAME ROUTE FUNCTIONS a human edit uses
  (same grants, same validation, same audit events), and each of those appends a NEW
  revision with kind='restore' + restored_from=N.
* AUTHORITY — reading history is a member read (viewers included). Restoring needs a human
  actor plus exactly the grants the underlying edits need (manage_agents for
  alias/role/prompt/model/effort, manage_autonomy for autonomy_override/auto-wake); the
  routes re-check them on every call.
* SECRETS — only the whitelisted CAPTURED_FIELDS are ever stored (never provider keys,
  tokens, PATs, grants). Secret-looking substrings inside free text (a key pasted into a
  prompt) are replaced by REDACTION before insert and the field is listed in
  ``redacted_fields``; restore refuses to "recreate" a redacted value it never stored.
* TRUTHFUL ACTOR — the actor is whoever the route resolved (trusted proxy identity or the
  human body actor). Self-hosted model/effort swaps carry no actor, so their revisions say
  so (actor null → the UI shows "Unattributed"); nothing is guessed.
"""

import contextvars
import re
from contextlib import contextmanager
from typing import Optional

from fastapi import HTTPException, Query, Request
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_kind, valid_uuid
from portal_backend.identity_routes import (
    enforce_grant,
    require_member_read,
    trusted_actor,
)
from portal_backend.model_policy import MODELS_BY_ID

# The agent config a revision captures — and the ONLY columns ever stored.
CAPTURED_FIELDS = (
    "alias",
    "role",
    "system_prompt",
    "model",
    "reasoning_effort",
    "auto_wake_interval_secs",
    "autonomy_override",
)
# Display-only, derived from `model` (the provider/runtime is not independently settable).
DERIVED_FIELDS = ("provider",)
_TEXT_FIELDS = ("alias", "role", "system_prompt")
# Which grant an edit of each field needs (mirrors the routes' own enforce_grant lanes).
FIELD_GRANT = {
    "alias": "manage_agents",
    "role": "manage_agents",
    "system_prompt": "manage_agents",
    "model": "manage_agents",
    "reasoning_effort": "manage_agents",
    "autonomy_override": "manage_autonomy",
    "auto_wake_interval_secs": "manage_autonomy",
}

REDACTION = "[redacted secret]"
_SECRET_PATTERNS = [
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", re.S),
    re.compile(r"\bsk-ant-[A-Za-z0-9_\-]{16,}"),
    re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_\-]{20,}"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}"),
    re.compile(r"\bxox[abprs]-[A-Za-z0-9\-]{10,}"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\bAIza[0-9A-Za-z_\-]{30,}"),
]


def redact(value):
    """Replace secret-looking substrings; returns (value, was_redacted)."""
    if not isinstance(value, str) or not value:
        return value, False
    out = value
    for pat in _SECRET_PATTERNS:
        out = pat.sub(REDACTION, out)
    return out, out != value


def _provider(model):
    return MODELS_BY_ID.get(model, {}).get("runtime") if model else None


# ---------------------------------------------------------------- restore context
# Set only while restore_revision re-applies a snapshot through the normal routes, so the
# revisions those routes append are tagged kind='restore' + restored_from + reason, and the
# restore's human actor is credited where a route itself resolves no actor (model/effort).
_RESTORE_CTX: contextvars.ContextVar[Optional[dict]] = contextvars.ContextVar(
    "agent_config_restore", default=None
)


@contextmanager
def _restoring(restored_from, actor_agent_id, reason):
    token = _RESTORE_CTX.set(
        {"restored_from": restored_from, "actor": actor_agent_id, "reason": reason}
    )
    try:
        yield
    finally:
        _RESTORE_CTX.reset(token)


# ---------------------------------------------------------------- capture hooks
def config_before(cur, aid) -> Optional[dict]:
    """The agent's captured config, row-locked for this transaction (call before UPDATE)."""
    cur.execute(
        f"SELECT container_id, {', '.join(CAPTURED_FIELDS)} FROM agents WHERE id=%s FOR UPDATE",
        (aid,),
    )
    return cur.fetchone()


def _snapshot(row) -> tuple[dict, list]:
    snap, redacted = {}, []
    for field in CAPTURED_FIELDS:
        value = row.get(field)
        if field in _TEXT_FIELDS:
            value, hit = redact(value)
            if hit:
                redacted.append(field)
        snap[field] = value
    snap["provider"] = _provider(row.get("model"))
    return snap, redacted


def _actor_row(cur, actor_agent_id):
    if not actor_agent_id or not valid_uuid(str(actor_agent_id)):
        return None
    cur.execute("SELECT id, alias, kind FROM agents WHERE id=%s", (str(actor_agent_id),))
    return cur.fetchone()


def _ensure_initial(cur, aid, row) -> None:
    """Write revision #1 ('initial') from `row` if the agent has no history yet."""
    cur.execute("SELECT 1 FROM agent_config_revisions WHERE agent_id=%s LIMIT 1", (aid,))
    if cur.fetchone():
        return
    snap, redacted = _snapshot(row)
    cur.execute(
        """INSERT INTO agent_config_revisions
             (agent_id, container_id, revision_no, kind, source, snapshot, changes,
              redacted_fields)
           VALUES (%s, %s, 1, 'initial', 'backfill', %s, '[]'::jsonb, %s)
           ON CONFLICT (agent_id, revision_no) DO NOTHING""",
        (aid, row["container_id"], Jsonb(snap), Jsonb(redacted)),
    )


def record_config_change(cur, aid, before, *, source, actor_agent_id=None) -> Optional[int]:
    """Append a revision for whatever `before` → current changed (no-op writes record
    nothing). Runs inside the caller's transaction, so it commits or rolls back with the
    config UPDATE itself. Returns the new revision_no, or None when nothing changed."""
    if before is None:
        return None
    cur.execute(
        f"SELECT container_id, {', '.join(CAPTURED_FIELDS)} FROM agents WHERE id=%s",
        (aid,),
    )
    after = cur.fetchone()
    changed = [f for f in CAPTURED_FIELDS if before.get(f) != after.get(f)]
    if not changed:
        return None
    _ensure_initial(cur, aid, before)
    before_snap, _ = _snapshot(before)
    after_snap, redacted = _snapshot(after)
    changes = [
        {"field": f, "before": before_snap[f], "after": after_snap[f]} for f in changed
    ]
    if before_snap["provider"] != after_snap["provider"]:
        changes.append(
            {
                "field": "provider",
                "before": before_snap["provider"],
                "after": after_snap["provider"],
                "derived": True,
            }
        )
    ctx = _RESTORE_CTX.get()
    actor = _actor_row(cur, actor_agent_id or (ctx or {}).get("actor"))
    cur.execute(
        "SELECT COALESCE(MAX(revision_no), 0) + 1 AS n FROM agent_config_revisions "
        "WHERE agent_id=%s",
        (aid,),
    )
    revision_no = cur.fetchone()["n"]
    cur.execute(
        """INSERT INTO agent_config_revisions
             (agent_id, container_id, revision_no, kind, source, snapshot, changes,
              actor_agent_id, actor_kind, actor_alias, restored_from, reason,
              redacted_fields)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
        (
            aid,
            after["container_id"],
            revision_no,
            "restore" if ctx else "change",
            source,
            Jsonb(after_snap),
            Jsonb(changes),
            str(actor["id"]) if actor else None,
            actor["kind"] if actor else None,
            actor["alias"] if actor else None,
            ctx["restored_from"] if ctx else None,
            ctx["reason"] if ctx else None,
            Jsonb(redacted),
        ),
    )
    return revision_no


# ---------------------------------------------------------------- read API
def _revision_payload(row, *, with_snapshot=False) -> dict:
    out = {
        "revision_no": row["revision_no"],
        "kind": row["kind"],
        "source": row["source"],
        "changes": row["changes"] or [],
        "actor": (
            {
                "agent_id": str(row["actor_agent_id"]),
                "alias": row["actor_alias"],
                "kind": row["actor_kind"],
            }
            if row["actor_agent_id"]
            else None
        ),
        "restored_from": row["restored_from"],
        "reason": row["reason"],
        "redacted_fields": row["redacted_fields"] or [],
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
    }
    if with_snapshot:
        out["snapshot"] = row["snapshot"]
    return out


def _load_agent(cur, aid):
    if not valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    cur.execute(
        f"SELECT id, kind, container_id, {', '.join(CAPTURED_FIELDS)} FROM agents WHERE id=%s",
        (aid,),
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, f"agent {aid} not found")
    return row


@app.get("/api/agents/{aid}/config-revisions")
def list_config_revisions(
    aid: str,
    request: Request,
    field: Optional[str] = Query(None, description="only revisions that changed this field"),
    actor_kind: Optional[str] = Query(None, description="human | ai | none (unattributed)"),
    kind: Optional[str] = Query(None, description="initial | change | restore"),
    before: Optional[int] = Query(None, ge=1, description="page: revision_no strictly below"),
    limit: int = Query(50, ge=1, le=200),
):
    """An agent's config history, newest first. Member read (viewers included). The first
    read of an agent with no history backfills its 'initial' revision from the current
    config (the one write a GET makes; idempotent and race-safe)."""
    if field is not None and field not in CAPTURED_FIELDS + DERIVED_FIELDS:
        raise HTTPException(400, f"unknown field '{field}'; one of {list(CAPTURED_FIELDS)}")
    if actor_kind is not None and actor_kind not in ("human", "ai", "none"):
        raise HTTPException(400, "actor_kind must be human | ai | none")
    if kind is not None and kind not in ("initial", "change", "restore"):
        raise HTTPException(400, "kind must be initial | change | restore")
    with db_cursor() as (conn, cur):
        agent = _load_agent(cur, aid)
        require_member_read(cur, request, str(agent["container_id"]))
        # lock the agent row so a concurrent first write and this backfill can't both
        # claim revision #1 (ON CONFLICT DO NOTHING is the second belt)
        cur.execute("SELECT 1 FROM agents WHERE id=%s FOR UPDATE", (aid,))
        _ensure_initial(cur, aid, agent)
        conn.commit()
        where, params = ["agent_id=%s"], [aid]
        if field is not None:
            where.append("changes @> %s")
            params.append(Jsonb([{"field": field}]))
        if actor_kind == "none":
            where.append("actor_agent_id IS NULL")
        elif actor_kind is not None:
            where.append("actor_kind=%s")
            params.append(actor_kind)
        if kind is not None:
            where.append("kind=%s")
            params.append(kind)
        cur.execute(
            "SELECT COUNT(*) AS n FROM agent_config_revisions WHERE " + " AND ".join(where),
            params,
        )
        total = cur.fetchone()["n"]
        if before is not None:
            where.append("revision_no < %s")
            params.append(before)
        cur.execute(
            "SELECT * FROM agent_config_revisions WHERE "
            + " AND ".join(where)
            + " ORDER BY revision_no DESC LIMIT %s",
            [*params, limit + 1],
        )
        rows = cur.fetchall()
        cur.execute(
            "SELECT MAX(revision_no) AS n FROM agent_config_revisions WHERE agent_id=%s",
            (aid,),
        )
        latest = cur.fetchone()["n"]
    page = rows[:limit]
    return {
        "agent_id": aid,
        "latest_revision_no": latest,
        "total": total,
        "revisions": [_revision_payload(r) for r in page],
        "next_before": page[-1]["revision_no"] if len(rows) > limit else None,
    }


def _restore_plan(agent, snapshot, redacted_fields):
    """[(field, current, target)] a restore of `snapshot` would change, plus the fields it
    cannot restore (redacted secret / value no route can set) as [(field, why)]."""
    plan, blocked = [], []
    for field in CAPTURED_FIELDS:
        if field not in snapshot:
            continue
        target = snapshot[field]
        current = agent[field]
        if field in _TEXT_FIELDS and field in (redacted_fields or []):
            if redact(current)[0] == target:
                continue  # already equal (modulo the redacted secret)
            blocked.append(
                (field, "contained a secret that was never stored, so it cannot be restored")
            )
            continue
        if current == target:
            continue
        if agent["kind"] == "human" and field not in ("alias", "role"):
            blocked.append((field, "humans carry no model / prompt / wake / autonomy config"))
            continue
        if field in ("alias", "role", "system_prompt", "model") and target is None:
            blocked.append((field, "was unset in that revision; the edit routes cannot unset it"))
            continue
        plan.append((field, current, target))
    return plan, blocked


@app.get("/api/agents/{aid}/config-revisions/{rev}")
def get_config_revision(aid: str, rev: int, request: Request):
    """One revision with its full snapshot, plus what restoring it would change NOW
    (`restore_preview`, current vs target — text fields redacted) and any fields it can't
    restore (`restore_blocked`)."""
    with db_cursor() as (_, cur):
        agent = _load_agent(cur, aid)
        require_member_read(cur, request, str(agent["container_id"]))
        cur.execute(
            "SELECT * FROM agent_config_revisions WHERE agent_id=%s AND revision_no=%s",
            (aid, rev),
        )
        row = cur.fetchone()
    if not row:
        raise HTTPException(404, f"revision #{rev} not found for agent {aid}")
    plan, blocked = _restore_plan(agent, row["snapshot"], row["redacted_fields"])
    out = _revision_payload(row, with_snapshot=True)
    out["restore_preview"] = [
        {
            "field": f,
            "current": redact(cur_v)[0] if f in _TEXT_FIELDS else cur_v,
            "target": target,
            "grant": FIELD_GRANT[f],
        }
        for f, cur_v, target in plan
    ]
    out["restore_blocked"] = [{"field": f, "reason": why} for f, why in blocked]
    return out


class ConfigRestore(BaseModel):
    """Restore an agent's config to revision N. Same human-authority convention as the
    PATCH it re-uses: `actor_agent_id` is the acting human (overridden by a trusted proxy
    identity); `reason` is optional free text kept on the new revisions."""

    actor_agent_id: Optional[str] = None
    reason: Optional[str] = Field(default=None, max_length=500)


@app.post("/api/agents/{aid}/config-revisions/{rev}/restore", status_code=200)
def restore_config_revision(aid: str, rev: int, body: ConfigRestore, request: Request):
    """Re-apply revision #rev's values through the SAME authorized routes a human edit
    uses (PATCH /api/agents/{aid}, POST .../model, POST .../reasoning-effort, PATCH
    .../auto-wake). Each appends a NEW revision (kind='restore', restored_from=rev);
    history is never rewritten. Authority is checked up front for every field the restore
    touches (so a restore is refused whole rather than half-applied on a 403) and again by
    each route. Already-matching config is a 200 no-op (`applied: []`)."""
    from portal_backend.agent_model_routes import (
        set_agent_model,
        set_agent_reasoning_effort,
    )
    from portal_backend.agent_profile_routes import update_agent
    from portal_backend.agent_wake_policy_routes import update_agent_auto_wake
    from portal_backend.schemas.agent_state import (
        AgentModelUpdate,
        AgentReasoningEffortUpdate,
        AgentUpdate,
        AutoWakeUpdate,
    )

    with db_cursor() as (conn, cur):
        agent = _load_agent(cur, aid)
        cid = str(agent["container_id"])
        cur.execute(
            "SELECT snapshot, redacted_fields FROM agent_config_revisions "
            "WHERE agent_id=%s AND revision_no=%s",
            (aid, rev),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, f"revision #{rev} not found for agent {aid}")
        plan, blocked = _restore_plan(agent, row["snapshot"], row["redacted_fields"])
        # Up-front authority (the routes re-check): every grant the touched fields need,
        # then the human actor — a restore is a human decision, like the PATCH it re-uses.
        for grant in sorted({FIELD_GRANT[f] for f, _, _ in plan}):
            enforce_grant(cur, request, cid, grant)
        actor = trusted_actor(cur, request, cid, body.actor_agent_id)
        require_kind(cur, actor, ("human",))
        conn.commit()  # persist a proxy-override audit event, if trusted_actor logged one
    if blocked:
        raise HTTPException(
            409,
            {
                "message": "revision #%d can't be fully restored: %s"
                % (rev, "; ".join(f"{f} {why}" for f, why in blocked)),
                "blocked": [{"field": f, "reason": why} for f, why in blocked],
            },
        )
    if not plan:
        return {"agent_id": aid, "restored_from": rev, "applied": [], "revisions": []}

    targets = {f: target for f, _, target in plan}
    applied: list[str] = []
    with db_cursor() as (_, cur):
        cur.execute(
            "SELECT COALESCE(MAX(revision_no), 0) AS n FROM agent_config_revisions "
            "WHERE agent_id=%s",
            (aid,),
        )
        first_new = cur.fetchone()["n"] + 1

    def step(fields, call):
        try:
            call()
        except HTTPException as exc:
            if not applied:
                raise
            detail = exc.detail if isinstance(exc.detail, str) else str(exc.detail)
            raise HTTPException(
                exc.status_code,
                {
                    "message": f"partially restored ({', '.join(applied)}); then: {detail}",
                    "applied": list(applied),
                },
            )
        applied.extend(fields)

    with _restoring(rev, actor, body.reason):
        profile = {
            f: targets[f]
            for f in ("alias", "role", "system_prompt", "autonomy_override")
            if f in targets
        }
        if profile:
            step(
                list(profile),
                lambda: update_agent(aid, AgentUpdate(actor_agent_id=actor, **profile), request),
            )
        if "model" in targets:
            step(
                ["model"],
                lambda: set_agent_model(aid, AgentModelUpdate(model=targets["model"]), request),
            )
        # re-check effort AFTER the model step: a model swap may already have kept/cleared it
        if "reasoning_effort" in row["snapshot"]:
            with db_cursor() as (_, cur):
                cur.execute("SELECT kind, reasoning_effort FROM agents WHERE id=%s", (aid,))
                now = cur.fetchone()
            want = row["snapshot"]["reasoning_effort"]
            if now["kind"] != "human" and now["reasoning_effort"] != want:
                step(
                    ["reasoning_effort"],
                    lambda: set_agent_reasoning_effort(
                        aid, AgentReasoningEffortUpdate(reasoning_effort=want), request
                    ),
                )
        if "auto_wake_interval_secs" in targets:
            step(
                ["auto_wake_interval_secs"],
                lambda: update_agent_auto_wake(
                    aid,
                    AutoWakeUpdate(
                        actor_agent_id=actor, interval_secs=targets["auto_wake_interval_secs"]
                    ),
                    request,
                ),
            )

    with db_cursor() as (_, cur):
        cur.execute(
            "SELECT * FROM agent_config_revisions WHERE agent_id=%s AND revision_no>=%s "
            "ORDER BY revision_no",
            (aid, first_new),
        )
        new_rows = cur.fetchall()
    return {
        "agent_id": aid,
        "restored_from": rev,
        "applied": applied,
        "revisions": [_revision_payload(r) for r in new_rows],
    }
