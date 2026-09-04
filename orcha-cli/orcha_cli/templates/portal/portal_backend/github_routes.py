"""Bind a container to a GitHub repo and list the App installation's repositories."""

import json
import os
import urllib.error
import urllib.request
from typing import Optional

from fastapi import HTTPException, Request

from portal_backend import local_git
from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_container, valid_uuid
from portal_backend.identity_routes import (
    enforce_grant,
    require_member_read,
    trusted_actor,
)
from portal_backend.schemas import ContainerGithubBinding

# One page of 100 covers every realistic single-project installation; a >100-repo
# installation simply sees the first page (pagination can ride a later slice).
GITHUB_REPOS_URL = "https://api.github.com/installation/repositories?per_page=100"
# The PAT fallback (Orcha Cloud local run gap #1): App-only /installation/repositories
# isn't reachable with a personal token, so a PAT-sourced listing instead asks GitHub
# for the repos the token's own user can see — sorted by most-recently-pushed, which
# is the more useful default ordering for "what am I probably about to work on".
GITHUB_USER_REPOS_URL = "https://api.github.com/user/repos?per_page=100&sort=pushed"
GITHUB_TIMEOUT_SECONDS = 10


def _read_token():
    """Read the GitHub App INSTALLATION token the host-side refresh timer maintains.

    The compose template bind-mounts the stack dir read-only and points
    ORCHA_GITHUB_TOKEN_FILE at <stack>/github-token. Only this short-lived token ever
    reaches a container — the App's PEM stays on the host, always. Env unset, file
    missing/unreadable, or file empty all mean "the GitHub App isn't wired here"
    (a normal state for self-hosters) and resolve to None, never an error.
    """
    path = (os.environ.get("ORCHA_GITHUB_TOKEN_FILE") or "").strip()
    if not path:
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            token = fh.read().strip()
    except OSError:
        return None
    return token or None


def _read_token_map():
    """Read the multi-installation token map the refresh timer maintains (multi-org).

    ORCHA_GITHUB_TOKENS_FILE points at a JSON object {"<owner-lowercase>": "<token>"}
    with one installation token per org/user the App is installed on
    (<project>/.orcha/github-tokens.json on the host). Env unset, file
    missing/unreadable, not a JSON object, or an empty/valueless map all resolve to
    None — the caller then falls back to the legacy single-token file. Never an error.
    """
    path = (os.environ.get("ORCHA_GITHUB_TOKENS_FILE") or "").strip()
    if not path:
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    tokens = {
        str(owner).lower(): str(token).strip()
        for owner, token in data.items()
        if isinstance(token, str) and token.strip()
    }
    return tokens or None


def _read_pat(cid: Optional[str] = None) -> Optional[str]:
    """Read the PAT fallback source (Orcha Cloud local run gap #1) — LOWEST precedence,
    beneath the token map and the single-token file above. env ORCHA_GITHUB_PAT wins;
    else the DB-stored per-container PAT (github_pat_routes' sealed storage), read via a
    short-lived cursor since callers here don't already hold one open. `cid` is optional:
    every caller in this module has one in scope by the time a PAT lookup is reached
    (a bound repo implies a container), but the env override alone is still useful with
    no cid (e.g. the unscoped /api/github/repos listing before a repo is chosen).
    """
    try:
        from portal_backend.github_pat_routes import pat_for_container
    except ImportError:  # pragma: no cover - module always ships alongside this one
        return None
    if cid is None:
        env_override = (os.environ.get("ORCHA_GITHUB_PAT") or "").strip()
        return env_override or None
    with db_cursor() as (_, cur):
        return pat_for_container(cur, cid)


def _fetch_installation_repos(token: str) -> list:
    """Fetch the repos this installation token can see (the App's installed repos).

    GET https://api.github.com/installation/repositories with the installation token
    lists exactly the repositories the App is installed on. stdlib urllib, matching the
    rest of the codebase (no httpx dependency). Raises RuntimeError with a short,
    user-showable detail string on any GitHub/network failure — the route maps that to
    the graceful {"available": false, "detail": ...} shape. Tests monkeypatch THIS
    function (the network leaf), never the route.
    """
    request = urllib.request.Request(
        GITHUB_REPOS_URL,
        headers={
            "Authorization": f"token {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "orcha-portal",
        },
    )
    try:
        with urllib.request.urlopen(
            request, timeout=GITHUB_TIMEOUT_SECONDS
        ) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise RuntimeError(
            f"GitHub returned {exc.code} for installation/repositories"
        ) from exc
    except Exception as exc:  # DNS, timeout, TLS, bad JSON — one graceful shape
        raise RuntimeError(f"could not reach GitHub: {exc}") from exc
    return payload.get("repositories") or []


