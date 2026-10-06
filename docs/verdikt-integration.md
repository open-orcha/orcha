# Proof-of-work evidence and the Verdikt handoff

When a task reaches **needs verification**, Orcha builds an **evidence pack** from what the task's
own runs recorded. It can also hand the task to **Verdikt** (Husseinovich/verdikt), a local QA agent
that drives a web page in Chromium, an iOS simulator app or an Android package. Verdikt checks the
task's definition of done and reports a verdict for each line, with screenshots and a report link.

Neither one completes a task. A human still accepts the work at the verification gate. The one
exception to "evidence only" is the opt-in **auto-fix loop** (section 9): when an automatic Verdikt
run fails, Embodent can send the task back to its agent (as the system identity `system:verdikt`)
until Verdikt passes or a stop condition fires. Even then a pass only hands the task to a person.

## 1. The evidence pack

`GET /api/tasks/{tid}/evidence` returns the pack. It is built automatically when the task enters
`needs_verification` (the `/done` hook, which runs in a background thread after the commit). It is
rebuilt on read whenever any of its inputs change.

| Part | What it contains | Where it comes from (never invented) |
|---|---|---|
| **Tests** | Each test suite the agent ran, with passed/failed/skipped counts and the command | The runs' stream-json: Claude `tool_use` Bash with its `tool_result`, and Codex `command_execution` / `exec_command_end`. Counts come from the runner's own summary line (pytest, vitest, jest, mocha, node's built-in runner `node --test` in both its TAP (`# tests 35` / `# pass 34` / `# fail 1`) and spec (`ℹ tests 35` …) formats, go, cargo, unittest, XCTest/Swift Testing, rspec, phpunit, dotnet, maven/gradle). Package scripts (`npm test`, `npm run test`, `pnpm test`, `yarn test`, `node --run test`) count as test runs of unknown framework until their output names the runner, then read e.g. "npm test (node:test)". Node's cancelled tests count as errors, never passes, and several node summaries in one output (workspaces) are summed. The go parser only accepts real package lines (`ok  <pkg>  0.12s`, `FAIL <pkg> 0.2s`), so TAP's `ok 1 - name` is never read as go. If there is no summary line, the pack shows the exit code ("exit 0 · no summary line") or "result not captured". If no test command ran, it says "no tests ran". When a command was rerun, only its latest run counts; earlier runs are listed as superseded. |
| **Changes** | A plain-English summary ("Changed 3 files (+14 −2): 1 UI file, 1 source file, 1 test file. Mostly in web/login, api/auth.") and **risk flags** | The run's captured diff (`worker_runs.diff`), or the live checkout for a run that is still going. Both are read through the same code as Live changes. The risk flags are: database migration, auth/permissions, possible secret (a secret-like file or an added line that looks like a credential; the value is never shown), files deleted or a large removal, large change, dependencies changed, and CI/infra. |
| **Definition of done** | Each DoD line marked **proven**, **not proven** or **needs a human**, with the evidence line behind it | A deterministic heuristic, applied in this order: 1. Verdikt's verdict for the line, if it was sent. 2. Test lines are proven by passing suites and disproven by failing ones or by no test run; "add tests" lines also accept changed test files. 3. Lines that name files are proven when those files changed. 4. Migration and docs lines are proven when a migration or doc file changed. 5. Anything else needs a human, with related changed files shown as a hint. The agent's own report appears as **"Agent says: …"**. That is a labelled claim: it never changes a line's status, and each sentence is attributed to at most one line. |
| **Links** | Live changes or captured diff for each run, the task's Runs tab, and PR URLs | PR URLs are only those that appear in the recorded output or in the agent's result. |

**Rounds.** After a verification is rejected, only runs that started after the rejection count, so
the new claim is judged on the rework.

**Summary line.** The pack's summary line reads like "4/5 DoD items evidenced · 128 tests passed ·
1 risk flag · Verdikt fail". `GET /api/containers/{cid}/evidence-summaries` returns the same summary
for every task that is awaiting verification, for the Needs-you rows.

## 2. The Verdikt handoff

### What Orcha sends

Orcha uses only the Verdikt site's existing HTTP routes. See `portal_backend/verdikt_client.py`.

1. `GET /api/health` checks that Verdikt is up and whether a worker is online.
2. `POST /api/db` runs a read-only `select` on `apps` to resolve the configured project slug.
3. Orcha creates one scenario per task, named `Orcha <short id> · <title>`, in category **Orcha**
   with tags `orcha` and `orcha-task-<short>`. On retry it finds the scenario by name and reuses it.
   - `POST /api/scenarios` creates it and `PATCH /api/scenarios/{id}` fills it in:
     - **criteria**: the DoD lines a UI tester can check. Code-level lines (tests pass, a file,
       migration or doc changed) are proven from the run and are not sent; the handoff lists them
       as `skipped_items`. If nothing UI-checkable remains, every line is sent.
     - **description**: the task description, the changed files, the branch, the PR URL(s), any
       preview URL the agent reported, and the target.
     - `status: validated`.
4. `POST /api/requests` queues `{target_kind, locator, mode: "scenarios", scenario_ids: [id],
   project_id}`. Verdikt's worker claims the request and runs Claude Code with the verdikt MCP
   tools against the target.

### Reading results back

Polling happens when someone reads the evidence, at most every 3 s. The UI polls every 4 s while a
Verdikt run is open.

- It reads `run_requests` (status, error, `run_id`), linked `runs` (including fan-out children and
  runs linked by `runs.request_id`), `scenario_results` for the scenario, `evidence`, and `steps`
  frames if a run recorded no evidence. All reads are read-only `select`s through `POST /api/db`.
- Each criterion result is mapped back to its DoD line by normalised text, falling back to
  position. The mapped verdicts feed the DoD checklist: pass → proven, fail → not proven with
  Verdikt's "actual", and blocked/unprocessable/warning → needs a human.
- The checklist uses the current round's latest **completed** run. A later retry that is
  cancelled, unavailable or still running does not erase that verdict; the summary's Verdikt part
  still reports the latest run. A run handed off before the last rejected verification judged
  the previous claim: it proves nothing for the rework, is left out of the summary line, and is
  returned flagged `previous_round` (the UI labels it).
- Links. The browser never gets a Verdikt URL directly. The configured Verdikt URL is the address
  the **portal** reaches Verdikt at. When the portal runs in Docker that is
  `http://host.docker.internal:31970`, and a browser on the host can't resolve that name. So the
  pack hands out portal URLs:
  - screenshots and recording: `/api/tasks/{tid}/verdikt/runs/{rid}/artifact?path=<path>`. The
    portal streams the file from Verdikt's `{base}/api/artifacts/qa-runs/<path>`. The recording is
    present only when Verdikt recorded a video.
  - report: `/api/tasks/{tid}/verdikt/runs/{rid}/report`. This is a 302 to `{base}/runs/{run_id}`,
    except that a container-only host (`host.docker.internal`, `gateway.docker.internal`,
    `host.containers.internal`, `172.17.0.1` …) is replaced by the host the portal was opened on,
    keeping Verdikt's port. So `http://host.docker.internal:31970` becomes
    `http://127.0.0.1:31970` when the portal is open at `http://127.0.0.1:8610`.
  - `{rid}` is Orcha's Verdikt-run id (the `id` in `verdikt_runs`), not Verdikt's run id.

### The artifact proxy

`GET /api/tasks/{tid}/verdikt/runs/{rid}/artifact?path=…` uses the same permission as reading the
task's evidence: members read, including viewers, and trusted non-members get 403.

It serves only what the run itself surfaced. `path` must:
- be one of the screenshot, frame or recording paths that this run recorded;
- sit inside that run's own Verdikt folder (`<verdikt_run_id>/…`);
- have plain segments (`[A-Za-z0-9][A-Za-z0-9_.-]*`, with no `..`, `.`, leading `/`, `\` or
  `%`);
- end in `png`, `jpg`, `jpeg`, `webp`, `webm` or `mp4`.

Anything else gets a 404 and is never sent to Verdikt. The host is the run's stored Verdikt base,
never something from the request, so there is no SSRF. The `Content-Type` is chosen by the portal
from the extension, never taken from Verdikt, and every response carries
`X-Content-Type-Options: nosniff` and a sandboxing CSP. `Range` requests are passed through, so
recordings can seek (206). If Verdikt no longer has the file the proxy returns 404, and if Verdikt
is unreachable it returns 502; the panel then shows "Screenshot unavailable" rather than a broken
image. Verdikt has no auth, so the proxy sends no token.

**Why a proxy and not a "browser URL" setting.** A second URL would have to be kept in step with the
first by hand, and it breaks as soon as the browser is not on the same machine as Verdikt. The
proxy needs no configuration and works from anywhere the portal itself is reachable. It also keeps
access under the portal's own member check instead of opening Verdikt's unauthenticated file route
to every browser. The report is the one exception: it is Verdikt's own interactive Next.js page,
whose scripts and API calls go to Verdikt's origin, so it cannot be proxied under a portal path.
The report is therefore linked through the host-rewriting redirect.

Rows stored by older builds, which kept only the server-side URLs, are still served: the portal
recovers each artifact path from the stored URL. A stored URL that is not an artifact of that run
is dropped rather than passed through.

### Honest states (each is shown in the UI with Retry)

| State | Meaning |
|---|---|
| `queued` | The request is queued in Verdikt. If no worker is online, the run says so: "queued — no Verdikt worker is online to run it yet". |
| `running` | A Verdikt worker claimed the request. |
| `completed` + verdict | Verdikt answered, with `pass`, `fail`, `warning` or `blocked`. |
| `failed` | Verdikt answered with an error. Examples: the project is missing (the message lists the known projects), the project is archived, an HTTP error, a request error such as "build failed", or the run finished without a verdict for the scenario. |
| `unavailable` | Verdikt could not be reached (connection refused, DNS failure or timeout). |
| `timeout` | No result arrived within the project's timeout (default 30 min). Orcha polls once more first (polling is read-driven, so a verdict may have landed unseen) and keeps a real answer; otherwise it also tries to cancel the Verdikt request. |
| `cancelled` | Cancelled from Orcha, or cancelled in Verdikt. |

A poll that fails temporarily leaves the run open and adds a "last check failed: …" note. Only one
Verdikt run can be open per task at a time.

### When it runs

This is a per-project setting:

| Setting | Behaviour |
|---|---|
| `manual` (the default) | Only the **Run in Verdikt** button in the evidence pack's Verdikt section. |
| `ui_changes` | Runs automatically when a task that changed UI files (`.tsx/.jsx/.vue/.svelte/.html/.css`, `components/`, `pages/`, `views/`, `screens/`, SwiftUI/Android views) reaches verification. |
| `always` | Runs automatically for every task that reaches verification. |

An automatic run fires at most once per verification round. If the diff is captured only after
`/done` (the usual case: the run exits after calling `/done`), the pack is rebuilt on the next read
and the automatic trigger is re-evaluated then.

## 3. Setup

1. **Run Verdikt.**
   - Option A: the Mac app (`macos/scripts/build-app.sh`). Its site runs on `http://127.0.0.1:31100`.
   - Option B: from a checkout: `bin/install.sh`, then `cd web && pnpm dev` (site on :3100), then
     `bin/qa-worker --interval 3` with the same `VERDIKT_HOME`.
   - A worker must be online. It needs `claude` logged in, or another configured model backend.
2. **Create a Verdikt project** for the app (Verdikt onboarding, or *Quick web run*) and note its
   **slug**.
3. **In Orcha:** go to **Settings → Integrations → Verdikt** (owner, or a member with the
   `manage_repo` permission) and fill in:
   - **Verdikt URL**
     - If Orcha's portal runs in Docker on the same Mac, use `http://host.docker.internal:31100`
       (or `:3100`). This is the address the portal uses. Screenshots and recordings still show in
       the browser because they go through the portal's artifact proxy, and the report link is
       rewritten to the host you opened the portal on (see *Links* above).
     - A cloud-hosted Orcha needs a Verdikt URL it can reach. Verdikt has no auth; see the proposal.
   - **Verdikt project**: the slug.
   - **What to test**: a web URL, an iOS bundle id installed on the simulator, or an Android package.
   - **When**: see the table above.
   - **Timeout**

   Then **Test connection**. It shows whether Verdikt is reachable, whether a worker is online,
   whether the project was found, and the list of projects.
4. On a task awaiting verification, open **Proof → Details → Verdikt → Run in Verdikt**, or let
   the automatic trigger fire.

If no URL is configured for a web target, Orcha uses a preview URL from the agent's report. You
can also enter a URL when you trigger the run.

To have Verdikt test the task's own branch instead of whatever runs at the URL, set a **preview
command** (section 7).

To look at anything in Verdikt itself, use **Open in Verdikt** (the evidence pack's Verdikt
section, and every earlier run row) or **Open Verdikt** (Settings → Integrations → Verdikt).
Both go through a portal redirect to a browser-reachable host (section 8).

## 4. API reference

All routes are additive. Tables are `task_evidence_packs`, `container_verdikt_settings` and
`verdikt_runs`, from migration `058_evidence_verdikt.sql`. The contract is `/openapi.json`.

| Route | Who |
|---|---|
| `GET /api/tasks/{tid}/evidence` · `POST …/evidence/rebuild` | Members read, including viewers. Trusted non-members get 403. |
| `GET /api/containers/{cid}/evidence-summaries?status=needs_verification` | Members read. |
| `GET /api/containers/{cid}/verdikt` | Members read. |
| `PUT /api/containers/{cid}/verdikt` · `POST …/verdikt/test` | Owner or `manage_repo`. Viewers and other members get 403. |
| `GET /api/tasks/{tid}/verdikt/runs` · `POST …/runs/{rid}/refresh` | Members read. |
| `GET /api/tasks/{tid}/verdikt/runs/{rid}/artifact?path=…` · `GET …/runs/{rid}/report` | Members read, including viewers (the same check as the evidence). Trusted non-members get 403. `artifact` streams one allow-listed screenshot or recording; `report` returns a 302 to the Verdikt report at a browser-reachable host. |
| `POST /api/tasks/{tid}/verdikt/runs` · `POST …/runs/{rid}/cancel` | A human member. Viewers and AI agents get 403. The action is audited as `verdikt_triggered` / `verdikt_cancelled`. |

| `GET /api/tasks/{tid}/verdikt/open?run=` · `GET /api/containers/{cid}/verdikt/open` | Members read, including viewers. A 302 into Verdikt's own UI (section 8). |
| `GET /api/tasks/{tid}/verdikt/runs/{rid}/preview` · `GET …/preview/log` | Members read. `preview` returns a 302 to the running preview; `log` returns the log tail (section 7). |
| `POST /api/containers/{cid}/verdikt/previews/claim` · `POST /api/verdikt/previews/{pid}/ready`, `/failed`, `/heartbeat`, `/stopped` | The notifier's machine lane. A header-less daemon call passes. A trusted human must be a non-viewer member with `manage_repo` (owners hold it). |
| `GET /api/tasks/{tid}/verdikt/autofix` | Members read, including viewers. The task's auto-fix state: whether it applies and why, the override, the latest loop and its attempts (section 9). |
| `PUT /api/tasks/{tid}/verdikt/autofix` | Owner or `manage_repo` (like the settings). Per-task override `inherit` / `on` / `off`. Audited as `verdikt_autofix_override`. |
| `POST /api/tasks/{tid}/verdikt/autofix/stop` | A human member (viewers and AI agents get 403). **Stop auto-fix**. 409 when no loop runs. |
| `POST /api/containers/{cid}/verdikt/sweep` | The machine lane (as above). The background check: refreshes in-flight runs and applies the loop. Idempotent. |

Settings changes are audited as `verdikt_settings_changed`. The preview settings and the
`verdikt_previews` table come from migration `064_verdikt_previews.sql`.

## 5. Tested for real (2026-09-29)

- **Setup.**
  - Verdikt: a throwaway instance (`VERDIKT_HOME` under the session scratchpad; site :31950 and
    worker running from a symlinked root so nothing is written into the Verdikt checkout), plus a
    small local sign-in page on :5810.
  - Orcha: the real portal on the h-0 harness (:9100).
- **What happened.**
  - The owner configured Verdikt, with auto-trigger on UI changes.
  - Pixel's run was recorded with test output, a PR URL and a diff touching UI, test and auth
    files, and Pixel marked the task done.
  - The `/done` hook built the pack and auto-triggered Verdikt. Verdikt's worker claimed the
    request, drove Chromium and answered in about a minute:
    - "shows Wrong password": **pass**
    - "error is red": **pass**
    - "greets the user by name": **fail** ("Page shows 'Welcome back!' … no user name"). The agent
      had claimed this line was done; its claim is still shown, labelled, next to the disproof.
  - Four screenshots and the report link came back into the pack.
- **Result.** The summary read "4/5 DoD items evidenced · 128 tests passed · 1 risk flag · Verdikt
  fail". The task stayed at needs verification.
- **Evidence.** Screenshots are in the session scratchpad `overnight/build/proof-verdikt/`.

## 6. Browser links behind Docker, tested for real (2026-09-30)

- **Setup.** The branch's portal ran on the e2e harness at :9250. It was started with a
  `getaddrinfo` shim so that only the portal process resolves `host.docker.internal`, which is
  exactly the position of a portal inside Docker. On the host, `curl http://host.docker.internal:31970`
  fails with "Could not resolve host". The project's Verdikt URL was `http://host.docker.internal:31970`,
  the real Verdikt, and the task was linked to its completed "Wishlist: save items for later" run
  `fa4ee56e`. Only read-only `select`s were sent to Verdikt.
- **What happened.**
  - The refresh returned verdict `pass` and three screenshots. Every link was a portal URL;
    `host.docker.internal` and `:31970` appeared nowhere in them.
  - Each proxied PNG was byte-identical (same SHA-1) to the file fetched from Verdikt directly:
    1280×800, `image/png`.
  - These paths got 404 and were never fetched: another run's screenshot, `..` traversal,
    `../../etc/passwd`, the run's `trace.json`, and an unrecorded `004.png`. A stranger got 403;
    the viewer got 200.
  - The report link returned a 302 to `http://127.0.0.1:31970/runs/fa4ee56e-…`. Opened in
    Chromium, it reached the "Run fa4ee56e · QA" page.
  - In the SPA (Needs you, then the task, then Proof), Playwright found all three screenshots
    loaded at 1280×800, with no 4xx responses, failed requests or page errors.

## 7. Preview environments: test the task's branch, not whatever is at the URL

Verdikt only tests something that is already running at a target. Without a preview, "Run in
Verdikt" tests whatever happens to be at the configured URL, which is usually not the agent's
change. A **preview command** closes that gap.

### Setup

In **Settings → Integrations → Verdikt → Preview** (web targets only; owner or `manage_repo`, the
same as the other Verdikt settings):

| Field | Meaning |
|---|---|
| **Preview command** | One line, run with `/bin/sh -c` in the task's worktree. Examples: `npm ci && npm run build && npx serve -l {port} dist`, or `python3 -m http.server {port} --bind 127.0.0.1`. It must use `{port}` or read `$PORT`. Placeholders: `{port}`, `{worktree}`, `{branch}`. Empty means no preview. |
| **Ready check** | A path on the preview that is polled until it answers below HTTP 400. The default is `/`. |
| **Start timeout** | 5–900 s (default 120). If the preview isn't ready by then, it fails. |
| **Stop after** | 5–480 min (default 60). The notifier stops a preview after this long, even if the run is still going. |

The API fields are `preview_command`, `preview_ready_path`, `preview_timeout_seconds` and
`preview_ttl_minutes` on `PUT /api/containers/{cid}/verdikt`. A client that leaves them out keeps
the saved values, and `""` or `null` clears the command.

### What happens on a run

1. **The portal records a request.** When a Verdikt run is requested (**Run in Verdikt**, Retry,
   or the automatic trigger), the portal records a `verdikt_previews` row in state `requested`.
   It takes the task's worktree, branch and checkout from the latest run in the current
   verification round. The Verdikt run shows "Waiting for the preview", and Verdikt is not
   contacted yet.
2. **The notifier claims it and starts the preview.** Why the notifier: the host notifier daemon
   owns the agent worktrees on the host, and the portal (in Docker) can't run host commands. It
   claims the request (`starting`) and finds the task's checkout:
   - the recorded worktree, if it is the project checkout itself or a direct child of its
     `.orcha-worktrees/`;
   - otherwise, a throwaway detached worktree of the recorded branch, which it removes afterwards.

   It then picks a free port and runs the command in its own process group. Output goes to
   `~/.orcha/previews/<id>.log`.
3. **It becomes ready, or it fails.** The notifier polls
   `http://127.0.0.1:{port}{ready check}`.
   - When the preview answers, the notifier reports **ready**. The portal points the Verdikt run
     at the preview's URL, rewrites the scenario's `Target:` line to say it is a preview of the
     branch, and hands the task to Verdikt as usual.
   - If the command exits, the ready check times out, or the checkout is refused, the preview
     **fails**. The Verdikt run then fails with "Preview failed: <plain reason>", along with the
     last log lines. Verdikt is never handed a dead URL.
4. **It stops.** The notifier sends a heartbeat every 5 s with the log tail. Each heartbeat also
   drives the Verdikt poll, so a finished run is noticed even when nobody has the task open.
   - The portal answers "stop" once the Verdikt run completes, fails, times out or is cancelled,
     or when the time limit passes. The notifier enforces the time limit on its own as well.
   - To stop a preview, the notifier sends TERM to the whole process group, then KILL after 5 s.
     It removes any throwaway worktree and reports **stopped**.
   - On exit, the notifier stops every preview it started. After a crash, the next start finds
     the leftovers by their pid files (matching pid **and** start time, and only for this
     project) and stops them.
   - A preview whose process dies while Verdikt is testing it is reported on the run.

### The URL Verdikt gets

`http://127.0.0.1:{port}` plus the path and query of the configured target URL. For example, a
target of `http://localhost:5173/login` becomes `http://127.0.0.1:41234/login`.
- The preview listens on the notifier's machine. Verdikt's worker drives Chromium on the machine
  *it* runs on. So a preview-backed run needs the notifier and the Verdikt worker on the **same
  machine**. That is the supported local setup: the Verdikt Mac app, or `bin/qa-worker`, next to
  the agent worktrees.
- The portal's own address for Verdikt (`host.docker.internal`, for example) doesn't matter here,
  because it is Verdikt's worker that opens the preview, not the portal.

### What the UI shows

The evidence pack's Verdikt section shows the preview's state in plain words:
- "Starting preview…" (with the branch)
- "Preview ready at http://127.0.0.1:…/", with a **Preview** button that opens the running
  preview in a new tab. The button goes through `GET …/runs/{rid}/preview`, a 302 to the preview
  at the host you opened the portal on.
- "Preview failed: <reason>", with the last log lines. **Log** shows up to 80 lines from
  `GET …/preview/log`.
- "Preview stopped: <why>"

Before any run:
- With no command: "No preview command set: Verdikt will test <configured URL>".
- With a command: "Verdikt will test a preview of this task's branch".

Honest failures:
- If no notifier claims the request within 2 min, the run fails with "Preview failed: no notifier
  picked up the preview request — is `orcha notifier` running …".
- If a claimed preview stops reporting for its start timeout + 60 s, the run fails with "the
  notifier stopped reporting".
- If the task has no recorded worktree or branch, the run fails at once, because there is nothing
  to build.

### When no preview runs

Three cases skip the preview:
- No preview command is set.
- The target is iOS or Android.
- A URL was typed when triggering the run.

In each case the run behaves exactly as before: Verdikt tests the configured URL, or the typed
one.

### Security

- **Who sets the command.** The command is a project setting that only owners and `manage_repo`
  members can change. It runs as the notifier's user.
- **What gets substituted.** Only three values are ever put into the command:
  - `{port}`: an int the notifier picked, within 1024–65535.
  - `{worktree}` and `{branch}`: validated, then `shlex.quote`d.

  Task text (title, description, result) never reaches the shell.
- **Which paths are accepted.**
  - A worktree must resolve (via realpath, so symlinks count) to the project checkout or a direct
    child of its `.orcha-worktrees/`.
  - The recorded checkout must be this notifier's checkout.
  - The branch must be a plain ref that exists locally.
  - A path containing shell characters (`$`, backquote, quotes, `;`, `|`, `&`, parentheses and
    so on) is refused outright. This keeps it safe even when a command puts `{worktree}` inside
    double quotes.
- **What the command can't see.** Orcha's own secrets (`ORCHA_*`, model API keys) are removed
  from the command's environment. `PORT` is set.
- **Who can report.** The notifier lane refuses viewers, plain members and strangers. `ready`
  only accepts a port in 1024–65535.

## 8. Open in Verdikt

- `GET /api/tasks/{tid}/verdikt/open?run=<Orcha Verdikt-run id>` redirects as follows. Without
  `run`, it uses the task's latest run.
  - If Verdikt has started a run: `{verdikt}/runs/{verdikt run id}?scenario={scenario id}`, the
    run page opened on the task's scenario.
  - If the run is still queued or waiting for its preview, or nothing has run yet:
    `{verdikt}/projects/{slug}`.
  - If no slug is known: Verdikt's home page.
- `GET /api/containers/{cid}/verdikt/open` redirects to `{verdikt}/projects/{slug}`.

Both use the same host rewrite as the report link: a container-only host such as
`host.docker.internal` is replaced by the host the browser opened the portal on, keeping
Verdikt's port. Both are members-read. They return 404 when Verdikt isn't set up and nothing has
run.

These targets match Verdikt's web routes (`web/src/app/(app)/runs/[id]`, which reads
`?scenario=`, and `projects/[slug]`). Verdikt's `/scenarios` page shows the scenarios of the
project selected in its `qa_app` cookie and doesn't read `?scenario=`. That means a scenario link
can't be made reliable from outside, so before a run Embodent opens the project instead.

In the UI:
- The evidence pack's Verdikt section has **Open in Verdikt**.
- Every row under **Earlier runs** has its own **Open in Verdikt**.
- Settings → Integrations → Verdikt has **Open Verdikt**.

All three open in a new tab.

## 9. Auto-fix: send failures back until Verdikt passes

Opt-in per project (migration `068_verdikt_autofix.sql`; `portal_backend/verdikt_autofix.py` is
the source of truth, `verdikt_autofix_routes.py` the API).

```
agent marks done → Verdikt (auto) → FAIL → back to the agent (system:verdikt) → rework → done
      ↑                                                                                   │
      └──────────────────────── a new verification round, auto-triggered once ←──────────┘
                              … until PASS (→ a person verifies) or a stop condition
```

### Settings

Settings → Integrations → Verdikt → **Auto-fix** (owner or `manage_repo`):

- **When Verdikt fails, send it back to the agent automatically.** Off by default.
- **Max attempts.** Default 3, 1–10. It counts Verdikt checks in one loop, the first one included,
  so 3 means at most two send-backs. 1 means report only.

Both only take effect while Verdikt runs automatically (**When** = `ui_changes` or `always`). With
`manual` they are disabled in the UI, and the API reports `autofix_applies: false`. Each task's
Verdikt section has an override: **Project default / On / Off**. Turning auto-fix off (project or
task), or switching Verdikt to `manual`, ends any running loop as "turned off".

### The loop

1. An automatic run started while auto-fix applies to the task is flagged `verdikt_runs.autofix`.
   Only flagged runs drive the loop. Manual runs never do, and neither does a run that started
   before auto-fix was switched on.
2. When a flagged run finishes, the loop judges it exactly once (attempt N of M). Three things
   enforce that: `autofix_done_at`, a per-task advisory lock and a UNIQUE Verdikt-run key on
   `verdikt_autofix_attempts`. So two pollers, a person's **Check now** and a retry can never send
   the task back twice.
3. **Fail** → the task goes `needs_verification → in_progress`. This is the same transition a
   person's reject makes: assignees are restored to `working`, and a pending AI-manager pre-review is
   superseded. The actor is the system identity `system:verdikt`, recorded as
   `actor_type='system'` with a `verdikt_auto_rework` event. It never impersonates a person.
   - **The agent's message** is posted to the task thread (a system line,
     `[Verdikt auto-fix] …`) and carried as `feedback` on the assignee's `task_verified` event
     (`approved:false`, `by:"system:verdikt"`, `verdikt_auto_rework:true`, `attempt`,
     `max_attempts`). That is the normal rework directive. It always wakes the agent through the
     event bus. The message, failures first:
     ```
     Verdikt failed this task on attempt 1 of 3. Embodent sent it back to you automatically … mark the
     task done again. Verdikt will check it again (2 more checks before a person takes over).

     Failed criteria:
     1. The error text is red
        Expected: the error text is red
        Actual: the error text is black
        Screenshot: /api/tasks/{tid}/verdikt/runs/{rid}/artifact?path=…
     Passed: 1 of 2 criteria.
     Verdikt's summary: …

     Report: /api/tasks/{tid}/verdikt/runs/{rid}/report
     Tested: web:http://127.0.0.1:5173/login
     Your changes on this attempt: /agents?agent=Pixel&changes={run}
     ```
     Links are portal paths. They become absolute when `ORCHA_PORTAL_BASE_URL` is set.
   - The send-back starts a **new verification round**: the evidence pack's round start is now the
     last person's reject *or* `verdikt_auto_rework`. When the agent marks the task done again, the
     existing auto-trigger fires once for that round. While a loop runs, it fires even under
     `ui_changes` for a rework that touched no UI file.
