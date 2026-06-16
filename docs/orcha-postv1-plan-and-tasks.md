# Orcha — Post-v1 Plan & Tasks (deferred backlog)

> Features deliberately **out of the v1 push** (Refactor R1–R3 → Engine A1–A5 → Continuity C1–C3 →
> Surface B0–B10 → terminal-free E2E acceptance). Captured here so they're not lost; **triage into the
> active plan once v1 ships.** Numbered `PV1-N` (with `.M` subtasks, mirroring the `ISS-N.M` convention).
> Companion to `docs/orcha-portal-pivot-{plan,tasks}.md` (v1) and `docs/orcha-issues-log.md`.

---

## PV1-1 — Task hierarchy / subtasks  (kedar 2026-06-02)
*Why:* tasks (and the issues log) are **flat**. Orcha today has only a dependency DAG
(`task_dependencies` = "blocks-on", precedence) + an `is_root` flag — **no `parent_task_id` / parent-child
containment.** As the project grows, a flat tasks list *and* a flat issues log get noisy; e.g. "ISS-8.1/8.2
should be subtasks of ISS-8" has no in-product home (only the `ISS-N.M` doc convention). This also makes
the portal tasks view, the B1 worker feed, and the request graph harder to navigate at scale.
- **PV1-1.1** schema: `parent_task_id` on `tasks` (or a `task_parents` edge) — **distinct from
  `task_dependencies`** (containment ≠ precedence). Keep `is_root` consistent.
- **PV1-1.2** API: create-as-subtask, list children, **status rollup** (parent reflects children), guard
  against cycles.
- **PV1-1.3** portal: **collapsible groups** (epic → task → subtask) in the tasks view; reuse the grouping
  for the B1 feed + the request graph.
*Verify:* create a parent + 2 subtasks → portal shows them nested/collapsible; parent rollup reflects child
states; `depends_on` precedence still works independently.

## PV1-2 — Request-graph aggregation view  (deferred from the B-series, 2026-06-02)
*Why:* a container-wide **directed graph** of agent↔agent requests — nodes = agents (+human), edges =
requests with direction/status/age/chain — the coordination + bottleneck view ("who's blocked on whom,
which asks are overdue").
- **PV1-2.1** one read endpoint aggregating requests into nodes+edges. **PV1-2.2** a portal graph view.
*Verify:* the graph surfaces who's-blocked-on-whom and overdue asks across the whole container.

## PV1-3 — Conversational / multi-turn requests (ISS-25)  — ⚠ SCOPE PENDING (v1 or here)
*Why:* a request is one `payload` + one `response`, no history. Make requests **threaded**: two states
(`open`/`closed`, "answered" → derived whose-turn hint), **message-driven notifications** (each turn emits
an event that wakes the recipient — the "bump"), **close-only-when-fully-addressed**, and the
**FYI-vs-request split** (one-way announcements stop clogging the open queue). Full design in
`docs/orcha-issues-log.md` (ISS-25).
*Status:* **kedar to decide v1-or-here.** Lands here if deferred; promote into the v1 plan if not.

## PV1-4 — Continuity summaries (C3)
*Why:* condense long task/agent threads into a portal-readable summary (needs the Haiku / API-key
decision). Already marked "deferred from v1" in `orcha-portal-pivot-tasks.md` (C3).
*Verify:* request a summary of a long thread → coherent condensed text.

## PV1-5 — Warm worker pool / wake latency
*Why:* every headless wake is a **cold `claude -p`** (~1 min incl. boot + hooks). Fine for async, not
instant. A warm/pre-booted worker pool (or a persistent session per agent) would cut wake→response
latency. Optimize **after** the headless path is proven reliable (Engine + ISS-21/ISS-8 done).
*Verify:* wake→first-action latency drops materially vs the cold-start baseline.

---

## PV1-6 — Live feed via server-push (SSE) + incremental rendering  (kedar 2026-06-02)
*Why:* B1's feed polls every 3s and re-renders the whole view via `innerHTML` — crude: it loses open
`<details>`, scroll, selection, focus, and flickers (ISS-28 only band-aids the open-details part). And a
run's content only lands at **reap** (`worker_runs.output` filled on finish) — A1's live NDJSON isn't
exposed incrementally — so there's no true token-level streaming of an in-progress worker.
- **PV1-6.1** stream a running worker's NDJSON to the portal via **SSE** (one-way server→client; plain
  HTTP, auto-reconnect — simpler than WebSocket, which is only needed for bidirectional steering that
  already has the event-bus path). Source: tail the per-wake log as it grows / push on each new line.
- **PV1-6.2** **incremental rendering** — append new feed entries + patch status/diff in place; never
  rebuild the DOM. Preserves open `<details>`, scroll, selection naturally (supersedes the ISS-28 patch).
- **PV1-6.3** expose in-progress run output (not just at reap) so the feed truly streams.
*Verify:* a running worker's log appears line-by-line in the portal sub-second, with no full re-render;
expanded sections + scroll position survive indefinitely while new entries stream in.
*Note:* ISS-28 is the interim fix for v1; PV1-6 replaces the polling mechanism wholesale.

## How to use
Items numbered `PV1-N` (+ `.M` subtasks). When v1 ships, **triage** each into the active pivot plan or
close as won't-do. Cross-reference `docs/orcha-issues-log.md` where an item has a logged issue (e.g.
ISS-25 ↔ PV1-3). Nothing here competes with the current Engine/Surface push.
