"""Resolve the acting human from the OAuth proxy's verified GitHub identity."""

import os

from fastapi import HTTPException, Request

from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_container, require_kind, valid_uuid

# The cloud deployment fronts the portal with a GitHub OAuth proxy that forwards the
# VERIFIED username in this header. It is trustworthy ONLY because the portal is
# loopback-bound behind that proxy — so it is read exclusively when the operator opts in
# via ORCHA_TRUST_PROXY_USER=1 (compose passthrough). Self-hosters without a proxy leave
# the env unset and the header is ignored entirely.
TRUST_ENV = "ORCHA_TRUST_PROXY_USER"
PROXY_USER_HEADER = "X-Auth-Request-User"

# The granular permission grants (mig 039, agents.grants JSONB array). Grants are
# ADDITIVE extras on top of the member role's work bundle; owners hold all of them
# implicitly. A grant on a VIEWER affects reads only (today: manage_members reveals
# the roster) — the viewer role's write ban is absolute.
GRANTS = (
    "manage_keys",       # LLM/provider keys + universal model settings
    "manage_members",    # invite/remove/re-role BELOW owner + see the full roster
    "manage_repo",       # bind/unbind the GitHub repo
    "manage_autonomy",   # notifier/autonomy/wakes switches, status, reset, sweep
    "manage_agents",     # register/retire/update agents, model + effort changes
    "assign_reviewers",  # name the human reviewer on a task
)


def _proxy_trusted() -> bool:
    """Whether the operator opted in to trusting the proxy's identity header."""
    return (os.environ.get(TRUST_ENV) or "").strip() == "1"


def proxy_login(request: Request):
    """The proxy-verified GitHub username, or None when untrusted/absent/blank."""
    if not _proxy_trusted():
        return None
    login = (request.headers.get(PROXY_USER_HEADER) or "").strip()
    return login or None


def find_member_by_login(cur, container_id, login):
    """The container's live human agent mapped to a GitHub login (case-insensitive)."""
    cur.execute(
        """SELECT id, alias, github_login, member_role, grants FROM agents
           WHERE container_id=%s AND kind='human' AND terminated_at IS NULL
             AND lower(github_login)=lower(%s)""",
        (container_id, login),
    )
    return cur.fetchone()


def container_mapped(cur, container_id) -> bool:
    """Whether ANY live human here carries a github_login (i.e. bootstrap is over)."""
    cur.execute(
        """SELECT 1 FROM agents
           WHERE container_id=%s AND kind='human' AND terminated_at IS NULL
             AND github_login IS NOT NULL LIMIT 1""",
        (container_id,),
    )
    return cur.fetchone() is not None


def has_grant(member_row, grant) -> bool:
    """Does this member hold a permission grant? Owners hold every grant implicitly;
    member/viewer rows need it in agents.grants. PURE capability predicate — the
    viewer role's write ban is enforced by the gates, not here, so a read-side
    consumer (roster visibility) can honor a grant held by a viewer."""
    if not member_row:
        return False
    if member_row["member_role"] == "owner":
        return True
    return grant in (member_row.get("grants") or [])


def _forbid_viewer_write(member_row):
    """The viewer role is read-only: every write is refused, grants or not."""
    if member_row is not None and member_row["member_role"] == "viewer":
        raise HTTPException(
            403,
            "your role on this project is viewer — it is read-only; "
            "ask an owner for the member role to act",
        )


