# Orcha — working agreements (loaded every session)

## Swagger / OpenAPI is the source of truth for the API
The API contract's single source of truth is the **Swagger / OpenAPI** surface FastAPI
generates from the route declarations and Pydantic models — interactive docs at `/docs`,
raw spec at `/openapi.json`. Reviewers verify routes, request/response bodies, and any DB
shape that surfaces through the API **against `/openapi.json`**; the spec is generated from
the code, so it cannot drift the way a hand-maintained artifact can.
- This **retires** (2026-06-12) the former Postman-lockstep mandate — the hand-maintained
  `docs/orcha.postman_collection.json`, its `FT-DEPLOY-4` parity guard, and
  `tests/check_postman_parity.py`. The collection JSON, if still present, is a frozen
  artifact, not a contract.
- Full review discipline (PR-open conventions, state machine, chain): `docs/orcha-review-protocol.md`.

## Other standing rules
- Never self-certify: agent work stops at `needs_verification`; a human verifies.
- Relaunch with `orcha up` — never `orcha init --force` (new container) or `orcha down -v` (DB wipe).
- Roadmap/findings: `docs/orcha-roadmap-and-findings.md`. Pivot plan/tasks (v1):
  `docs/orcha-portal-pivot-{plan,tasks}.md`. Running issues: `docs/orcha-issues-log.md`.
  Post-v1 deferred backlog: `docs/orcha-postv1-plan-and-tasks.md`.
  **Live status board: `docs/orcha-status-board.md`** (maintained locally: 🟠 on dispatch, ✅ on verify, 🔴 at risk).

## Running tests
- See `docs/orcha-test-runbook.md` for the local `.venv-test` command and known pre-existing failures.
