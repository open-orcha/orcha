"""List, invite, re-role, grant, and remove a container's human members (collab v1
+ the access model: viewer role, granular grants, roster privacy)."""

from typing import Optional

import psycopg
from fastapi import HTTPException, Request
from psycopg.types.json import Jsonb

from portal_backend.agent_profile_routes import retire_agent_record
from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_container, valid_uuid
from portal_backend.identity_routes import (
    container_mapped,
    has_grant,
    proxy_login,
    require_grant,
)
from portal_backend.plan_routes import require_feature
from portal_backend.schemas import MemberCreate, MemberRemove, MemberRoleUpdate

_MEMBER_FIELDS = (
    "id AS agent_id, alias, github_login, member_role, grants, "
    # pending = invited (github_login set) but has NEVER SIGNED IN. /api/me stamps
    # last_heartbeat_at once on first identity resolution (match or bind —
    # identity_routes._stamp_presence), and bump_agent stamps humans on turns, so a
    # NULL heartbeat on a mapped human genuinely means "never arrived".
    "(github_login IS NOT NULL AND last_heartbeat_at IS NULL) AS pending"
)


def _require_member(cur, cid, aid):
    """A live human member of the container, or 404."""
    cur.execute(
        f"""SELECT {_MEMBER_FIELDS} FROM agents
           WHERE id=%s AND container_id=%s AND kind='human' AND terminated_at IS NULL""",
        (aid, cid),
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, f"no live human member {aid} in container {cid}")
    return row


def _other_owner_exists(cur, cid, aid) -> bool:
    cur.execute(
        """SELECT 1 FROM agents
           WHERE container_id=%s AND kind='human' AND terminated_at IS NULL
             AND member_role='owner' AND id<>%s LIMIT 1""",
        (cid, aid),
    )
    return cur.fetchone() is not None


def _require_owner_actor(actor, action: str):
    """Escalation guard: the sensitive member mutations stay owner-only even for a
    manage_members holder — role changes to/from owner, owner removal, and grant
    edits (a grant editor could otherwise mint their own escalations)."""
    if actor["member_role"] != "owner":
        raise HTTPException(403, f"{action} requires the owner role")


@app.get("/api/containers/{cid}/members")
def list_members(cid: str, request: Request):
    """The container's live human members, founding-first, each with `pending` and
    their grant set.

    ROSTER PRIVACY (access model): under the trusted proxy lane the full roster is
    visible only to owners and manage_members holders (a viewer holding the grant
    included — it is a read). Any other member gets ONLY their own row plus
    `restricted: true`, so a collaborator can see their own standing but never who
    else is on the project. A trusted NON-member is refused outright (403) — reads
    are project-isolated. Trust off / no header, and a still-unmapped bootstrap
    container, keep the pre-collab full listing."""
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (_, cur):
        require_container(cur, cid)
        login = proxy_login(request)
        own_row = None
        if login:
            cur.execute(
                f"""SELECT {_MEMBER_FIELDS} FROM agents
                   WHERE container_id=%s AND kind='human' AND terminated_at IS NULL
                     AND lower(github_login)=lower(%s)""",
                (cid, login),
            )
            own_row = cur.fetchone()
            if own_row is None:
                if container_mapped(cur, cid):
                    raise HTTPException(
                        403,
                        f"your GitHub account ('{login}') is not a member of this "
                        "project — ask an owner for an invite",
                    )
            elif not has_grant(own_row, "manage_members"):
                return {"members": [own_row], "restricted": True}
        cur.execute(
            f"""SELECT {_MEMBER_FIELDS} FROM agents
               WHERE container_id=%s AND kind='human' AND terminated_at IS NULL
               ORDER BY created_at ASC, id ASC""",
            (cid,),
        )
        return {"members": cur.fetchall(), "restricted": False}


