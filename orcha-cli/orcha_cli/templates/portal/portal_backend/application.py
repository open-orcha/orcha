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
    return response
