"""Create the FastAPI application and apply portal-wide response policy."""

from fastapi import FastAPI, Request
from fastapi.exception_handlers import http_exception_handler
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from portal_backend.static_pages import STATIC_DIR, serve_page

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


# VD-12: paths that must keep FastAPI's JSON 404 (API, assets, generated docs).
_JSON_404_PREFIXES = ("/api/", "/assets/", "/static/", "/docs", "/redoc", "/openapi.json")


@app.exception_handler(StarletteHTTPException)
async def spa_fallback_for_unknown_pages(request: Request, exc: StarletteHTTPException):
    """VD-12: a browser that opens an unknown PAGE URL (/does-not-exist, /tasks/abc) gets
    the SPA shell — whose router renders the app's own dark fallback — instead of raw
    `{"detail":"Not Found"}` JSON on a white page. Only a 404 for a GET that accepts
    text/html outside the API / asset / docs prefixes; everything else (every /api/
    404, a curl without Accept: text/html, raised HTTPExceptions of other codes) keeps
    the stock JSON response byte-for-byte. Status stays 404."""
    if (
        exc.status_code == 404
        and request.method in ("GET", "HEAD")
        and "text/html" in (request.headers.get("accept") or "")
        and not request.url.path.startswith(_JSON_404_PREFIXES)
    ):
        page = serve_page("dist/index.html")
        if page.status_code == 200:
            page.status_code = 404
            return page
    return await http_exception_handler(request, exc)