@app.post("/api/containers/{cid}/members", status_code=201)
def invite_member(cid: str, body: MemberCreate, request: Request):
    """Owner-or-manage_members: invite a GitHub user as a human member (alias = the
    login). Inviting straight to OWNER stays owner-only (a role-to-owner change).

    The invited row is a kind='human' agent with github_login pre-set, so the moment
    that user arrives through the proxy /api/me matches them directly (no binding-rule
    involvement — that rule only fires while NO human is mapped). NOTE the cloud
    PERIMETER allowlist is synced separately cloud-side; inviting here does not by
    itself open the front door. 409 when the login is already a member (the partial
    unique index backs this against races) or the alias is taken.

    PLAN GATING: member mutations are a Team-plan feature (docs/orcha-cloud-local-run.md
    addendum) — 402 under the free solo tier, checked FIRST, before any DB work."""
    require_feature("members")
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        require_container(cur, cid)
        actor = require_grant(
            cur, request, cid, body.actor_agent_id, "manage_members"
        )
        if body.role == "owner":
            _require_owner_actor(actor, "inviting an owner")
        cur.execute(
            """SELECT 1 FROM agents
               WHERE container_id=%s AND lower(github_login)=lower(%s)
                 AND terminated_at IS NULL LIMIT 1""",
            (cid, body.github_login),
        )
        if cur.fetchone():
            raise HTTPException(
                409, f"GitHub user '{body.github_login}' is already a member"
            )
        # Re-inviting a REMOVED member. Removal is a retire, never a hard delete (the
        # audit trail and thread attribution keep pointing at the row) — and BOTH
        # uniqueness guards (agents.container_id+alias, the 036 lower(github_login)
        # partial index) still match that retired row, so a fresh INSERT would 409
        # forever and lock the login out of the project. Reactivate the same row
        # instead: one stable identity per login per project; the role comes from
        # THIS invite, grants start empty, and the presence stamp resets so the
        # roster shows them as pending until they arrive again.
        cur.execute(
            """SELECT id FROM agents
               WHERE container_id=%s AND kind='human'
                 AND lower(github_login)=lower(%s) AND terminated_at IS NOT NULL
               ORDER BY terminated_at DESC LIMIT 1""",
            (cid, body.github_login),
        )
        retired = cur.fetchone()
        if retired:
            # Belt-and-braces twin of the remove-side revocation: a row retired
            # BEFORE that revocation shipped may still carry live token rows —
            # reactivation must never bring a credential back to life.
            cur.execute(
                """UPDATE device_tokens SET revoked_at=now()
                   WHERE agent_id=%s AND revoked_at IS NULL""",
                (retired["id"],),
            )
            cur.execute(
                f"""UPDATE agents
                       SET terminated_at=NULL, status='idle', member_role=%s,
                           grants='[]'::jsonb, last_heartbeat_at=NULL
                     WHERE id=%s
                 RETURNING {_MEMBER_FIELDS}""",
                (body.role, retired["id"]),
            )
        else:
            try:
                cur.execute(
                    f"""INSERT INTO agents
                           (container_id, alias, role, kind, github_login, member_role)
                       VALUES (%s, %s, 'collaborator', 'human', %s, %s)
                       RETURNING {_MEMBER_FIELDS}""",
                    (cid, body.github_login, body.github_login, body.role),
                )
            except psycopg.errors.UniqueViolation:
                raise HTTPException(
                    409,
                    f"'{body.github_login}' is already a member "
                    "(or the alias is taken) in this container",
                )
        member = cur.fetchone()
        log_event(
            cur,
            cid,
            "human",
            str(actor["id"]),
            "agent",
            str(member["agent_id"]),
            "member_invited",
            {"github_login": body.github_login, "role": body.role,
             "reactivated": bool(retired)},
        )
        conn.commit()
    return member


