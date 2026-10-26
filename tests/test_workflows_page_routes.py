"""Workflows page routes serve the SPA shell on a fresh load or pasted link.

BrowserRouter owns /workflows, /workflows/new and /workflows/:workflowId, so the
backend must serve the same shell as every other page route, otherwise a hard
reload 404s. Page routes carry no data; the screens read the Workflows API,
which stays disabled until integration.
"""
import pathlib
import re

import pytest

pytestmark = pytest.mark.asyncio

REPO = pathlib.Path(__file__).resolve().parent.parent
ROUTES = REPO / "orcha-cli/orcha_cli/templates/portal/portal_backend/dashboard_routes.py"


@pytest.mark.parametrize(
    "path",
    [
        "/workflows",
        "/workflows/new",
        "/workflows/7b0c1d9e-3f42-4a51-9a5e-1c2d3e4f5a6b",
        "/workflows/7b0c1d9e-3f42-4a51-9a5e-1c2d3e4f5a6b?cid=abc&task=def",
    ],
)
async def test_workflow_page_routes_serve_the_spa_shell(client, path):
    r = await client.get(path)
    assert r.status_code == 200, (path, r.status_code, r.text[:200])
    assert "text/html" in r.headers.get("content-type", "")
    assert 'id="root"' in r.text, f"{path} does not serve the SPA mount point"


async def test_workflow_page_routes_do_not_shadow_the_api(client):
    # The page route is HTML only; the JSON API path is separate and still answers.
    r = await client.get("/api/workflows/7b0c1d9e-3f42-4a51-9a5e-1c2d3e4f5a6b")
    assert "text/html" not in r.headers.get("content-type", "")


def test_workflow_page_routes_are_plain_shell_routes():
    src = ROUTES.read_text()
    for path, args in [
        ("/workflows", ""),
        ("/workflows/new", ""),
        ("/workflows/{workflow_id}", "workflow_id: str"),
    ]:
        pattern = (
            r'@app\.get\("%s", response_class=HTMLResponse\)\ndef (\w+)\(%s\):\n'
            r'(?:    """[\s\S]*?"""\n)?    return serve_page\("dist/index\.html"\)'
        ) % (re.escape(path), re.escape(args))
        assert re.search(pattern, src), f"{path} must only serve the SPA shell"
