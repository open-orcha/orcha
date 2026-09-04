# Slack integration — trigger seam (dormant until credentials)

A thin Slack seam that lets a linked member **trigger** and **observe** Orcha from
Slack — start a task from a GitHub issue/PR, file a new GitHub issue (from a slash
command OR a message shortcut, screenshots included), read the needs-attention
summary, and get a ping when a task parks at `needs_verification`. It follows Orcha's
one integration rule: **external systems TRIGGER and OBSERVE; the verification and
merge gates stay in Orcha.** A Slack `/orcha start ...` / `/orcha issue ...` / message
shortcut creates a task or issue exactly the way the GitHub hub does — it never
completes or merges anything.

**Status: built, shipped OFF.** Both endpoints (`/api/slack/commands` and
`/api/slack/interactions`) are dark (HTTP 503) until BOTH `SLACK_SIGNING_SECRET` and
`SLACK_BOT_TOKEN` are set in the portal's environment. With either unset there is no
Slack behavior at all — no signature check, no commands, no interactions, no outbound.
Turning it on is configuration, not code.

## What it does

**Inbound — `POST /api/slack/commands`** (a Slack slash command):

| Command | Effect |
|---|---|
| `/orcha start issue <N>` | Start an Orcha task from GitHub issue #N (same internals as the hub's Start button). |
| `/orcha start pr <N>` | Start an Orcha task from GitHub PR #N. |
| `/orcha issue <title> [-- <body>]` | File a NEW GitHub issue in the container's connected repo. Everything before an optional ` -- ` separator is the title; the rest is the body. |
| `/orcha tasks` | Ephemeral "Needs you": up to 5 needs_verification tasks (linked), open-request and ready-unassigned counts. |

Every command replies **ephemerally** (only the caller sees it) as a small Block Kit
message — header, mrkdwn section(s), a muted context line, and a button where a link
belongs — well within Slack's 3s response contract. A Slack-started task is
byte-identical to a hub-started one: both call the one shared
`task_start_core.start_task_from_github` (single source of truth), so the title
(`GH #N: <the real GitHub title>`), the templated definition-of-done, and the audit
trail match. The Slack seam does a live GitHub fetch (issue/PR title + html_url + body
excerpt, `github_hub_routes._fetch_gh_item`) since a bare Slack number has no title to
pass otherwise — a bare `#N` has no title to pass otherwise. If that fetch fails (repo
not bound, no installation token, GitHub unreachable/rate-limited), the command still
succeeds and degrades to the bare `#N` title rather than erroring the dispatch.

**The hub's OWN `POST /github/start` does the SAME live fetch now, for both
issue and pull starts** — a production defect fix: the hub frontend's `postStart()`
(static/pages/github-render.js) never actually sent `title`/`body_excerpt`/`html_url`
in its request body despite `GithubStartBody`'s docstring assuming it did, so every
hub-started task was landing titled a bare `GH #<N>:` with nothing after. Both dispatch
paths now go through the exact same `_fetch_gh_item`, so a hub-started task and a
Slack-started task of the SAME GitHub item structurally cannot drift on title. The
client-supplied `title`/`body_excerpt`/`html_url` fields remain in `GithubStartBody`
purely as the fallback when the live fetch itself fails.

**Inbound — `POST /api/slack/interactions`** (message shortcuts, modal submission,
button clicks) — see "Creating issues and tasks from Slack" below.

**Ack-first, work-after (interactions endpoint).** Every `/api/slack/interactions`
payload type acks Slack's HTTP response IMMEDIATELY and does its actual work —
`views.open`, GitHub calls, image downloads, task_start_core — in a background task
scheduled only AFTER that response is already built:
  - **shortcut/message_action**: an empty `200` returns first; `views.open` (the call
    that visibly opens the modal) fires a beat later in the background. Slack shows
    no "trouble connecting" banner even when the modal takes a moment to appear.
  - **view_submission**: `{"response_action": "clear"}` returns first (closing the
    modal); the WHOLE pipeline — screenshot download, and then either the GitHub
    issue POST ("Create GitHub issue") or direct Orcha task creation ("Create Orcha
    task", task-first — see below) — runs in the background. The result (or an
    honest failure card) is delivered afterward as a `chat.postMessage` DM to the
    submitting user.
  - **block_actions** (the "Start Orcha task" button): a minimal, blocks-free
    ephemeral acks immediately; the live GitHub title fetch + task_start_core call run
    in the background, with the result card DMed to the clicking user.
