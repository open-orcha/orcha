"""Per-container GitHub personal access token — Orcha Cloud local run gap #1 (GitHub
access without the App). Self-hosters running `orcha up` on a laptop have no GitHub App
installation and no host-side token-refresh timer; a PAT is the lowest-precedence
fallback source github_routes._read_token / _read_token_map resolve through (see
`docs/orcha-cloud-local-run.md` §1). App-managed token files, where present, keep
winning unchanged — this module never touches that resolution order itself, only the
storage + test-ping surface a PAT needs.

  * GET    /api/containers/{cid}/settings/github-pat       -> status (never the secret)
  * PUT    /api/containers/{cid}/settings/github-pat        -> seal + store (human-gated)
  * DELETE /api/containers/{cid}/settings/github-pat        -> clear (human-gated)
  * POST   /api/containers/{cid}/settings/github-pat/test   -> GET /user credential ping

Same discipline as /settings/llm-key and /settings/provider-keys: GET is open (masked
hint only); PUT/DELETE/test are HUMAN-AUTHORITY gated + audit-logged; sealed via
secret_box, 503 without ORCHA_SECRET_KEY; env override (ORCHA_GITHUB_PAT) shadows the
stored token, same shadow semantics as the LLM keys.
"""

import json
import os
import urllib.error
import urllib.request
from typing import Optional

from fastapi import HTTPException, Request

from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_container, require_kind, valid_uuid
from portal_backend.identity_routes import enforce_grant, require_member_read, trusted_actor
from portal_backend.schemas import GithubPatActor, GithubPatTest, GithubPatUpdate

try:
    import secret_box
except ImportError:
    from orcha_cli import secret_box

GITHUB_USER_URL = "https://api.github.com/user"
GITHUB_TIMEOUT_SECONDS = 10
PAT_ENV_VAR = "ORCHA_GITHUB_PAT"


def _mask_pat(hint: Optional[str]) -> Optional[str]:
    """Render the last-4 hint as a masked display value, or None when no PAT is set."""
    return f"ghp_...{hint}" if hint else None


def _stored_pat_row(cur, container_id: str):
    cur.execute(
        "SELECT token_enc, token_hint, set_at FROM container_github_pat WHERE container_id=%s",
        (container_id,),
    )
    return cur.fetchone()


def stored_pat(cur, container_id: str) -> Optional[str]:
    """The decrypted DB-stored PAT for this container, or None (missing row / no master
    key / corrupt blob — a bad row degrades to 'no stored token' rather than raising,
    mirroring provider_keys.provider_api_key). Calls `secret_box.unseal` directly
    (rather than `resolve_llm_key`) — that helper's env-override check is keyed on
    ORCHA_LLM_API_KEY, an unrelated credential; a PAT's own env override
    (ORCHA_GITHUB_PAT) is handled one level up, in `pat_for_container`."""
    row = _stored_pat_row(cur, container_id)
    if not row or not row["token_enc"]:
        return None
    try:
        return secret_box.unseal(row["token_enc"])
    except secret_box.SecretBoxError:
        return None


def pat_for_container(cur, container_id: Optional[str]) -> Optional[str]:
    """The effective PAT for `container_id` — env override (ORCHA_GITHUB_PAT) first,
    else the DB-stored PAT for that container. This is the ONE seam github_routes and
    github_hub_routes thread a cid through to reach the lowest-precedence token source
    (see those modules' `_read_pat`/`_resolve_repo_token`). `container_id` may be None
    (no container in scope yet) — the env override still applies; the DB lookup is
    simply skipped."""
    env_override = (os.environ.get(PAT_ENV_VAR) or "").strip()
    if env_override:
        return env_override
    if not container_id:
        return None
    return stored_pat(cur, container_id)


