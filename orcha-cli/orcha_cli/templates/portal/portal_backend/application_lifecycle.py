"""Configure validation responses and database migration lifecycle endpoints."""

import os
import time

from fastapi import HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from portal_backend.application import app
from portal_backend import database

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


def start_verdikt_sweeper() -> None:
    """Background check for in-flight Verdikt runs + the auto-fix loop (mig 068).

    Results used to be polled only while someone viewed the task or a preview ran; this daemon
    thread refreshes every in-flight run every ORCHA_VERDIKT_SWEEP_SECONDS (default 12; 0 turns
    it off) and applies the auto-fix loop to finished ones, so a fail at 3am still sends the
    task back. Idle cost: one indexed count per pass. Idempotent with the notifier's
    POST /api/containers/{cid}/verdikt/sweep and any person's "Check now" (each finished run is
    judged exactly once). Each pass swallows its own failures."""
    import threading

    try:
        every = float(os.environ.get("ORCHA_VERDIKT_SWEEP_SECONDS", "12"))
    except ValueError:
        every = 12.0
    if every <= 0:
        return

    def _loop() -> None:
        from portal_backend import verdikt_autofix

        time.sleep(5)  # let migrations settle before the first pass
        while True:
            try:
                verdikt_autofix.sweep(None)
            except Exception:  # noqa: BLE001 — never let the thread die
                pass
            time.sleep(max(2.0, every))

    threading.Thread(target=_loop, name="verdikt-sweeper", daemon=True).start()


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