@app.patch("/api/containers/{cid}/members/{aid}", status_code=200)
def update_member_role(cid: str, aid: str, body: MemberRoleUpdate, request: Request):
    """Owner-or-manage_members: change a member's role and/or grant set. PARTIAL —
    only supplied fields change; at least one is required.

    Owner-only carve-outs (escalation guards):
      * a role change TO or FROM owner;
      * any grants change (the "Permissions" expander is owner-only in the UI too).
    Demoting the LAST owner is refused (400) — a container without an owner could
    never manage itself again.

    PLAN GATING: member mutations are a Team-plan feature (docs/orcha-cloud-local-run.md
    addendum) — 402 under the free solo tier, checked FIRST, before any DB work."""
    require_feature("members")
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    if not valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    if body.role is None and body.grants is None:
        raise HTTPException(400, "no updatable field supplied (role / grants)")
    with db_cursor() as (conn, cur):
        require_container(cur, cid)
        actor = require_grant(
            cur, request, cid, body.actor_agent_id, "manage_members"
        )
        member = _require_member(cur, cid, aid)
        sets, params, detail = [], [], {}
        if body.role is not None and body.role != member["member_role"]:
            if body.role == "owner" or member["member_role"] == "owner":
                _require_owner_actor(actor, "a role change to/from owner")
            if (
                member["member_role"] == "owner"
                and not _other_owner_exists(cur, cid, aid)
            ):
                raise HTTPException(400, "cannot demote the last owner")
            sets.append("member_role=%s")
            params.append(body.role)
            detail["from"] = member["member_role"]
            detail["to"] = body.role
        if body.grants is not None:
            _require_owner_actor(actor, "changing permissions")
            deduped = sorted(set(body.grants))
            sets.append("grants=%s")
            params.append(Jsonb(deduped))
            detail["grants"] = deduped
        if not sets:
            return member  # no-op (e.g. re-asserting the current role)
        params.append(aid)
        cur.execute(
            f"UPDATE agents SET {', '.join(sets)} WHERE id=%s "
            f"RETURNING {_MEMBER_FIELDS}",
            params,
        )
        updated = cur.fetchone()
        log_event(
            cur,
            cid,
            "human",
            str(actor["id"]),
            "agent",
            aid,
            "member_role_changed" if "to" in detail else "member_grants_changed",
            detail,
        )
        conn.commit()
    return updated


@app.delete("/api/containers/{cid}/members/{aid}", status_code=200)
def remove_member(
    cid: str, aid: str, request: Request, body: Optional[MemberRemove] = None
):
    """Owner-or-manage_members: remove a member — the existing agent-RETIRE semantics,
    never a hard delete (the audit trail and thread attribution keep pointing at the
    row). Removing an OWNER stays owner-only, and removing the LAST owner is refused
    (400). Any task naming the removed member as its reviewer reverts to
    reviewer=anyone.

    PLAN GATING: member mutations are a Team-plan feature (docs/orcha-cloud-local-run.md
    addendum) — 402 under the free solo tier, checked FIRST, before any DB work."""
    require_feature("members")
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    if not valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        require_container(cur, cid)
        actor = require_grant(
            cur, request, cid, body.actor_agent_id if body else None, "manage_members"
        )
        member = _require_member(cur, cid, aid)
        if member["member_role"] == "owner":
            _require_owner_actor(actor, "removing an owner")
            if not _other_owner_exists(cur, cid, aid):
                raise HTTPException(400, "cannot remove the last owner")
        released = retire_agent_record(cur, aid)  # ISS-51 mechanics, reused
        # PR #223 review: removal is a PERMANENT credential boundary — revoke the
        # member's device tokens NOW, not just mask them behind terminated_at.
        # Without this, a later re-invite (which reactivates this same row) would
        # resurrect every unrevoked phone token minted before the removal.
        cur.execute(
            "UPDATE device_tokens SET revoked_at=now() "
            "WHERE agent_id=%s AND revoked_at IS NULL",
            (aid,),
        )
        revoked_device_tokens = cur.rowcount
        cur.execute(
            "UPDATE tasks SET reviewer_agent_id=NULL "
            "WHERE container_id=%s AND reviewer_agent_id=%s RETURNING id",
            (cid, aid),
        )
        cleared_reviews = [str(r["id"]) for r in cur.fetchall()]
        log_event(
            cur,
            cid,
            "human",
            str(actor["id"]),
            "agent",
            aid,
            "member_removed",
            {
                "github_login": member["github_login"],
                "released_tasks": released,
                "cleared_reviewer_on": cleared_reviews,
                "revoked_device_tokens": revoked_device_tokens,
            },
        )
        conn.commit()
    return {
        "agent_id": aid,
        "status": "terminated",
        "released_tasks": released,
        "cleared_reviewer_on": cleared_reviews,
    }