4. **Pass** → the loop stops and the task **stays in needs_verification**. The loop never completes a
   task (never self-certify). The humans get a `verdikt_autofix_stopped` notification and a push
   saying "Verdikt passed on attempt N of M — ready for your review". While a loop runs, the
   per-`/done` "Verify task" push and Slack ping are held back. People are told once, when it
   stops.

### Stop conditions

Each one is recorded on the loop with `stop_kind` and a plain-words `stop_reason`, and posted as a
`[Verdikt auto-fix] Stopped: …` line. The humans are notified, except when a person caused the
stop, and the task is left for a person:

| `stop_kind` | When |
|---|---|
| `pass` | Verdikt passed. |
| `attempt_limit` | The Nth failed check, where N is Max attempts. |
| `no_diff` | **No progress.** The agent marked the task done again with no code change at all in the new round (checked at hand-back, before Verdikt runs again), or the rework's code changes are byte-identical to the previous attempt's. Run diffs are cumulative against the base, so an identical diff means nothing changed. |
| `same_failure` | **No progress.** The same set of criteria failed with the same "actual" twice in a row (compared case- and whitespace-insensitively). |
| `non_fail` | Any outcome that isn't a test fail: blocked, unprocessable, warning-only, no verdict, unavailable, timeout, cancelled, failed to run, or no run could be started for the rework (no target, Verdikt switched off). |
| `budget` / `agent_paused` / `no_assignee` | The assignee hit a budget hard stop, its wakes are off (or the project's are, or the project isn't active), or nobody is assigned. |
| `human` | A person accepted, rejected, cancelled or reassigned the task. The loop ends in that same transaction. A late Verdikt answer then does nothing. |
| `stopped_by_human` | **Stop auto-fix** (task page or Verdikt section). |
| `turned_off` | Auto-fix was turned off for the project or the task, or Verdikt was made manual. |