def _fetch_user_repos(token: str) -> list:
    """Fetch the repos this PAT's own user can see (the PAT listing fallback — Orcha
    Cloud local run gap #1). GET https://api.github.com/user/repos, sorted by most-
    recently-pushed. Same stdlib urllib + RuntimeError contract as
    `_fetch_installation_repos`; the two are interchangeable to callers, differing only
    in which GitHub endpoint they hit and what kind of token they expect."""
    request = urllib.request.Request(
        GITHUB_USER_REPOS_URL,
        headers={
            "Authorization": f"token {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "orcha-portal",
        },
    )
    try:
        with urllib.request.urlopen(
            request, timeout=GITHUB_TIMEOUT_SECONDS
        ) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"GitHub returned {exc.code} for user/repos") from exc
    except Exception as exc:  # DNS, timeout, TLS, bad JSON — one graceful shape
        raise RuntimeError(f"could not reach GitHub: {exc}") from exc
    return payload if isinstance(payload, list) else []


def _repo_entry(repo: dict) -> dict:
    return {
        "full_name": repo.get("full_name"),
        "private": bool(repo.get("private")),
        "description": repo.get("description"),
        "html_url": repo.get("html_url"),
    }


def _local_repo_entry() -> Optional[dict]:
    """The Connect-repo modal's local-source entry (Addendum 2) — `full_name: "local"`
    is the SAME sentinel `PUT .../github` accepts as `repo`, so the frontend needs no
    special-case wiring beyond rendering this row first. None when local_git isn't
    available (env unset, dir/`.git` missing, or no `git` binary) — the caller only
    prepends when this returns something real."""
    if not local_git.available():
        return None
    name = local_git.workspace_name() or "local"
    return {
        "full_name": "local",
        "name": name,
        "source_kind": "local",
        "private": False,
        "description": None,
        "html_url": None,
    }


