"""The GitHub hub: a container's connected repo's open issues + PRs (lists AND per-item
detail), and one-click "Start" that turns an issue/PR into an Orcha task (Feature A).

Endpoints (all GETs share the SAME grant model; the two writes are only /start):
  GET  .../github/issues            — open issues (list)
  GET  .../github/pulls             — open PRs (list) — ONE GitHub call, checks:null
  GET  .../github/checks            — batch checks rollup for a set of PR numbers
  GET  .../github/pulls/{number}    — one PR's full detail (PR detail page)
  GET  .../github/issues/{number}   — one issue's full detail (issue detail page)
  POST .../github/start             — issue/PR -> Orcha task
The detail GETs are READ-ONLY: no approve/close/rerun write endpoints — deliberate; the
portal's only GitHub action stays Start.

Auth/token plumbing is SHARED with github_routes.py — the same resolution chain: the
GitHub App INSTALLATION token the host-side refresh timer maintains (multi-org token map,
then the legacy single-token file), and — Orcha Cloud local run gap #1 — a personal
access token as the lowest-precedence fallback when no App token is wired (env
ORCHA_GITHUB_PAT, else the DB-stored per-container PAT). App files, where present, always
keep winning. See `_resolve_repo_token`.

Network calls go through small monkeypatchable leaf functions (`_gh_get`) — tests stub
that leaf and NEVER hit live GitHub (mirroring github_routes._fetch_installation_repos).

A tiny in-module TTL cache (60s) shields GitHub's rate limit from the portal's polling UI:
lists keyed per (cid, 'issues'|'pulls'), detail keyed per (cid, 'pull'|'issue', number),
per-PR checks rollups keyed per (cid, 'checks', number, sha). POST /start invalidates
every cache entry for its container so a freshly tracked item's state can refresh
immediately.

PERFORMANCE (list vs. checks split): the PR list used to build a full checks rollup
INLINE per row — 2 GitHub HTTP calls per PR head sha (commit-status + check-runs), so a
26-PR list cost ~52 sequential GitHub round-trips on a cold cache (the "Loading…" the
founder saw). The list endpoint now makes exactly ONE GitHub call (the /pulls list) and
returns `checks: null` on every row ("not loaded yet" — distinct from a real all-zero
rollup `{passed:0,failing:0,pending:0,total:0}`). The frontend renders the list instantly
off that single call, then requests GET .../github/checks?numbers=... for the visible
rows; this route resolves each requested number's head sha from the SAME cached pulls
list (re-fetching the list only if its own 60s cache has expired — never a second list
call just to get shas) and rolls up checks CONCURRENTLY via a bounded thread pool
(GITHUB_CHECKS_POOL_SIZE workers) — routes here are plain sync `def`s running in
Starlette's threadpool, so `concurrent.futures.ThreadPoolExecutor` is the matching
primitive for fanning out N blocking `_gh_get` calls (no httpx/asyncio dependency added).
"""

import concurrent.futures
import json
import time
import urllib.error
import urllib.parse
import urllib.request

from fastapi import HTTPException, Query, Request

from portal_backend import local_git
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_container, valid_uuid
from portal_backend.github_routes import _read_pat, _read_token, _read_token_map
from portal_backend.identity_routes import require_member_read, trusted_actor
from portal_backend.schemas.github_hub import GithubStartBody
from portal_backend.task_start_core import (
    ORCHA_START_COMMENT_MARKER,
    find_open_gh_task,
    find_open_gh_tasks,
    start_task_from_github,
)

# The repo-binding sentinel meaning "this project's own working tree" (Addendum 2).
# Duplicated here (rather than imported from github_repo_browse_routes) to avoid a
# circular import: that module already imports several names FROM this one. Both
# modules must agree on the literal string; a value drift would silently break the
# local-source degrade below, so keep this in sync with
# github_repo_browse_routes.LOCAL_REPO if either ever changes.
LOCAL_REPO = "local"

GITHUB_API = "https://api.github.com"
GITHUB_TIMEOUT_SECONDS = 10
BODY_EXCERPT_CHARS = 200
CACHE_TTL_SECONDS = 60
# Detail-endpoint fetch caps. The PR files API is paginated; we take the first page of
# 100 and flag `files.truncated` when GitHub says there are more. Issue comments show the
# most-recent 20 (fetched newest-first via GitHub's sort/direction, then re-ordered oldest
# -first for display).
PR_FILES_PER_PAGE = 100
ISSUE_COMMENTS_LIMIT = 20
# How many 100-comment pages a Fix dispatch will walk to net Orcha's OWN round-trip
# comments out of the PR's conversation-comment count (_orcha_comment_count). Five pages
# = 500 comments, far past any real PR thread, and it bounds one Fix click's worst case
# at five extra GitHub calls. Past the cap the netting simply under-counts, which is the
# pre-fix behaviour — never a wrong-direction over-count.
_FIX_COMMENT_PAGE_CAP = 5
# Per-file `patch` text budget for the Files-changed diff view: files are walked IN ORDER
# (the order GitHub's files-page returns them) and each file's patch is included until the
# running total of patch bytes would exceed this budget; every file from that point on gets
# `patch_omitted: true` instead (same shape a binary/oversized single file already gets from
# GitHub omitting `patch` itself — the frontend can't tell "budget" apart from "GitHub never
# sent one" and doesn't need to). ~800KB keeps a large PR's response bounded without needing
# a second paginated fetch of patch text; `files.patches_truncated` is set true whenever ANY
# file's patch was skipped for budget (as opposed to GitHub simply never sending one).
PATCH_BUDGET_BYTES = 800_000
# GET .../github/checks caps: at most this many PR numbers per request (keeps one batch
# call boundedly cheap even if the frontend ever passes an oversized ?numbers= list), and
# at most this many concurrent in-flight GitHub fetches (bounded pool — polite to GitHub's
# rate limit and to the portal process' own thread budget).
CHECKS_BATCH_MAX_NUMBERS = 30
CHECKS_POOL_SIZE = 8

# GET .../github/pulls filtering + pagination (monorepo-scale repos, ~1000 open PRs).
# Defaults/caps mirror the checks batch route's own style: a sane default, a hard
# ceiling enforced server-side rather than trusting the caller.
PULLS_DEFAULT_PAGE = 1
PULLS_DEFAULT_PER_PAGE = 30
PULLS_MAX_PER_PAGE = 50
GITHUB_SEARCH_API = "/search/issues"

# In-module TTL cache. Deliberately a plain module dict — one portal process, tiny
# per-container footprint, invalidated on POST /start. Tests exercise TTL behavior by
# monkeypatching time.monotonic / clearing. Keys are a (cid, kind, *rest) tuple: the
# list routes cache per (cid, 'issues'|'pulls'); the detail routes cache per
# (cid, 'pull'|'issue', number); the batch checks route caches per
# (cid, 'checks', number, sha) — the sha is part of the key so a new push (new head sha)
# is never served a stale rollup even mid-TTL. cid is always key[0] so invalidation
# (which drops every entry for a container) stays correct for all four shapes.
_CACHE: dict = {}


def _cache_key(cid: str, kind: str, *rest) -> tuple:
    return (cid, kind) + rest


def _cache_get(cid: str, kind: str, *rest):
    hit = _CACHE.get(_cache_key(cid, kind, *rest))
    if hit and hit[0] > time.monotonic():
        return hit[1]
    return None


def _cache_put(cid: str, kind: str, payload, *rest) -> None:
    _CACHE[_cache_key(cid, kind, *rest)] = (time.monotonic() + CACHE_TTL_SECONDS, payload)


def _cache_invalidate(cid: str) -> None:
    # Drops every entry for this container — list, detail, raw-pulls, and batch-checks
    # caches alike (key[0] is cid for all four shapes).
    for key in [k for k in _CACHE if k[0] == cid]:
        _CACHE.pop(key, None)


