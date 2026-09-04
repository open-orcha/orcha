"""Per-device bearer tokens: mint behind the OAuth proxy, validate at the perimeter.

The flow (docs/device-tokens.md): the iOS app opens /auth/device in an authenticated
browser sheet → the page POSTs /api/device-tokens (the proxy session supplies the
trusted X-Auth-Request-User header) → the raw token is handed to the app via the
orcha:// URL scheme and NEVER stored (sha256 hash only). From then on the phone sends
`Authorization: Bearer <token>`; Caddy's forward_auth lane calls GET /api/auth/check,
which answers 202 + X-Auth-Request-User so the request reaches the portal carrying the
same verified GitHub identity a browser session would — attribution works from the
phone. Revocation = DELETE /api/device-tokens/{id} (owner: anyone's; member: their own).
"""

import hashlib
import secrets
from typing import Optional

from fastapi import HTTPException, Request, Response
from fastapi.responses import HTMLResponse

from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import valid_uuid
from portal_backend.identity_routes import proxy_login
from portal_backend.schemas import DeviceTokenCreate
from portal_backend.static_pages import serve_page

# /api/auth/check stamps last_used_at at most once per this window, so a chatty
# phone (3s polling) costs one UPDATE a minute instead of one per request.
_TOUCH_THROTTLE_SECS = 60


def _token_hash(token: str) -> str:
    """sha256 hex of the raw token — the only form the DB ever sees."""
    return hashlib.sha256(token.encode()).hexdigest()


def _acting_memberships(cur, request: Request):
    """(login, membership rows) for the trusted proxy identity, or 403.

    Match-only resolution (reused shape of identity_routes.find_member_by_login,
    across containers): a live human agent carrying the login. The BINDING RULE stays
    /api/me's side effect — an identity that never touched the portal resolves to no
    member here and is refused; /auth/device surfaces that as "ask an owner to invite
    you". Rows come back founding-first so the earliest membership is the mint anchor.
    """
    login = proxy_login(request)
    if not login:
        raise HTTPException(
            403, "device tokens require a verified GitHub identity (trusted proxy)"
        )
    cur.execute(
        """SELECT id, container_id, alias, github_login, member_role FROM agents
           WHERE kind='human' AND terminated_at IS NULL
             AND lower(github_login)=lower(%s)
           ORDER BY created_at ASC, id ASC""",
        (login,),
    )
    rows = cur.fetchall()
    if not rows:
        raise HTTPException(
            403, f"GitHub user '{login}' is not a member of any project"
        )
    return login, rows


@app.post("/api/device-tokens", status_code=201)
def mint_device_token(request: Request, body: Optional[DeviceTokenCreate] = None):
    """Mint a device token for the acting member. The raw token appears in THIS
    response only; the row keeps its sha256. 403 for anonymous/non-member callers."""
    label = body.label if body else None
    with db_cursor() as (conn, cur):
        _, memberships = _acting_memberships(cur, request)
        member = memberships[0]  # earliest membership anchors the token
        token = secrets.token_urlsafe(32)
        cur.execute(
            """INSERT INTO device_tokens (container_id, agent_id, token_hash, label)
               VALUES (%s, %s, %s, %s) RETURNING id""",
            (member["container_id"], member["id"], _token_hash(token), label),
        )
        token_id = str(cur.fetchone()["id"])
        log_event(
            cur,
            member["container_id"],
            "human",
            str(member["id"]),
            "agent",
            str(member["id"]),
            "device_token_minted",
            {"token_id": token_id, "label": label},
        )
        conn.commit()
    return {"token": token, "agent_id": str(member["id"]), "label": label}


