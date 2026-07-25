"""Serve compatibility snapshots and static dashboard pages."""

from fastapi.responses import HTMLResponse

from portal_backend.application import app
from portal_backend.container_snapshot_routes import get_container
from portal_backend.static_pages import serve_page


@app.get("/api/snapshot/{cid}")
def snapshot(cid: str):
    return get_container(cid)


@app.get("/", response_class=HTMLResponse)
def home():
    return serve_page("home.html")


@app.get("/settings", response_class=HTMLResponse)
def settings_page():
    """#294 Settings page — Anthropic API-key surface (+ future model selection).

    Same pure client-side pattern as the other page routes: serves the static
    shell, which loads the D0 assets + settings.js. The page resolves the
    container (OrchaData.resolveCid) and reads/writes the key via the existing
    /api/containers/{cid}/settings/llm-key routes (GET/PUT/DELETE + .../test) —
    no new API/DB route added here (those belong to the #294 backend PR).
    """
    return serve_page("settings.html")


@app.get("/agents", response_class=HTMLResponse)
def agents_page():
    """Per-agent detail view (owned by agent "C").

    Pure client-side: reads ?cid= (+ optional ?agent=alias) from the URL, fetches
    the same /api/containers/{cid} snapshot the home page uses, and renders a
    roster + a detail panel (current task in detail, every task the agent is on,
    and the agent's incoming + outgoing requests). No new API surface.
    """
    return serve_page("agents.html")


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
    return serve_page("requests.html")


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
    return serve_page("tasks.html")
