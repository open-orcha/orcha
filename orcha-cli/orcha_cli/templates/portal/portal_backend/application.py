"""Create the FastAPI application and apply portal-wide response policy."""

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles

from portal_backend.static_pages import STATIC_DIR

app = FastAPI(title="Orcha API", version="0.6.0")

if STATIC_DIR.is_dir():
    app.mount(
        "/assets",
        StaticFiles(directory=str(STATIC_DIR), check_dir=False),
        name="assets",
    )


@app.middleware("http")
async def no_store_dynamic_responses(request: Request, call_next):
    """Prevent stale API and HTML state while leaving versioned assets cacheable.

    Unversioned stylesheets (/assets/styles.css + the /assets/styles/*.css it
    @imports) must REVALIDATE on every load: their URLs never change across
    releases, so a browser/Electron heuristic-cached copy from an older portal
    silently skins a newer dist — partial, baffling breakage (unstyled
    components whose classes postdate the cached CSS). `no-cache` keeps them
    cacheable but forces the cheap ETag 304 round-trip. The Vite bundle under
    dist/assets/ is content-hashed, so it stays on the default (cache-friendly)
    policy.
    """
    response = await call_next(request)
    content_type = response.headers.get("content-type", "")
    path = request.url.path
    if path.startswith("/api/") or content_type.startswith("text/html"):
        response.headers["Cache-Control"] = "no-store"
    elif (
        path.startswith("/assets/")
        and path.endswith(".css")
        and "/dist/" not in path
    ):
        response.headers["Cache-Control"] = "no-cache"
    return response
