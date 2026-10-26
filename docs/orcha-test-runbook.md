# Orcha test runbook

How to run the Orcha test suite locally and read its signal. This codifies the
`.venv-test` + "N passed" convention that was previously memory-only.

All paths are repo-relative. Run everything from the repo root.

---

## 1. Prereqs — none for the default suite

A bare `pytest` needs **no Postgres and no Docker**: `tests/conftest.py` creates a
temporary SQLite file per session, points the app at it *before* importing `main`, and
deletes it afterwards. It never touches a project's `.orcha/orcha.db`.

### Optional: the Postgres leg (until the cleanup release)

While `portal_backend/sql.py` still carries both dialects (removed in GH #258 plan PR 20),
PRs that touch SQL also run the suite on Postgres. Set `ORCHA_TEST_BACKEND=postgres` plus:

| Var | Default | Purpose |
|-----|---------|---------|
| `ORCHA_TEST_ADMIN_URL` | `postgresql://orcha:orcha@localhost:5432/postgres` | admin conn used to `DROP/CREATE` the test DB |
| `ORCHA_TEST_DB_NAME` | `orcha_test` | name of the throwaway test DB (isolated; never `orcha`); use a unique name per worktree |
| `ORCHA_TEST_DATABASE_URL` | `postgresql://orcha:orcha@localhost:5432/<ORCHA_TEST_DB_NAME>` | the test DB the app runs against |

Any reachable Postgres works — e.g. a legacy Docker project's Postgres
(`db_port` in its `.claude/orcha.json`), or a throwaway one:

```bash
docker run --rm -d --name orcha-test-pg -p 5432:5432 \
  -e POSTGRES_USER=orcha -e POSTGRES_PASSWORD=orcha postgres:16
```

conftest creates/drops only the separate test DB; it never mutates `orcha`.

> Note: the self-hosted CI runner uses its own docker-run Postgres on `:55432` — that's a
> CI-only port, not something you set locally.

**Adding a migration while both dialects ship:** write the Postgres file
`templates/migrations/NNN_x.sql` and its SQLite twin `templates/migrations/sqlite/00M_x.sql`.
The twin must end by stamping both names
(`INSERT OR IGNORE INTO schema_migrations (version) VALUES ('00M_x.sql'), ('NNN_x.sql');`):
`test_schema_parity.py` applies the files directly and expects every file's own row, and
`pg_to_sqlite` excuses the SQLite file names when it compares a Postgres DB's history to the
CLI's. The three failures that teach this are all Postgres-leg only, so run that leg.

---

## 2. Build `.venv-test`

```bash
python3.11 -m venv .venv-test
source .venv-test/bin/activate
pip install -r tests/requirements.txt
```

`tests/requirements.txt` already carries the app deps the unit suite imports (`fastapi`,
`pydantic`) plus the test tooling (`pytest`, `pytest-asyncio`, `httpx`, and `psycopg[binary]` for the Postgres leg until plan PR 20).

**For the smoke gate (`pytest -m smoke`), also install `uvicorn`** — the end-to-end test
boots a real uvicorn server (`tests/test_e2e_terminal_smoke.py:62-68`) and it is **not** in
`tests/requirements.txt`:

```bash
pip install "uvicorn[standard]"
```

---

## 3. Run the suite

```bash
pytest
```

`pytest.ini` sets `asyncio_mode=auto`, `testpaths=tests`, `-q`, so a bare `pytest` runs the
whole unit suite against a temp SQLite file (or the Postgres test DB with
`ORCHA_TEST_BACKEND=postgres`). PRs that touch SQL report the `N passed` count for **both** legs.

### Smoke gate — the one real-seam merge gate

```bash
pytest -m smoke
```

`tests/test_e2e_terminal_smoke.py` (`pytestmark = pytest.mark.smoke`, line 46; marker
registered in `tests/conftest.py:234`) is the heavier end-to-end gate: it routes a **real**
uvicorn server + a **real** git repo (so the production isolated-worktree path actually runs)
+ a **real** PTY `orcha use`, and stubs only the unrunnable `claude` leaf via the
`ORCHA_LIVE_EXEC` seam. Treat a green `pytest -m smoke` as the required pre-merge signal for
any change that touches the live-terminal / worktree-overlay seam.

---

## 4. Accepted-red baseline

There is **one** known-red test on a clean checkout:

- `tests/test_terminal_bridge.py:619` — `test_ensure_bridge_restart_stops_old_first`

A run that is green **except for that single test** is the expected local baseline. **Any
other red is a real regression** — investigate before opening/approving a PR.

---

## 5. The signal rule — local "N passed" in every PR body

Report the local `pytest` result verbatim (e.g. `738 passed, 1 failed` with the failure being
the accepted-red above) in **every PR body**.

Since the repo is public, CI runs on **GitHub-hosted `ubuntu-latest` runners** (free + unlimited
for public repos) — so CI is authoritative, not advisory. Still report the local `pytest` result
in the PR body. Note that a few macOS-only tests (e.g. notifier daemon process-vetting, which
relies on macOS `ps` semantics) are `skipif`-guarded to skip on Linux CI; they still run locally
on a Mac, which is where that code actually runs in production.

---

## 6. Test teeth — mutation-check convention

A new or changed test must have **teeth**: it must go **RED when the fix it guards is reverted**.
A test that stays green after you undo the fix is proving nothing.

The pattern used across the suite (see the smoke test): **route real collaborators, stub only
the leaf that genuinely cannot run** (the `claude` binary, via `ORCHA_LIVE_EXEC`). Before
relying on a test, revert the production change and confirm the test fails; then restore.

---

## 7. Task verification gates

This is structural, not a convention you can opt out of:

- With task autonomy `off`, `POST /api/tasks/{tid}/done` moves work to
  **`needs_verification`** for a person to accept.
- With task autonomy `on`, the assigned agent may approve and complete only its own exact current
  work revision after the task and workflow guards pass. The immutable approval records the task
  requirements, submission, autonomy revision, actor and time.
- Only a **human** can `POST /api/tasks/{tid}/verify` — the route calls
  the human identity guard before approving autonomy-off work.
- Only the verified human workflow owner can use workflow Finish, regardless of task autonomy.

**Task-autonomy rule.** Project-wide Plan-only, Build-to-PR and Full authority are retired. Every
new task starts `off`. Only the human project owner may switch an individual task `on`, which lets
its assigned agent approve that task's exact plan and exact finished-work revision. The switch does
not authorize a pull-request merge and never bypasses workflow admission, dependencies, holds,
stop/cancellation rules, evidence review, or the human-only workflow Finish action. Existing
project and per-agent values are compatibility history only.

## 8. Back up and restore a native project's database (GH #258 S7)

A native project (no Docker) keeps structured data in `.orcha/orcha.db` and file evidence in
`.claude/.orcha-attachments`.

- `orcha backup` creates a verified database-and-attachments set while Orcha keeps running:
  `.db`, `.db.attachments`, and `.db.manifest.json`. SQLite uses `VACUUM INTO`; immutable evidence
  files and their hashes are captured before the database handle is published. The newest 10 sets
  are kept (`--keep N`); `--out PATH` writes one set anywhere instead.
- `orcha restore <file>` needs Orcha stopped (`orcha down`), checks the backup, keeps
  the database and attachments it replaces as `*.before-restore-<UTC time>`, restores the pair,
  and audits every current or accepted evidence hash. A legacy database-only restore is allowed,
  but missing files are durably reported as `missing_after_restore` and acceptance remains blocked.
- Both take `--json` (one JSON object) for the desktop app.

Docker projects keep using `pg_dump`/`pg_restore` until they move with
`orcha migrate-runtime`.
