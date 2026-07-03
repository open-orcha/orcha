# Flow 06 — Worker runs (list · live log · stop)

Mockups: [`../mockups/06-runs.html`](../mockups/06-runs.html)

> **Status: ships entirely against the existing API.** Runs list, SSE log stream, and stop are all
> in `/openapi.json` today. This flow covers the runs section inside a task detail (flow 05 §3.8)
> and the full-screen run-log viewer; the identical viewer is reused from the Agent detail screen
> (flow 09).

## 1. Story

When an agent wakes for a task, a **worker run** exists — the single most "alive" thing in Orcha.
The phone's job is to make watching one feel like watching a terminal over someone's shoulder:
the task detail lists the task's runs; tapping a run opens a full-screen, mono, color-keyed log
that streams live while the run executes, and reads as a clean transcript after it finishes. A
running run can be stopped from here (destructive, confirmed).

## 2. Runs list (section inside Task detail)

Section header **"Worker runs"** with count, below the thread row (flow 05). One row per run,
newest first:

```
[run 9f3c21]  [avatar] Dana   [running ●]   started 6m ago          ›
[run 41d87f]  [avatar] Dana   [finished]    2h ago · 4m 12s         ›
```

- **Run id** — short mono tag (first 6 chars), JetBrains Mono, `tag`-style.
- **Agent** — small avatar + alias (the agent the run belongs to; needed for the stream URL).
- **State chip** — pill, word + dot: `running` = `s-accent` with pulsing dot · `finished` =
  `s-ok` · `stopped` = `s-idle` · any error/failed state = `s-danger`. Unknown states render
  verbatim in `s-idle` (never drop).
- **Timing** — started-ago while running; ended-ago + total duration once terminal.
- Row tap → Run detail. Section collapsed to the first 3 rows + "All runs (N)" when longer.
- **Empty:** inline note in the section — "No runs yet — appears when a worker wakes for this
  task." (portal copy parity). Not a full-screen state.

## 3. Run detail (streaming log)

Full screen. Header: short run id (mono) as title; subheader row: agent avatar + alias, task
title (tappable back-reference), started-at. A `live` connection chip while streaming.

- **Log view** — the `.log` component: JetBrains Mono 11.5/1.55, pre-wrapped, full-bleed card.
  Color keying by line kind, matching the portal log language:
  - timestamps / frame markers → faint (`ln-t`)
  - tool invocations → accent (`ln-acc`)
  - success / completion lines → ok (`ln-ok`)
  - warnings → warn (`ln-warn`), errors → danger (`ln-err`)
  - plain output → default `text2`
- **Live cursor** — a pulsing block cursor sits at the end of the last line while the stream is
  open; it is the "this is live" signal (with the `live` chip), and disappears on terminal.
- **Auto-scroll (pin-to-bottom)** — on by default: new lines keep the view pinned to the bottom.
  Any upward user scroll disengages it and a floating pill appears ("Auto-scroll paused ·
  **Jump to latest**"); tapping the pill re-pins. Mirrors every terminal/chat convention — never
  fight the user's finger.
- **Terminal banner** — when the stream reports the run ended, a banner pins above the log:
  ok-style "Run finished · {duration}" / idle "Run stopped · {duration}" / danger
  "Run failed · {duration}". The log below stays scrollable; cursor and Stop disappear; the
  stream closes.
- **Stop run** — visible only while `running`: a destructive-tonal button in the header area.
  Confirm first (Android AlertDialog / iOS confirmationDialog): *"Stop this run? {agent}'s worker
  is interrupted mid-turn. The log so far is kept and the run is marked stopped."* Confirm →
  `POST /api/runs/{run_id}/stop`. On success the terminal banner appears via the stream (or via
  the refetched run row if the stream already dropped).
- **Utilities:** long-press a line to copy it; overflow menu offers "Copy all" and "Share log".

## 4. Screens & states (mockup frames)

| Frame | Screen | Notes |
|---|---|---|
| R1 | Runs section in task detail (Android, dark) | run rows: mono id, agent, state chips, timing; empty-note variant described in §2 |
| R2 | Run detail — streaming (iOS, dark) | color-keyed `.log`, pulsing cursor, live chip, auto-scroll pill, Stop |
| R3 | Run detail — finished (Android, light) | terminal banner with duration; no cursor, no Stop |
| R4 | Stream connect error (iOS, dark) | danger banner + frozen log + Retry; falls back to run-row polling |
| R5 | Stop-run confirm (Android, dark) | AlertDialog, destructive confirm |

Unreachable container: the flow-04/05 danger banner pattern; the log freezes with the same
"stream lost" treatment as R4.

## 5. Behavior (data & realtime)

- **Runs list:** `GET /api/tasks/{tid}/runs` fetched with the task detail; invalidated by task
  SSE events and by pull-to-refresh on the detail screen. While any run is `running`, the section
  header shows the pulsing `live` chip (portal parity).
- **Log stream:** opening Run detail connects `SSE GET /api/agents/{aid}/runs/{run_id}/stream`
  (`aid` comes from the run row). Lines append as events arrive; the client keeps the full
  transcript in memory for the screen's lifetime (no partial windowing in v1).
- **Lifecycle:** the stream closes when the screen is popped or the app backgrounds; reopening
  reconnects and replays from the server (the stream endpoint serves the transcript
  from the start — dedupe by line index).
- **Stream connect/drop error:** danger banner over the frozen log — "Stream disconnected —
  Retry". Retry reconnects; meanwhile the run row's state keeps updating via the events SSE /
  30s poll, so a run that finished while disconnected still resolves to its terminal banner.
- **Finished runs:** open the same screen; the endpoint replays the stored transcript and closes
  — terminal banner immediately, no cursor, no Stop.
- **Stop:** optimistic chip flip to `stopped` only **after** the 2xx; failures snackbar/toast
  ("Couldn't stop the run") and leave state untouched.

## 6. Platform notes

- **Android:** run detail is a pushed destination with a collapsing top app bar (id + meta
  collapse to a compact bar over the log); Stop confirm = M3 AlertDialog; auto-scroll pill is an
  M3 assist-chip floating above the gesture bar; log text selectable via long-press.
- **iOS:** pushed in the tab's `NavigationStack`, inline nav title (mono run id); Stop confirm =
  `confirmationDialog`; auto-scroll pill floats above the home indicator; swipe-back pops (the
  stream closes on pop).
- Both: screen stays awake while a stream is live (idle-timer off); log honors the mono type
  ramp, never Dynamic-Type-scales past 130% (readability of pre-wrapped output).

## 7. Endpoints used

| Action | Endpoint | Status |
|---|---|---|
| Runs of a task | `GET /api/tasks/{tid}/runs` | exists |
| Live / replayed log | SSE `GET /api/agents/{aid}/runs/{run_id}/stream` | exists |
| Stop a running run | `POST /api/runs/{run_id}/stop` | exists |
| Run-row liveness between streams | SSE `GET /api/containers/{cid}/events` (+30s poll fallback) | exists |
