"""Orcha Code Space — Phase 1 (line-anchored threads) + Phase 3 (built-in symbol
provider). Design: docs/orcha-code-space-design.md.

Phase 1 — threads
------------------
Endpoints (all gated by container membership; see below):
  POST /api/containers/{cid}/code/threads          — create a thread (resolves sha)
  GET  /api/containers/{cid}/code/threads           — list threads (+ blob_match)
  GET  /api/code/threads/{tid}                      — one thread + its messages
  POST /api/code/threads/{tid}/messages             — reply / resolve

A thread's anchor is `(repo, sha, path, start_line, end_line)`, pinned to the sha
resolved AT CREATION via the SAME ref-resolution the repo browser uses
(`github_repo_browse_routes._resolve_ref` — branch/tag/pr/short-or-full-sha, all
pass through identically). "Honesty over magic": a thread never silently re-anchors
to a new sha; `blob_match` on the list route tells the caller whether the file's
CURRENT blob at the requested ref still matches what the thread was pinned against.

Tagging @agent (`tagged_agent_id`) does NOT invent a parallel notification path —
it calls `request_creation_routes.create_request` **in-process** (the actual FastAPI
route function, not a reimplementation) so the tagged agent gets woken through the
existing requests/agent_events rails exactly like any other directed request: an
`agent_events` row with `event_name='request_created'` keyed to the tagged agent
(and to the container), read by wake-scan/notification-manifest like every other
request. The request's `payload` is the rendered anchor + question + the literal
reply instruction ("reply via POST /api/code/threads/{id}/messages with your agent
id as actor_agent_id") — see `_render_wake_payload`. The tagged agent's FIRST reply
(POST .../messages) flips the thread open->answered; a human may explicitly resolve
via `resolve:true` (answered/open -> resolved). The underlying request's OWN status
still rides its own independent lifecycle (answered when the target responds via
/api/requests/{rid}/respond, or whatever path it takes) — code_threads.status is a
separate state machine that only OBSERVES which agent replied on the thread itself.

Membership gating
------------------
Two distinct actor shapes hit this module, gated differently (mirrors the rest of
the portal — proxy-trust for human-facing reads/UI actions, actor_agent_id
validation for agent-authored writes):
  * GET routes (thread list/detail) — `require_member_read` (browse-module idiom):
    a trusted non-member of a MAPPED container gets 403; an unmapped/bootstrap
    container, or trust disabled entirely, passes through (self-host default).
  * POST routes (create thread, post message) — the caller supplies
    `actor_agent_id`; it must be a real agent belonging to THIS container
    (`require_agent` + container match), exactly like request_creation_routes and
    task_message_routes. This is what lets an agent process call the reply endpoint
    with only `{body, actor_agent_id}` — no proxy/session needed, the same posture
    every other agent-authored write in the portal already has.

Phase 3 — built-in symbol provider
-----------------------------------
  GET /api/containers/{cid}/code/symbols?ref=&q=   — workspace symbol search
  GET /api/containers/{cid}/code/outline?ref=&path= — one file's outline

Indexing warm-up, snapshot-first (docs/code-space-indexing-research.md §3 Phase A):
`search_code_symbols` first tries `github_repo_browse_routes._fetch_repo_snapshot` — a
SINGLE tarball fetch (`GET /repos/{repo}/tarball/{ref}`) extracted in-memory, replacing
the entire per-file Contents-API loop. When a snapshot is available the WHOLE repo is
indexed synchronously within this one request (`indexing:false` immediately in the
response — no polling needed, no budget bookkeeping) and cached 10 min per (cid, ref),
same TTL idea as the pre-existing symbol-state cache below. SYMBOL_INDEX_BUDGET and the
`pending`-list machinery become the FALLBACK path only, used when no snapshot is
available (the tarball exceeded REPO_SNAPSHOT_MAX_BYTES, or the download/extraction
failed) — same behavior as before this change: each request advances the index by at
most SYMBOL_INDEX_BUDGET per-file Contents-API fetches and `indexing`/`indexed`/`total`
report real progress across polls.

Built on the repo browser's existing cached recursive tree
(`github_repo_browse_routes._fetch_full_tree`, 60s TTL per (cid,ref) — reused
directly, never refetched here) — still needed even on the snapshot path, both to
compute `total` and because the snapshot only carries file BYTES, not the tree's
size/type metadata used to decide what counts as indexable in the first place — plus,
on the fallback path only, on-demand single-file fetches
(`github_repo_browse_routes.browse_file`'s underlying `_gh_get` contents call,
reused via `_fetch_source_file` below). A small regex definition extractor per
language (Kotlin, Swift, TS/JS, Python, Go) pulls functions / classes-structs-
interfaces-objects / top-level vals-consts. Deliberately NOT an AST/LSP — the design
doc reserves real language servers for a later "LSP adapter" provider type; this is
the always-on built-in fallback. `kind` values are one of:
function | class | interface | type | const | var
(`class` covers class/struct/object; `interface` covers interface/protocol).
"""

import re
import time
import urllib.parse

from fastapi import HTTPException, Query, Request
from fastapi.responses import JSONResponse

from portal_backend import local_git, request_creation_routes
from portal_backend.agent_status import bump_agent, log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.github_hub_routes import _detail_error_payload, _error_payload
from portal_backend.github_repo_browse_routes import (
    LOCAL_REPO,
    _fetch_full_tree,
    _fetch_repo_snapshot,
    _gh_get,
    _is_binary_content,
    _load_binding,
    _not_connected,
    is_vendored_path,
    _resolve_ref,
    _resolve_repo_token,
)
from portal_backend.guards import (
    require_agent as _require_agent,
    require_container as _require_container,
    valid_uuid as _valid_uuid,
)
from portal_backend.identity_routes import require_member_read as _require_member_read
from portal_backend.identity_routes import trusted_actor
from portal_backend.limits import MAX_PAYLOAD_LEN
from portal_backend.schemas.code_space import (
    CodeThreadCreate,
    CodeThreadMessageCreate,
)
from portal_backend.schemas.requests import RequestCreate

# ------------------------------------------------------------------ threads ---

