"""APNs push-device registry + the box-internal outbox lane (DORMANT until credentials).

Two distinct surfaces share this module:

  * /api/push/devices — the PHONE lane, identity-level like user_prefs (mig 040):
    a proxy-verified GitHub login that is a live human member of ANY project on
    the stack registers/lists/revokes its own APNs device tokens. No container_id
    in the API — the device belongs to the account. Untrusted / headerless /
    unmapped callers are refused (403); self-host stacks simply have no surface
    here, same as device_tokens.

  * /api/push/outbox/* + /api/push/devices/revoke-unregistered — the BOX lane,
    used by deploy/push-forwarder.py over loopback. These follow the OPPOSITE
    gate: a trusted browser identity is refused (403) — a member must not claim
    or suppress the outbox — while the headerless loopback/break-glass lane
    passes, the same convention the deploy timers (sync-members.sh) rely on.

Trust boundary (design rule): this box NEVER holds the APNs signing key. The
outbox stores only (kind, ref, title, body); the claim response resolves live
member devices at send time; signing + delivery happen on the central relay
(deploy/push-relay/). APNs device tokens are not secrets — possession without
the .p8 key delivers nothing — so storing/returning them raw is fine.
"""

import re

from fastapi import HTTPException, Request
from pydantic import BaseModel, Field

from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import valid_uuid
from portal_backend.identity_routes import proxy_login

# APNs device tokens are hex blobs (64 hex chars today; Apple says treat length
# as opaque). Accept 16..200 hex chars, store lowercased — reject anything else
# so the table can't become a junk-string store.
_TOKEN_RE = re.compile(r"^[0-9a-f]{16,200}$")

PLATFORMS = ("ios",)

# Deep-link payload kind per outbox kind — matches the iOS local-notification
# userInfo contract {cid, kind, id} (NotificationManager.swift tap routing).
_PAYLOAD_KIND = {"task_verify": "task", "plan_approval": "task", "request": "request"}


class PushDeviceBody(BaseModel):
    apns_token: str
    platform: str = "ios"


class PushDeviceRef(BaseModel):
    apns_token: str


class OutboxClaim(BaseModel):
    limit: int = Field(default=100, ge=1, le=500)


class OutboxMark(BaseModel):
    delivered: list[str] = Field(default_factory=list)
    failed: dict[str, str] = Field(default_factory=dict)


class RevokeUnregistered(BaseModel):
    apns_tokens: list[str] = Field(default_factory=list)


def _normalized_token(raw: str) -> str:
    token = (raw or "").strip().lower()
    if not _TOKEN_RE.fullmatch(token):
        raise HTTPException(422, "apns_token must be 16-200 hex characters")
    return token


def _acting_login(cur, request: Request) -> str:
    """The trusted identity, required to be a live member of ANY project (403
    otherwise) — the same identity-level membership rule as /api/prefs."""
    login = proxy_login(request)
    if not login:
        raise HTTPException(
            403, "push devices require a verified GitHub identity (trusted proxy)"
        )
    cur.execute(
        """SELECT 1 FROM agents
           WHERE kind='human' AND terminated_at IS NULL
             AND lower(github_login)=lower(%s) LIMIT 1""",
        (login,),
    )
    if cur.fetchone() is None:
        raise HTTPException(
            403, f"GitHub user '{login}' is not a member of any project"
        )
    return login.lower()


def _forbid_browser_identity(request: Request) -> None:
    """The box lane: loopback/timer callers carry no trusted identity; a signed-in
    member must not drive the outbox (claiming marks delivery state for everyone)."""
    if proxy_login(request):
        raise HTTPException(
            403, "this is a box-internal endpoint — not callable with a user identity"
        )


# ---------------------------------------------------------------- phone lane


