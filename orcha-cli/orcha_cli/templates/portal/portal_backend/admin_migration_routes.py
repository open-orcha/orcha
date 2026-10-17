"""Read-only migration ledger: the input to the native `orcha upgrade` DB-tip guard.

GH #258 plan Part 5 R-D1. Under the native runtime the portal code is the CLI's own package, so
the old template-tip downgrade guard becomes a DB-tip guard: the CLI compares its packaged
migration tip with the highest version recorded in this database. Sits next to
`POST /api/admin/migrate` (application_lifecycle.py).
"""

import re

from pydantic import BaseModel

from portal_backend import sql
from portal_backend.application import app
from portal_backend.database import db_cursor

_VERSION = re.compile(r"^(\d+)_.*\.sql$")


class MigrationsResponse(BaseModel):
    applied: list[str]
    count: int
    tip: int


def migration_tip(versions) -> int:
    """Highest NNN among recorded `NNN_*.sql` versions (0 when none)."""
    return max((int(m.group(1)) for v in versions if (m := _VERSION.match(v))), default=0)


@app.get("/api/admin/migrations", response_model=MigrationsResponse)
def admin_migrations():
    """List the recorded migrations and their tip (an un-migrated database lists none)."""
    try:
        with db_cursor() as (_, cur):
            cur.execute("SELECT version FROM schema_migrations ORDER BY version")
            versions = [row["version"] for row in cur.fetchall()]
    except Exception as error:
        if not sql.is_undefined_table(error):
            raise
        versions = []
    return {"applied": versions, "count": len(versions), "tip": migration_tip(versions)}