def bind_first_unmapped_human(cur, container_id, login):
    """The BINDING RULE: claim the container's founding human for an arriving GitHub user.

    When the container has humans but NONE carries a github_login yet (the fresh
    `orcha init` state — one human named after the unix user, e.g. "root"), the first
    verified GitHub user to arrive IS that human: set github_login, rename the alias to
    the login (this is what turns "ACTING AS root" into the GitHub name), and promote to
    owner. Single UPDATE with WHERE guards so the 3s-polling UI can race itself safely:
      - github_login IS NULL on the target row → a concurrent bind wins exactly once
        (READ COMMITTED re-checks the row qual after the lock, so the loser no-ops);
      - NOT EXISTS any mapped human → once anyone is mapped, arrivals stop binding and
        unmatched users resolve to no identity instead (invite-only from then on);
      - the alias only changes when no other agent in the container already uses the
        login as its alias (alias is UNIQUE per container — never trade a bind for a 500).
    Returns the bound row, or None when the rule doesn't apply.
    """
    cur.execute(
        """UPDATE agents SET
               github_login=%s,
               member_role='owner',
               alias=CASE WHEN EXISTS (SELECT 1 FROM agents dup
                                        WHERE dup.container_id=agents.container_id
                                          AND dup.alias=%s AND dup.id<>agents.id)
                          THEN agents.alias ELSE %s END
           WHERE id = (SELECT id FROM agents
                        WHERE container_id=%s AND kind='human' AND terminated_at IS NULL
                        ORDER BY created_at ASC, id ASC LIMIT 1)
             AND github_login IS NULL
             AND NOT EXISTS (SELECT 1 FROM agents m
                              WHERE m.container_id=%s AND m.kind='human'
                                AND m.terminated_at IS NULL
                                AND m.github_login IS NOT NULL)
           RETURNING id, alias, github_login, member_role, grants""",
        (login, login, login, container_id, container_id),
    )
    return cur.fetchone()


def _stamp_presence(cur, login) -> bool:
    """First-sign-in mark: set last_heartbeat_at once so the members list's `pending`
    flag (github_login set ∧ last_heartbeat_at IS NULL) means "invited but has never
    signed in" — humans never run workers, so without this a bound/invited user who
    only ever browsed would read pending forever.

    Stamps EVERY container's live human row carrying this github_login, not just the
    one /api/me happened to resolve against: the portal boots on ONE project (often the
    first), so an invitee whose membership lives in another project would otherwise
    read `pending` there forever — their /api/me never ran against that container
    (field bug: a member of a non-first project stayed pending after signing in).
    Signing in is a property of the GitHub account, not of the viewed project.

    Reusing last_heartbeat_at (no new column) is safe by consumer audit:
      - bump_agent already stamps HUMANS on every message/request turn, so the column
        is a mixed human+AI "last activity" signal, not a worker-liveness channel;
      - the wake scan (wake_scan_queries.list_wake_agents) filters kind='ai', so a
        human heartbeat never makes it a wake candidate;
      - the orphan-lease reaper only considers rows holding a LIVE lease
        (orphan_lease_routes._reap_lane: w.<lease_col> > now()) — humans hold none;
      - pick_human (guards) prefers the freshest heartbeat, which a sign-in stamp
        makes MORE correct ("most recently active human"), and the snapshot's
        last_active/heartbeat_age_secs simply report the sign-in as activity.
    Guarded WHERE ... IS NULL: stamped exactly once per row; later activity is
    bump_agent's. Returns True when this call stamped anything (caller commits)."""
    cur.execute(
        """UPDATE agents SET last_heartbeat_at = now()
           WHERE kind='human' AND terminated_at IS NULL
             AND lower(github_login)=lower(%s)
             AND last_heartbeat_at IS NULL""",
        (login,),
    )
    return cur.rowcount > 0


def trusted_actor(cur, request: Request, container_id, claimed_actor_id=None,
                  *, write=True):
    """Bind the actor of a human-authoritative write to the proxy-verified identity.

    THE per-project identity rule (cloud, multi-user): under proxy trust a signed-in
    GitHub user must never inherit another member's identity — in particular never a
    project's default/founding human. Returns the EFFECTIVE actor agent id; callers
    use it in place of any client-supplied actor (body/query/path param).

    - Trust off (env unset), or trust on with NO header (the break-glass team-token
      lane, which legitimately carries no user): `claimed_actor_id` unchanged — the
      self-host convention (permissive body actor + require_kind) stays intact.
    - Trusted header present → resolve the login IN THE TARGET CONTAINER
      (case-insensitive match ONLY — the binding rule is /api/me's side effect,
      never a write's):
        * resolved member ⇒ that agent IS the actor. A mismatched client-supplied
          actor is not an error — it is overridden (audited once via the house
          event log, riding the handler's own commit).
        * no match, but the container is still UNMAPPED (no live human carries a
          github_login — the fresh pre-binding bootstrap state) ⇒ claimed actor
          unchanged, mirroring bind_first_unmapped_human's NOT-EXISTS guard.
        * otherwise ⇒ 403 — a non-member can look, never act.

    Access model (mig 039): a resolved member whose role is VIEWER is refused on any
    `write=True` call (the default) — the viewer role is read-only across the board.
    The pairing payload builder passes write=False: pairing a phone for yourself is
    read-scoped access, not a project mutation.
    """
    login = proxy_login(request)
    if not login:
        return claimed_actor_id
    member = find_member_by_login(cur, container_id, login)
    if member is None:
        if not container_mapped(cur, container_id):
            return claimed_actor_id  # bootstrap: nobody is mapped yet
        raise HTTPException(
            403,
            f"your GitHub account ('{login}') is not a member of this project "
            "— ask an owner for an invite",
        )
    if write:
        _forbid_viewer_write(member)
    resolved = str(member["id"])
    if claimed_actor_id and str(claimed_actor_id) != resolved:
        log_event(
            cur,
            str(container_id),
            "human",
            resolved,
            "agent",
            resolved,
            "actor_overridden_by_proxy_identity",
            {
                "claimed_actor_agent_id": str(claimed_actor_id),
                "github_login": member["github_login"],
            },
        )
    return resolved


