# Jira integration — design doc (not built)

A design for connecting Jira to Orcha the same way the GitHub hub and the Slack seam
connect their systems: Jira **triggers** Orcha work and **observes** it back, while the
verification and merge gates stay in Orcha. This document is design only — no code ships
with it. It exists so the eventual build has a settled contract and a phased scope.

## The one rule (UX integration principles — Slack + Jira + GitHub)

All three integrations obey a single rule:

> **External systems TRIGGER and OBSERVE Orcha; the verification and merge gates stay in
> Orcha only.**

- **Trigger**: an external event (a labelled Jira issue, a Slack slash command, a
  GitHub-hub Start click) *creates* an Orcha task. Nothing more. The task then flows
  through Orcha's normal lifecycle.
- **Observe**: Orcha *reports back* to the external system (a Jira comment, a Slack ping,
  a task chip in the portal) at meaningful transitions — chiefly when a task parks at
  `needs_verification`.
- **Never delegate the gate**: no external system verifies, completes, approves a plan,
  or merges. `needs_verification → completed` is a human action inside Orcha
  (`POST /api/tasks/{tid}/verify`, human-gated). `gh pr merge` stays an in-Orcha,
  autonomy-governed decision. An external system can *ask* Orcha to start work and can
  *watch* the outcome; it can never be the thing that signs off.

Concretely, that means every integration is symmetrical: one inbound "make a task" path
that reuses `task_start_core`, and one outbound "a human is needed" path that hangs off
the same after-commit `needs_verification` hook. Jira is the third instance of that
shape, not a new mechanism.

## Issue ↔ task mapping

