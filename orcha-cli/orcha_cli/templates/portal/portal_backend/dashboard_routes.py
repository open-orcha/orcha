"""Serve compatibility snapshots and the React SPA shell for page routes."""

from fastapi import Request
from fastapi.responses import HTMLResponse

from portal_backend.application import app
from portal_backend.container_snapshot_routes import get_container
from portal_backend.static_pages import serve_page


@app.get("/api/snapshot/{cid}")
def snapshot(cid: str, request: Request):
    return get_container(cid, request)


# Every page route serves the same built SPA shell (static/dist/index.html);
# BrowserRouter owns which page renders, so the classic clean URLs
# (/tasks?task=..., /agents?agent=...) keep working unchanged
# (docs/orcha-portal-react-migration-plan.md Phase 7).


@app.get("/", response_class=HTMLResponse)
def home():
    return serve_page("dist/index.html")  # React SPA shell (open-orcha base; cloud pages via src/extensions.ts)


@app.get("/projects", response_class=HTMLResponse)
def projects_page():
    """The post-login PROJECTS landing (access model): a grid of the signed-in
    user's projects, one card each — name, repo chip, agents/tasks counts, a
    needs-you badge, member preview (roster-privacy aware), Open + per-project
    phone pairing. Pure client-side like every page: reads GET /api/containers
    (already membership-filtered under the trusted lane) and renders. The home
    page's boot redirects a bare "/" here whenever the stack isn't the
    single-project case; in-project links carry ?cid= and never bounce."""
    return serve_page("dist/index.html")  # React SPA shell (open-orcha base; cloud pages via src/extensions.ts)


@app.get("/settings", response_class=HTMLResponse)
def settings_page():
    """#294 Settings page — Anthropic API-key surface (+ future model selection).

    Same pure client-side pattern as the other page routes: serves the static
    shell, which loads the D0 assets + settings.js. The page resolves the
    container (OrchaData.resolveCid) and reads/writes the key via the existing
    /api/containers/{cid}/settings/llm-key routes (GET/PUT/DELETE + .../test) —
    no new API/DB route added here (those belong to the #294 backend PR).
    """
    return serve_page("dist/index.html")  # React SPA shell (open-orcha base; cloud pages via src/extensions.ts)


@app.get("/agents", response_class=HTMLResponse)
def agents_page():
    """Per-agent detail view (owned by agent "C").

    Pure client-side: reads ?cid= (+ optional ?agent=alias) from the URL, fetches
    the same /api/containers/{cid} snapshot the home page uses, and renders a
    roster + a detail panel (current task in detail, every task the agent is on,
    and the agent's incoming + outgoing requests). No new API surface.
    """
    return serve_page("dist/index.html")  # React SPA shell (open-orcha base; cloud pages via src/extensions.ts)


@app.get("/requests", response_class=HTMLResponse)
def requests_page():
    """Per-request detail view (owned by agent "E").

    Pure client-side, same pattern as /agents: reads ?cid= (+ optional ?req=id)
    from the URL, fetches the shared /api/containers/{cid} snapshot, and renders a
    request roster + a detail panel for one request — its lifecycle in detail
    (open / answered / closed / escalated / rejected), who started it and who it's
    for, how long it took to address, and its place in a request chain (parent
    request with a live link, plus any children asked in service of it). No new
    API surface — everything derives from requests[] joined to agents[] by id.
    """
    return serve_page("dist/index.html")  # React SPA shell (open-orcha base; cloud pages via src/extensions.ts)


@app.get("/code", response_class=HTMLResponse)
def code_space_page():
    """Orcha Code Space (docs/orcha-code-space-design.md): line-anchored
    threads + live edit view + symbols over the GitHub-backed repo. SPA shell."""
    return serve_page("dist/index.html")  # React SPA shell (open-orcha base; cloud pages via src/extensions.ts)


@app.get("/metrics", response_class=HTMLResponse)
def metrics_page():
    """Usage/cost visibility per agent — stat cards, per-agent cost table, daily bars.

    Pure client-side, same pattern as the other pages: serves the static shell,
    which loads the D0 assets + pages/metrics-*.js. The page resolves the container
    (OrchaData) and reads GET /api/containers/{cid}/metrics?days=7|30 — the one
    aggregate endpoint added for this page (container_metrics_routes).
    """
    return serve_page("dist/index.html")  # React SPA shell (open-orcha base; cloud pages via src/extensions.ts)


@app.get("/github", response_class=HTMLResponse)
def github_hub_page():
    """GitHub hub — open issues/PRs on the container's connected repo, with a
    Start action that spins up an Orcha task from either (Conductor-style list:
    number, title, reviewers, checks/merge chips, updated, Start + assignee).

    Pure client-side, same pattern as the other pages: serves the static shell,
    which loads the D0 assets + pages/github-*.js. The page resolves the
    container (OrchaData) then reads GET /api/containers/{cid}/github/issues and
    .../pulls (github_hub_routes.py) — new endpoints added alongside this page,
    not part of the shared container snapshot. No business logic here.
    """
    return serve_page("dist/index.html")  # React SPA shell (open-orcha base; cloud pages via src/extensions.ts)


@app.get("/members", response_class=HTMLResponse)
def members_page():
    """Members management (React /members — formerly the settings-members card).
    Serves the SPA shell like every page route."""
    return serve_page("dist/index.html")  # React SPA shell (open-orcha base; cloud pages via src/extensions.ts)


@app.get("/tasks", response_class=HTMLResponse)
def tasks_page():
    """Per-task detail view (owned by agent "D").

    Pure client-side, same pattern as /agents and /requests: reads ?cid= (+
    optional ?task=id) from the URL, fetches the shared /api/containers/{cid}
    snapshot, and renders a task roster + a detail panel for one task — its
    status in detail, the agents performing it (joined from assignees[]), when
    it started, and a live-ticking "running for" duration, plus DoD, description,
    result, who created it, and the request that spawned it (if any). No new API
    surface — everything derives from tasks[] joined to agents[] by alias/id.
    """
    return serve_page("dist/index.html")  # React SPA shell (open-orcha base; cloud pages via src/extensions.ts)
