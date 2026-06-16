# Test Plan — ISS-31 watchdog · C1 digest-on-exit · SSE live feed (#58)

> Run these to verify + close out the three. All headless runs use **Invy** (the headless-only test
> agent — wake on, no live tab) so nothing intercepts the worker. Tim drives the assigns + checks; kedar
> does the deploy/ops + the final `/orcha-verify`.

## 0. Deploy prereqs (none of these fixes are live until deployed — ISS-20)
ISS-31 changes the daemon (notifier), C1 adds a Stop hook (settings.json + CLI), the SSE client is portal.
```bash
cd /Users/kedar/ai_apps/Orcha && orcha upgrade && orcha up          # portal + templates + migrations
kill "$(cat .claude/.orcha-notifier.pid)" && orcha notifier --ensure # daemon onto ISS-31 + C1 hook (run --ensure twice if "already running")
```
Confirm: daemon pid changed; `agent_reachability` for Invy still `wake_enabled=true`.

## Test 1 — ISS-31: progress-aware watchdog (slow-but-working survives past 300s)
**Setup:** assign Invy a task that produces output *continuously* for >300s:
> "Narrate a detailed walkthrough of the docs/ folder — ~1 short paragraph per file, no rush, keep
> producing steadily for about 6 minutes. Then stop. No file changes."
**Expected:** the wake-log keeps growing → the worker is **NOT killed at 300s** → its `worker_runs` row
ends `status=exited` (not `killed`) with `ended_at − started_at` **> 300s**. *(Pre-ISS-31 it'd be `killed` at 300s.)*
**Stall case** (the kill path) is covered by Forge's unit test (no log growth for N sec → killed); a boot-hang
worker also stalls → killed quickly. **PASS:** a continuously-progressing worker outlives 300s + completes.

## Test 2 — C1: digest write-on-exit (continuity accrues)
**Setup:** assign Invy a task with a clear decision:
> "Decide whether docs/ should have an index file; record your decision + 2-line reasoning to the task
> thread; then stop."
**Expected:** after the worker **exits**, `agent_memory_digests` has a **new row for Invy** reflecting that
focus/decision/open-threads. Then **wake Invy again** (a follow-up task) → it rehydrates (C2) and
**references the prior wake's decision** → proves N wakes read as one agent.
**Verify:** `select created_at,left(current_focus,60),left(decisions,80) from agent_memory_digests where agent_id='<Invy>' order by created_at desc limit 2;`

## Test 3 — SSE live feed (#58) — "see it stream in the portal"
**Status:** #58 is the **backend**, and it's **validated** (curl `-N` the `/stream` endpoint captured 9 live
NDJSON events). The reason kedar **"never saw the live feed"** is that the **portal client** that renders the
stream — the **SSE client EventSource** (task `199982a9`, Frame, still in flight) — isn't shipped/deployed yet.
So **#58 the backend is done**; the user-facing live feed closes out when the client lands.
**Test (once the SSE client is merged + deployed):** assign Invy a narration task → open Invy's run in the
portal (Tasks/Agents view) → its NDJSON appears **line-by-line, sub-second**, classified into the 9 types,
with open sections preserved. **PASS:** a running worker streams live into the portal (no wait for reap).

## Close-out mapping
- **ISS-31** (`2d3c6218`, needs_verification) → Test 1 → `/orcha-verify`.
- **C1** (`3851ef97`, needs_verification) → Test 2 → `/orcha-verify`.
- **#58 SSE backend** (`92ac722d`, needs_verification) → already curl-validated; `/orcha-verify` the backend now. The **live-feed UX** = SSE client (`199982a9`) + Test 3.