VALID_KINDS = ("question", "why", "teach", "note")
VALID_STATUSES = ("open", "answered", "resolved")


QUESTION_LIKE_KINDS = ("question", "why", "teach")  # NOT note — see _default_ai_agent_id


def _default_ai_agent_id(cur, cid: str):
    """The container's default AI agent: the first live (`terminated_at IS NULL`)
    `kind='ai'` agent by `created_at` — the lead/main convention (Atlas in
    practice), same 'oldest live ai agent' shape as
    `task_start_core.find_orchestrator_agent` and `slack_routes._live_ai_agents`,
    minus the role-string filter (this wants ANY default, not specifically an
    orchestrator-titled one).

    Used by create_code_thread to auto-target a question-like thread
    (question | why | teach) left untagged: an unowned question is a broken
    promise — silence nobody notices until a human goes looking. `note` is
    deliberately excluded, both here and by the caller — a note is not a
    request for an answer, so it stays untargeted by design, exactly as if a
    human had chosen not to @tag anyone.

    Returns the agent id (str) or None (no live ai agent in the container —
    caller keeps the untargeted, pre-existing behavior)."""
    cur.execute(
        """SELECT id FROM agents
            WHERE container_id=%s AND kind='ai' AND terminated_at IS NULL
            ORDER BY created_at ASC, id ASC
            LIMIT 1""",
        (cid,),
    )
    row = cur.fetchone()
    return str(row["id"]) if row else None


def _require_actor_in_container(cur, cid: str, actor_agent_id: str):
    """The calling agent must be a real, non-retired member of THIS container —
    the agent-authored-write gate (mirrors request_creation_routes.create_request /
    task_message_routes). Raises 400/404/400 exactly like those callers."""
    if not _valid_uuid(actor_agent_id):
        raise HTTPException(400, "actor_agent_id is not a valid UUID")
    agent = _require_agent(cur, actor_agent_id)
    if str(agent["container_id"]) != cid:
        raise HTTPException(400, "actor_agent_id belongs to a different container")
    return agent


def _thread_row_to_dict(row) -> dict:
    return {
        "id": str(row["id"]),
        "container_id": str(row["container_id"]),
        "repo": row["repo"],
        "ref": row["ref"],
        "sha": row["sha"],
        "path": row["path"],
        "start_line": row["start_line"],
        "end_line": row["end_line"],
        "kind": row["kind"],
        "status": row["status"],
        "created_by_agent_id": str(row["created_by_agent_id"]),
        "tagged_agent_id": str(row["tagged_agent_id"]) if row["tagged_agent_id"] else None,
        "request_id": str(row["request_id"]) if row["request_id"] else None,
        "created_at": row["created_at"].isoformat(),
        "updated_at": row["updated_at"].isoformat(),
    }


_FULL_SHA_RE = re.compile(r"^[0-9a-f]{40}$")

# A local-source "token" placeholder — never sent anywhere (local_git needs no
# credential), just a truthy value so the shared `token = ...; if not token: return
# _not_connected()` gate below reads identically for both sources. Every downstream
# call this token gets threaded into (_resolve_ref, _fetch_full_tree,
# _fetch_repo_snapshot, _gh_get-based helpers) already branches on `repo == LOCAL_REPO`
# BEFORE ever using the token value, so this placeholder is never actually consulted.
_LOCAL_TOKEN_PLACEHOLDER = "local"


def _resolve_token_for(repo: str, cid: str = None):
    """The single chokepoint every code-space route uses to answer "do we have
    something to read this repo with": LOCAL_REPO always yields the placeholder
    (local_git needs no token — see `_LOCAL_TOKEN_PLACEHOLDER`); any other repo falls
    through to the SAME `_resolve_repo_token` resolution every hub/browse route uses.
    None means "not connected" either way, so every existing
    `token = ...; if not token: return _not_connected()` call site needed only this
    one-line swap to become local-aware."""
    if repo == LOCAL_REPO:
        return _LOCAL_TOKEN_PLACEHOLDER
    return _resolve_repo_token(repo, cid)


def _resolve_commit_sha(repo: str, token: str, cid: str, ref) -> str:
    """Anchor pinning: turn any ref into the COMMIT SHA it points at right now.

    _resolve_ref handles default-branch and pr/<n> (already a head sha), but
    passes branch/tag names through — an anchor stored as "main" is not pinned
    at all. GET /repos/{repo}/commits/{ref} resolves the rest."""
    resolved = _resolve_ref(repo, token, cid, ref)
    if _FULL_SHA_RE.match(resolved or ""):
        return resolved
    raw = _gh_get(f"/repos/{repo}/commits/{resolved}", token)
    sha = (raw or {}).get("sha")
    if not sha or not _FULL_SHA_RE.match(sha):
        raise RuntimeError("github_status:404")
    return sha


def _render_wake_payload(thread_id: str, anchor: dict, kind: str, body: str) -> str:
    """The directed request's `payload` text — the ONLY thing the tagged agent's wake
    prompt actually renders (request_nudge_routes / the wake manifest surface a
    request's payload preview verbatim). Carries the anchor (repo/sha/path/lines),
    the thread kind, the human/agent's question body, and the literal reply
    instruction — naming the REAL thread id, since it already exists by the time this
    is called — so the woken agent knows exactly how to answer without guessing an
    endpoint shape. Also appends a portal deep-link line so a human reading the
    conversation/request surface can jump straight to the thread in Code Space; the
    conversation UI's linkify (lib/format.ts) only turns http(s) URLs into anchors,
    not portal-relative paths, so this renders as copyable plain text there — the
    reverse direction (thread -> request) is a clickable chip in ThreadView instead
    (see ThreadView.tsx's "via request <id>" chip), giving bidirectional linking
    without inventing a second portal-relative-link renderer."""
    location = f"{anchor['path']}:{anchor['start_line']}-{anchor['end_line']}"
    deep_link = f"/code?path={urllib.parse.quote(anchor['path'])}&thread={thread_id}"
    return (
        f"[code thread — {kind}] {anchor['repo']}@{anchor['sha'][:7]} {location}\n"
        f"{body}\n\n"
        f"reply via POST /api/code/threads/{thread_id}/messages with your agent id as actor_agent_id\n"
        f"view/reply in the portal: {deep_link}"
    )