@app.post("/api/push/devices", status_code=201)
def register_push_device(request: Request, body: PushDeviceBody):
    """Register (or refresh) this phone's APNs token for the acting identity.

    Upsert by token: iOS hands the app the same token across launches, so
    re-registering just stamps last_seen_at — and RE-OWNS the row to the current
    login, so a phone that changes hands stops pushing to its previous owner.
    Re-registering a previously revoked token revives it (the phone is
    demonstrably back in a signed-in member's hands)."""
    if body.platform not in PLATFORMS:
        raise HTTPException(422, f"platform must be one of {PLATFORMS}")
    token = _normalized_token(body.apns_token)
    with db_cursor() as (conn, cur):
        login = _acting_login(cur, request)
        cur.execute(
            """INSERT INTO push_devices (github_login, apns_token, platform, last_seen_at)
               VALUES (%s, %s, %s, now())
               ON CONFLICT (apns_token) DO UPDATE
                 SET github_login=EXCLUDED.github_login,
                     platform=EXCLUDED.platform,
                     last_seen_at=now(),
                     revoked_at=NULL
               RETURNING id, github_login, apns_token, platform,
                         created_at, last_seen_at""",
            (login, token, body.platform),
        )
        row = cur.fetchone()
        conn.commit()
    row["id"] = str(row["id"])
    return {"device": row}


@app.get("/api/push/devices")
def list_push_devices(request: Request):
    """The acting identity's own live devices (a member sees only their own)."""
    with db_cursor() as (_, cur):
        login = _acting_login(cur, request)
        cur.execute(
            """SELECT id, apns_token, platform, created_at, last_seen_at
               FROM push_devices
               WHERE github_login=%s AND revoked_at IS NULL
               ORDER BY created_at DESC, id DESC""",
            (login,),
        )
        rows = cur.fetchall()
    for row in rows:
        row["id"] = str(row["id"])
    return {"devices": rows}


@app.delete("/api/push/devices")
def revoke_push_device(request: Request, body: PushDeviceRef):
    """Revoke a device by token: your own, or — as an owner — a device held by a
    member of a project you own. Idempotent: re-revoking answers revoked=false."""
    token = _normalized_token(body.apns_token)
    with db_cursor() as (conn, cur):
        login = _acting_login(cur, request)
        cur.execute(
            "SELECT id, github_login, revoked_at FROM push_devices WHERE apns_token=%s",
            (token,),
        )
        device = cur.fetchone()
        if not device:
            raise HTTPException(404, "no push device registered with that token")
        own = device["github_login"] == login
        if not own:
            # Owner reach: some project where the acting login holds the owner
            # role AND the device's holder is a live member.
            cur.execute(
                """SELECT 1 FROM agents me
                   JOIN agents holder ON holder.container_id = me.container_id
                   WHERE me.kind='human' AND me.terminated_at IS NULL
                     AND lower(me.github_login)=%s AND me.member_role='owner'
                     AND holder.kind='human' AND holder.terminated_at IS NULL
                     AND lower(holder.github_login)=%s
                   LIMIT 1""",
                (login, device["github_login"]),
            )
            if cur.fetchone() is None:
                raise HTTPException(
                    403,
                    "only the device's member or an owner of one of their "
                    "projects can revoke it",
                )
        cur.execute(
            "UPDATE push_devices SET revoked_at=now() "
            "WHERE id=%s AND revoked_at IS NULL",
            (device["id"],),
        )
        revoked = cur.rowcount > 0
        conn.commit()
    return {"id": str(device["id"]), "revoked": revoked}


# ------------------------------------------------------------------ box lane