def _test_pat(token: str) -> dict:
    """GET https://api.github.com/user with `token` — the credential ping PUT's setup
    flow and the /test route share. Returns {ok, login|detail, scopes?}: `scopes` is a
    list parsed from the X-OAuth-Scopes response header when GitHub sends one (classic
    PATs; fine-grained PATs typically omit it, so its absence is not an error). Never
    raises — any network/HTTP failure becomes ok:False with an honest detail string."""
    request = urllib.request.Request(
        GITHUB_USER_URL,
        headers={
            "Authorization": f"token {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "orcha-portal",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=GITHUB_TIMEOUT_SECONDS) as response:
            payload = json.loads(response.read().decode("utf-8"))
            scopes_header = response.headers.get("X-OAuth-Scopes")
    except urllib.error.HTTPError as exc:
        detail = f"GitHub returned {exc.code} for /user"
        if exc.code == 401:
            detail = "GitHub rejected this token (401 — invalid or expired)"
        return {"ok": False, "detail": detail}
    except Exception as exc:  # DNS, timeout, TLS, bad JSON — one graceful shape
        return {"ok": False, "detail": f"could not reach GitHub: {exc}"}
    result = {"ok": True, "login": payload.get("login")}
    if scopes_header is not None:
        result["scopes"] = [s.strip() for s in scopes_header.split(",") if s.strip()]
    return result


@app.get("/api/containers/{cid}/settings/github-pat", status_code=200)
def get_container_github_pat(cid: str, request: Request):
    """Report whether a container has a GitHub PAT configured, and from where — NEVER
    the secret. Precedence mirrors the read path: an ORCHA_GITHUB_PAT env override is
    reported as source='env' (and shadows any stored token); else a stored token is
    source='db'; else configured=False. `masked` is a 'ghp_...1234' hint; `set_at`
    feeds the SETTINGS banner."""
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (_, cur):
        require_container(cur, cid)
        # Access model: reads are project-isolated (trusted non-member 403).
        require_member_read(cur, request, cid)
        row = _stored_pat_row(cur, cid)
    env_override = (os.environ.get(PAT_ENV_VAR) or "").strip()
    if env_override:
        return {
            "configured": True,
            "source": "env",
            "masked": _mask_pat(secret_box.last4(env_override)),
            "set_at": None,
        }
    if row and row["token_enc"]:
        return {
            "configured": True,
            "source": "db",
            "masked": _mask_pat(row["token_hint"]),
            "set_at": row["set_at"],
        }
    return {"configured": False, "source": None, "masked": None, "set_at": None}


@app.put("/api/containers/{cid}/settings/github-pat", status_code=200)
def put_container_github_pat(cid: str, body: GithubPatUpdate, request: Request):
    """Seal + store a per-container GitHub PAT. HUMAN-AUTHORITY gated + audit-logged.
    Returns the masked hint, never the plaintext. 503 if ORCHA_SECRET_KEY is unset
    (encrypted persistence disabled — the operator can still use the ORCHA_GITHUB_PAT
    env override instead)."""
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    token = body.token.strip()
    if not token:
        raise HTTPException(400, "token must not be blank")
    with db_cursor() as (conn, cur):
        require_container(cur, cid)
        # Per-project identity: a trusted proxy login IS the actor (403 non-member).
        # Access model: credentials are owner-or-manage_keys (trusted lane).
        enforce_grant(cur, request, cid, "manage_keys")
        body.actor_agent_id = trusted_actor(cur, request, cid, body.actor_agent_id)
        require_kind(cur, body.actor_agent_id, ("human",))  # writing a credential is a human action
        if not secret_box.master_key_present():
            raise HTTPException(
                503,
                "encrypted key storage is disabled: ORCHA_SECRET_KEY is not set in the portal "
                "environment. Set it to store a token, or use the ORCHA_GITHUB_PAT env override.",
            )
        sealed = secret_box.seal(token)
        hint = secret_box.last4(token)
        cur.execute(
            "INSERT INTO container_github_pat (container_id, token_enc, token_hint, set_at) "
            "VALUES (%s, %s, %s, now()) "
            "ON CONFLICT (container_id) DO UPDATE SET "
            "token_enc=EXCLUDED.token_enc, token_hint=EXCLUDED.token_hint, set_at=now()",
            (cid, sealed, hint),
        )
        log_event(
            cur,
            cid,
            "human",
            body.actor_agent_id,
            "container",
            cid,
            "github_pat_set",
            {"hint": hint},
        )
        conn.commit()
    return {"configured": True, "source": "db", "masked": _mask_pat(hint)}


@app.delete("/api/containers/{cid}/settings/github-pat", status_code=200)
def delete_container_github_pat(cid: str, body: GithubPatActor, request: Request):
    """Remove the stored PAT (resolution falls back to the env override, else none).
    HUMAN-AUTHORITY gated + audit-logged. Carries a JSON body for the actor (no other
    body fields) — same convention as DELETE .../settings/llm-key."""
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        require_container(cur, cid)
        # Per-project identity: a trusted proxy login IS the actor (403 non-member).
        # Access model: credentials are owner-or-manage_keys (trusted lane).
        enforce_grant(cur, request, cid, "manage_keys")
        body.actor_agent_id = trusted_actor(cur, request, cid, body.actor_agent_id)
        require_kind(cur, body.actor_agent_id, ("human",))
        cur.execute("DELETE FROM container_github_pat WHERE container_id=%s", (cid,))
        log_event(
            cur,
            cid,
            "human",
            body.actor_agent_id,
            "container",
            cid,
            "github_pat_cleared",
            {},
        )
        conn.commit()
    env_override = (os.environ.get(PAT_ENV_VAR) or "").strip()
    if env_override:
        return {
            "configured": True,
            "source": "env",
            "masked": _mask_pat(secret_box.last4(env_override)),
        }
    return {"configured": False, "source": None, "masked": None}


@app.post("/api/containers/{cid}/settings/github-pat/test", status_code=200)
def test_container_github_pat(cid: str, body: GithubPatTest, request: Request):
    """Server-side credential ping against GET https://api.github.com/user.
    HUMAN-AUTHORITY gated. With `token` -> test that candidate (the pre-save setup
    flow); without -> test the currently-resolved token (env override > stored).
    Returns {ok, login|detail, scopes?} — a 401 from GitHub is ok=False (bad token),
    never a 500. The network call runs OUTSIDE the DB transaction (no lock held during
    I/O), matching /settings/llm-key/test."""
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        require_container(cur, cid)
        # Per-project identity: a trusted proxy login IS the actor (403 non-member).
        # Access model: credentials are owner-or-manage_keys (trusted lane).
        enforce_grant(cur, request, cid, "manage_keys")
        body.actor_agent_id = trusted_actor(cur, request, cid, body.actor_agent_id)
        require_kind(cur, body.actor_agent_id, ("human",))
        if body.token and body.token.strip():
            candidate: Optional[str] = body.token.strip()
        else:
            candidate = pat_for_container(cur, cid)
    if not candidate:
        return {
            "ok": False,
            "detail": "no token to test: none supplied, none stored, and ORCHA_GITHUB_PAT is unset",
        }
    return _test_pat(candidate)