@app.post("/api/containers/{cid}/code/threads")
def create_code_thread(cid: str, body: CodeThreadCreate, request: Request):
    # Deliberately no decorator-level status_code=201: the repo-not-connected /
    # rate-limited degradation returns a plain 200 {available:false,...} dict (the
    # browse module's convention) — only the actual success path is 201, via an
    # explicit JSONResponse below.
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    if body.start_line < 1 or body.end_line < body.start_line:
        raise HTTPException(400, "start_line/end_line must satisfy 1 <= start_line <= end_line")
    with db_cursor() as (conn, cur):
        _require_container(cur, cid)
        # Per-project identity: under proxy trust the signed-in login IS the actor
        # (a claimed actor_agent_id is overridden, a viewer / trusted non-member is
        # 403) — the same seam every other agent-authored write uses
        # (task_message_routes, request_creation_routes). Trust off / no header (an
        # AI agent calling from inside the stack) keeps the claimed actor unchanged.
        body.actor_agent_id = trusted_actor(cur, request, cid, body.actor_agent_id)
        creator = _require_actor_in_container(cur, cid, body.actor_agent_id)

        # An untagged question-like thread (question | why | teach — NOT note) is a
        # broken promise: nobody owns it, so it sits unanswered until a human
        # notices. Backfill tagged_agent_id to the container's default AI agent
        # BEFORE the existing tagged branch below, so an auto-routed question is
        # indistinguishable from one the user explicitly @tagged — same directed
        # request, same wake nudge, no forked logic. `note` and containers with no
        # live ai agent are untouched (both keep the pre-existing untargeted
        # behavior).
        if body.tagged_agent_id is None and body.kind in QUESTION_LIKE_KINDS:
            body.tagged_agent_id = _default_ai_agent_id(cur, cid)

        tagged_agent = None
        if body.tagged_agent_id is not None:
            tagged_agent = _require_actor_in_container(cur, cid, body.tagged_agent_id)

        cur.execute("SELECT github_repo FROM containers WHERE id=%s", (cid,))
        repo = cur.fetchone()["github_repo"]
        if not repo:
            return _not_connected()
        token = _resolve_token_for(repo, cid)
        if not token:
            return _not_connected()
        try:
            resolved_sha = _resolve_commit_sha(repo, token, cid, body.ref)
        except RuntimeError as exc:
            return {**_detail_error_payload(exc), "repo": repo}

        clean_path = (body.path or "").strip("/")
        if not clean_path:
            raise HTTPException(400, "path is required")

        cur.execute(
            """INSERT INTO code_threads
                 (container_id, repo, ref, sha, path, start_line, end_line, kind,
                  status, created_by_agent_id, tagged_agent_id)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'open', %s, %s)
               RETURNING id, created_at, updated_at""",
            (
                cid, repo, body.ref or resolved_sha, resolved_sha, clean_path,
                body.start_line, body.end_line, body.kind,
                body.actor_agent_id, body.tagged_agent_id,
            ),
        )
        row = cur.fetchone()
        thread_id = str(row["id"])

        # `require_agent` doesn't select `kind`; fetch it directly for the is_human flag
        # (mirrors every other route here that needs the actor's human/ai distinction).
        cur.execute("SELECT kind FROM agents WHERE id=%s", (body.actor_agent_id,))
        creator_kind = cur.fetchone()["kind"]
        cur.execute(
            """INSERT INTO code_thread_messages (thread_id, author_agent_id, is_human, body)
               VALUES (%s, %s, %s, %s)""",
            (thread_id, body.actor_agent_id, creator_kind == "human", body.body),
        )

        log_event(
            cur, cid, "human" if creator_kind == "human" else "ai", body.actor_agent_id,
            "code_thread", thread_id, "created",
            {"path": clean_path, "kind": body.kind, "tagged_agent_id": body.tagged_agent_id},
        )
        conn.commit()

    if tagged_agent is not None:
        anchor = {
            "repo": repo, "sha": resolved_sha, "path": clean_path,
            "start_line": body.start_line, "end_line": body.end_line,
        }
        payload_text = _render_wake_payload(thread_id, anchor, body.kind, body.body)[:MAX_PAYLOAD_LEN]

        # request_creation_routes.create_request is the REAL route function, called
        # in-process (not reimplemented) so the tagged agent is woken through the exact
        # same requests/agent_events rails as any other directed request — its own
        # db_cursor transaction, separate from the thread insert above (already
        # committed), exactly as if a second, independent API call had been made.
        req_result = request_creation_routes.create_request(
            cid,
            RequestCreate(
                requester_agent_id=body.actor_agent_id,
                target_agent_id=body.tagged_agent_id,
                payload=payload_text,
                type="info",
            ),
        )
        request_id = req_result["request_id"]
        with db_cursor() as (conn, cur):
            cur.execute(
                "UPDATE code_threads SET request_id=%s, updated_at=now() WHERE id=%s",
                (request_id, thread_id),
            )
            conn.commit()

    with db_cursor() as (_, cur):
        cur.execute("SELECT * FROM code_threads WHERE id=%s", (thread_id,))
        thread = _thread_row_to_dict(cur.fetchone())
    return JSONResponse(status_code=201, content=thread)


RECENT_THREADS_MAX = 50