@app.get("/api/github/repos")
def list_github_repos(request: Request, cid: Optional[str] = None):
    """List repos reachable for the Connect-repo modal, App installs first.

    Multi-org: when the token map (ORCHA_GITHUB_TOKENS_FILE) is present, every
    installation's repos are fetched and merged (deduped, sorted by full_name);
    `available` is true if ANY installation answered, and per-owner failures ride a
    `detail` string. Without the map, the legacy single-token file is used unchanged.
    Either App path returns `"source": "app"`.

    PAT fallback (Orcha Cloud local run gap #1): when NEITHER App source resolves a
    token, a PAT is tried (env ORCHA_GITHUB_PAT, else the DB-stored PAT for `cid` if
    one was passed — this endpoint is otherwise container-unscoped, so `cid` is an
    OPTIONAL query param a caller may supply once a project is in view). App-only
    `/installation/repositories` isn't reachable with a personal token, so a PAT-backed
    listing instead calls `GET /user/repos?per_page=100&sort=pushed` — same response
    shape via the shared `_repo_entry` mapping, plus `"source": "pat"`.

    No token at all (self-hosters without the App or a PAT) → 200 {"available": false,
    "repos": []} — a graceful off state, deliberately NOT an error. A GitHub-side
    failure is likewise available:false plus a short `detail` string.

    Local source (Addendum 2): whenever `local_git.available()` (the project's own
    working tree is mounted + has a `.git`), a `{full_name:"local", source_kind:
    "local", ...}` entry is PREPENDED to `repos` in every branch below — including the
    otherwise-fully-off "no token at all" case, where `available` flips to `true` on
    the strength of the local entry alone (the Connect-repo modal then always has
    SOMETHING to offer, even with zero GitHub setup). The `source` field keeps meaning
    "which GitHub path fed the GitHub half of the list" unchanged; it says nothing
    about the prepended local entry.
    """
    if cid is not None:
        # Access model: a `cid` unlocks THAT project's sealed PAT (`_read_pat` →
        # `pat_for_container`), so the caller must be able to read that project — a
        # trusted non-member is refused (403) exactly like every cid-scoped GET
        # (require_member_read); trust off / no header is unchanged. Without this any
        # authenticated user could list another project's PAT owner's private repos.
        if not valid_uuid(cid):
            raise HTTPException(400, "cid is not a valid UUID")
        with db_cursor() as (_, cur):
            require_container(cur, cid)
            require_member_read(cur, request, cid)
    local_entry = _local_repo_entry()

    token_map = _read_token_map()
    if token_map:
        merged: dict = {}
        failures = []
        for owner in sorted(token_map):
            try:
                raw = _fetch_installation_repos(token_map[owner])
            except RuntimeError as exc:
                failures.append(f"{owner}: {exc}")
                continue
            for repo in raw:
                merged.setdefault(repo.get("full_name"), _repo_entry(repo))
        repos = [merged[name] for name in sorted(merged, key=lambda n: n or "")]
        result = {
            "available": len(failures) < len(token_map),
            "repos": ([local_entry] if local_entry else []) + repos,
            "source": "app",
        }
        if failures:
            result["detail"] = "; ".join(failures)
        return result

    token = _read_token()
    if token:
        try:
            raw = _fetch_installation_repos(token)
        except RuntimeError as exc:
            return {
                "available": bool(local_entry),
                "repos": [local_entry] if local_entry else [],
                "detail": str(exc), "source": "app",
            }
        return {
            "available": True,
            "repos": ([local_entry] if local_entry else []) + [_repo_entry(repo) for repo in raw],
            "source": "app",
        }

    pat = _read_pat(cid)
    if not pat:
        return {
            "available": bool(local_entry),
            "repos": [local_entry] if local_entry else [],
        }
    try:
        raw = _fetch_user_repos(pat)
    except RuntimeError as exc:
        return {
            "available": bool(local_entry),
            "repos": [local_entry] if local_entry else [],
            "detail": str(exc), "source": "pat",
        }
    return {
        "available": True,
        "repos": ([local_entry] if local_entry else []) + [_repo_entry(repo) for repo in raw],
        "source": "pat",
    }


@app.get("/api/containers/{cid}/github")
def get_container_github(cid: str, request: Request):
    """Read a container's GitHub repo binding: {"repo": "owner/name" | null}."""
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (_, cur):
        require_container(cur, cid)
        # Access model: reads are project-isolated (trusted non-member 403).
        require_member_read(cur, request, cid)
        cur.execute("SELECT github_repo FROM containers WHERE id=%s", (cid,))
        return {"repo": cur.fetchone()["github_repo"]}


@app.put("/api/containers/{cid}/github")
def put_container_github(cid: str, body: ContainerGithubBinding, request: Request):
    """Bind (or with repo=null, unbind) a container's code source.

    The owner/name-or-"local" shape is enforced by the ContainerGithubBinding schema
    (422 on anything else). The sentinel `repo="local"` (Addendum 2) additionally
    requires `local_git.available()` — a 400 with an honest message when the project's
    own working tree isn't actually mounted/git-initialized here, rather than silently
    accepting a binding nothing can serve. Returns the persisted binding in the same
    shape as GET. Audited to the container event log like other container-setting
    writes.
    """
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    if body.repo == "local" and not local_git.available():
        raise HTTPException(
            400,
            "local repository source is not available here — "
            "ORCHA_LOCAL_REPO_DIR is unset, the mounted directory is missing, "
            "it has no .git, or the git binary is unavailable in this container",
        )
    with db_cursor() as (conn, cur):
        require_container(cur, cid)
        # Per-project identity + access model: binding a repo is owner-or-manage_repo
        # under the trusted lane (403 non-member / ungranted member / viewer).
        enforce_grant(cur, request, cid, "manage_repo")
        trusted_actor(cur, request, cid, None)
        cur.execute(
            "UPDATE containers SET github_repo=%s WHERE id=%s RETURNING github_repo",
            (body.repo, cid),
        )
        repo = cur.fetchone()["github_repo"]
        log_event(
            cur,
            cid,
            "human",
            None,
            "container",
            cid,
            "github_repo_bound" if repo else "github_repo_unbound",
            {"repo": repo},
        )
        conn.commit()
    return {"repo": repo}