def _resolve_repo_token(repo: str, cid: str = None):
    """The token that can read `owner/name`, or None when nothing is wired for it.
    Multi-org: prefer the per-owner token from the map; else the legacy single-token
    file; else — Orcha Cloud local run gap #1 — the PAT fallback (env ORCHA_GITHUB_PAT,
    else the DB-stored PAT for `cid`). Mirrors github_routes' resolution precedence
    exactly; App files, where present, keep winning unchanged. `cid` is optional so
    existing callers that only have a `repo` string keep working (env-only PAT still
    applies), but every route below passes its container id so the DB-stored PAT can
    participate too."""
    owner = (repo or "").split("/", 1)[0].lower()
    token_map = _read_token_map()
    if token_map and owner in token_map:
        return token_map[owner]
    token = _read_token()
    if token:
        return token
    return _read_pat(cid)


def _gh_get(path: str, token: str):
    """GET a GitHub REST path with the installation token; return parsed JSON.

    stdlib urllib (no httpx dependency), matching github_routes. Raises RuntimeError
    carrying the HTTP status on any GitHub/network failure — the route maps that to a
    clean JSON error the UI can render (rate limit / 403 / 404 not-connected). This is
    the ONLY network leaf; tests monkeypatch it, never the routes.
    """
    url = f"{GITHUB_API}{path}"
    request = urllib.request.Request(
        url,
        headers={
            "Authorization": f"token {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "orcha-portal",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=GITHUB_TIMEOUT_SECONDS) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"github_status:{exc.code}") from exc
    except Exception as exc:  # DNS, timeout, TLS, bad JSON — one graceful shape
        raise RuntimeError(f"github_unreachable:{exc}") from exc


def _error_payload(exc: RuntimeError) -> dict:
    """Map a _gh_get RuntimeError to the UI-renderable {available:false, ...} shape.

    403 → rate-limited/forbidden (quiet-retry note); 404 → the repo isn't reachable
    with this installation (treated as not-connected); anything else → a generic
    unreachable. `available` is false in every case; `detail` is a short string.
    """
    msg = str(exc)
    if msg.startswith("github_status:"):
        code = msg.split(":", 1)[1]
        if code == "403":
            return {"available": False, "reason": "rate_limited",
                    "detail": "GitHub rate limit or access forbidden (403)"}
        if code == "404":
            return {"available": False, "reason": "repo_not_connected",
                    "detail": "repo not reachable with this installation (404)"}
        return {"available": False, "reason": "github_error",
                "detail": f"GitHub returned {code}"}
    return {"available": False, "reason": "unreachable", "detail": "could not reach GitHub"}


def _detail_error_payload(exc: RuntimeError) -> dict:
    """Detail-route error mapping. Identical to `_error_payload` EXCEPT a 404 means the
    specific issue/PR *number* does not exist (not that the whole repo is unreachable):
    the detail pages want `reason:"not_found"` so they can render a distinct 'this item
    is gone' state. All other codes (403 rate-limit, generic, unreachable) reuse the
    shared mapping so the two surfaces stay consistent."""
    msg = str(exc)
    if msg == "github_status:404":
        return {"available": False, "reason": "not_found",
                "detail": "issue or pull request not found (404)"}
    return _error_payload(exc)


def _load_binding(cur, cid: str, request: Request):
    """Container exists + reader is authorized + the repo binding. Raises on a bad
    cid/unknown container/non-member; returns the bound `owner/name` or None."""
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    require_container(cur, cid)
    # Access model: reads are project-isolated (trusted non-member 403), like the other
    # container GET routes (github_routes.get_container_github, container_task_list).
    require_member_read(cur, request, cid)
    cur.execute("SELECT github_repo FROM containers WHERE id=%s", (cid,))
    return cur.fetchone()["github_repo"]


def _acting_github_login(cur, cid: str, request: Request) -> "str | None":
    """The acting identity's github_login, per the SAME identity seam every other
    route here already leans on (`require_member_read` — trusted-proxy login
    resolved to a live container member). Used by involvement=assigned|
    review_requested to resolve "me" server-side. None when no trusted identity
    resolved (trust off/self-host, or a trusted login that isn't a member here —
    require_member_read itself 403s the non-member case, so reaching this point
    with None means either trust-off or a still-unmapped container) OR the
    resolved member simply has no github_login on file."""
    member = require_member_read(cur, request, cid)
    if not member:
        return None
    return member.get("github_login")


def _not_connected():
    """The container has no bound repo — a clean, renderable off state (not an error)."""
    return {"available": False, "reason": "repo_not_connected",
            "detail": "no GitHub repo is connected to this project"}


def _local_source_unavailable(origin_detected: "str | None" = None):
    """The container is bound to the LOCAL_REPO sentinel (Addendum 2) — a real code
    source (browse/Code Space work fine against it), but the hub's issues/PRs/checks
    have no GitHub equivalent to show. Same {available:false,...} shape every other
    graceful hub off-state uses, with a DISTINCT `reason` ("local_source", never
    "repo_not_connected") so the frontend can render "connect GitHub for issues & PRs"
    instead of the generic "no repo connected" empty state — the project IS connected
    to something, just not to GitHub.

    `origin_detected` (owner/name | None) — local-binding + GitHub-origin fall-through:
    when the local working tree's `origin` remote points at GitHub
    (`local_git.origin_repo()`) but no token is wired for it, this is that repo's
    owner/name, so the frontend can render "this clone comes from <owner/name> — add
    GitHub access" instead of the generic "no origin at all" wording. None when the
    local repo has no GitHub origin (or origin detection itself isn't applicable),
    distinguishing the two flavors of degrade from a single boolean-shaped reason."""
    return {"available": False, "reason": "local_source",
            "detail": "issues & PRs need a connected GitHub repo — this project is "
                       "using its local working tree as the code source",
            "origin_detected": origin_detected}


def _local_fallthrough_repo(cid: str) -> "str | None":
    """Local-binding + GitHub-origin fall-through (simultaneous local binding + GitHub
    hub): when a container is bound to LOCAL_REPO, resolve the working tree's `origin`
    remote (`local_git.origin_repo()`) and, ONLY if a token can also be resolved for
    it, return that `owner/name` so the caller can serve the hub route against the
    ORIGIN exactly as if the container had been bound to it directly — same
    `_resolve_repo_token`/`_gh_get` path downstream, no local-specific reshaping
    needed anywhere past this point. Returns None when there's no GitHub origin, or
    there is one but no token is wired for it — either case, the caller falls back to
    the existing `_local_source_unavailable()` degrade (passing the origin along for
    the UI's benefit even on a None-token miss; see call sites)."""
    origin = local_git.origin_repo()
    if not origin:
        return None
    if not _resolve_repo_token(origin, cid):
        return None
    return origin


def _with_tracked_list(cid: str, items: list) -> list:
    """Stamp `tracked_task_id` (str | None) onto every row of an issues/pulls LIST
    payload, batched into ONE query via task_start_core.find_open_gh_tasks — the SAME
    open-task lookup POST /start's idempotency check uses, so "tracked" here and
    "existing:true" there can never disagree. Deliberately applied OUTSIDE the 60s
    GitHub-list cache (called on every request, cached or fresh): tracked state is a
    local Postgres read, not a GitHub call, so keeping it live costs nothing and means
    a Slack-started task shows as tracked on this container's very next hub page load
    instead of waiting out the list's GitHub cache TTL.
    """
    if not items:
        return items
    numbers = [it["number"] for it in items if it.get("number") is not None]
    with db_cursor() as (_, cur):
        tracked = find_open_gh_tasks(cur, cid, numbers)
    return [{**it, "tracked_task_id": tracked.get(it.get("number"))} for it in items]


def _with_tracked_one(cid: str, number, item: dict) -> dict:
    """Single-item form of _with_tracked_list for the detail routes (one number, but
    the SAME shared find_open_gh_tasks lookup — never a separate/duplicated query
    shape from the list path)."""
    with db_cursor() as (_, cur):
        tracked = find_open_gh_tasks(cur, cid, [number])
    return {**item, "tracked_task_id": tracked.get(number)}


def _labels(issue: dict) -> list:
    """Each label as {name, color} — GitHub's own label hex (no leading '#', e.g. "d73a4a"),
    so the UI can render tags in their real repo colors instead of a flat generic chip.
    `color` is omitted (None) on the rare label that carries none; the UI falls back to a
    deterministic palette in that case."""
    return [{"name": lb.get("name"), "color": lb.get("color")}
            for lb in (issue.get("labels") or []) if lb.get("name")]


def _excerpt(body) -> str:
    return (body or "")[:BODY_EXCERPT_CHARS]


def _fetch_gh_item(cur, container_id, kind: str, number: int):
    """Live-fetch a GitHub issue/PR's {title, html_url, body_excerpt} — the
    AUTHORITATIVE source for a start's task copy (see `start_from_github`'s
    docstring). Originally built for the Slack seam (which only ever gets a bare
    number from Slack) and promoted here as the shared server-side source of truth
    after a production defect: the hub's OWN frontend (`postStart` in
    static/pages/github-render.js) never actually sends `title`/`body_excerpt`/
    `html_url` in its POST body despite `GithubStartBody`'s docstring assuming it
    does — every hub-started task (issue OR pull) was landing titled bare `GH #<N>:`
    with nothing after. Rather than patch the frontend (still worth doing, but a
    server-side authoritative fetch fixes EVERY caller — hub, Slack, any future
    seam — in one place and can't regress the same way again), every dispatch path
    now fetches the real title itself; a client-supplied title is only ever used as
    the last-resort fallback when this live fetch fails.

    Returns None on ANY failure (no bound repo, no installation token, GitHub
    unreachable/rate-limited/404) — callers degrade to whatever fallback title they
    have on hand (client-supplied, or a bare '#N') rather than fail the whole start;
    neither the hub route nor Slack's 3s slash-command contract has room for a retry
    loop.
    """
    cur.execute("SELECT github_repo FROM containers WHERE id=%s", (container_id,))
    row = cur.fetchone()
    repo = row["github_repo"] if row else None
    if not repo:
        return None
    token = _resolve_repo_token(repo, container_id)
    if not token:
        return None
    path = f"/repos/{repo}/pulls/{number}" if kind == "pull" else f"/repos/{repo}/issues/{number}"
    try:
        raw = _gh_get(path, token)
    except RuntimeError:
        return None
    return {
        "title": raw.get("title") or "",
        "html_url": raw.get("html_url") or "",
        "body_excerpt": _excerpt(raw.get("body")),
    }


def _issue_entry(issue: dict) -> dict:
    assignee = issue.get("assignee") or {}
    return {
        "number": issue.get("number"),
        "title": issue.get("title"),
        "labels": _labels(issue),
        "assignee": assignee.get("login"),
        "updated_at": issue.get("updated_at"),
        "html_url": issue.get("html_url"),
        "body_excerpt": _excerpt(issue.get("body")),
    }


def _checks_rollup(repo: str, sha: str, token: str, include_runs: bool = False) -> dict:
    """Combine the legacy commit-status API and the newer check-runs API for a head SHA
    into one {passed, failing, pending, total} rollup — the UI's checks chip.

    Both surfaces coexist on real repos (status = older CI like Travis; check-runs =
    GitHub Actions / Apps), so we sum both. A network failure on either surface degrades
    gracefully to zeros rather than failing the whole PR list.

    The list endpoint calls this with the default `include_runs=False` and reads only the
    four counts. The PR-DETAIL endpoint passes `include_runs=True` to additionally get a
    `runs:[{name,status,conclusion,html_url}]` list under the SAME classification math —
    so the aggregate chip on the detail page can never disagree with the per-run rows.
    The returned dict is freshly built on every call (no shared mutable default); callers
    may freely mutate/extend it — e.g. `_pull_detail` drops `runs` in when it wants them
    and the count-only callers simply ignore that absent key.
    """
    passed = failing = pending = 0
    runs_out = []
    # Legacy combined commit status: contexts each 'success' | 'failure'|'error' | 'pending'.
    try:
        combined = _gh_get(f"/repos/{repo}/commits/{sha}/status", token)
        for st in combined.get("statuses") or []:
            state = st.get("state")
            if state == "success":
                passed += 1
            elif state in ("failure", "error"):
                failing += 1
            else:
                pending += 1
            if include_runs:
                # Normalize a legacy status context into the same run row shape as a
                # check-run: its `state` is the conclusion, and it's always 'completed'.
                runs_out.append({
                    "name": st.get("context"),
                    "status": "completed",
                    "conclusion": state,
                    "html_url": st.get("target_url"),
                })
    except RuntimeError:
        pass
    # Check runs: status queued|in_progress|completed; conclusion success|failure|...
    try:
        runs = _gh_get(f"/repos/{repo}/commits/{sha}/check-runs", token)
        for run in runs.get("check_runs") or []:
            if run.get("status") != "completed":
                pending += 1
            else:
                conclusion = run.get("conclusion")
                if conclusion in ("success", "neutral", "skipped"):
                    passed += 1
                elif conclusion in ("failure", "timed_out", "action_required", "cancelled",
                                    "stale", "startup_failure"):
                    failing += 1
                else:
                    pending += 1
            if include_runs:
                runs_out.append({
                    "name": run.get("name"),
                    "status": run.get("status"),
                    "conclusion": run.get("conclusion"),
                    "html_url": run.get("html_url"),
                })
    except RuntimeError:
        pass
    rollup = {"passed": passed, "failing": failing, "pending": pending,
              "total": passed + failing + pending}
    if include_runs:
        rollup["runs"] = runs_out
    return rollup


def _pull_entry(repo: str, pull: dict) -> dict:
    """One row of the PR LIST — no checks-rollup GitHub calls (that's the whole point of
    the lazy split, see the module header's PERFORMANCE note). `checks` is always None
    here — "not loaded yet", filled in by a follow-up GET .../github/checks batch call —
    NEVER a real rollup dict, so the frontend can tell "not loaded" apart from an honest
    all-zero result. `repo` is accepted (unused) to keep this a drop-in swap for the old
    signature at call sites; head sha isn't needed here either (the checks route re-reads
    it straight off the cached raw pulls list). `author_login` is an ADDITIVE field (the
    PR author's login, straight off GitHub's `user.login`) — feeds the filter bar's
    "authors seen in loaded rows" datalist; existing consumers ignore the extra key."""
    reviewers = [r.get("login") for r in (pull.get("requested_reviewers") or [])
                 if r.get("login")]
    head = pull.get("head") or {}
    return {
        "number": pull.get("number"),
        "title": pull.get("title"),
        "head": head.get("ref"),
        "draft": bool(pull.get("draft")),
        "updated_at": pull.get("updated_at"),
        "html_url": pull.get("html_url"),
        "requested_reviewers": reviewers,
        "checks": None,
        "mergeable_state": pull.get("mergeable_state"),
        "author_login": (pull.get("user") or {}).get("login"),
    }


def _search_pull_entry(item: dict) -> dict:
    """One row of the PR list SOURCED FROM GitHub's search API (author=/involvement=/q=
    present). `/search/issues` returns the issue-shaped subset of a PR — no head/base,
    no requested_reviewers, no mergeable_state — so this maps to the SAME row shape
    `_pull_entry` emits (clients tolerate the gaps), filling in only what's known and
    leaving the rest null/absent rather than fabricating it. `checks` is null here too,
    same "not loaded yet" convention as the plain list path — the progressive-fill
    checks route re-resolves shas off a warm /pulls list, which a search-sourced row
    was never part of, so a search-tab PR simply never gets a checks fill (acceptable:
    checks aren't in the frozen contract's ask for this surface)."""
    return {
        "number": item.get("number"),
        "title": item.get("title"),
        "head": None,
        "draft": bool(item.get("draft")),
        "updated_at": item.get("updated_at"),
        "html_url": item.get("html_url"),
        "requested_reviewers": [],
        "checks": None,
        "mergeable_state": None,
        "author_login": (item.get("user") or {}).get("login"),
    }


def _build_search_query(repo: str, *, author: "str | None", involvement_login: "str | None",
                         involvement: "str | None", q: "str | None") -> str:
    """Compose the `q=` search string for GitHub's /search/issues: repo scope + is:pr
    is:open, plus whichever of author:/assignee:/review-requested:/free-text the
    caller asked for. `involvement_login` is the ALREADY-RESOLVED acting identity's
    github_login (server-side — see list_github_pulls); `involvement` is which
    qualifier that resolves to. Free text (`q`) is appended last, unquoted, exactly as
    GitHub's search box would take it (title/body full-text match)."""
    parts = [f"repo:{repo}", "is:pr", "is:open"]
    if author:
        parts.append(f"author:{author}")
    if involvement == "assigned" and involvement_login:
        parts.append(f"assignee:{involvement_login}")
    elif involvement == "review_requested" and involvement_login:
        parts.append(f"review-requested:{involvement_login}")
    if q:
        parts.append(q)
    return " ".join(parts)


def _search_pulls(repo: str, token: str, *, author: "str | None",
                   involvement_login: "str | None", involvement: "str | None",
                   q: "str | None", page: int, per_page: int) -> dict:
    """The ONE GitHub call behind a filtered/paginated PR list: GET /search/issues with
    the composed query string. Returns the raw GitHub search response
    ({total_count, incomplete_results, items}) — the route maps `items` through
    `_search_pull_entry` and reads `total_count` for pagination."""
    query = _build_search_query(repo, author=author, involvement_login=involvement_login,
                                 involvement=involvement, q=q)
    params = urllib.parse.urlencode({"q": query, "page": page, "per_page": per_page})
    return _gh_get(f"{GITHUB_SEARCH_API}?{params}", token)


def _logins(items) -> list:
    """The `login` of each user object in a list, skipping any without one."""
    return [u.get("login") for u in (items or []) if u.get("login")]


def _pr_files(repo: str, number: int, token: str, changed_files) -> dict:
    """The PR's changed files (first page of 100), as
    {count, items[{filename,additions,deletions,status,patch,patch_omitted}][, truncated,
    patches_truncated]}.

    `count` is GitHub's OWN `changed_files` total from the PR object (the honest total, not
    the length of the page we fetched); `truncated` is set true only when that honest total
    exceeds what we returned (unchanged from the list-only shape this replaces).

    Each item now ALSO carries the diff text: `patch` is GitHub's raw unified-diff hunk
    string for that file, or `null` when GitHub itself omits it (binary files, and files
    GitHub judges "too large" get no `patch` field at all) — `patch_omitted: true` marks
    that case so the frontend can render an honest "diff not available" line instead of a
    silently-empty diff. Files are walked IN ORDER (GitHub's own files-page order) tracking
    a running total of patch bytes; once including a file's patch would cross
    PATCH_BUDGET_BYTES, a STICKY `budget_hit` flag flips on and every file from that point
    on — regardless of how small its own patch is — is ALSO forced to
    patch:null/patch_omitted:true (never re-checked against the budget again; a small file
    arriving after a big one that tripped the budget must not sneak back in under the
    now-stale running total). Same shape as a GitHub-side omission, so the frontend needs no
    separate case for it — and `patches_truncated: true` is set on the returned dict so the
    UI can show one honest "diffs cut off, view on GitHub" note distinct from the per-file
    omitted line. A network failure fetching the files page degrades to an empty list rather
    than failing the whole PR.
    """
    try:
        raw = _gh_get(
            f"/repos/{repo}/pulls/{number}/files?per_page={PR_FILES_PER_PAGE}", token)
    except RuntimeError:
        raw = []
    items = []
    patch_bytes_used = 0
    budget_hit = False
    for f in raw:
        patch = f.get("patch")
        entry = {
            "filename": f.get("filename"),
            "additions": f.get("additions"),
            "deletions": f.get("deletions"),
            "status": f.get("status"),
        }
        if patch is None:
            # GitHub itself never sent a patch (binary file, or GitHub judged it too large) —
            # honest omission, not a budget decision.
            entry["patch"] = None
            entry["patch_omitted"] = True
        elif budget_hit or patch_bytes_used + len(patch) > PATCH_BUDGET_BYTES:
            # Either the budget was already tripped by an earlier file (sticky — never
            # re-checked), or including THIS file's patch would trip it now. Either way, omit
            # this file's patch (and every file after it) and flag the budget cut distinctly.
            entry["patch"] = None
            entry["patch_omitted"] = True
            budget_hit = True
        else:
            entry["patch"] = patch
            entry["patch_omitted"] = False
            patch_bytes_used += len(patch)
        items.append(entry)
    # Prefer GitHub's declared total; fall back to what we actually fetched if it's absent.
    count = changed_files if isinstance(changed_files, int) else len(items)
    out = {"count": count, "items": items}
    if count > len(items):
        out["truncated"] = True
    if budget_hit:
        out["patches_truncated"] = True
    return out


def _pull_detail(repo: str, pull: dict, token: str) -> dict:
    """Assemble the PR-detail payload from the fetched PR object + its files + checks.

    body_markdown is the RAW markdown straight from GitHub (`body`) — the frontend renders
    it with the portal's own markdown renderer; we deliberately do NOT html-render server
    -side. Checks reuse the SHARED `_checks_rollup` (with include_runs=True) so the chip
    math is identical to the list endpoint, plus a per-run breakdown for the detail page.
    """
    head = pull.get("head") or {}
    base = pull.get("base") or {}
    sha = head.get("sha")
    checks = _checks_rollup(repo, sha, token, include_runs=True) if sha else {
        "passed": 0, "failing": 0, "pending": 0, "total": 0, "runs": []}
    return {
        "number": pull.get("number"),
        "title": pull.get("title"),
        "state": pull.get("state"),
        "draft": bool(pull.get("draft")),
        "body_markdown": pull.get("body") or "",
        "author_login": (pull.get("user") or {}).get("login"),
        "base": base.get("ref"),
        "head": head.get("ref"),
        "updated_at": pull.get("updated_at"),
        "created_at": pull.get("created_at"),
        "html_url": pull.get("html_url"),
        "mergeable_state": pull.get("mergeable_state"),
        "assignees": _logins(pull.get("assignees")),
        "requested_reviewers": _logins(pull.get("requested_reviewers")),
        "checks": checks,
        "files": _pr_files(repo, pull.get("number"), token, pull.get("changed_files")),
        "comments_count": pull.get("comments"),
        "review_comments_count": pull.get("review_comments"),
    }


def _fix_description(*, number: int, title: str, head: str, draft: bool,
                      mergeable_state, checks: dict, review_comments_count,
                      comments_count) -> str:
    """Compose the context-aware DoD for a PR "Fix" dispatch (founder decision) from the
    PR's ACTUAL state at dispatch time — the same fields the detail path already
    surfaces (checks-with-runs, mergeable_state, comment counts) — rather than the
    generic static template every PR used to get regardless of what's actually wrong
    with it.

    Pure/no-network (the caller does the one PR + one checks-rollup fetch and hands the
    already-assembled pieces in), so this is independently unit-testable against fixture
    shapes without stubbing _gh_get.

    Clauses, each included ONLY when it applies (all omitted -> the generic fallback
    sentence, never an empty "Outstanding: ." line):
      - failing checks: "k failing check(s): name1, name2" (names from checks['runs'],
        capped at 5 named + "+N more" so a PR with 30 failing jobs doesn't blow up the
        DoD into a wall of text)
      - unresolved review feedback: review_comments_count + comments_count as the
        available proxy for "there's feedback to address" (the detail endpoint doesn't
        expose per-comment resolved/unresolved state, so a total count is the honest
        signal we actually have)
      - merge conflicts: mergeable_state == "dirty" (GitHub's own vocabulary for "has
        conflicts with base" — see mergeChipHtml's CLEAN_STATES on the frontend for the
        sibling "clean" set this deliberately does NOT reuse, since dirty is a specific
        state, not "not clean")
      - draft: prefixed as its own note (not folded into "Outstanding") since a draft PR
        isn't really "outstanding work to fix" so much as "not ready for this yet" — still
        worth flagging so the dispatched agent knows.
    pending checks are mentioned by count only (no per-check detail — GitHub doesn't
    tell us what a still-running check's outcome will be, so there's nothing more
    specific to say about it yet).
    """
    r = checks or {}
    failing = r.get("failing") or 0
    pending = r.get("pending") or 0
    runs = r.get("runs") or []
    failing_names = [run.get("name") or "unnamed check" for run in runs
                     if (run.get("status") == "completed"
                         and run.get("conclusion") in ("failure", "timed_out",
                                                        "action_required", "cancelled",
                                                        "stale", "startup_failure"))]

    outstanding = []
    if failing:
        shown = failing_names[:5]
        more = len(failing_names) - len(shown)
        names = ", ".join(shown) + (f", +{more} more" if more > 0 else "")
        outstanding.append(f"{failing} failing check{'s' if failing != 1 else ''}"
                            + (f": {names}" if names else ""))
    if pending:
        outstanding.append(f"{pending} check{'s' if pending != 1 else ''} still pending")
    review_total = (review_comments_count or 0) + (comments_count or 0)
    if review_total:
        outstanding.append(
            f"{review_total} review comment{'s' if review_total != 1 else ''} to address")
    if mergeable_state == "dirty":
        outstanding.append("merge conflicts with base — rebase or resolve conflicts")

    draft_note = "This PR is a draft. " if draft else ""
    if outstanding:
        body = f"Outstanding: {'; '.join(outstanding)}."
    else:
        body = "Review the PR's feedback and CI state and address anything outstanding."
    return (f"Fix PR #{number}: {title}. {draft_note}{body} "
            f"Push fixes to its branch {head or '?'}. "
            f"Never merge; stop for human review.")


def _orcha_authored_comment(comment: dict) -> bool:
    """Is this issue/PR comment one ORCHA ITSELF posted (task_start_core's round-trip
    "🤖 Orcha started task ..." note), rather than real feedback from a human?

    Matched on the body's opening literal (ORCHA_START_COMMENT_MARKER), NOT on the
    author's login or `user.type == "Bot"`, because the author identity is not stable:
    the same comment is posted by the App's `<slug>[bot]` when a container runs on an
    installation token, but by a REAL human login when it falls through to a stored PAT
    (_resolve_repo_token's fallback). The body literal is the one thing Orcha controls
    in both cases. Cost of the tradeoff: a human who opens a comment by quoting that
    exact line verbatim (no `>` quote marker, no preamble) is misread as Orcha and their
    comment goes uncounted — a deliberately narrower failure than the one being fixed,
    where EVERY Orcha dispatch inflated the count for every PR.
    """
    body = comment.get("body") or ""
    return body.lstrip().startswith(ORCHA_START_COMMENT_MARKER)


def _orcha_comment_count(repo: str, number: int, token: str, total: int) -> int:
    """How many of this issue/PR's `total` conversation comments Orcha posted itself.

    Paged at 100/request and capped at _FIX_COMMENT_PAGE_CAP pages, so a PR with a
    pathological comment thread can't turn one Fix click into dozens of GitHub calls.
    Every failure mode here UNDER-counts (a fetch error, or an unexpected non-array
    payload, stops the walk; comments past the cap are never scanned), which degrades to
    exactly the pre-fix behaviour — an over-count would be worse, since it could hide
    real review feedback from the DoD. Nothing in here raises: this is an enrichment
    nicety and must never be what fails a Fix click.
    """
    pages = min(-(-total // 100), _FIX_COMMENT_PAGE_CAP)   # ceil-div, then cap
    found = 0
    for page in range(1, pages + 1):
        try:
            raw = _gh_get(
                f"/repos/{repo}/issues/{number}/comments?per_page=100&page={page}",
                token)
        except RuntimeError:
            break   # degrade to what we've counted so far — never fail the dispatch
        if not isinstance(raw, list) or not raw:
            break   # empty page, or a shape that isn't a comment array — stop, don't raise
        found += sum(1 for c in raw if isinstance(c, dict) and _orcha_authored_comment(c))
        if len(raw) < 100:
            break
    return found


def _pull_fix_context(repo: str, number: int, token: str) -> dict:
    """The minimal live-state fetch a Fix dispatch needs to compose _fix_description:
    one PR object + one checks rollup (WITH per-run names) — deliberately NOT the full
    _pull_detail (which also paginates the files list; a Fix dispatch doesn't need
    files, so skipping that fetch keeps the dispatch click itself fast). Returns the
    kwargs _fix_description expects, straight off the raw GitHub shapes. A 404 for the
    number propagates as RuntimeError (github_status:404) exactly like every other
    _gh_get caller here — the route's existing _detail_error_payload handles it.

    ONE exception to "straight off the raw shapes": `comments_count`. Every dispatch
    posts a "🤖 Orcha started task ..." comment back on the PR
    (task_start_core._post_start_comment), and GitHub counts that in the PR object's
    `comments` — so a SECOND Fix click on the same PR read Orcha's own note back as
    "1 review comment to address" and told the agent to go address a phantom. The raw
    count is therefore netted against _orcha_comment_count. This costs at most one
    extra GitHub call, and only when the PR actually has conversation comments (a PR
    with `comments == 0` has nothing to net out, so the call is skipped entirely).

    `review_comments` needs NO such netting: those are INLINE code-review comments on
    the `/pulls/{n}/comments` endpoint, and Orcha only ever posts to the conversation
    endpoint (`/issues/{n}/comments`) — so nothing Orcha writes can land in that count.
    """
    pull = _gh_get(f"/repos/{repo}/pulls/{number}", token)
    head = pull.get("head") or {}
    sha = head.get("sha")
    checks = _checks_rollup(repo, sha, token, include_runs=True) if sha else {
        "passed": 0, "failing": 0, "pending": 0, "total": 0, "runs": []}
    comments = pull.get("comments") or 0
    if comments > 0:
        comments = max(0, comments - _orcha_comment_count(repo, number, token, comments))
    return {
        "number": pull.get("number"),
        "title": pull.get("title") or "",
        "head": head.get("ref") or "",
        "draft": bool(pull.get("draft")),
        "mergeable_state": pull.get("mergeable_state"),
        "checks": checks,
        "review_comments_count": pull.get("review_comments"),
        "comments_count": comments,
    }


def _issue_comment(comment: dict) -> dict:
    return {
        "author_login": (comment.get("user") or {}).get("login"),
        "body_markdown": comment.get("body") or "",
        "created_at": comment.get("created_at"),
    }


def _issue_comments(repo: str, number: int, token: str) -> list:
    """The issue's most-recent ISSUE_COMMENTS_LIMIT comments, oldest-first for display.

    We ask GitHub for the newest ones (sort=created&direction=desc, capped at the limit)
    then reverse to oldest-first so the detail thread reads top-to-bottom. A fetch failure
    degrades to an empty list rather than failing the whole issue."""
    try:
        raw = _gh_get(
            f"/repos/{repo}/issues/{number}/comments"
            f"?per_page={ISSUE_COMMENTS_LIMIT}&sort=created&direction=desc",
            token)
    except RuntimeError:
        return []
    newest_first = [_issue_comment(c) for c in raw[:ISSUE_COMMENTS_LIMIT]]
    newest_first.reverse()  # -> oldest-first
    return newest_first


def _issue_detail(repo: str, issue: dict, token: str) -> dict:
    """Assemble the issue-detail payload from the fetched issue object + its comments.

    body_markdown is the RAW markdown (`body`); the frontend renders it. `assignee` is the
    single primary assignee's login (GitHub's legacy field); `assignees` is the full list.
    """
    assignee = issue.get("assignee") or {}
    return {
        "number": issue.get("number"),
        "title": issue.get("title"),
        "state": issue.get("state"),
        "body_markdown": issue.get("body") or "",
        "author_login": (issue.get("user") or {}).get("login"),
        "labels": _labels(issue),
        "assignee": assignee.get("login"),
        "assignees": _logins(issue.get("assignees")),
        "updated_at": issue.get("updated_at"),
        "created_at": issue.get("created_at"),
        "html_url": issue.get("html_url"),
        "comments_count": issue.get("comments"),
        "comments": _issue_comments(repo, issue.get("number"), token),
    }


@app.get("/api/containers/{cid}/github/issues")
def list_github_issues(cid: str, request: Request):
    """Open issues of the container's connected repo — the hub's Issues tab.

    Returns {available, repo, issues:[{number,title,labels,assignee,updated_at,
    html_url,body_excerpt,tracked_task_id}]}. `tracked_task_id` (str | None) is the
    OPEN Orcha task already tracking this issue, if any — computed fresh on every
    request (see _with_tracked_list), even when the GitHub-sourced fields below it are
    served from the 60s cache, so a task started via ANY path (hub, Slack, a re-run of
    this same fetch) shows as tracked without waiting on the GitHub cache TTL.
    Not-connected / rate-limited / GitHub error all resolve to a clean
    {available:false, reason, detail} the UI renders (never a 5xx)."""
    with db_cursor() as (_, cur):
        repo = _load_binding(cur, cid, request)
    if not repo:
        return _not_connected()
    if repo == LOCAL_REPO:
        # Addendum 2 + local-binding/GitHub-origin fall-through: a local-source
        # binding has no GitHub issues/PRs/checks to show UNLESS the working tree's
        # `origin` remote points at a GitHub repo we hold a token for — in that case
        # serve this route against the ORIGIN exactly as if bound to it directly
        # (reassign `repo` and fall through to the normal GitHub path below). Only
        # when there's no such origin (or no token for it) does this degrade, with a
        # DISTINCT reason (see _local_source_unavailable) so the frontend can render
        # "connect GitHub for issues & PRs" rather than the generic not-connected
        # empty state. Browse/Code Space stay fully functional against local either
        # way; only this hub surface is affected.
        fallthrough_repo = _local_fallthrough_repo(cid)
        if not fallthrough_repo:
            return _local_source_unavailable(local_git.origin_repo())
        repo = fallthrough_repo
    cached = _cache_get(cid, "issues")
    if cached is not None:
        return {**cached, "issues": _with_tracked_list(cid, cached["issues"])}
    token = _resolve_repo_token(repo, cid)
    if not token:
        return _not_connected()
    # GitHub's issues list includes PRs; filter them out (PRs carry pull_request).
    path = f"/repos/{repo}/issues?state=open&per_page=100"
    try:
        raw = _gh_get(path, token)
    except RuntimeError as exc:
        return {**_error_payload(exc), "repo": repo}
    issues = [_issue_entry(i) for i in raw if "pull_request" not in i]
    payload = {"available": True, "repo": repo, "issues": issues}
    _cache_put(cid, "issues", payload)
    return {**payload, "issues": _with_tracked_list(cid, issues)}


def _fetch_and_cache_pulls_list(cid: str, repo: str, token: str):
    """The ONE GitHub call behind the PR list: fetch `/pulls`, cache both the
    client-facing payload (`checks: None` per row — see `_pull_entry`) AND the raw
    GitHub response (`_cache_get(cid, "pulls_raw")`) under the SAME 60s TTL. The raw copy
    is read-only plumbing for the batch checks route below — it needs each requested
    number's head sha and must never trigger a second `/pulls` list call just to get it.
    Returns (payload, raw) on success; raises RuntimeError on a GitHub failure (the raw
    cache is left untouched on failure — a transient error must never poison it with a
    partial/absent list)."""
    raw = _gh_get(f"/repos/{repo}/pulls?state=open&per_page=100", token)
    pulls = [_pull_entry(repo, p) for p in raw]
    payload = {"available": True, "repo": repo, "pulls": pulls}
    _cache_put(cid, "pulls", payload)
    _cache_put(cid, "pulls_raw", raw)
    return payload, raw


def _cached_or_fetch_raw_pulls(cid: str, repo: str, token: str):
    """The batch checks route's entry point for "what's this PR's head sha": prefer the
    warm raw-pulls cache (no GitHub call at all); on a miss/expiry, re-fetch the list
    ONCE (populating both caches via `_fetch_and_cache_pulls_list`, so a subsequent list
    GET this same 60s window is also served from cache). Raises RuntimeError on failure,
    same as any other GitHub fetch here."""
    raw = _cache_get(cid, "pulls_raw")
    if raw is not None:
        return raw
    _, raw = _fetch_and_cache_pulls_list(cid, repo, token)
    return raw


def _clamp_per_page(per_page: int) -> int:
    return max(1, min(per_page, PULLS_MAX_PER_PAGE))


@app.get("/api/containers/{cid}/github/pulls")
def list_github_pulls(
    cid: str, request: Request,
    author: "str | None" = Query(None),
    involvement: "str | None" = Query(None, pattern="^(assigned|review_requested)$"),
    q: "str | None" = Query(None),
    page: int = Query(PULLS_DEFAULT_PAGE, ge=1),
    per_page: int = Query(PULLS_DEFAULT_PER_PAGE, ge=1),
):
    """Open PRs of the container's connected repo — the hub's PRs tab. Monorepo-scale
    filtering/pagination (~1000 open PRs): author=<login> (exact, case-insensitive —
    passed straight through to GitHub's own author: qualifier, which is itself
    case-insensitive), involvement=assigned|review_requested (resolved SERVER-SIDE
    against the acting identity's github_login — see `_acting_github_login`), q=<free
    text> (title/body search), page=<1-based, default 1>, per_page=<default 30, max 50>.

    When ANY of author/involvement/q is present, this uses GitHub's SEARCH API
    (`_search_pulls` -> GET /search/issues) instead of the plain /pulls list — search
    -sourced rows map to the SAME shape but lack head/base/checks/requested_reviewers
    (GitHub's search index doesn't carry them); those fields come back null/empty
    rather than fabricated (see `_search_pull_entry`). The plain (no-filter) path is
    UNCHANGED apart from page/per_page passthrough+clamp, and stays on the existing
    60s-cached single-call list — this is the common case (open the PRs tab, no
    filter yet) and must not cost an extra round-trip or lose its cache.

    Returns {available, source:"list"|"search", repo, pulls:[...], page, per_page,
    total_count, has_more}. `total_count` is GitHub's own search total (int) on the
    search path; always null on the list path (the plain /pulls list carries no
    honest total without walking every page). `has_more`: on the search path, whether
    `page * per_page < total_count`; on the list path (no total available), whether a
    FULL page came back (a partial/empty page means nothing more to page to).
    `checks` stays ALWAYS null on the list path — "not loaded yet" — the checks
    rollup is fetched separately via GET .../github/checks. `tracked_task_id`
    (str | None) is computed fresh on every request, same as the issues list — see
    _with_tracked_list's docstring. Same clean-error contract as the issues route
    (never a 5xx); an identity-less involvement request is a distinct clean-empty
    shape (see below), not an error.

    involvement with no resolvable github_login for the acting identity (self-host
    with no trusted proxy, or a trusted member who never linked GitHub) short-circuits
    BEFORE any GitHub call, returning {available:true, items:[], detail:"Link a
    GitHub login to use this filter", ...} — a friendly empty state, not a 4xx: the
    filter is simply unusable for this identity right now, which isn't an error."""
    with db_cursor() as (conn, cur):
        repo = _load_binding(cur, cid, request)
        involvement_login = None
        if involvement:
            involvement_login = _acting_github_login(cur, cid, request)
        conn.commit()  # release the read transaction before any GitHub round-trip
    if involvement and not involvement_login:
        return {"available": True, "source": "search", "repo": repo, "items": [],
                "pulls": [], "page": page, "per_page": _clamp_per_page(per_page),
                "total_count": None, "has_more": False,
                "detail": "Link a GitHub login to use this filter"}
    if not repo:
        return _not_connected()
    if repo == LOCAL_REPO:
        # Addendum 2 + local-binding/GitHub-origin fall-through — see the identical
        # comment on list_github_issues above for the full rationale.
        fallthrough_repo = _local_fallthrough_repo(cid)
        if not fallthrough_repo:
            return _local_source_unavailable(local_git.origin_repo())
        repo = fallthrough_repo
    per_page = _clamp_per_page(per_page)
    filtering = bool(author or involvement or q)
    if filtering:
        token = _resolve_repo_token(repo, cid)
        if not token:
            return _not_connected()
        try:
            raw = _search_pulls(repo, token, author=author, involvement_login=involvement_login,
                                involvement=involvement, q=q, page=page, per_page=per_page)
        except RuntimeError as exc:
            return {**_error_payload(exc), "repo": repo}
        items = raw.get("items") or []
        total_count = raw.get("total_count")
        pulls = [_search_pull_entry(it) for it in items]
        has_more = isinstance(total_count, int) and (page * per_page) < total_count
        return {
            "available": True, "source": "search", "repo": repo,
            "pulls": _with_tracked_list(cid, pulls),
            "page": page, "per_page": per_page,
            "total_count": total_count, "has_more": has_more,
        }
    # Plain path (no filters): unchanged single-call list + 60s cache, now with
    # page/per_page passthrough. Only page 1 at the default per_page is ever served
    # from the 60s cache — any other page/per_page is a fresh, uncached GitHub call
    # (the cache's one slot can't hold every page combination).
    cache_eligible = page == PULLS_DEFAULT_PAGE and per_page == PULLS_DEFAULT_PER_PAGE
    if cache_eligible:
        cached = _cache_get(cid, "pulls")
        if cached is not None:
            return {**cached, "pulls": _with_tracked_list(cid, cached["pulls"]),
                    "source": "list", "page": page, "per_page": per_page,
                    "total_count": None, "has_more": len(cached["pulls"]) >= per_page}
    token = _resolve_repo_token(repo, cid)
    if not token:
        return _not_connected()
    try:
        if cache_eligible:
            payload, _raw = _fetch_and_cache_pulls_list(cid, repo, token)
        else:
            raw = _gh_get(f"/repos/{repo}/pulls?state=open&page={page}&per_page={per_page}", token)
            payload = {"available": True, "repo": repo,
                       "pulls": [_pull_entry(repo, p) for p in raw]}
    except RuntimeError as exc:
        return {**_error_payload(exc), "repo": repo}
    has_more = len(payload["pulls"]) >= per_page
    return {**payload, "pulls": _with_tracked_list(cid, payload["pulls"]),
            "source": "list", "page": page, "per_page": per_page,
            "total_count": None, "has_more": has_more}


@app.get("/api/containers/{cid}/github/checks")
def list_github_checks(cid: str, request: Request, numbers: str = Query(...)):
    """Batch checks rollup for a set of open PRs — the list's progressive-fill follow-up
    call. ?numbers=1,2,3 (max CHECKS_BATCH_MAX_NUMBERS numbers per request — a 400 above
    that, not a silent truncation, so a caller notices it's asking for too much rather
    than quietly losing rows).

    Returns {available, checks: {"<number>": {passed,failing,pending,total}}}. Only
    numbers whose head sha we can resolve (i.e. still present in the current open-PRs
    list) get an entry — a number that's since closed/merged is simply absent, not an
    error. Each number's rollup is fetched CONCURRENTLY off a bounded thread pool
    (CHECKS_POOL_SIZE workers — see the module header's PERFORMANCE note) and cached per
    (cid, number, head sha) for 60s, same TTL as everything else here. The existing
    403-degrades-to-zeros behavior of `_checks_rollup` applies per-number, so one PR's
    checks being unreadable never fails the whole batch.
    """
    with db_cursor() as (_, cur):
        repo = _load_binding(cur, cid, request)
    if not repo:
        return _not_connected()
    if repo == LOCAL_REPO:
        # Addendum 2 + local-binding/GitHub-origin fall-through — see the identical
        # comment on list_github_issues above for the full rationale.
        fallthrough_repo = _local_fallthrough_repo(cid)
        if not fallthrough_repo:
            return _local_source_unavailable(local_git.origin_repo())
        repo = fallthrough_repo
    raw_numbers = [n for n in numbers.split(",") if n.strip()]
    if len(raw_numbers) > CHECKS_BATCH_MAX_NUMBERS:
        raise HTTPException(
            400, f"at most {CHECKS_BATCH_MAX_NUMBERS} numbers per request")
    try:
        wanted = sorted({int(n) for n in raw_numbers})
    except ValueError:
        raise HTTPException(400, "numbers must be a comma-separated list of integers")
    if not wanted:
        return {"available": True, "checks": {}}
    token = _resolve_repo_token(repo, cid)
    if not token:
        return _not_connected()
    try:
        raw_pulls = _cached_or_fetch_raw_pulls(cid, repo, token)
    except RuntimeError as exc:
        return {**_error_payload(exc), "repo": repo}
    sha_by_number = {}
    for p in raw_pulls:
        n = p.get("number")
        sha = (p.get("head") or {}).get("sha")
        if n in wanted and sha:
            sha_by_number[n] = sha

    def _rollup_for(number: int):
        sha = sha_by_number[number]
        cached = _cache_get(cid, "checks", number, sha)
        if cached is not None:
            return number, cached
        rollup = _checks_rollup(repo, sha, token)
        _cache_put(cid, "checks", rollup, number, sha)
        return number, rollup

    checks: dict = {}
    targets = list(sha_by_number)
    if targets:
        with concurrent.futures.ThreadPoolExecutor(
                max_workers=min(CHECKS_POOL_SIZE, len(targets))) as pool:
            for number, rollup in pool.map(_rollup_for, targets):
                checks[str(number)] = rollup
    return {"available": True, "checks": checks}


@app.get("/api/containers/{cid}/github/pulls/{number}")
def get_github_pull(cid: str, number: int, request: Request):
    """One PR's full detail — the PR detail page.

    Returns {available, repo, pull:{number,title,state,draft,body_markdown,author_login,
    base,head,updated_at,created_at,html_url,mergeable_state,assignees,requested_reviewers,
    checks:{passed,failing,pending,total,runs:[{name,status,conclusion,html_url}]},
    files:{count,items:[{filename,additions,deletions,status,patch,patch_omitted}]
    [,truncated][,patches_truncated]},comments_count,
    review_comments_count}}. body_markdown is RAW markdown (rendered client-side). Each
    file's `patch` is GitHub's raw unified-diff text (string) or null when omitted — either
    GitHub itself never sent one (binary/oversized single file, `patch_omitted:true`) or the
    summed patch text crossed PATCH_BUDGET_BYTES (~800KB; same per-file shape, plus
    `files.patches_truncated:true`) — see `_pr_files`'s docstring. Checks
    reuse the SHARED list-endpoint rollup helper (with per-run breakdown). `pull` also
    carries `tracked_task_id` (str | None, computed fresh every request — see
    _with_tracked_one), the SAME lookup the list rows and POST /start's idempotency
    check use, so the detail header's Start button can render "tracked" state up
    front instead of only after a click. A GitHub 404 for the number →
    {available:false, reason:"not_found"}; not-connected / rate-limited resolve to
    the same clean {available:false,...} shape (never a 5xx). GitHub-sourced fields
    cached 60s per (cid,'pull',number)."""
    with db_cursor() as (_, cur):
        repo = _load_binding(cur, cid, request)
    if not repo:
        return _not_connected()
    if repo == LOCAL_REPO:
        # Addendum 2 + local-binding/GitHub-origin fall-through — see the identical
        # comment on list_github_issues above for the full rationale.
        fallthrough_repo = _local_fallthrough_repo(cid)
        if not fallthrough_repo:
            return _local_source_unavailable(local_git.origin_repo())
        repo = fallthrough_repo
    cached = _cache_get(cid, "pull", number)
    if cached is not None:
        return {**cached, "pull": _with_tracked_one(cid, number, cached["pull"])}
    token = _resolve_repo_token(repo, cid)
    if not token:
        return _not_connected()
    try:
        raw = _gh_get(f"/repos/{repo}/pulls/{number}", token)
    except RuntimeError as exc:
        return {**_detail_error_payload(exc), "repo": repo}
    payload = {"available": True, "repo": repo, "pull": _pull_detail(repo, raw, token)}
    _cache_put(cid, "pull", payload, number)
    return {**payload, "pull": _with_tracked_one(cid, number, payload["pull"])}


@app.get("/api/containers/{cid}/github/issues/{number}")
def get_github_issue(cid: str, number: int, request: Request):
    """One issue's full detail — the issue detail page.

    Returns {available, repo, issue:{number,title,state,body_markdown,author_login,labels,
    assignee,assignees,updated_at,created_at,html_url,comments_count,
    comments:[{author_login,body_markdown,created_at}],tracked_task_id}}. `comments` is
    the most-recent 20, oldest-first. body_markdown is RAW markdown (rendered
    client-side). `tracked_task_id` (str | None, computed fresh every request) is the
    SAME shared lookup the pulls detail route and POST /start's idempotency check use
    (task_start_core.find_open_gh_tasks) — see _with_tracked_one's docstring. A GitHub
    404 → {available:false, reason:"not_found"}; not-connected / rate-limited resolve
    to the same clean shape. GitHub-sourced fields cached 60s per (cid,'issue',number)."""
    with db_cursor() as (_, cur):
        repo = _load_binding(cur, cid, request)
    if not repo:
        return _not_connected()
    if repo == LOCAL_REPO:
        # Addendum 2 + local-binding/GitHub-origin fall-through — see the identical
        # comment on list_github_issues above for the full rationale.
        fallthrough_repo = _local_fallthrough_repo(cid)
        if not fallthrough_repo:
            return _local_source_unavailable(local_git.origin_repo())
        repo = fallthrough_repo
    cached = _cache_get(cid, "issue", number)
    if cached is not None:
        return {**cached, "issue": _with_tracked_one(cid, number, cached["issue"])}
    token = _resolve_repo_token(repo, cid)
    if not token:
        return _not_connected()
    try:
        raw = _gh_get(f"/repos/{repo}/issues/{number}", token)
    except RuntimeError as exc:
        return {**_detail_error_payload(exc), "repo": repo}
    payload = {"available": True, "repo": repo, "issue": _issue_detail(repo, raw, token)}
    _cache_put(cid, "issue", payload, number)
    return {**payload, "issue": _with_tracked_one(cid, number, payload["issue"])}


@app.post("/api/containers/{cid}/github/start", status_code=201)
def start_from_github(cid: str, body: GithubStartBody, request: Request):
    """Turn a GitHub issue/PR into an Orcha task (the [Start →] / PR [Fix →] button).

    Reuses the SAME start internals the Slack seam uses (task_start_core) — one source
    of truth. Grant model MIRRORS task creation exactly: the trusted proxy login IS the
    creator (trusted_actor: 403 non-member, viewer refused); trust-off keeps the
    permissive body-actor convention. Idempotent: an OPEN task already tracking `GH #N:`
    for this number is returned with {existing:true}. Optional assignee_agent_id assigns
    a live AI agent so the wake machinery fires; bare start = an unassigned 'ready' task.

    PR dispatch (kind="pull") is CONTEXT-AWARE (founder decision): before creating the
    task, this re-fetches the PR's live state from GitHub (_pull_fix_context — one PR +
    one checks-rollup call, NOT the full detail/files fetch) and composes the DoD from
    what's ACTUALLY outstanding right now (failing checks by name, pending count, review
    -comment count, draft/mergeable_state) via _fix_description — never the frontend
    -supplied fields, which the server already doesn't trust for identity either. If the
    idempotency check finds an already-open GH task for this number, existing:true short
    -circuits BEFORE this fetch ever happens (no wasted GitHub call on a re-click). If
    the live re-fetch itself fails (rate limit, repo unreachable), the dispatch degrades
    to the static generic DoD (dod_override stays None) rather than failing the whole
    Start click over a context-enrichment nicety — a dispatched task with the generic DoD
    beats no task at all.

    Title/body_excerpt/html_url are ALSO authoritatively live-fetched here
    (`_fetch_gh_item`, shared with the Slack seam), for BOTH kinds, before every fresh
    start — a production defect fix: the hub's OWN frontend (`postStart` in
    static/pages/github-render.js) never actually sends these fields in its POST body
    despite this schema's docstring assuming it does, so a client-supplied `body.title`
    was silently empty on every real hub-started task, landing as a bare `GH #<N>:`
    with nothing after. The client-supplied fields are now used ONLY as the fallback
    when the live fetch itself fails (repo not bound, no token, GitHub
    unreachable/rate-limited) — never as the primary source, mirroring the same
    fail-open-to-a-degraded-but-real-title contract task_start_core.start_task_from_github
    already has for a title-fetch failure. Skipped on an `existing:true` idempotency
    hit (no wasted GitHub call re-rendering a task that already exists).
    Returns {task_id, existing}.
    """
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        require_container(cur, cid)
        # Same identity/grant gate task creation requires today: the trusted login IS the
        # creator (non-member 403, viewer write-banned); trust-off passes the body actor
        # through unchanged (the self-host convention).
        created_by = trusted_actor(cur, request, cid, body.created_by_agent_id)

        assignee_id = None
        if body.assignee_agent_id:
            if not valid_uuid(body.assignee_agent_id):
                raise HTTPException(400, "assignee_agent_id is not a valid UUID")
            cur.execute(
                "SELECT kind, container_id, terminated_at FROM agents WHERE id=%s",
                (body.assignee_agent_id,),
            )
            a = cur.fetchone()
            if not a:
                raise HTTPException(404, f"agent {body.assignee_agent_id} not found")
            if str(a["container_id"]) != cid:
                raise HTTPException(409, "assignee is not in this container")
            if a["terminated_at"] is not None:
                raise HTTPException(409, "assignee is retired and cannot be assigned work")
            if a["kind"] != "ai":
                raise HTTPException(409, "can only assign GitHub work to AI agents")
            assignee_id = body.assignee_agent_id

        gh_title, body_excerpt, html_url = body.title or "", body.body_excerpt or "", body.html_url or ""
        dod_override = None
        if not find_open_gh_task(cur, cid, body.number):
            # Authoritative title/body/url — see this function's docstring. Fetched for
            # BOTH kinds; the client-supplied body.* fields above are the fallback,
            # used only if this fetch itself fails.
            gh_item = _fetch_gh_item(cur, cid, body.kind, body.number)
            if gh_item:
                gh_title = gh_item["title"] or gh_title
                body_excerpt = gh_item["body_excerpt"] or body_excerpt
                html_url = gh_item["html_url"] or html_url

            if body.kind == "pull":
                cur.execute("SELECT github_repo FROM containers WHERE id=%s", (cid,))
                repo = cur.fetchone()["github_repo"]
                token = _resolve_repo_token(repo, cid) if repo else None
                if token:
                    try:
                        ctx = _pull_fix_context(repo, body.number, token)
                        dod_override = _fix_description(**ctx)
                    except RuntimeError:
                        pass   # live re-fetch failed — degrade to the generic static DoD

        result = start_task_from_github(
            cur,
            cid,
            kind=body.kind,
            number=body.number,
            gh_title=gh_title,
            body_excerpt=body_excerpt,
            html_url=html_url,
            created_by_agent_id=created_by,
            assignee_agent_id=assignee_id,
            dod_override=dod_override,
            source="github_hub",
        )
        conn.commit()
    # A newly-tracked item's issue/PR state may change (assignee, etc.); drop the cache
    # so the next poll reflects it. Cheap and outside the transaction.
    _cache_invalidate(cid)
    return result