@app.get("/api/containers/{cid}/code/threads")
def list_code_threads(
    cid: str,
    request: Request,
    ref: str = Query(default=""),
    path: str = Query(default=""),
    status: str = Query(default=""),
    recent: int = Query(default=0),
):
    """List a container's code threads, optionally filtered by `path` and/or
    `status`. `ref` is NEVER a row filter — a thread pinned to an older sha still
    belongs to its file and must still surface when browsing that file at a newer
    ref (that's exactly the "outdated — pinned to <sha7>" honesty case the design
    calls for); `ref` only steers which CURRENT blob shas `blob_match` is computed
    against. When `path` is omitted and `recent` is unset, returns per-file thread
    COUNTS instead of full thread rows (the directory-tree/file-list overview
    surface) — each entry is `{path, count, open_count}`. When `path` is omitted
    and `recent=<n>` is given (n capped at RECENT_THREADS_MAX), returns
    `{threads: [...]}` — the n newest threads across every path in the container,
    newest-first (Code Space's "Recent" quick-jump; no blob_match is computed for
    this shape, same as the by_path counts branch it replaces — the caller isn't
    viewing a specific file/ref pair to compare blobs against). When `path` is
    given, returns the full thread rows for that file, each stamped with
    `blob_match` (bool): whether the file's blob at the CURRENT `ref` (or the
    thread's own creation ref if `ref` is omitted) still matches the blob the
    thread was anchored against — computed via the repo browser's cached
    recursive-tree blob shas, never a fresh raw-blob fetch per thread.
    `blob_match` is omitted (None) when the repo/ref can't be resolved
    (rate-limited, not connected, etc.) — an honest "don't know", never a guessed
    true/false.
    """
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (_, cur):
        _require_container(cur, cid)
        _require_member_read(cur, request, cid)
        cur.execute("SELECT github_repo FROM containers WHERE id=%s", (cid,))
        repo = cur.fetchone()["github_repo"]

        if status and status not in VALID_STATUSES:
            raise HTTPException(400, f"status must be one of {VALID_STATUSES}")

        if not path and recent:
            n = min(recent, RECENT_THREADS_MAX)
            query = "SELECT * FROM code_threads WHERE container_id=%s"
            params = [cid]
            if status:
                query += " AND status=%s"
                params.append(status)
            query += " ORDER BY created_at DESC LIMIT %s"
            params.append(n)
            cur.execute(query, params)
            recent_rows = cur.fetchall()
            recent_threads = [_thread_row_to_dict(r) for r in recent_rows]

            # First-message snippet per thread (Code Space's Recent quick-jump row) —
            # one query for the whole page rather than N+1: DISTINCT ON picks each
            # thread's earliest message by created_at, matching "the opening note"
            # every thread is created with (see create_code_thread's own first
            # INSERT into code_thread_messages).
            if recent_threads:
                ids = [t["id"] for t in recent_threads]
                cur.execute(
                    """SELECT DISTINCT ON (thread_id) thread_id, body
                         FROM code_thread_messages
                        WHERE thread_id = ANY(%s)
                        ORDER BY thread_id, created_at ASC""",
                    (ids,),
                )
                first_body_by_thread = {str(r["thread_id"]): r["body"] for r in cur.fetchall()}
                for t in recent_threads:
                    t["first_message"] = first_body_by_thread.get(t["id"])
            return {"threads": recent_threads}

        if not path:
            query = "SELECT path, status FROM code_threads WHERE container_id=%s"
            params = [cid]
            if status:
                query += " AND status=%s"
                params.append(status)
            cur.execute(query, params)
            rows = cur.fetchall()
            counts: dict = {}
            for r in rows:
                bucket = counts.setdefault(r["path"], {"path": r["path"], "count": 0, "open_count": 0})
                bucket["count"] += 1
                if r["status"] == "open":
                    bucket["open_count"] += 1
            return {"by_path": list(counts.values())}

        clean_path = path.strip("/")
        query = "SELECT * FROM code_threads WHERE container_id=%s AND path=%s"
        params = [cid, clean_path]
        if status:
            query += " AND status=%s"
            params.append(status)
        query += " ORDER BY created_at ASC"
        cur.execute(query, params)
        thread_rows = cur.fetchall()

    threads = [_thread_row_to_dict(r) for r in thread_rows]
    if not threads:
        return {"threads": []}

    if not repo:
        for t in threads:
            t["blob_match"] = None
        return {"threads": threads}
    token = _resolve_token_for(repo, cid)
    if not token:
        for t in threads:
            t["blob_match"] = None
        return {"threads": threads}

    # Resolve the CURRENT blob sha for this path per requested ref (falling back to each
    # thread's own creation ref when the caller didn't pass one) via the browser's cached
    # tree — never a fresh per-thread network call.
    blob_shas_by_ref: dict = {}
    for t in threads:
        lookup_ref = ref or t["ref"]
        if lookup_ref in blob_shas_by_ref:
            continue
        try:
            resolved = _resolve_ref(repo, token, cid, lookup_ref)
            entries, _truncated = _fetch_full_tree(repo, resolved, token, cid)
            blob_shas_by_ref[lookup_ref] = {
                e.get("path"): e.get("sha") for e in entries if e.get("type") == "blob"
            }
        except RuntimeError:
            blob_shas_by_ref[lookup_ref] = None

    # The thread's OWN pinned sha also needs a blob-sha lookup (the tree AT the pinned sha) —
    # a thread's `sha` is a commit/tree sha, so its own blob map may differ from the "current"
    # ref's map above (they're often the same call when ref== the thread's own ref, but not
    # necessarily, and either way `_fetch_full_tree` is cached per (cid, resolved) so a repeat
    # never refetches).
    pinned_blob_shas_by_sha: dict = {}
    for t in threads:
        if t["sha"] in pinned_blob_shas_by_sha:
            continue
        try:
            entries, _truncated = _fetch_full_tree(repo, t["sha"], token, cid)
            pinned_blob_shas_by_sha[t["sha"]] = {
                e.get("path"): e.get("sha") for e in entries if e.get("type") == "blob"
            }
        except RuntimeError:
            pinned_blob_shas_by_sha[t["sha"]] = None

    for t in threads:
        lookup_ref = ref or t["ref"]
        current_map = blob_shas_by_ref.get(lookup_ref)
        pinned_map = pinned_blob_shas_by_sha.get(t["sha"])
        if current_map is None or pinned_map is None:
            t["blob_match"] = None
            continue
        current_blob = current_map.get(t["path"])
        pinned_blob = pinned_map.get(t["path"])
        if current_blob is None or pinned_blob is None:
            t["blob_match"] = None
        else:
            t["blob_match"] = current_blob == pinned_blob

    return {"threads": threads}