def require_owner(cur, request: Request, container_id, actor_agent_id):
    """Gate an owner-only write; returns the acting owner's agent row.

    With a trusted proxy identity the header IS the actor (match-only — no binding side
    effect here; /api/me owns that): a non-member or non-owner is refused. Without one
    (self-hosters, ORCHA_TRUST_PROXY_USER unset) fall back to the permissive
    actor_agent_id body param, the same convention every human-gated endpoint uses
    (require_kind) — plus the owner-role check, since these routes are owner-scoped.
    """
    login = proxy_login(request)
    if login:
        member = find_member_by_login(cur, container_id, login)
        if not member:
            raise HTTPException(
                403, f"GitHub user '{login}' is not a member of this project"
            )
        if member["member_role"] != "owner":
            raise HTTPException(403, "this action requires the owner role")
        return member
    require_kind(cur, actor_agent_id, ("human",))  # Orcha#30 convention
    cur.execute(
        """SELECT id, alias, github_login, member_role, grants FROM agents
           WHERE id=%s AND container_id=%s AND terminated_at IS NULL""",
        (actor_agent_id, container_id),
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(403, "actor is not a live member of this container")
    if row["member_role"] != "owner":
        raise HTTPException(403, "this action requires the owner role")
    return row


def require_grant(cur, request: Request, container_id, actor_agent_id, grant):
    """Gate a management write on owner-or-grant; returns the acting member row.

    require_owner relaxed to `has_grant`: the same two lanes (trusted proxy identity
    IS the actor / trust-off body-actor fallback), but a member holding the named
    grant passes alongside owners. Viewers are refused outright — the viewer role is
    read-only, and a grant on a viewer affects reads only, never writes."""
    login = proxy_login(request)
    if login:
        member = find_member_by_login(cur, container_id, login)
        if not member:
            raise HTTPException(
                403, f"GitHub user '{login}' is not a member of this project"
            )
    else:
        require_kind(cur, actor_agent_id, ("human",))  # Orcha#30 convention
        cur.execute(
            """SELECT id, alias, github_login, member_role, grants FROM agents
               WHERE id=%s AND container_id=%s AND terminated_at IS NULL""",
            (actor_agent_id, container_id),
        )
        member = cur.fetchone()
        if not member:
            raise HTTPException(403, "actor is not a live member of this container")
    _forbid_viewer_write(member)
    if not has_grant(member, grant):
        raise HTTPException(
            403, f"this action requires the owner role or the '{grant}' permission"
        )
    return member


def enforce_grant(cur, request: Request, container_id, grant):
    """TRUSTED-LANE owner-or-grant gate for endpoints whose trust-off convention must
    stay permissive (keys, repo binding, autonomy/wakes/status/reset/sweep, agent
    management): the CLI, the notifier daemon, and self-hosters call these without a
    proxy identity, and those lanes keep today's behavior byte-for-byte.

    Trust off / no header ⇒ None (caller's existing gates apply unchanged). Trusted
    login ⇒ the member must be an owner or hold the grant (viewers refused — writes
    are banned for the role); a non-member is 403 unless the container is still
    UNMAPPED (fresh-bootstrap exemption, mirroring trusted_actor)."""
    login = proxy_login(request)
    if not login:
        return None
    member = find_member_by_login(cur, container_id, login)
    if member is None:
        if not container_mapped(cur, container_id):
            return None  # bootstrap: nobody is mapped yet
        raise HTTPException(
            403, f"GitHub user '{login}' is not a member of this project"
        )
    _forbid_viewer_write(member)
    if not has_grant(member, grant):
        raise HTTPException(
            403, f"this action requires the owner role or the '{grant}' permission"
        )
    return member


def require_member_read(cur, request: Request, container_id):
    """Close a cid-scoped READ to trusted non-members (project isolation).

    Trust off / no header ⇒ passthrough (self-host + break-glass unchanged). Trusted
    login ⇒ any resolved member reads (viewer included — viewing is the one thing the
    role is for); an UNMAPPED container stays world-readable to trusted users (the
    fresh-stack bootstrap exemption — its founder must be able to see it to claim
    it); otherwise 403. Returns the member row when one resolved."""
    login = proxy_login(request)
    if not login:
        return None
    member = find_member_by_login(cur, container_id, login)
    if member is not None:
        return member
    if not container_mapped(cur, container_id):
        return None
    raise HTTPException(
        403,
        f"your GitHub account ('{login}') is not a member of this project "
        "— ask an owner for an invite",
    )


def _identity_payload(member):
    login = member["github_login"]
    return {
        "agent_id": str(member["id"]),
        "alias": member["alias"],
        "github_login": login,
        "member_role": member["member_role"],
        # Access model (mig 039): the acting member's own grants, so the frontend can
        # gate affordances (settings tabs, roster management) off the same source the
        # server enforces. Owners implicitly hold everything; their list is not
        # synthesized here — consumers check member_role first, like has_grant().
        "grants": list(member.get("grants") or []),
        # GitHub serves any user's avatar at this well-known URL — no API call needed.
        "avatar_url": f"https://github.com/{login}.png" if login else None,
    }


@app.get("/api/me")
def get_me(request: Request, cid: str):
    """Who is the acting human, per the trusted proxy identity?
    {"identity": {...}|null, "trusted": bool}.

    `trusted` says whether a proxy-verified login was present on THIS request — it is
    what lets the frontend tell "trust off / no header: fall back to the local human"
    (self-host, unchanged) apart from "trusted but NOT a member of this project": in
    that second state the UI must show an honest viewer state, never someone else's
    identity (the per-project identity rule).

    Resolution for the container: a live human with a matching github_login is the
    actor. Else the BINDING RULE runs as a side effect (see bind_first_unmapped_human) —
    this call is what flips a fresh container's "root" human into the GitHub user. Else
    (mapped humans exist but none match) identity is null — the perimeter allowlist
    stays the hard gate; endpoints decide what null means.
    Idempotent: re-polling returns the same identity without re-binding.
    """
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    login = proxy_login(request)
    with db_cursor() as (conn, cur):
        require_container(cur, cid)
        if not login:
            return {"identity": None, "trusted": False}
        member = find_member_by_login(cur, cid, login)
        if member is None:
            member = bind_first_unmapped_human(cur, cid, login)
            if member is not None:
                log_event(
                    cur,
                    cid,
                    "human",
                    str(member["id"]),
                    "agent",
                    str(member["id"]),
                    "github_identity_bound",
                    {"github_login": member["github_login"], "alias": member["alias"]},
                )
                conn.commit()
            else:
                # Lost a concurrent bind for the SAME login? Re-read before giving up.
                member = find_member_by_login(cur, cid, login)
        # A verified sign-in counts EVERYWHERE the account is a member, whichever
        # project the portal happened to boot on: stamp every container's human row
        # carrying this login (guarded, once per row) so no membership stays
        # "pending" just because /api/me ran against a different cid. Runs even when
        # this cid resolved no identity — the viewer may be a member elsewhere.
        if _stamp_presence(cur, login):
            conn.commit()
    if member is None:
        return {"identity": None, "trusted": True}
    return {"identity": _identity_payload(member), "trusted": True}
