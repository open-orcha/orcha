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
    """Prevent stale API and HTML state while leaving versioned assets cacheable."""
    response = await call_next(request)
    content_type = response.headers.get("content-type", "")
    if request.url.path.startswith("/api/") or content_type.startswith("text/html"):
        response.headers["Cache-Control"] = "no-store"
    elif request.url.path.startswith("/assets/fonts/"):
        # Seamless-nav review round 1, finding 6: the self-hosted woff2 files replaced
        # fonts.gstatic.com's `max-age=31536000, immutable` with a bare StaticFiles mount
        # (no Cache-Control at all), so every navigation on a freshly-installed portal
        # reissues a conditional GET per font — a visible FOUT on the PR whose whole point
        # is a seamless navigation. These filenames are pinned (not content-hashed), so an
        # upgrade that changes a font's bytes MUST ship under a new filename or clients that
        # cached the old immutable response would keep serving stale bytes indefinitely.
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return response
