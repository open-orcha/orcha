"""Per-user COSMETIC preferences, keyed by the proxy-verified GitHub identity.

A signed-in user's personalization (theme / skin / sidebar / default project
star) follows their GitHub account across browsers and devices. Two hard rules
shape everything here:

  * IDENTITY-level, not container-level (mig 040): the login just has to be a
    mapped member of ANY project on this stack — /api/me's cid-scoped membership
    question is deliberately NOT asked. Appearance belongs to the account, not
    to whichever project the portal happens to be viewing.
  * COSMETIC ONLY, by construction: nothing server-side ever reads user_prefs —
    no gate, no filter, no default takes input from this table. A write here can
    restyle the portal for its own author and do nothing else, so the endpoint
    can stay far away from the authorization machinery (grants, roles, gates).

Trust contract (mirrors identity_routes): the identity is `proxy_login()` —
present only when the operator opted in via ORCHA_TRUST_PROXY_USER=1 AND the
proxy forwarded a verified login. Self-host / trust-off / break-glass lanes get
`{"prefs": null}` on GET — the frontend's explicit "stay on localStorage"
signal — and 403 on PUT. Behavior for those lanes is byte-identical to
pre-040: no code path changes, because nothing consults this table.
"""

import json

from fastapi import HTTPException, Request
from pydantic import BaseModel

from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.identity_routes import _proxy_trusted, proxy_login

# Local run (no OAuth proxy): the portal is a single-operator surface, so per-user
# prefs collapse to per-STACK prefs under one sentinel row. This is what lets
# appearance survive browser switches / app reinstalls on a laptop stack, where
# the pre-040 "localStorage only" fallback silently loses them per-origin.
LOCAL_OPERATOR_LOGIN = "__local__"


def _effective_login(request: Request):
    """proxy-verified login, else the local-operator sentinel — but ONLY when
    proxy trust is off entirely (the self-host/laptop default). On a TRUSTED
    deployment a headerless call is the break-glass service lane, not a person:
    it must never read or write the shared sentinel row, so it keeps the
    pre-existing null/403 contract. Returns (login, is_local_sentinel)."""
    login = proxy_login(request)
    if login:
        return login, False
    if not _proxy_trusted():
        return LOCAL_OPERATOR_LOGIN, True
    return None, False

# STRICT whitelist — no tolerant passthrough bucket. A new preference is a
# deliberate one-line addition here (and in the frontend mirror), never a
# client-invented key: the table must stay a tiny cosmetic bag, not a grab-bag
# state store that something eventually reads server-side.
ALLOWED_PREF_KEYS = ("theme", "skin", "sidebar", "default_cid")

# Cosmetics are a handful of short scalars; ~2KB is generous. The cap bounds the
# row (and the mirror localStorage write) whatever the client sends.
PREFS_MAX_BYTES = 2048
PREF_VALUE_MAX_CHARS = 500


class PrefsBody(BaseModel):
    prefs: dict


def _login_mapped_anywhere(cur, login) -> bool:
    """Is this GitHub login a live human member of ANY project on the stack?

    The identity-level membership question (contrast identity_routes.
    find_member_by_login, which is cid-scoped): prefs belong to the account, so
    a login mapped in project B may read/write them while viewing project A."""
    cur.execute(
        """SELECT 1 FROM agents
           WHERE kind='human' AND terminated_at IS NULL
             AND lower(github_login)=lower(%s) LIMIT 1""",
        (login,),
    )
    return cur.fetchone() is not None


def _validate_prefs(prefs: dict) -> None:
    """Strict shape gate: whitelisted keys, scalar values, bounded size."""
    unknown = sorted(k for k in prefs if k not in ALLOWED_PREF_KEYS)
    if unknown:
        raise HTTPException(
            422,
            f"unknown preference key(s): {', '.join(unknown)} — "
            f"allowed: {', '.join(ALLOWED_PREF_KEYS)}",
        )
    for key, value in prefs.items():
        if value is not None and not isinstance(value, (str, int, float, bool)):
            raise HTTPException(
                422, f"preference '{key}' must be a scalar (or null), not a container"
            )
        if isinstance(value, str) and len(value) > PREF_VALUE_MAX_CHARS:
            raise HTTPException(
                422, f"preference '{key}' exceeds {PREF_VALUE_MAX_CHARS} characters"
            )
    payload = json.dumps(prefs)
    if len(payload.encode("utf-8")) > PREFS_MAX_BYTES:
        raise HTTPException(
            422, f"prefs payload exceeds the {PREFS_MAX_BYTES}-byte cap"
        )


@app.get("/api/prefs")
def get_prefs(request: Request):
    """The signed-in user's cosmetic prefs: {"prefs": {...}} — or {"prefs": null}.

    null is a 200, not an error: it is the deliberate self-host/trust-off/
    unmapped signal telling the frontend to stay on pure localStorage (its
    pre-040 behavior). A mapped login with no row yet gets {} — server prefs
    are ACTIVE but empty, so the client mirrors its local picks up on the
    first write-through."""
    login, is_local = _effective_login(request)
    with db_cursor() as (conn, cur):
        if not is_local and (not login or not _login_mapped_anywhere(cur, login)):
            return {"prefs": None}
        cur.execute(
            "SELECT prefs FROM user_prefs WHERE github_login=%s", (login.lower(),)
        )
        row = cur.fetchone()
    return {"prefs": (row["prefs"] if row else {})}


@app.put("/api/prefs")
def put_prefs(request: Request, body: PrefsBody):
    """Replace the signed-in user's cosmetic prefs (upsert by lowercased login).

    Whole-bag replace, not a merge: the client always mirrors the complete
    cosmetic set, so replace keeps unsetting honest (drop the key, PUT). The
    write is cosmetic-only by construction — see the module docstring."""
    login, is_local = _effective_login(request)
    if not is_local and not login:
        raise HTTPException(
            403,
            "per-user preferences need a proxy-verified GitHub identity — "
            "self-host portals keep preferences in the browser",
        )
    _validate_prefs(body.prefs)
    with db_cursor() as (conn, cur):
        if not is_local and not _login_mapped_anywhere(cur, login):
            raise HTTPException(
                403,
                f"your GitHub account ('{login}') is not a member of any project "
                "on this Orcha",
            )
        cur.execute(
            """INSERT INTO user_prefs (github_login, prefs, updated_at)
               VALUES (%s, %s::jsonb, now())
               ON CONFLICT (github_login)
               DO UPDATE SET prefs=EXCLUDED.prefs, updated_at=now()""",
            (login.lower(), json.dumps(body.prefs)),
        )
        conn.commit()
    return {"prefs": body.prefs}
