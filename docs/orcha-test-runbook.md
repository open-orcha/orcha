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

## 7. The verification gate (never self-certify)

This is structural, not a convention you can opt out of:

- An agent can only call `POST /api/tasks/{tid}/done`, which moves a task to
  **`needs_verification`** (`main.py:3168`) — never to `completed`.
- Only a **human** can `POST /api/tasks/{tid}/verify` — the route calls
  `_require_kind(..., ("human",))` (`main.py` verify handler) before approving.

So an agent cannot self-certify its own work into `completed`. Stop at `needs_verification`
and let a human verify.

**#298 exception — the autonomy slider.** The above is the behavior at autonomy levels `plan`
(default) and `pr`. A human can move a container to `full` via `POST /api/containers/{cid}/autonomy`
(human-gated); at `full`, `/done` AUTO-COMPLETES the task (no `needs_verification`) via the SAME
`_complete_and_unblock` path `/verify` uses. The completion gate is the ONE engine-enforced part
of the slider; the `gh pr create` / `gh pr merge` rules are loosely-hardened agent behaviors keyed
off `autonomy_level` (see `docs/orcha-project-preferences.md`). So "an agent cannot self-certify"
holds at `plan`/`pr` — at `full` the human has explicitly delegated completion via the slider.

## 8. Back up and restore a native project's database (GH #258 S7)

A native project (no Docker) keeps everything in one SQLite file, `.orcha/orcha.db`.

- `orcha backup` copies it to `.orcha/backups/orcha-<UTC time>.db` while Orcha keeps
  running (SQLite `VACUUM INTO`: one consistent snapshot, integrity-checked) and keeps
  the newest 10 (`--keep N`). `--out PATH` writes a single copy anywhere instead.
- `orcha restore <file>` needs Orcha stopped (`orcha down`), checks the backup, keeps
  the database it replaces as `.orcha/orcha.db.before-restore-<UTC time>`, then puts
  the backup in place; `orcha up` starts Orcha on it.
- Both take `--json` (one JSON object) for the desktop app.

Docker projects keep using `pg_dump`/`pg_restore` until they move with
`orcha migrate-runtime`.
