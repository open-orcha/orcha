"""Configure validation responses and database migration lifecycle endpoints."""

import os
import time

from fastapi import HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from portal_backend.application import app
from portal_backend import database

_run_migrations_getter = None
_qa_sweeper_started = False


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
    errors = exc.errors()
    if '/job-monitors/' in request.url.path and request.url.path.endswith('/continuation-heartbeat'):
        errors = [{k:v for k,v in error.items() if k not in {'input','ctx'}} for error in errors]
    return JSONResponse(status_code=422, content={"detail": errors})


def start_local_index_warmer() -> None:
    """Background warm loop for the LOCAL code source's symbol index (Addendum 2).

    Every 4 minutes (inside the 10-min symbol/snapshot TTLs, so the index never goes
    cold between passes) rebuild any missing index for containers bound to the local
    working tree — including picking up NEW commits, since the state is keyed by the
    resolved HEAD sha. Daemon thread; each pass swallows its own failures. No-op forever
    on stacks without a local mount (thread exits after the first check)."""
    import threading

    def _loop() -> None:
        from portal_backend.code_space_routes import warm_local_symbol_index
        from portal_backend import local_git
        time.sleep(3)  # let migrations settle before the first pass
        if not local_git.available():
            return
        while True:
            warm_local_symbol_index()
            time.sleep(240)

    threading.Thread(target=_loop, name="local-index-warmer", daemon=True).start()


def start_qa_session_sweeper() -> None:
    """End QA sessions nobody is running even when no page is open to read them. Daemon thread;
    the sweep reads first and writes only when something ended, so a quiet portal never touches
    the database's write lock, and each pass swallows its own failures."""
    import threading

    global _qa_sweeper_started
    if _qa_sweeper_started:
        return  # a second startup in one process (the tests) needs no second sweeper
    _qa_sweeper_started = True

    def _loop() -> None:
        from portal_backend import qa_explorations

        time.sleep(3)  # let migrations settle before the first pass
        while True:
            try:
                qa_explorations.sweep_all()
            except Exception as error:  # noqa: BLE001 - e.g. a schema that failed to migrate
                print(f"[qa-sweep] {type(error).__name__}: {error}", flush=True)
            time.sleep(qa_explorations.SWEEPER_SECONDS)

    threading.Thread(target=_loop, name="qa-session-sweeper", daemon=True).start()


def startup_migrate() -> None:
    """Wait briefly for the database, then apply pending migrations at startup."""
    # SQLite is a file open, so three tries cover a slow mounted volume; Postgres keeps its
    # twenty while the transition switch exists (GH #258 S3 note 6).
    for _ in range(3 if database.BACKEND == "sqlite" else 20):
        try:
            database.ping()
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
