"""#140 — portal 'ghost agent' after a workspace reset (infra half).

After `orcha init --force` / container reset, the portal could still render an agent
that no longer exists in the DB until a HARD refresh. One of the three named
contributors is the **browser HTTP cache**: the portal HTML shells and the live
`/api/*` JSON carried no cache headers, so a soft refresh could serve a stale cached
onboarding screen / roster instead of re-fetching live state.

Forge's infra fix: a single `@app.middleware("http")` stamps `Cache-Control: no-store`
on the dynamic surface (HTML page shells + every `/api/*` response, incl. SSE), while
URL-versioned `/assets/*` stay cacheable. These tests give that fix teeth — and a
mutation check (revert the middleware → the HTML/API assertions go red, the asset one
stays green) so it can't silently rot.

(Clearing the SPA's own client state on reset remains frontend-owned — not asserted here.)
"""
import pytest

pytestmark = pytest.mark.asyncio


async def test_html_shells_are_no_store(client):
    """Every portal page shell must be no-store so a soft refresh re-fetches live state."""
    for path in ("/", "/onboarding", "/agents", "/requests", "/tasks"):
        r = await client.get(path)
        assert r.status_code == 200, f"{path}: {r.status_code} {r.text[:200]}"
        assert "text/html" in r.headers.get("content-type", ""), path
        assert r.headers.get("cache-control") == "no-store", \
            f"{path} must be no-store, got {r.headers.get('cache-control')!r}"


async def test_api_snapshot_is_no_store(client, container):
    """The live container snapshot (the SPA's source of truth on reload) must not be
    served from the HTTP cache — that is exactly how a deleted agent 'ghosts'."""
    cid = container["id"]
    r = await client.get(f"/api/containers/{cid}")
    assert r.status_code == 200, r.text
    assert r.headers.get("cache-control") == "no-store", \
        f"container snapshot must be no-store, got {r.headers.get('cache-control')!r}"


async def test_assets_stay_cacheable(client):
    """Scope guard: URL-versioned static assets are NOT forced no-store (asset staleness
    is a separate, restart-driven concern). If this goes red, the middleware is too broad."""
    r = await client.get("/assets/styles.css")
    assert r.status_code == 200, r.text
    assert r.headers.get("cache-control") != "no-store", \
        "static assets must remain cacheable — middleware scope is too broad"


async def test_middleware_is_the_mechanism():
    """Mutation anchor: the no-store behaviour comes from the documented middleware, not
    an accidental default. If the middleware is removed, the HTML/API tests above fail."""
    import pathlib
    main_py = (pathlib.Path(__file__).resolve().parent.parent
               / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "main.py").read_text()
    assert '_no_store_dynamic_responses' in main_py
    assert 'Cache-Control' in main_py and 'no-store' in main_py