`/orcha issue` (the SLASH COMMAND) intentionally keeps its pre-existing synchronous,
inline-reply contract and is not part of this ack-timing rework.

**Outbound — needs_verification ping**: when a task transitions to `needs_verification`
(the `plan`/`pr` autonomy default — an agent finished and a human must verify), and the
container has a `slack_webhook_url` configured, Orcha POSTs a compact Block Kit message
("🛡️ Needs your verification" header, the task title as a link, a project/agent context
line, and a "Verify in Orcha" button) to that webhook — ONE message, no channel noise.
This hangs off the SAME after-commit hook that already emits the in-portal / push
"needs you" state (`task_done_routes.mark_done` →
`slack_notify.notify_task_needs_verification`). It is **non-fatal by construction**: a
missing webhook, a dead URL, or a network error is swallowed — the transition always
lands identically whether or not Slack is reachable.

**Outbound — GitHub round-trip comment**: every FRESH task start (hub Start/Fix button
OR Slack `/orcha start` — never a `{existing:true}` re-click) also posts a short
comment back on the source GitHub issue/PR: "🤖 Orcha started task `<id8>` for this —
assigned to **<alias>**" (or "unassigned — the orchestrator routes it"), plus a line
noting work arrives as a PR and a human verifies before anything merges. Posted from
`task_start_core.start_task_from_github` itself (the shared core), so every dispatch
path gets it exactly once, never duplicated. Same non-fatal contract as the Slack
ping: no bound repo, no installation token, or any GitHub failure is caught and
swallowed — a dead comment never breaks task creation. Requires the GitHub App's
`Issues: Read and write` permission (already required for `gh issue create` — see
`docs/byoc-guide.md`'s permission table); PR comments ride the same
`issues/{number}/comments` endpoint GitHub uses for both issues and PRs.

## Creating issues and tasks from Slack

Two ways to file a GitHub issue in the container's connected repo without leaving
Slack (`/orcha issue` and the "Create GitHub issue" message shortcut), both
attributed to the linked member via a footer line on the issue body
("_Filed from Slack by \<github_login\> via Orcha_") — plus the "Create Orcha task"
message shortcut, which captures a report as an Orcha TASK directly (task-first; the
agent files the GitHub issue later, see below):

### 1. Slash command — `/orcha issue <title> [-- <body>]`

Everything before an optional ` -- ` separator becomes the title; anything after
becomes the body. `/orcha issue Login button is misaligned -- happens only on Safari`
files an issue titled "Login button is misaligned" with that body line. The reply is
the same "📝 Issue filed" Block Kit card the message shortcut uses (below) — a link to
the new issue on GitHub, and a **real, clickable "Start Orcha task" button** (routed
through `POST /api/slack/interactions` as a `block_actions` click, driving the same
shared `task_start_core.start_task_from_github` every other dispatch path uses — not
just a hint to run another command). A 403 from GitHub (the App's installation lacks
`Issues: Read and write`) never surfaces as a raw error — it's a friendly "🔒 Can't
file that issue" card telling the member the App needs that permission.

### 2. Message shortcut — "Create GitHub issue" / "Create Orcha task"

Right-click (or use the "More actions" `⋯` menu on) any Slack message → one of two
shortcuts:

- **"Create GitHub issue"** opens a modal (title pre-filled from the message's first
  line, body pre-filled with the full message text + a "— from Slack conversation"
  provenance footer) → **File issue** creates the GitHub issue and DMs a confirmation
  card back.
- **"Create Orcha task"** opens the SAME modal plus an optional **Assignee** picker
  (the container's live AI agents, or "Let the orchestrator route it" for unassigned)
  → **Create task** creates the Orcha task DIRECTLY (task-first): raw title/body +
  Slack provenance, screenshots landed on the task's own attachment store, no GitHub
  issue filed by the portal at all — the dispatched/routed agent files the polished
  issue itself, per the task's own DoD (see "Task-first capture" below). The
  confirmation card is "🚀 Task created" with a link to the Orcha task and a context
  line noting the agent files the refined GitHub issue.

Both shortcuts share one modal layout (`slack_notify.build_create_issue_modal`);
`view_submission` routes on the submitted view's own callback_id to either file
the issue (issue-only), or create the Orcha task directly (task-first).

### Task-first capture, agent-refined issues (the "Create Orcha task" shortcut)

The "Create Orcha task" shortcut's modal submission creates the Orcha task
**directly** — the portal does not call an LLM and does not file a GitHub issue at
capture time. The task's title is the modal's own title field, used verbatim; its
description is the modal's body text plus a Slack-provenance footer
("_Captured from Slack by \<github_login\> via Orcha_"). Any screenshots on the
source message are downloaded (same `slack_files` pipeline as always) and land
directly on the new task's own attachment store — never committed to a repo at this
point, since no GitHub issue exists yet to embed them into.

The task's `definition_of_done` (`task_start_core.build_slack_captured_dod` — a
distinct template from `_ISSUE_DOD`/`_PULL_DOD`, which both assume a GitHub
issue/PR already exists) instructs the dispatched or orchestrator-routed agent, in
order:

1. **File a professional GitHub issue** in the connected repo for this report:
   imperative title, a structured Summary/Observed/Expected/Technical-context body
   grounded in the actual codebase, the task's attached screenshots embedded
   (committed under the repo's `.github/orcha-attachments/` convention, same layout
   the old portal-side commit step used), the reporter's original message quoted
   verbatim, and a provenance footer. Post the new issue's link back as a message on
   the Orcha task's own thread.
2. **Then** post a codebase-grounded triage comment on that issue (same convention
   as every other GitHub-issue-kind task's `_ISSUE_DOD`).
3. **Then** implement per the standard protocol: PR, fresh-session review, human
   review, never merge without a human verifying.

This moves the wording-refinement work that used to run as a portal-side LLM call
(`slack_issue_refine`, now deleted entirely — see "Removed: portal-side LLM
refinement" below) onto the agent itself, which has actual repo access and can
ground the issue in real code rather than guessing from a raw pasted message alone.

**The confirmation card** ("🚀 Task created") links straight to the Orcha task —
there is no GitHub issue link yet — with a context line: "the agent files the
refined GitHub issue — link arrives in the task thread." The screenshot-count
honesty line (e.g. "2 screenshots attached") is unchanged in spirit, just now
describing what landed on the TASK rather than on a GitHub issue.

**Idempotency note (accepted behavior):** a slack-captured task carries no `GH #N:`
title prefix at creation — `task_start_core.find_open_gh_task`'s idempotency probe
(which matches on that exact prefix) simply does not apply to it. A slack-captured
task is not tracked against any GitHub issue number until the agent files one; a
double-submission of the same shortcut creates two separate Orcha tasks (no
dedup) — this is accepted, not a regression, since the previous behavior for this
exact case (no prior GH issue) had no dedup key either.

**`/orcha issue` (the slash command) and the "Create GitHub issue" message
shortcut are both unaffected by this redesign** — they keep filing a GitHub issue
directly, raw title/body as typed.

### Removed: portal-side LLM refinement

An earlier version of the "Create Orcha task" / "Create GitHub issue" shortcuts ran
the modal's title/body through the portal's universal LLM client
(`slack_issue_refine` use case in `llm_catalog`/`llm_decisions`/`llm_util`) before
filing, rewriting a raw pasted Slack message into a professional technical report.
This has been removed entirely — no portal Slack path calls an LLM anymore. For the
task-first flow this responsibility moved to the dispatched agent itself (see above,
which also gives the agent real codebase access the portal-side rewrite never had);
for the issue-only shortcut and `/orcha issue`, the raw title/body are filed as
typed, matching their behavior from before AI refinement was ever added.

**Screenshots travel with the work.** If the source message carries images (the first
5, `image/*` mimetypes only, each ≤10MB — see "Screenshot download hardening" below for
why), they're downloaded and:
  - For the **"Create GitHub issue"** shortcut: committed into the connected repo under
    `.github/orcha-attachments/<issue-slug>/` via the GitHub Contents API and embedded
    as markdown images in the issue body (`### Screenshots` + one `![name](url)` per
    landed file) — **private repo, so visibility follows the repo's own access**, same
    as every other file in it.
  - For the **"Create Orcha task"** shortcut: attached to the created task via the
    portal's existing task-attachments machinery — the same store
    `POST /api/tasks/{tid}/attachments` writes to — so a sandboxed agent working the
    task can fetch and actually look at the screenshot (the whole point: the AI
    reviews the image, not just a link to it). Nothing is committed to the repo at
    capture time — the agent commits/embeds them itself when it files the issue, per
    the task's DoD.

Downloading a Slack file requires the **`files:read`** OAuth scope (see the updated
scope list below) — **without it, the issue/task is still filed, just without
images**, and the confirmation card says so explicitly (e.g. "2 screenshots skipped —
add the files:read scope and reinstall the App"). Any per-image failure (download,
GitHub commit, or task-attach) is isolated to that one file — one bad screenshot never
fails the whole issue/task creation — and the confirmation card's screenshot count is
always honest about how many actually landed (e.g. "2/3 screenshots attached").

**Card honesty widened (issue #234 follow-up):** the confirmation card now states an
outcome whenever the source message carried ANY candidate images — not just when at
least one survived the pre-download selection filter. A message whose screenshots were
ALL filtered out (over the size cap, wrong mimetype) used to produce a card with no
screenshot note at all, indistinguishable from a plain-text message that never had any
— it now says "N screenshots were skipped — too large or not an image" instead.

**Screenshot download hardening (task 394d1063):** a production incident landed two
"screenshots" that were actually Slack's own HTML page saved with a `.png` name —
`url_private_download` answered HTTP 200 (not 401/403) when the bot token wasn't
effectively authorizing the request, and the pipeline accepted any 200 as image bytes.
Root cause: a redirect hop on Slack's download flow was dropping the `Authorization`
header (the stdlib's default redirect handling does not guarantee a custom header
survives a cross-host 30x). Fixed two ways, independent of each other:
  - `slack_files.download_slack_file` now uses an explicit redirect handler
    (`_AuthPreservingRedirectHandler`) that re-attaches the same Authorization header
    on every hop.
  - Every download is validated before being accepted as a screenshot: the response
    `Content-Type` must be `image/*`, AND the downloaded bytes' own magic-number
    signature must match a real image format (PNG/JPEG/GIF/WebP) — an HTTP 200 with an
    HTML (or any other non-image) body is now treated as a download failure, counted
    honestly in the skip total, never stored or embedded.
The per-file selection cap was also raised from 5MB to **10MB** (matching the
task-attachment store's own `MAX_ATTACHMENT_BYTES` ceiling) — full-resolution
phone/desktop screenshots routinely exceed 5MB, and the old cap silently dropped them.

### App-config steps for the message shortcuts

1. **Interactivity & Shortcuts** (left sidebar of your app at
   <https://api.slack.com/apps>) → toggle **Interactivity** ON.
2. **Request URL**: `https://<your-portal-host>/api/slack/interactions`
3. **Create New Shortcut** → **On messages** → name it **"Create GitHub issue"** →
   callback_id **`create_github_issue`** → **Create**.
4. **Create New Shortcut** again → **On messages** → name it **"Create Orcha task"** →
   callback_id **`create_orcha_task`** → **Create**. (Both shortcuts share the one
   Interactivity Request URL from step 2 — no separate endpoint per shortcut.)
5. Save changes; if Slack prompts to **reinstall the app** to your workspace, do it —
   new shortcuts/scopes only take effect after reinstall.

The `/api/slack/*` prefix (both `/api/slack/commands` and `/api/slack/interactions`)
bypasses the portal's OAuth reverse-proxy perimeter (`deploy/auth/Caddyfile` /
`docs/byoc-guide.md`'s host-Caddy reference block) — Slack's servers can't complete a
browser OAuth flow or carry a bearer token, so the app-level Slack v0 signature check
is the real gate for this prefix, not the proxy. No further Caddy change is needed
once that bypass is in place.

**Caddy note:** the `/api/slack/*` bypass block referenced above ships in this same
change — a prior version of this doc assumed it already existed on deployed boxes; it
did not, and Slack's real (unauthenticated) traffic to `/api/slack/commands` would
previously have been redirected into the browser sign-in flow by the perimeter's
catch-all. Existing self-hosted boxes running the `docs/byoc-guide.md` host-Caddy
reference block need to hand-add the equivalent `handle /api/slack/* { reverse_proxy
127.0.0.1:8001 }` block (ahead of the catch-all) and `systemctl reload caddy`.

## Block Kit design language

All Slack-facing messages live in `slack_notify.py`: a header line with an emoji
glyph, mrkdwn sections, muted context lines, and buttons where a link belongs —
absolute portal URLs, since Slack buttons must be externally reachable
(`ORCHA_PORTAL_BASE_URL`, the same config-based source both the outbound ping and the
inbound replies read through `slack_notify.portal_base_url()`/`portal_task_link()`; a
button deep-links to the extensionless `/tasks?cid=...&task=...` route the portal
actually serves — never a `/tasks.html` path, which 404s). Every composer is a small
pure function (`blocks_start_success`, `blocks_already_tracked`, `blocks_unlinked_user`,
`blocks_usage_help`, `blocks_tasks_summary`, `blocks_needs_verification`,
`blocks_issue_filed`, `blocks_task_created`, `blocks_github_permission_error`,
`blocks_github_unreachable_error`, `blocks_issue_usage_help`,
`build_create_issue_modal`, `build_unlinked_user_modal`) returning a block/view
structure; mrkdwn-unsafe characters (`<`, `>`, `&`) in a task/issue title are always
escaped (`_mrkdwn_escape`) before landing in a block.

## Creating the Slack app (do this tomorrow)

1. **Create the app** at <https://api.slack.com/apps> → *Create New App* → *From
   scratch*. Name it (e.g. "Orcha"), pick your workspace.
2. **Bot token scopes** (*OAuth & Permissions* → *Scopes* → *Bot Token Scopes*):
   - `commands` — to register the slash command.
   - `chat:write` — for any bot-authored messages (including the modal-submission
     confirmation DMs).
   - `files:read` — **new**, required to download image attachments (screenshots) off
     a Slack message for the "Creating issues and tasks from Slack" flow. Without it, issue/task
     creation still works — images are simply skipped and the confirmation card says
     so ("N screenshots skipped — add the files:read scope and reinstall the App").
   Install the app to the workspace; copy the **Bot User OAuth Token** (`xoxb-…`) — this
   is `SLACK_BOT_TOKEN`.
3. **Signing secret** (*Basic Information* → *App Credentials* → *Signing Secret*) — this
   is `SLACK_SIGNING_SECRET`. It is what verifies every inbound request actually came
   from Slack (both `/api/slack/commands` and `/api/slack/interactions` use it).
4. **Slash command** (*Slash Commands* → *Create New Command*):
   - Command: `/orcha`
   - Request URL: `https://<your-portal-host>/api/slack/commands`
   - Short description / usage hint: `start issue <N> | start pr <N> | issue <title> [-- <body>] | tasks`
5. **Interactivity & Shortcuts** (for the two message shortcuts) — see "Creating
   issues from Slack" → "App-config steps for the message shortcuts" above for the
   exact click-by-click steps (Interactivity Request URL, both shortcuts' names and
   callback_ids).
6. **Reinstall the app** to the workspace if Slack prompts you to (adding scopes or
   shortcuts after the initial install always requires this — new permissions/shortcuts
   don't take effect until you do).
7. **Paste the two secrets** into the portal's environment (the same channel other
   secrets ride — e.g. the compose env / stack config that already carries
   `ORCHA_LLM_API_KEY`), then restart the portal. `slack_routes._slack_enabled()` reads
   both from `os.environ`; both present flips BOTH endpoints live.
8. **Caddy**: confirm the box's reverse-proxy config has the `/api/slack/*` bypass
   block (ships in `deploy/auth/Caddyfile` as of this change; self-hosted boxes on the
   `docs/byoc-guide.md` host-Caddy reference block need to hand-add it — see the note
   above). Without it, Slack's requests never reach the app-level signature check at
   all.
9. **Outbound (optional)**: to receive needs_verification pings, create an *Incoming
   Webhook* for the target channel and store its URL as the container's
   `slack_webhook_url` (container-level setting, mig 044). No webhook ⇒ no outbound,
   silently.

## Linking members

An inbound slash command OR interaction (shortcut, modal submission, button click) is
only honored for a member whose Slack user id is linked to their Orcha membership
(`agents.slack_user_id`, mig 044). An unknown/unlinked caller gets an ephemeral "link
your Slack in Settings" reply (slash commands / block_actions) or a small "Not linked"
modal (message shortcuts — `views.open` is the only ack mechanism available for that
payload type, so a small informational modal stands in for the ephemeral reply) and
**never acts** — Slack can trigger Orcha, but only on behalf of a known member. A
`view_submission` re-validates the linked member from the modal's `private_metadata`
(set at open time) before doing anything, so a modal can't be reused past a member
being unlinked mid-flow. (The Settings UI for entering the Slack user id is the
frontend's surface; the column and the mapping are here.)

## Security model

- **Request signing.** Every inbound request — both `/api/slack/commands` and
  `/api/slack/interactions` — is verified with Slack's v0 scheme:
  `HMAC-SHA256("v0:{timestamp}:{raw_body}", SLACK_SIGNING_SECRET)`, compared in constant
  time against the `X-Slack-Signature` header, with the `X-Slack-Request-Timestamp`
  required to be within **±300 s** (replay protection). A bad, missing, or stale
  signature is a `401` before any work is done.
- **Identity, not impersonation.** The command/interaction acts as the linked member
  (their `container_id`, their creator attribution) — a Slack caller can never act as a
  member they are not linked to. Unlinked ⇒ no action.
- **The gates stay in Orcha.** Slack can start tasks, file GitHub issues, and read
  summaries. It cannot verify, complete, or merge. The `needs_verification` gate and
  human merge authority are untouched.
- **Least privilege.** `commands` + `chat:write` + `files:read` are the only bot
  scopes requested — no broad `channels:history`/`groups:history` scope is needed
  since shortcuts deliver the SOURCE message inline in the payload itself. GitHub-side,
  issue creation and screenshot commits ride the App's existing `Issues: Read and
  write` / `Contents: Read and write` installation permissions — no new GitHub
  permission beyond what the round-trip comment already required. The outbound
  needs_verification ping uses a channel Incoming Webhook, not a broad posting scope.
- **Fail safe.** With secrets unset the whole surface (`/commands` AND
  `/interactions`) is a `503` no-op; the outbound webhook ping is best-effort and never
  affects domain state; a missing `files:read` scope degrades screenshot handling
  gracefully rather than failing issue/task creation.
- **Reverse-proxy bypass, not an open door.** `/api/slack/*` is exempted from the
  portal's OAuth perimeter (Caddy) because Slack can't complete that flow — but every
  request landing there still must pass the app-level signature check above before any
  work happens; the bypass only lets that check run at all.

## Codebase triage-first (all GitHub-originated ISSUE tasks)

Every GitHub-originated issue-kind task's `definition_of_done`
(`task_start_core._ISSUE_DOD` — shared by the hub's Start button, `/orcha start
issue <N>`, and the "Start Orcha task" button on an issue-filed card) opens with an
explicit instruction: before writing any code, post a triage comment on the GitHub
issue with codebase-grounded analysis — the specific modules/files involved, the
most likely cause ranked against the actual code, and what logs/repro would confirm
it. The dispatched agent is the one with actual repo access, so its first move is
real investigation from inside the code, not more wording. PR/Fix tasks
(`_PULL_DOD`, and any `dod_override` the hub's PR-Fix path supplies) are unchanged —
a PR is reacting to CI/review feedback on code that already exists, not triaging a
fresh report. Slack-captured tasks (the "Create Orcha task" shortcut) use their own
`build_slack_captured_dod` template instead — same triage discipline, but preceded
by the file-the-issue-first step, since no GitHub issue exists yet for that flow
(see "Task-first capture" above).

## Cross-seam consistency: the hub also knows about a Slack start

Because a Slack start and a hub start share the same `task_start_core` internals, the
GitHub hub's issue/PR list and detail endpoints (`github_hub_routes.py`) carry a
`tracked_task_id` field on every row/item — computed fresh on every request from the
SAME open-task lookup (`task_start_core.find_open_gh_tasks`) the idempotency check
uses. So an issue started via `/orcha start issue 232` shows as tracked on the hub's
NEXT page load, not only after a hub click (which would itself just bounce off
`{existing:true}`). This is deliberately NOT Slack-specific plumbing — it is the
general "any dispatch path is visible from any other surface" property the shared
core exists to guarantee.

## Files

- `portal_backend/slack_routes.py` — both flagged endpoints (`/commands`,
  `/interactions`), signature verification, command parsing (`/orcha start`, `/orcha
  issue`), member mapping, the live GitHub title fetch for `/orcha start`, GitHub
  issue creation (`create_github_issue`, `_gh_post_issue`), the Contents-API
  screenshot commit (`_gh_put_contents`, `_commit_images_to_repo`,
  `_embed_images_markdown`, used only by the issue-only pipeline), the ack-first
  shortcut/view_submission/block_actions split (`_prepare_interaction`,
  `_build_shortcut_modal_view`/`_open_modal_background`,
  `_prepare_view_submission`/`_run_view_submission_pipeline` — which branches into
  `_run_issue_only_pipeline` (files a GitHub issue) and `_run_task_first_pipeline`
  (creates the Orcha task directly, no GitHub issue — see "Task-first capture"
  above) — `_prepare_block_action`/`_run_block_action_pipeline`, all scheduled
  through the ONE `_schedule_background` seam), the shortcut-time per-file verdict
  instrumentation (`_log_shortcut_file_verdicts`), the private_metadata byte-budget
  guard (`_private_metadata_files`), and task-attachment landing
  (`_land_images_on_task`).
- `portal_backend/slack_notify.py` — the Block Kit composers (inbound ephemeral
  replies, modal views, and the outbound ping) + the non-fatal outbound webhook POST +
  `call_slack_api` (the authenticated Slack Web API leaf for `views.open`/
  `views.update`/`chat.postMessage`).
- `portal_backend/slack_files.py` — Slack message-file selection
  (count/mimetype/size filtering, `select_image_files_verdicts` for the per-file
  instrumentation) and download (`files:read`-gated, with the scope-missing
  degradation path; `_AuthPreservingRedirectHandler` + Content-Type/magic-byte
  validation per the task 394d1063 hardening).
- `portal_backend/task_start_core.py` — the shared start internals: task
  creation/idempotency, the batched `find_open_gh_tasks` tracked-state lookup, the
  non-fatal GitHub round-trip comment, the codebase-triage-first `_ISSUE_DOD` clause
  (GitHub hub + `/orcha start` + the issue-filed card's "Start Orcha task" button,
  all genuinely GH-issue/PR-triggered), and the separate task-first
  `start_task_from_slack_capture` / `build_slack_captured_dod` used ONLY by the
  "Create Orcha task" shortcut (no GH issue exists at creation time for that path).
- `portal_backend/github_hub_routes.py` — `tracked_task_id` on the issues/pulls list
  and detail endpoints (`_with_tracked_list`/`_with_tracked_one`); the authoritative
  server-side title/body/url fetch (`_fetch_gh_item`, shared with `slack_routes.py`)
  `POST /github/start` now runs for both issue and pull dispatches.
- `portal_backend/attachment_references.py` / `attachment_storage.py` — the existing
  task-attachment store/ref machinery the screenshot-landing path reuses in-process
  (same store `POST /api/tasks/{tid}/attachments` writes to).
- `static/pages/github-render.js` — `startedOf()` reads the server's
  `tracked_task_id` (any dispatch path, any session) ahead of the page's own
  in-session Start-click cache.
- `migrations/044_slack_integration.sql` — `agents.slack_user_id` +
  `containers.slack_webhook_url` (additive, nullable).
- `deploy/auth/Caddyfile` / `docs/byoc-guide.md` — the `/api/slack/*` OAuth-perimeter
  bypass block.
- Tests: `tests/test_slack_routes.py`, `tests/test_slack_files.py`,
  `tests/test_task_start_core.py`, `tests/test_github_hub_routes.py`,
  `tests/portal/github_hub_live_defects.test.js`.

## Known follow-up (not shipped here)

A `conversations.history` fallback for message-shortcut screenshot handling (in case a
future incident shows Slack ever delivers a `message_action` payload with a TRIMMED
`files[]` array, requiring a follow-up fetch) was considered and explicitly deferred —
task 394d1063's actual root cause turned out to be the redirect/auth-header bug fixed
above, not payload trimming, so no evidence currently supports adding the extra
`channels:history`/`groups:history` scope this would require. Revisit only if a
production repro specifically shows an empty `files[]` on a message that demonstrably
had attachments (the per-file verdict logging added in this change would surface that
distinction immediately).