- **Identity**: the Jira issue key (e.g. `PROJ-123`) is the external identity. Store it
  in task metadata — a `jira_issue_key` field (a nullable `tasks` column, additive
  migration, mirroring how `GH #N` lives in the title/audit today; or a small
  `task_external_refs` table if we want multiple external refs per task). The key is the
  idempotency probe: an open task already carrying `PROJ-123` is returned instead of
  duplicated (same discipline as the GitHub hub's `GH #N:` prefix probe).
- **Title / body**: task title `PROJ-123: <summary>`; description = the issue's
  description excerpt + the issue URL + "Triggered from Jira".
- **Definition of done**: templated like the GitHub triggers — "Resolve PROJ-123 per its
  description. Reference the issue key in the PR. Fresh-session review, then human
  review. Never merge."

### Task state → Jira transition mapping

Orcha task state is the source of truth; Jira mirrors it via transitions. The mapping is
a per-deployment table (Jira workflows are customizable, so it must be configurable, not
hard-coded), with these defaults:

| Orcha task state | Jira transition (default target status) | Notes |
|---|---|---|
| created / `ready` | *To Do* → *In Progress* (optional) | Only if the deployment wants Orcha to claim the issue on start. |
| `in_progress` | *In Progress* | On assignment/start. |
| `needs_verification` | *In Review* + a comment | The observe signal — a human must verify in Orcha. |
| `completed` | *Done* | Only after a human verifies in Orcha (never Orcha self-certifying). |
| `cancelled` | (no transition) + a comment | Leave the human to re-triage in Jira. |

Transitions are **best-effort and non-fatal**: a failed Jira API call never blocks the
Orcha state change (same contract as the Slack outbound ping). Only whitelisted target
statuses are applied; an unmapped state is a no-op comment, never a guess.

## Inbound webhook

- **Event**: `jira:issue_created` (and optionally `jira:issue_updated` for a label
  added later). Jira posts to `POST /api/jira/webhook`.
- **Gate**: only issues carrying a configured label (default `orcha`) create a task —
  so a whole Jira project isn't swept into Orcha. Unlabelled issues are ignored.
- **Mapping**: the Jira project/board maps to an Orcha container (a per-deployment
  binding, stored container-side like `github_repo` / `slack_webhook_url`). The webhook
  resolves the container from the issue's project, then calls the shared start internals.
- **Security**: verify the webhook is genuinely from Jira. Jira Cloud does not sign
  webhooks the way Slack does, so the practical options are (a) a secret path token /
  shared-secret header on the webhook URL, and/or (b) IP allowlisting Atlassian's egress
  ranges. Document the chosen mechanism; default to a secret header the deployment sets.
- **Feature flag**: dark unless the Jira credentials + binding are configured (mirroring
  the Slack `_slack_enabled()` both-secrets gate).

## Outbound

- **`needs_verification` → Jira comment** (+ optional *In Review* transition): hang off
  the SAME after-commit hook `task_done_routes.mark_done` already fires for push and
  Slack (`_push_task_verify`, `notify_task_needs_verification`). Add a third sibling,
  `notify_jira_needs_verification`, non-fatal by construction. The comment carries the
  task title, the Orcha task link, and "Verify in Orcha" — an observe signal, not a gate.
- **`completed` → *Done* transition + comment**: after a human verifies, mirror the
  completion into Jira. This is the only path that moves the issue to Done, and it is
  downstream of a human verification — never an agent self-certifying.

## Auth model (per deployment)

Two supported shapes, chosen per deployment:

1. **API token (Basic auth)** — a Jira account email + API token, stored as a sealed
   secret (the same secret-box path the LLM key uses). Simplest for a single-tenant /
   self-hosted deployment. Coarse-grained (acts as that account).
2. **OAuth 2.0 (3LO)** — an Atlassian OAuth app; per-user or per-workspace consent,
   refresh tokens stored sealed. Correct for a multi-tenant cloud where actions should be
   attributed to a connected user and scopes should be least-privilege
   (`read:jira-work`, `write:jira-work`). More setup; the right long-term answer for
   Orcha Cloud.

Default the design to API-token for the first shippable version (fewer moving parts),
with OAuth 2.0 3LO as the cloud-grade upgrade. Credentials never live in a customer
container beyond the sealed store; the PEM/host-token discipline GitHub uses is the model
to follow for anything long-lived.

## UX — where Jira chips appear

- **Task rows / task detail**: a Jira chip (`PROJ-123`) next to the existing GitHub
  chips, linking to the Jira issue — the same chip pattern the GitHub hub uses for
  `#number`. Present only on tasks that carry a `jira_issue_key`.
- **GitHub hub parity**: if we build a Jira hub page, it mirrors the GitHub hub — a list
  of labelled issues with a Start button — reusing the hub's row/skeleton/empty-state
  conventions. Not required for v1 (the inbound webhook covers the trigger path without
  a page).
- **Settings**: a Workspace → Jira connect panel (project/board binding, credentials,
  the trigger label, the transition map), alongside the GitHub connect and Slack link
  panels. All three integrations live under one Settings surface.
- **Honest off state**: unconfigured Jira shows a connect affordance, never a broken
  chip — exactly like the GitHub hub's "repo not connected" card.

## Phased rollout

- **Phase 1 (trigger)**: inbound `jira:issue_created` + `orcha` label → task
  (`task_start_core`), project→container binding, `jira_issue_key` in task metadata,
  Jira chip on task rows. API-token auth. Feature-flagged off.
- **Phase 2 (observe)**: outbound `needs_verification` comment (+ optional *In Review*
  transition) on the shared after-commit hook; `completed` → *Done* after human verify.
- **Phase 3 (cloud-grade)**: OAuth 2.0 3LO, a configurable transition map UI, optional
  Jira hub page, `issue_updated` (label-added-later) support.

## Explicitly not now

- No two-way field sync (comments/attachments/assignee mirroring beyond the transition +
  the single needs-verification comment).
- No Orcha-initiated Jira issue *creation* (Orcha consumes Jira issues; it does not
  create them).
- No Jira automation of the merge/verify gate — categorically excluded by the one rule.
- No Jira Server / Data Center specialization in v1 (Cloud first; Server auth differs).
- No per-issue-type or per-workflow branching logic beyond the single configurable
  transition map.
- No sprint/board management, story-point sync, or JQL-driven bulk import.