A loop that stopped never restarts by itself. A new loop can start only after a person accepts or
rejects the task, which begins a new review cycle. The Stop button therefore really stops the
loop, and the agent's next hand-back simply waits for a person.

### Background check (results at 3am)

Results used to be polled only while someone viewed the evidence or a preview ran. Now two paths
poll them:

- **The portal**: a daemon thread (`application_lifecycle.start_verdikt_sweeper`). Every
  `ORCHA_VERDIKT_SWEEP_SECONDS` (default 12; `0` turns it off) it refreshes every in-flight run
  (each at most every 3 s, the existing throttle) and judges finished flagged runs. When idle, a
  pass costs two indexed queries.
- **The host notifier**: it calls `POST /api/containers/{cid}/verdikt/sweep` every 12 s while that
  answer says runs are in flight, otherwise once a minute (`notifier_verdikt_sweep.py`). If the
  portal thread is gone, the loop still closes.

Both are idempotent with each other and with any read (see step 2).

### UI

- **Task page** (any status while a current-cycle loop exists): a *Verdikt auto-fix* card. It
  shows "Auto-fix running: attempt 2 of 3" with **Stop auto-fix**, or the stop reason. Below that
  is the attempts timeline: "Attempt 1 ✗ 1/3 · Attempt 2 ✗ 2/3 · Attempt 3 ✓ 3/3". Each attempt
  links to its run evidence (the Verdikt report) and to *changes* (that attempt's captured diff).
- **Verdikt section** of the evidence pack: the same status and timeline, plus the per-task
  override.
- **Activity**: the system lines render as events ("Verdikt auto-fix sent it back to the agent —
  Verdikt failed attempt 1 of 3", with the failed criteria; "Verdikt auto-fix stopped").
- **Needs you** and the proof line: the loop's part comes first, for example "Verdikt passed on
  attempt 3/3" or "Auto-fix stopped: same failure twice". The full reason is in the tooltip. An
  older cycle's loop (a person has decided since) is not shown.

### Data

- `container_verdikt_settings.autofix_enabled` / `autofix_max_attempts`.
- `verdikt_runs.autofix` / `autofix_done_at`.
- `verdikt_task_autofix`: the override.
- `verdikt_autofix_loops`: one row per loop. At most one is `running` per task.
- `verdikt_autofix_attempts`: one row per judged run. `failed` holds `[{text, expected, actual}]`
  and `changes` holds `{summary, files, href, run_ids}`.

### Tested for real (2026-10-01)

The test used the e2e portal on :9440 (real uvicorn and Postgres, migrations through 068). The fake
Verdikt served real HTTP on :9441 and was scripted per scenario. A stub agent with no LLM drove only
the public API: it started a run, finished it with a diff, called `/done` with a work token, then
blocked on `/agents/{id}/wait` for its rework directive. Nothing called the sweep or polled Verdikt;
the portal's own sweeper closed every step.

- **fail → fail → pass**: the task was sent back after 4.6 s and 6.6 s with the directive above.
  The loop stopped `pass` ("Verdikt passed on attempt 3 of 3 — ready for your review"). The task
  stayed in needs_verification. Timeline: Attempt 1 ✗ 1/3 · Attempt 2 ✗ 2/3 · Attempt 3 ✓ 3/3.
- **fail → fail → fail**: two send-backs, then `attempt_limit` ("Verdikt failed 3 of 3 attempts —
  the attempt limit is reached, over to you").
- Needs you showed "Verdikt passed on attempt 3/3 · …" and "Auto-fix stopped: failed 3 of 3
  attempts · …". None of the page loads had page errors, console errors or 5xx responses.