@app.get("/api/auth/check", status_code=202)
def auth_check(request: Request, response: Response):
    """The perimeter's forward_auth validator — deliberately NOT gated on the trusted
    header (this endpoint is what MAKES the header for the device lane). A bearer
    token hashing to a live, unrevoked row answers 202 with X-Auth-Request-User set
    to the owning member's github_login (Caddy copy_headers carries it upstream);
    anything else is 401. Tokens die with their human: a retired/removed member's
    rows no longer resolve."""
    authorization = request.headers.get("Authorization") or ""
    scheme, _, token = authorization.partition(" ")
    token = token.strip()
    if scheme != "Bearer" or not token:
        raise HTTPException(401, "missing bearer token")
    with db_cursor() as (conn, cur):
        cur.execute(
            """SELECT dt.id, a.github_login FROM device_tokens dt
               JOIN agents a ON a.id = dt.agent_id
               WHERE dt.token_hash=%s AND dt.revoked_at IS NULL
                 AND a.terminated_at IS NULL AND a.github_login IS NOT NULL""",
            (_token_hash(token),),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(401, "unknown or revoked device token")
        cur.execute(
            """UPDATE device_tokens SET last_used_at=now()
               WHERE id=%s AND (last_used_at IS NULL
                                OR last_used_at < now() - %s * interval '1 second')""",
            (row["id"], _TOUCH_THROTTLE_SECS),
        )
        if cur.rowcount:
            conn.commit()
    response.headers["X-Auth-Request-User"] = row["github_login"]
    return {"user": row["github_login"]}


@app.get("/api/device-tokens")
def list_device_tokens(request: Request):
    """The acting identity's own live tokens (id/label/created/last used) — owners see
    THEIR list here too; revoking someone else's token goes by id via DELETE."""
    with db_cursor() as (_, cur):
        _, memberships = _acting_memberships(cur, request)
        cur.execute(
            """SELECT id, label, created_at, last_used_at FROM device_tokens
               WHERE agent_id = ANY(%s) AND revoked_at IS NULL
               ORDER BY created_at DESC, id DESC""",
            ([m["id"] for m in memberships],),
        )
        return {"tokens": cur.fetchall()}


@app.delete("/api/device-tokens/{token_id}")
def revoke_device_token(token_id: str, request: Request):
    """Revoke a device token: an owner (of the token's container) may revoke ANY
    member's token; a member only their own. Idempotent — re-revoking answers
    revoked=false rather than erroring."""
    if not valid_uuid(token_id):
        raise HTTPException(400, "token id is not a valid UUID")
    with db_cursor() as (conn, cur):
        login, memberships = _acting_memberships(cur, request)
        cur.execute(
            """SELECT dt.id, dt.container_id, dt.agent_id, dt.label,
                      a.github_login AS holder_login
               FROM device_tokens dt JOIN agents a ON a.id = dt.agent_id
               WHERE dt.id=%s""",
            (token_id,),
        )
        tok = cur.fetchone()
        if not tok:
            raise HTTPException(404, f"device token {token_id} not found")
        own = (tok["holder_login"] or "").lower() == login.lower()
        acting = next(
            (m for m in memberships if m["container_id"] == tok["container_id"]),
            None,
        )
        if not own and not (acting and acting["member_role"] == "owner"):
            raise HTTPException(
                403, "only the token's member or a project owner can revoke it"
            )
        cur.execute(
            "UPDATE device_tokens SET revoked_at=now() "
            "WHERE id=%s AND revoked_at IS NULL",
            (token_id,),
        )
        revoked = cur.rowcount > 0
        if revoked:
            actor = acting or memberships[0]
            log_event(
                cur,
                tok["container_id"],
                "human",
                str(actor["id"]),
                "agent",
                str(tok["agent_id"]),
                "device_token_revoked",
                {"token_id": token_id, "label": tok["label"], "own": own},
            )
            conn.commit()
    return {"id": token_id, "revoked": revoked}


@app.get("/auth/device", response_class=HTMLResponse)
def device_auth_page():
    """The pairing page the iOS app opens in its authenticated browser sheet. Only
    reachable through the OAuth-proxied browser lane (no bearer header → forward_auth
    to oauth2-proxy), so the fetch it fires carries the trusted identity."""
    return serve_page("dist/index.html")  # React SPA shell (open-orcha base; cloud pages via src/extensions.ts)
