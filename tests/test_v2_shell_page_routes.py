"""Orcha V2 (Agent B) — direct-entry page routes for the new addressable views.

docs/orcha-v2-architecture.md §2.1: /needs (Needs you queue) and /activity
(runs/events) are BrowserRouter URLs, so a hard reload / pasted link must be
served the SPA shell by an explicit FastAPI page route — otherwise it 404s.
Additive only: same serve_page("dist/index.html") pattern, no new API/data.
Also pins that every pre-V2 page route keeps serving the shell (R-01…R-12) and
that the Vite dev server's PAGE_ROUTES list mirrors the backend (GAP-09).
"""
import pathlib
import re

import pytest

pytestmark = pytest.mark.asyncio

REPO = pathlib.Path(__file__).resolve().parent.parent
PORTAL = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal"

V2_ROUTES = ["/needs", "/activity", "/org", "/routines"]  # /org: org chart (mig 052); /routines (mig 054)
LEGACY_ROUTES = ["/", "/projects", "/tasks", "/agents", "/requests", "/settings",
                 "/code", "/metrics", "/github", "/members"]


@pytest.mark.parametrize("path", V2_ROUTES + LEGACY_ROUTES)
async def test_page_route_serves_the_spa_shell(client, path):
    r = await client.get(path)
    assert r.status_code == 200, (path, r.status_code, r.text[:200])
    assert "text/html" in r.headers.get("content-type", "")
    assert 'id="root"' in r.text, f"{path} does not serve the SPA mount point"


async def test_v2_routes_keep_query_strings(client):
    # deep links carry scope + selection; the page route must not reject them
    r = await client.get("/needs?cid=00000000-0000-0000-0000-000000000000&item=verify:abc&scope=project")
    assert r.status_code == 200
    r = await client.get("/activity?agent=Atlas&state=running")
    assert r.status_code == 200


def test_v2_routes_are_additive_page_routes_only():
    src = (PORTAL / "portal_backend" / "dashboard_routes.py").read_text()
    for path in V2_ROUTES:
        m = re.search(r'@app\.get\("%s", response_class=HTMLResponse\)\ndef (\w+)\(\):\n(?:    """[\s\S]*?"""\n)?    return serve_page\("dist/index\.html"\)' % re.escape(path), src)
        assert m, f"{path} must be a plain SPA page route (serve_page only)"


def test_vite_dev_page_routes_mirror_the_backend():
    """GAP-09: `npm run dev` must serve the SPA at every backend page route."""
    cfg = (PORTAL / "frontend" / "vite.config.ts").read_text()
    m = re.search(r"PAGE_ROUTES = \[([\s\S]*?)\]", cfg)
    assert m, "vite.config.ts lost PAGE_ROUTES"
    dev = set(re.findall(r'"(/[^"]*)"', m.group(1)))
    for path in V2_ROUTES + LEGACY_ROUTES + ["/onboarding", "/auth/device"]:
        assert path in dev, f"vite dev PAGE_ROUTES missing {path}"
