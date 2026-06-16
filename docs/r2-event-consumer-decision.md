# R2.1 — Event-consumer offset model (decision)

**Status:** APPROVED — kedar approved, Tim (LEADER) signed off (2026-06-01).
**Scope:** how out-of-band consumers (the wake daemon) and interactive consumers
(`/orcha-listen`) track their position in the durable `agent_events` bus, and what
delivery guarantee the system provides.

## Decision

1. **The wake daemon reuses `agent_wake_state.delivered_ts` as its consumer offset.**
   No new `consumer_offsets` table. The daemon already advances `delivered_ts` via
   `POST /wake-ack` after a successful delivery; that column *is* the daemon's cursor.
   `wake-scan` only surfaces events newer than `delivered_ts`, so the offset and the
   wake decision read from one source of truth.

2. **Interactive `/orcha-listen` keeps its own client-side cursor** —
   `.claude/orcha-tabs/<alias>.last_event_ts`, advanced before acting on each event.
   It is a *separate* consumer from the daemon and must not share the daemon's
   server-side offset: a human watching a live tab and the headless daemon are two
   independent readers of the same per-agent stream, each at its own position.

3. **Delivery guarantee = at-least-once + idempotent mutations + full-drain ⇒
   effectively-once.** We do not build exactly-once delivery (impossible without
   distributed txns across the spawn boundary). Instead:
   - *at-least-once*: a crash between "act" and "advance offset" replays the event;
   - *idempotent mutations* (R2.3): replaying a mutation is a safe no-op;
   - *full-drain* (R2.2): a woken worker drains the entire backlog in one pass, so a
     missed wake never strands events — the next wake catches everything pending.
   Together these make reprocessing harmless and gaps self-healing.

4. **`consumer_offsets` table is DEFERRED (YAGNI).** A dedicated offset table only
   earns its keep when we need *multiple independent consumer groups per agent* or a
   durable offset for a non-wake consumer that isn't `/orcha-listen`. Neither exists
   today. Revisit if/when a second server-side consumer appears; until then the extra
   table is schema we'd migrate, back up, and reason about for no behavioral gain.

## Why not a dedicated offset table now

| | reuse `delivered_ts` (chosen) | new `consumer_offsets` table |
|---|---|---|
| Source of truth | one column, same row wake-scan reads | offset split from the wake decision |
| Migration cost | none (column exists) | new table + FK + backfill |
| Multi-consumer-group | not supported (don't need it) | supported (not needed yet) |
| Failure reasoning | "did we ack?" — one field | join across tables |

The reuse path is strictly simpler for the one consumer we actually have. The table
is a clean future extension, not a thing we're foreclosing.

## How this composes with R2.4 (single-flight)

R2.4's per-agent lease (`wake_lease_until`) bounds *concurrency* (one live worker per
agent); the `delivered_ts` offset bounds *re-delivery* (don't re-surface acked events).
They are orthogonal: the lease says "a reader is active, don't start another," the
offset says "this reader has consumed up to here." A one-shot worker claims the lease,
drains the full backlog (advancing `delivered_ts`), exits (releasing the lease early;
TTL is the crash-safe net). Effectively-once falls out of the three properties above —
the lease is not what provides it, it just stops duplicate *workers*.

## Follow-ups (this epic)

- **R2.2** — woken worker drains the *full* event set in one pass (not one event).
- **R2.3** — make request/task mutations idempotent (safe under replay).
