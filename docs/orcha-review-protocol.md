# Orcha review protocol

This doc captures the review discipline that previously lived only in agent memory:
the PR-open conventions, the review state machine, the team review chain, and the
API source-of-truth rule. It is the durable reference; if a working agreement in
`CLAUDE.md` and this doc ever disagree, `CLAUDE.md` wins for the short rules and this
doc fills in the mechanics.

## 1. PR-open conventions

On **opening** any PR:

1. **Base `main`, stay OPEN.** Every PR bases on `main`. PRs are NEVER merged to `main`
   (or to any `auto_merged` branch) by an agent — they stay OPEN for Kedar. Agents do
   not self-merge.
2. **Title prefix `[Author]`.** Prefix the PR title with the authoring agent's alias in
   brackets, e.g. `[Lens] retire Postman lockstep → Swagger source of truth`. Set it via
   `gh api -X PATCH .../pulls/<#> -f title=...` (the combined `gh pr edit` path is
   unreliable in this environment).
3. **`NEEDS REVIEW` label.** Add it via
   `gh api -X POST .../issues/<#>/labels -f 'labels[]=NEEDS REVIEW'`.
4. **PR author = `kedar1607`.** Author all PRs as the GitHub user `kedar1607`
   (`gh auth switch --user kedar1607`; the human runs the auth).
5. **Report the local `N passed` count in the PR body.** CI here is billing-red and is
   **not** a signal. Run the local test suite (`.venv-test`) and report `N passed` in the
   PR body. See the test runbook — **`docs/orcha-test-runbook.md`** — for the exact
   command and the list of known pre-existing failures to exclude from the count.

## 2. Review state machine

```
NEEDS REVIEW  →  APPROVABLE  →  APPROVED (Kedar)  →  Needs Verification  →  completed
```

- **NEEDS REVIEW** — the label set on open; the PR is awaiting first-pass review.
- **APPROVABLE** — reviewers (Lens, then Gate) have done their passes and found nothing
  blocking. `APPROVABLE` is **terminal for agents** — it does not authorize a merge.
- **APPROVED** — only **Kedar** moves a PR to APPROVED.
- **Needs Verification** — on merge the task moves to `needs_verification`. **Never
  self-certify**: agent work stops at `needs_verification`; a **human** verifies.
- **completed** — a human runs `/orcha-verify`; verification may unblock downstream tasks.
  A reject (`/orcha-verify` with feedback) sends the task back to `in_progress`.

## 3. Team review chain

```
dev  →  Lens (Reviewer I)  →  Gate (Reviewer II)  →  Helm (lead)  →  Kedar
```

- **Lens** owns the **first pass**: design/plan soundness before any build, then on every
  PR the docs-accuracy + route↔schema review (see §4). Lens reads real source and cites
  `file:line`; Lens never rubber-stamps.
- **Gate** owns the **second pass**: code correctness + verification.
- Every hand-off **returns to Helm** first. **Nothing reaches Kedar except through Helm.**
- One task in progress per agent at a time.

### 3.1 Hand-offs go out as `task` requests, not `info` (GH #71)

Any real work hand-off — a code review, a sign-off, a docs write-up, a coding/implementation
hand-off — goes out as a **`task` request** (`/orcha-ask <target> "..." --task --task-dod "..."`),
so the target wakes on it as ready work and the task wake path fires. **`info` is reserved for a
quick knowledge question** the requester genuinely cannot answer themselves ("what port does the DB
use?").

Sending review/sign-off/docs/coding work as a plain `info` once caused a missed-wake incident, so
the server now **auto-promotes** an `info` request to a `task` when its payload clearly asks for
work (a curated work verb in imperative position, and not a question). Promoted requests are stamped
`detail.promoted_from_info=true` / `detail.matched_verb`. This is a backstop — reviewers and dispatchers
should still send work explicitly with `--task`; do not rely on the classifier.

## 4. API source of truth — Swagger / OpenAPI

The API contract's single source of truth is the live **Swagger / OpenAPI** surface that
FastAPI generates from the route declarations and Pydantic models:

- Interactive docs: **`/docs`**
- Raw spec: **`/openapi.json`**

Reviewers verify that routes, request bodies, response shapes, and any DB shape that
surfaces through the API are accurate **against `/openapi.json`** — the spec is generated
from the code, so it cannot drift from the routes the way a hand-maintained artifact can.

> **Historical note.** This replaces the former Postman-lockstep discipline, in which a
> hand-maintained `docs/orcha.postman_collection.json` had to be updated in lockstep with
> every route/DB change, guarded by `FT-DEPLOY-4` and `tests/check_postman_parity.py`.
> That mandate was **retired 2026-06-12** in favor of the generated Swagger/OpenAPI spec.
> The old Postman collection JSON, if still present, is a frozen artifact — not a contract.

## 5. Never self-certify

To restate the invariant that anchors the whole chain: an agent's work stops at
`needs_verification`. A **human** verifies. This holds for every task and every PR unless
a task's autonomy level explicitly permits otherwise (not yet encoded — human-gated for now).