@app.post("/api/push/outbox/claim")
def claim_push_outbox(request: Request, body: OutboxClaim):
    """The forwarder's poll: prune stale rows, then return pending events with
    each event's recipient devices RESOLVED AT SEND TIME (live devices of the
    container's live mapped members — never a snapshot from enqueue time).

    Claiming does NOT mark delivery — the forwarder reports outcomes via
    /api/push/outbox/mark after the relay answers, so a crash between claim and
    mark re-sends next tick (at-least-once, bounded by the 48h prune).
    A pending row whose audience has vanished (all devices revoked since
    enqueue) is failed in place so it stops re-claiming."""
    _forbid_browser_identity(request)
    with db_cursor() as (conn, cur):
        cur.execute(
            "DELETE FROM push_outbox WHERE created_at < now() - interval '48 hours'"
        )
        cur.execute(
            """SELECT id, container_id, kind, ref_id, title, body, created_at
               FROM push_outbox
               WHERE delivered_at IS NULL AND failed IS NULL
               ORDER BY created_at ASC, id ASC
               LIMIT %s""",
            (body.limit,),
        )
        rows = cur.fetchall()
        events, empty_ids = [], []
        for row in rows:
            cur.execute(
                """SELECT pd.apns_token FROM push_devices pd
                   WHERE pd.revoked_at IS NULL
                     AND EXISTS (SELECT 1 FROM agents a
                                  WHERE a.container_id=%s AND a.kind='human'
                                    AND a.terminated_at IS NULL
                                    AND lower(a.github_login)=pd.github_login)
                   ORDER BY pd.created_at ASC""",
                (row["container_id"],),
            )
            devices = [d["apns_token"] for d in cur.fetchall()]
            if not devices:
                empty_ids.append(row["id"])
                continue
            events.append(
                {
                    "id": str(row["id"]),
                    "container_id": str(row["container_id"]),
                    "kind": row["kind"],
                    "ref_id": str(row["ref_id"]),
                    "title": row["title"],
                    "body": row["body"],
                    "payload": {
                        "cid": str(row["container_id"]),
                        "kind": _PAYLOAD_KIND.get(row["kind"], "task"),
                        "id": str(row["ref_id"]),
                    },
                    "devices": devices,
                }
            )
        if empty_ids:
            cur.execute(
                "UPDATE push_outbox SET failed='no live devices at claim' "
                "WHERE id = ANY(%s)",
                (empty_ids,),
            )
        conn.commit()
    return {"events": events}


@app.post("/api/push/outbox/mark")
def mark_push_outbox(request: Request, body: OutboxMark):
    """The forwarder's outcome report: stamp delivered_at / failed per row.
    Unknown or already-terminal ids are ignored (at-least-once tolerance)."""
    _forbid_browser_identity(request)
    delivered_ids = [i for i in body.delivered if valid_uuid(i)]
    failed_items = {i: r for i, r in body.failed.items() if valid_uuid(i)}
    delivered = failed = 0
    with db_cursor() as (conn, cur):
        if delivered_ids:
            cur.execute(
                "UPDATE push_outbox SET delivered_at=now() "
                "WHERE id = ANY(%s) AND delivered_at IS NULL",
                (delivered_ids,),
            )
            delivered = cur.rowcount
        for oid, reason in failed_items.items():
            cur.execute(
                "UPDATE push_outbox SET failed=%s "
                "WHERE id=%s AND delivered_at IS NULL AND failed IS NULL",
                ((reason or "failed")[:300], oid),
            )
            failed += cur.rowcount
        conn.commit()
    return {"delivered": delivered, "failed": failed}


@app.post("/api/push/devices/revoke-unregistered")
def revoke_unregistered_devices(request: Request, body: RevokeUnregistered):
    """APNs said Unregistered for these tokens (app deleted / token rotated):
    the forwarder retires them so they stop resolving at claim time. The phone
    re-registers on next launch if push is still wanted."""
    _forbid_browser_identity(request)
    tokens = [t.strip().lower() for t in body.apns_tokens if (t or "").strip()]
    if not tokens:
        return {"revoked": 0}
    with db_cursor() as (conn, cur):
        cur.execute(
            "UPDATE push_devices SET revoked_at=now() "
            "WHERE apns_token = ANY(%s) AND revoked_at IS NULL",
            (tokens,),
        )
        revoked = cur.rowcount
        conn.commit()
    return {"revoked": revoked}