@app.get("/api/code/threads/{tid}")
def get_code_thread(tid: str, request: Request):
    if not _valid_uuid(tid):
        raise HTTPException(400, "thread_id is not a valid UUID")
    with db_cursor() as (_, cur):
        cur.execute("SELECT * FROM code_threads WHERE id=%s", (tid,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, f"code thread {tid} not found")
        cid = str(row["container_id"])
        _require_member_read(cur, request, cid)
        thread = _thread_row_to_dict(row)
        cur.execute(
            "SELECT * FROM code_thread_messages WHERE thread_id=%s ORDER BY created_at ASC",
            (tid,),
        )
        messages = [
            {
                "id": str(m["id"]),
                "author_agent_id": str(m["author_agent_id"]) if m["author_agent_id"] else None,
                "is_human": m["is_human"],
                "body": m["body"],
                "created_at": m["created_at"].isoformat(),
            }
            for m in cur.fetchall()
        ]
    thread["messages"] = messages
    return thread


@app.post("/api/code/threads/{tid}/messages", status_code=201)
def post_code_thread_message(tid: str, body: CodeThreadMessageCreate, request: Request):
    if not _valid_uuid(tid):
        raise HTTPException(400, "thread_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        cur.execute("SELECT * FROM code_threads WHERE id=%s FOR UPDATE", (tid,))
        thread = cur.fetchone()
        if not thread:
            raise HTTPException(404, f"code thread {tid} not found")
        cid = str(thread["container_id"])
        # Same identity binding as create_code_thread above.
        body.actor_agent_id = trusted_actor(cur, request, cid, body.actor_agent_id)
        _require_actor_in_container(cur, cid, body.actor_agent_id)

        if thread["status"] == "resolved" and not body.resolve:
            # A resolved thread stays readable/appendable in spirit, but reopening implicitly
            # would undo a human's explicit call — refuse rather than silently un-resolve.
            raise HTTPException(409, "thread is resolved; cannot post further messages")

        # `require_agent` doesn't select `kind`; fetch it directly for the is_human flag.
        cur.execute("SELECT kind FROM agents WHERE id=%s", (body.actor_agent_id,))
        actor_kind = cur.fetchone()["kind"]
        cur.execute(
            """INSERT INTO code_thread_messages (thread_id, author_agent_id, is_human, body)
               VALUES (%s, %s, %s, %s)""",
            (tid, body.actor_agent_id, actor_kind == "human", body.body),
        )

        new_status = thread["status"]
        # The TAGGED agent's first reply flips open -> answered (kind check, not just "any
        # reply") — a thread creator or a bystander agent replying does not count.
        if (
            thread["status"] == "open"
            and thread["tagged_agent_id"] is not None
            and str(thread["tagged_agent_id"]) == body.actor_agent_id
        ):
            new_status = "answered"

        if body.resolve:
            if actor_kind != "human":
                raise HTTPException(403, "only a human may resolve a code thread")
            new_status = "resolved"

        if new_status != thread["status"]:
            cur.execute(
                "UPDATE code_threads SET status=%s, updated_at=now() WHERE id=%s",
                (new_status, tid),
            )
        else:
            cur.execute("UPDATE code_threads SET updated_at=now() WHERE id=%s", (tid,))

        bump_agent(cur, body.actor_agent_id)
        log_event(
            cur, cid, "human" if actor_kind == "human" else "ai", body.actor_agent_id,
            "code_thread", tid, "message",
            {"resolve": bool(body.resolve), "new_status": new_status},
        )
        conn.commit()

    with db_cursor() as (_, cur):
        cur.execute("SELECT * FROM code_threads WHERE id=%s", (tid,))
        thread = _thread_row_to_dict(cur.fetchone())
    return thread


# ------------------------------------------------------------------ symbols ---

# Files above this size are skipped entirely (never fetched into the indexer) — matches
# the design's "skip files >200KB and non-source extensions" cap.
MAX_SOURCE_FILE_BYTES = 200_000
# Snapshot member cap when building the ALL-files snapshot (extensions=None): the
# same 500KB the browse file endpoint caps content at — bigger files fall back to
# the per-file git path anyway, so snapshotting them is pure memory cost.
SNAPSHOT_ANY_FILE_MAX_BYTES = 500_000

SYMBOL_SEARCH_MAX_RESULTS = 200
SYMBOL_INDEX_BUDGET = 40   # files fetched per request while the index warms
SYMBOL_STATE_TTL_SECONDS = 600  # warm index kept 10 min — indexing is expensive

_symbol_state: dict = {}


def _symbol_state_get(cid: str, ref: str):
    entry = _symbol_state.get((cid, ref))
    if entry is None:
        return None
    state, ts = entry
    if time.monotonic() - ts > SYMBOL_STATE_TTL_SECONDS:
        _symbol_state.pop((cid, ref), None)
        return None
    return state


def _symbol_state_put(cid: str, ref: str, state) -> None:
    _symbol_state[(cid, ref)] = (state, time.monotonic())


# Extension -> language id, used to pick the right regex table. Only these extensions are
# ever considered "source" for indexing purposes (design doc language list: Kotlin, Swift,
# TS/JS, Python, Go).
LANGUAGE_BY_EXTENSION = {
    ".kt": "kotlin", ".kts": "kotlin",
    ".java": "java",
    ".swift": "swift",
    ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript",
    ".py": "python",
    ".go": "go",
}

_SYMBOL_TREE_CACHE: dict = {}
SYMBOL_CACHE_TTL_SECONDS = 60


def _symbol_cache_get(cid: str, ref: str):
    hit = _SYMBOL_TREE_CACHE.get((cid, ref))
    if hit and hit[0] > time.monotonic():
        return hit[1]
    return None


def _symbol_cache_put(cid: str, ref: str, payload) -> None:
    _SYMBOL_TREE_CACHE[(cid, ref)] = (time.monotonic() + SYMBOL_CACHE_TTL_SECONDS, payload)


def _language_for_path(path: str):
    for ext, lang in LANGUAGE_BY_EXTENSION.items():
        if path.endswith(ext):
            return lang
    return None


def _fetch_source_file(repo: str, resolved_ref: str, token: str, path: str):
    """Fetch one file's decoded text content for indexing, or None when it should be
    skipped (binary, non-decodeable, or >MAX_SOURCE_FILE_BYTES). Mirrors
    github_repo_browse_routes.browse_file's decode/binary-sniff logic directly (kept as
    a small local copy rather than calling the route function, since that route also
    does its own ref-resolution/binding load we've already done here).

    Local source (repo == LOCAL_REPO): reads via `local_git.file_bytes` instead of the
    GitHub contents API — `token` is unused on this path. Used only as the FALLBACK
    per-file fetch (both the symbol indexer and the outline route try the whole-repo
    snapshot first — see `_fetch_repo_snapshot`/`_fetch_local_repo_snapshot` — so this
    is rarely reached at all for a local repo; kept local-aware anyway so a snapshot
    failure never silently reaches out to `_gh_get` for a repo that was never
    GitHub-backed in the first place)."""
    if repo == LOCAL_REPO:
        raw_bytes = local_git.file_bytes(resolved_ref, path)
        if raw_bytes is None:
            return None
        if len(raw_bytes) > MAX_SOURCE_FILE_BYTES:
            return None
        if _is_binary_content(raw_bytes):
            return None
        return raw_bytes.decode("utf-8", errors="ignore")

    import base64

    query = urllib.parse.urlencode({"ref": resolved_ref})
    raw = _gh_get(f"/repos/{repo}/contents/{path}?{query}", token)
    if isinstance(raw, list):
        return None
    size = raw.get("size") or 0
    if size > MAX_SOURCE_FILE_BYTES:
        return None
    if raw.get("encoding") != "base64":
        return None
    try:
        raw_bytes = base64.b64decode(raw.get("content") or "")
    except (ValueError, TypeError):
        return None
    if _is_binary_content(raw_bytes):
        return None
    return raw_bytes.decode("utf-8", errors="ignore")


# ---- per-language definition regexes -----------------------------------------------
#
# Deliberately regex, not an AST: this is the ALWAYS-ON built-in fallback provider (design
# doc: "LSP adapters are the documented second provider type... deliberately NOT run on
# the 4GB dogfood box"). Every pattern captures the definition's NAME in group 1 and is
# anchored to line starts (re.MULTILINE) with common modifier keywords tolerated before
# the defining keyword (pub/export/async/static/final/open/private/public/internal, etc.)
# so idiomatic real-world code (not just the bare keyword-first case) still matches.

_MODIFIERS = r"(?:(?:export|public|private|protected|internal|open|final|static|abstract|async|override|default|readonly|const|pub|crate)\s+)*"

_LANGUAGE_PATTERNS = {
    "kotlin": [
        (re.compile(rf"^\s*{_MODIFIERS}fun\s+(?:<[^>]*>\s*)?(\w+)\s*\(", re.MULTILINE), "function"),
        (re.compile(rf"^\s*{_MODIFIERS}(?:data\s+|sealed\s+|enum\s+)?class\s+(\w+)", re.MULTILINE), "class"),
        (re.compile(rf"^\s*{_MODIFIERS}object\s+(\w+)", re.MULTILINE), "class"),
        (re.compile(rf"^\s*{_MODIFIERS}interface\s+(\w+)", re.MULTILINE), "interface"),
        (re.compile(rf"^\s*{_MODIFIERS}val\s+(\w+)\s*[:=]", re.MULTILINE), "const"),
        (re.compile(rf"^\s*{_MODIFIERS}var\s+(\w+)\s*[:=]", re.MULTILINE), "var"),
    ],
    "java": [
        # Types first — Android's Java surface is class/interface/enum-heavy.
        (re.compile(rf"^\s*{_MODIFIERS}(?:class)\s+(\w+)", re.MULTILINE), "class"),
        (re.compile(rf"^\s*{_MODIFIERS}(?:interface)\s+(\w+)", re.MULTILINE), "interface"),
        (re.compile(rf"^\s*{_MODIFIERS}(?:enum|record)\s+(\w+)", re.MULTILINE), "class"),
        # Methods: modifier(s) + return type + name( — requires at least one explicit
        # modifier so local calls/constructors-in-bodies don't flood the index.
        (re.compile(r"^\s*(?:(?:public|private|protected|static|final|abstract|synchronized|native)\s+)+[\w<>\[\],.\s]*?\b(\w+)\s*\(", re.MULTILINE), "function"),
        # Constants: static final FIELD = ...
        (re.compile(r"^\s*(?:(?:public|private|protected)\s+)?static\s+final\s+[\w<>\[\]]+\s+(\w+)\s*=", re.MULTILINE), "const"),
    ],
    "swift": [
        (re.compile(rf"^\s*{_MODIFIERS}func\s+(\w+)\s*[\(<]", re.MULTILINE), "function"),
        (re.compile(rf"^\s*{_MODIFIERS}(?:final\s+)?class\s+(\w+)", re.MULTILINE), "class"),
        (re.compile(rf"^\s*{_MODIFIERS}struct\s+(\w+)", re.MULTILINE), "class"),
        (re.compile(rf"^\s*{_MODIFIERS}enum\s+(\w+)", re.MULTILINE), "class"),
        (re.compile(rf"^\s*{_MODIFIERS}protocol\s+(\w+)", re.MULTILINE), "interface"),
        (re.compile(rf"^\s*{_MODIFIERS}let\s+(\w+)\s*[:=]", re.MULTILINE), "const"),
        (re.compile(rf"^\s*{_MODIFIERS}var\s+(\w+)\s*[:=]", re.MULTILINE), "var"),
    ],
    "typescript": [
        (re.compile(rf"^\s*{_MODIFIERS}(?:async\s+)?function\s*\*?\s+(\w+)\s*[\(<]", re.MULTILINE), "function"),
        (re.compile(rf"^\s*{_MODIFIERS}class\s+(\w+)", re.MULTILINE), "class"),
        (re.compile(rf"^\s*{_MODIFIERS}interface\s+(\w+)", re.MULTILINE), "interface"),
        (re.compile(rf"^\s*{_MODIFIERS}type\s+(\w+)\s*=", re.MULTILINE), "type"),
        (re.compile(rf"^\s*{_MODIFIERS}const\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]+)?=>", re.MULTILINE), "function"),
        (re.compile(rf"^\s*{_MODIFIERS}const\s+(\w+)\s*[:=]", re.MULTILINE), "const"),
        (re.compile(rf"^\s*{_MODIFIERS}let\s+(\w+)\s*[:=]", re.MULTILINE), "var"),
    ],
    "javascript": [
        (re.compile(rf"^\s*{_MODIFIERS}(?:async\s+)?function\s*\*?\s+(\w+)\s*\(", re.MULTILINE), "function"),
        (re.compile(rf"^\s*{_MODIFIERS}class\s+(\w+)", re.MULTILINE), "class"),
        (re.compile(rf"^\s*{_MODIFIERS}const\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>", re.MULTILINE), "function"),
        (re.compile(rf"^\s*{_MODIFIERS}const\s+(\w+)\s*=", re.MULTILINE), "const"),
        (re.compile(rf"^\s*{_MODIFIERS}let\s+(\w+)\s*=", re.MULTILINE), "var"),
    ],
    "python": [
        (re.compile(r"^\s*(?:async\s+)?def\s+(\w+)\s*\(", re.MULTILINE), "function"),
        (re.compile(r"^\s*class\s+(\w+)", re.MULTILINE), "class"),
        (re.compile(r"^([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=(?!=)", re.MULTILINE), "const"),
    ],
    "go": [
        (re.compile(r"^\s*func\s+(?:\([^)]*\)\s*)?(\w+)\s*[\(\[]", re.MULTILINE), "function"),
        (re.compile(r"^\s*type\s+(\w+)\s+struct\b", re.MULTILINE), "class"),
        (re.compile(r"^\s*type\s+(\w+)\s+interface\b", re.MULTILINE), "interface"),
        (re.compile(r"^\s*type\s+(\w+)\s+", re.MULTILINE), "type"),
        (re.compile(r"^\s*const\s+(\w+)\s*", re.MULTILINE), "const"),
        (re.compile(r"^\s*var\s+(\w+)\s*", re.MULTILINE), "var"),
    ],
}


def _extract_definitions(text: str, language: str) -> list:
    """Every definition found in `text` for `language`, as
    {name, kind, line} (1-indexed line number of the match start). A name matched by
    more than one pattern (rare — patterns target disjoint keywords per language) keeps
    only its FIRST match by (name, line) to avoid duplicate entries."""
    patterns = _LANGUAGE_PATTERNS.get(language, [])
    seen = set()
    results = []
    for pattern, kind in patterns:
        for match in pattern.finditer(text):
            name = match.group(1)
            line = text.count("\n", 0, match.start()) + 1
            key = (name, line)
            if key in seen:
                continue
            seen.add(key)
            results.append({"name": name, "kind": kind, "line": line})
    results.sort(key=lambda d: d["line"])
    return results


def _index_from_snapshot(indexable, snapshot) -> list:
    """Regex-extract every definition from the snapshot's bytes for `indexable` paths —
    the whole-repo one-pass indexing body, shared by the symbols route (cold path) and
    the local background warmer (`warm_local_symbol_index`)."""
    symbols = []
    for path in indexable:
        raw_bytes = snapshot.get(path)
        if raw_bytes is None:
            continue
        if _is_binary_content(raw_bytes):
            continue
        text = raw_bytes.decode("utf-8", errors="ignore")
        language = _language_for_path(path)
        for definition in _extract_definitions(text, language):
            symbols.append({**definition, "path": path})
    return symbols


def warm_local_symbol_index() -> bool:
    """Pre-build the snapshot + symbol index for every container bound to the LOCAL
    repo, so the first go-to-symbol/outline click is warm instead of paying the cold
    cost (a bind-mounted `git archive` + whole-repo regex pass — ~10s+ on Docker for
    Mac). Called from a background thread (startup + periodic re-warm inside the cache
    TTL, see application_lifecycle) — NEVER from a request path. Returns whether any
    index was (re)built; all failures are swallowed (warming is an optimization, the
    request-path cold build remains the source of truth)."""
    try:
        from portal_backend import local_git
        if not local_git.available():
            return False
        with db_cursor() as (_, cur):
            cur.execute(
                "SELECT id FROM containers WHERE github_repo=%s", (LOCAL_REPO,)
            )
            cids = [str(r["id"]) for r in cur.fetchall()]
        if not cids:
            return False
        sha = local_git.resolve_ref("HEAD")
        if not sha:
            return False
        # Same warm pass also pre-scans the working tree so the Changes tab's
        # first open is cache-served (import here to avoid a route-module cycle).
        from portal_backend.code_workingtree_routes import prewarm_worktree
        prewarm_worktree(cids)
        built = False
        for cid in cids:
            if _symbol_state_get(cid, sha) is not None:
                continue
            entries, _tr = _fetch_full_tree(LOCAL_REPO, sha, None, cid)
            indexable = []
            for entry in entries:
                if entry.get("type") != "blob":
                    continue
                path = entry.get("path") or ""
                if is_vendored_path(path):
                    continue
                if _language_for_path(path) is None:
                    continue
                size = entry.get("size")
                if size is not None and size > MAX_SOURCE_FILE_BYTES:
                    continue
                indexable.append(path)
            snapshot = _fetch_repo_snapshot(
                LOCAL_REPO, sha, None, cid,
                None, SNAPSHOT_ANY_FILE_MAX_BYTES,
            )
            if snapshot is None:
                continue
            _symbol_state_put(cid, sha, {
                "symbols": _index_from_snapshot(indexable, snapshot),
                "pending": [], "total": len(indexable),
            })
            built = True
        return built
    except Exception:
        return False


@app.get("/api/containers/{cid}/code/symbols")
def search_code_symbols(cid: str, request: Request, ref: str = Query(default=""), q: str = Query(default="")):
    """Workspace symbol search: every definition across every indexable source file at
    `ref` (or the default branch) whose name contains `q` (case-insensitive substring;
    empty `q` returns everything, capped). Results capped at SYMBOL_SEARCH_MAX_RESULTS,
    each `{name, kind, path, line}`. Built over the SAME cached recursive tree the repo
    browser uses (`_fetch_full_tree`) plus on-demand per-file fetches, indexed and
    cached 60s per (cid, ref) — a burst of go-to-symbol queries against the same ref
    costs at most one full-tree-plus-per-file-fetch pass every 60s, not one per
    keystroke.
    """
    with db_cursor() as (_, cur):
        repo = _load_binding(cur, cid, request)
    if not repo:
        return _not_connected()
    token = _resolve_token_for(repo, cid)
    if not token:
        return _not_connected()
    try:
        resolved_ref = _resolve_ref(repo, token, cid, ref)
    except RuntimeError as exc:
        return {**_detail_error_payload(exc), "repo": repo}

    # Cold-start indexing. Snapshot-first (docs/code-space-indexing-research.md §3 Phase
    # A): a single tarball fetch + in-memory extraction can index the WHOLE repo within
    # this one request, so the SYMBOL_INDEX_BUDGET/pending-list machinery below only
    # runs as the FALLBACK — when no snapshot is available (oversize tarball, or the
    # tarball download/extraction failed). State keyed (cid, ref) either way.
    state = _symbol_state_get(cid, resolved_ref)
    if state is None:
        try:
            entries, _truncated = _fetch_full_tree(repo, resolved_ref, token, cid)
        except RuntimeError as exc:
            return {**_error_payload(exc), "repo": repo}
        indexable = []
        for entry in entries:
            if entry.get("type") != "blob":
                continue
            path = entry.get("path") or ""
            if is_vendored_path(path):
                continue
            language = _language_for_path(path)
            if language is None:
                continue
            size = entry.get("size")
            if size is not None and size > MAX_SOURCE_FILE_BYTES:
                continue
            indexable.append(path)

        snapshot = None
        try:
            snapshot = _fetch_repo_snapshot(
                repo, resolved_ref, token, cid,
                None, SNAPSHOT_ANY_FILE_MAX_BYTES,
            )
        except RuntimeError:
            # Tarball download failed (rate limit, network) — not fatal to indexing
            # itself, since the per-file fallback below may still succeed (or itself
            # hit the same error and report it the same way it always has). Snapshot
            # is just an optimization; losing it never turns a working request into a
            # failing one.
            snapshot = None

        if snapshot is not None:
            # Whole-repo indexing in ONE pass: every indexable path's bytes are already
            # in `snapshot` (or the tree listed a path the tarball didn't have — a rare
            # skew, e.g. a submodule/symlink entry — skipped honestly rather than
            # guessed). `pending` stays empty: indexing:false immediately below, no
            # polling required for a snapshot-backed repo.
            state = {
                "symbols": _index_from_snapshot(indexable, snapshot),
                "pending": [], "total": len(indexable),
            }
        else:
            # Fallback: budgeted incremental indexing exactly as before snapshot
            # support existed. A cold index would otherwise fetch EVERY source file
            # serially (minutes + rate-limit burn on real repos); each request
            # advances the index by at most SYMBOL_INDEX_BUDGET files and returns what
            # it has, `indexing`/`indexed`/`total` reporting real progress across polls.
            state = {"symbols": [], "pending": list(indexable), "total": len(indexable)}
        _symbol_state_put(cid, resolved_ref, state)

    budget = SYMBOL_INDEX_BUDGET
    while state["pending"] and budget > 0:
        path = state["pending"].pop(0)
        budget -= 1
        language = _language_for_path(path)
        if language is None:
            continue
        try:
            text = _fetch_source_file(repo, resolved_ref, token, path)
        except RuntimeError:
            continue
        if text is None:
            continue
        for definition in _extract_definitions(text, language):
            state["symbols"].append({**definition, "path": path})
    cached = state["symbols"]

    if q:
        needle = q.lower()
        filtered = [s for s in cached if needle in s["name"].lower()]
    else:
        filtered = list(cached)
    truncated = len(filtered) > SYMBOL_SEARCH_MAX_RESULTS
    indexing = bool(state["pending"])
    return {
        "indexing": indexing,
        "indexed": state["total"] - len(state["pending"]),
        "total": state["total"],
        "available": True, "repo": repo, "ref": resolved_ref,
        "results": filtered[:SYMBOL_SEARCH_MAX_RESULTS],
        "truncated": truncated,
    }


@app.get("/api/containers/{cid}/code/outline")
def get_code_outline(cid: str, request: Request, ref: str = Query(default=""), path: str = Query(...)):
    """One file's outline: every definition found in it, in file order, UNCAPPED (a
    single file's definition count is bounded by the file itself — the 200KB
    size-skip already caps how large a file this ever runs against). Returns
    {available, repo, ref, path, language, symbols:[{name,kind,line}]}. A file whose
    extension isn't in the supported language table, or that exceeds
    MAX_SOURCE_FILE_BYTES, or is binary/non-decodeable, returns `symbols: []` with
    `language: null` — an honest empty outline, not an error.
    """
    clean_path = (path or "").strip("/")
    if not clean_path:
        raise HTTPException(400, "path is required")
    with db_cursor() as (_, cur):
        repo = _load_binding(cur, cid, request)
    if not repo:
        return _not_connected()
    token = _resolve_token_for(repo, cid)
    if not token:
        return _not_connected()
    try:
        resolved_ref = _resolve_ref(repo, token, cid, ref)
    except RuntimeError as exc:
        return {**_detail_error_payload(exc), "repo": repo}

    language = _language_for_path(clean_path)
    if language is None:
        return {
            "available": True, "repo": repo, "ref": resolved_ref, "path": clean_path,
            "language": None, "symbols": [],
        }
    try:
        text = _fetch_source_file(repo, resolved_ref, token, clean_path)
    except RuntimeError as exc:
        return {**_detail_error_payload(exc), "repo": repo}
    if text is None:
        return {
            "available": True, "repo": repo, "ref": resolved_ref, "path": clean_path,
            "language": language, "symbols": [],
        }
    symbols = _extract_definitions(text, language)
    return {
        "available": True, "repo": repo, "ref": resolved_ref, "path": clean_path,
        "language": language, "symbols": symbols,
    }
