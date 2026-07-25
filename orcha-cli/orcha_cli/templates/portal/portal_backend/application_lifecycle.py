"""Configure validation responses and database migration lifecycle endpoints."""

import os
import time

import psycopg
from fastapi import HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from portal_backend.application import app
from portal_backend.database import DB

_run_migrations_getter = None


def configure_compatibility(run_migrations_getter):
    """Bind the facade-owned migration helper retained for monkeypatching."""
    global _run_migrations_getter
    _run_migrations_getter = run_migrations_getter


@app.exception_handler(RequestValidationError)
async def too_long_or_invalid(request: Request, exc: RequestValidationError):
    """Return a concise 413 for length errors and preserve normal 422 responses."""
    for error in exc.errors():
        if error.get("type") == "string_too_long":
            field = error.get("loc", ["body", "?"])[-1]
            limit = (error.get("ctx") or {}).get("max_length")
            value = error.get("input")
            got = len(value) if isinstance(value, str) else None
            return JSONResponse(
                status_code=413,
                content={
                    "error": "body_too_long",
                    "field": str(field),
                    "limit": limit,
                    "got": got,
                    "detail": (
                        f"'{field}' is {got} characters but the limit is {limit}. "
                        "Split it into multiple posts/messages and try again."
                    ),
                },
            )
    return JSONResponse(status_code=422, content={"detail": exc.errors()})


def startup_migrate() -> None:
    """Wait briefly for Postgres, then apply pending migrations at startup."""
    for _ in range(20):
        try:
            with psycopg.connect(DB) as connection:
                connection.execute("SELECT 1")
            break
        except Exception:
            time.sleep(0.5)
    else:
        print(
            "[migrate] DB not reachable at startup; skipping (will retry next boot)",
            flush=True,
        )
        return
    try:
        applied = _run_migrations_getter()()
        print(
            f"[migrate] applied: {applied}"
            if applied
            else "[migrate] schema up to date",
            flush=True,
        )
    except Exception as error:
        if os.environ.get("ORCHA_MIGRATE_ON_FAILURE", "halt").lower() == "continue":
            print(
                "[migrate] ERROR "
                f"(ORCHA_MIGRATE_ON_FAILURE=continue — serving current schema): {error}",
                flush=True,
            )
            return
        print(
            f"[migrate] FATAL: {error} — aborting startup "
            "(set ORCHA_MIGRATE_ON_FAILURE=continue to serve anyway)",
            flush=True,
        )
        raise


@app.post("/api/admin/migrate", status_code=200)
def admin_migrate():
    """Apply pending migrations on demand (R1.3 — used by `orcha migrate`)."""
    try:
        applied = _run_migrations_getter()()
    except Exception as error:
        raise HTTPException(500, f"migration failed: {error}") from error
    return {"applied": applied, "count": len(applied)}
