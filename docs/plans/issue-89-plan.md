# Plan — GH #89: human can acknowledge an agent's pending notifications; acknowledged items must not re-wake the agent

Issue: https://github.com/open-orcha/orcha/issues/89
Branch: `feat/gh89-notification-ack`, **stacked on `feat/gh91-90-conversation-work-lanes` (PR #104)** — see "Why stacked" below.

## Pain point (from kedar)

Sometimes the human does NOT want an agent to wake for a certain notification — the human
handles it themselves, so the agent shouldn't burn a wake + tokens acting on it. The human
needs per-notification veto power: "I've seen this — the agent must not act on it."

## The one deliberate deviation from the issue spec (read this first)

Issue #89 proposes implementing suppression by **advancing `agent_wake_state.delivered_ts`**
to the acked event's ts (GREATEST). Written pre-#104, that mechanism is now wrong on two counts:

1. **Cursor advance swallows neighbors.** `delivered_ts` is a *cursor*, not a per-row flag.
   If two events are pending (ts1 < ts2) and the human acks only ts2, jumping the cursor to
   ts2 silently suppresses ts1 too — an event the human never acked. The pain point is
   "suppress the wake for a *chosen* notification", so per-row precision is the requirement.
2. **PR #104 split the cursor into lanes.** `delivered_ts` is now the WORK-lane cursor and
   `conv_delivered_ts` the CONVERSATION-lane cursor (migration 030). A single-cursor advance
   would leave the conversation lane un-suppressed (a human chat-ack path would still see the
   event), or force lane-aware double bookkeeping in the ack endpoint.

**Instead: a per-event marker.** Migration 031 adds `human_acked_at TIMESTAMPTZ` (nullable)
to `agent_events`. Every query that computes "pending events that justify waking / surfacing
work" adds `AND human_acked_at IS NULL`. This is lane-agnostic (both lanes' pending queries get
the same filter), per-row precise (no neighbor swallow), idempotent, and never moves any cursor
— so it composes cleanly with #104's lane machinery and cannot regress cursor semantics.
Cursors still advance past acked rows naturally (`max_ts` stays computed over ALL events,
unchanged), so acked rows never accumulate uncounted.

The issue's other components (pending feed, bulk ack, clock-wake snooze, per-agent panel with
badge) are built as specced, adjusted to this mechanism.

## Why stacked on PR #104

#89's server changes land inside `wake_scan()` and the conversation-drain path, both of which
PR #104 rewrote heavily (lane split). Branching off `main` would guarantee conflicts with a
CLEAN, merge-pending PR. So this branch is based on `feat/gh91-90-conversation-work-lanes` and
its PR will use that branch as base; when kedar merges #104 (first, per the agreed order),
GitHub auto-retargets this PR to `main` and the diff stays #89-only.

Migration numbering: 030 is taken by #104 → this is **`031_notification_ack.sql`**.

---

## 1. Migration `031_notification_ack.sql`

```sql
-- GH #89: per-event human acknowledge — "I've seen this, the agent must not act on it".
ALTER TABLE agent_events ADD COLUMN IF NOT EXISTS human_acked_at TIMESTAMPTZ;

-- GH #89: clock-wake snooze — suppress the *scheduled* (auto_wake_interval_secs) wake until
-- this instant without disabling auto-wake permanently. TIMESTAMPTZ (not epoch DOUBLE
-- PRECISION as the issue sketched) because every comparison is against now() in SQL, same as
-- the lease columns beside it.
ALTER TABLE agent_wake_state ADD COLUMN IF NOT EXISTS snooze_until TIMESTAMPTZ;
```

Idempotent `ADD COLUMN IF NOT EXISTS`, per the 009/011/030 convention. No index on
`human_acked_at`: every consuming query already narrows by `event_key = <aid> AND ts > <cursor>`
through the existing `(event_key, ts, id)` index, and acked rows are a tiny fraction of the
band that survives that range scan — a partial index would be dead weight.

## 2. Server — acknowledge endpoint (the core)

`POST /api/agents/{aid}/notifications/{event_id}/acknowledge` (portal `main.py`)

Body: `{ "suppress_wake": true }` (default **true** — the default must suppress; `false` gives
mark-read-only semantics for this row).

Behaviour:
- 404 if the event row doesn't exist or belongs to a different agent (`event_key != aid`).
- 400 if the event's name is in `_NOTIF_SUPPRESSED` (`digest_snapshotted`,
  `conversation_turn`) — these never surface in the feed, so a human can't have "seen" them;
  refusing protects the conversation lane from a client bug acking an un-consumed live chat
  message out of existence (see the bulk-ack guard below, same rationale).
- `suppress_wake=true` → `UPDATE agent_events SET human_acked_at = now() WHERE id = %s AND
  human_acked_at IS NULL` — idempotent; re-acking an already-acked row is a 200 no-op.
- The acked row must render as "read" in the feed. We do NOT advance `read_through_ts`
  per-row (that's a cursor too — same neighbor-swallow problem, it would visually mark older
  unread rows read). Instead the feed's `read` flag becomes
  `ts <= read_through_ts OR human_acked_at IS NOT NULL`.
- `suppress_wake=false` semantics: stamp nothing; pure no-op kept for API-shape compatibility
  with the issue. (Mark-read-without-suppress already exists as `POST notifications/read
  {through_ts}`; a *per-row* read marker would need a second column for near-zero value. The
  response echoes `{"suppressed": false}` so the client knows nothing changed.) The panel
  always sends `true`.
- Response: `{"agent_id", "event_id", "suppressed": bool, "human_acked_at"}`.

**Explicitly NOT done:** no `delivered_ts` / `conv_delivered_ts` writes anywhere in this
endpoint. Suppression comes only from the pending-query filters (§3). An in-flight wake that
already picked the event up in its manifest is not cancelled (issue accepts this).

**Scope boundary (documented in the endpoint docstring + UI copy):** acknowledge suppresses
*event-driven* wake reasons. State-driven reasons are untouched by design: an OPEN task
request keeps `has_pending_task_request` true and an assigned-ready task keeps `auto_tasks`
non-empty — both still wake the agent, because the underlying WORK still exists and hiding its
notification must not orphan it. The veto for those is answering/rejecting the request or
unassigning the task (the panel deep-links there via the row's existing `deeplink`).

### Bulk: extend `POST /api/agents/{aid}/notifications/read`

Add optional `suppress_wake: bool = false` to the `NotificationsRead` model. When true, after
the existing cursor UPSERT also run:

```sql
UPDATE agent_events SET human_acked_at = now()
 WHERE event_key = %s AND ts <= %s AND human_acked_at IS NULL
   AND event_name <> ALL(%s)   -- _NOTIF_SUPPRESSED guard
```

with `%s` = the (possibly defaulted) `through_ts`. Bulk is *bounded by ts* — matching the
existing "mark all read up to here" semantics — and is what "Acknowledge all" uses. The
`_NOTIF_SUPPRESSED` exclusion is load-bearing: you can only ack what the feed can show you.
Without it, "Acknowledge all" would stamp un-consumed `conversation_turn` events and the
resident drain would skip the human's own pending chat messages — a silent message-eater.
Existing callers are unaffected (flag defaults false; response only gains `"suppressed_count"`).

## 3. Server — filter acked events out of every "should the agent act on this?" query

All in portal `main.py`; each gets `AND human_acked_at IS NULL` (line numbers per the #104
branch as of `git merge-base`, will shift):

| Site | Function / route | Why |
|---|---|---|
| ~4690 | `wake_scan` pending count (`count(*) FILTER ... ts > delivered_ts`) | the wake decision itself |
| ~4700 | `wake_scan` latest-event lookup | reason string / triage hint must not name an acked event |
| ~4728 | `wake_scan` `request_answered` → `wake_task_id` fallback | acked answer must not attribute the wake |
| ~631 | `_wake_notification_manifest` | acked events must not appear in the wake manifest |
| ~4202 | `_collect_directed_messages` | an acked `prompt`/`task_message` must not be injected into the turn (this IS the delivery path for nudges — acking a nudge is the human eating it) |
| ~4328–4338 | `active_conversations` conversation-lane pending count / max-ts subqueries | same veto must hold for the resident-drain path (lane-agnostic requirement) |
| ~168 | `_fetch_next_event` (long-poll `/orcha-listen` delivery) | a live listener must not be handed an acked event. Safe: it returns the next *unacked* row, whose later ts advances the caller's cursor past the acked one; if none, the poll blocks as today |

`max_ts` / ack-through computations stay over ALL events (unchanged) so wake-acks advance
cursors past acked rows and they never linger. `_NON_WAKING_EVENTS` /
`_WORK_NON_WAKING_EVENTS` handling is orthogonal and unchanged.

The notification *feed* (`GET notifications`) deliberately does NOT filter acked rows out —
they stay visible, dimmed as read (`read` flag per §2), so the human can see what they acked.
The *pending* feed (§5) does filter them.

## 4. Server — clock-wake snooze

`POST /api/agents/{aid}/wake/snooze`, body `{"snooze_seconds": 3600}` or `{"until_ts":
<epoch>}` (exactly one; 422 otherwise). `snooze_seconds: 0` (or `until_ts` in the past)
clears the snooze (sets NULL). UPSERTs `agent_wake_state.snooze_until` (same upsert shape as
`wake_ack` uses for that table). Response `{"agent_id", "snooze_until"}`.

`wake_scan` change — one term:

```python
auto_wake_due = bool(
    auto_interval is not None
    and (secs_since_woken is None or secs_since_woken >= auto_interval)
    and not snoozed)          # snoozed = snooze_until IS NOT NULL AND snooze_until > now()
```

(SELECT gains `w.snooze_until` + a computed `snoozed` bool; candidate row surfaces both for
the portal/debug.) **Only** the `auto_wake_due` term is gated — event wakes, ready-task wakes
and owed-task-request wakes fire normally during a snooze, exactly as the issue specifies.

## 5. Server — pending feed

`GET /api/agents/{aid}/notifications/pending?limit=&before_ts=&before_id=`

Same query/classify/paginate machinery as the existing feed (shared helper extracted from
`agent_notifications` rather than copy-pasted), differing only in:
- filter `ts > read_through_ts AND human_acked_at IS NULL` (only items still awaiting the human),
- no `zone` param — returns both zones (the panel shows everything pending),
- response envelope adds `"total_pending"`: `SELECT count(*) FROM agent_events WHERE
  event_key=%s AND ts > <read_through_ts> AND human_acked_at IS NULL AND event_name <> ALL(
  _NOTIF_SUPPRESSED)`. Classify-time drops are name-driven and the constant already exists
  (`_NOTIF_SUPPRESSED`, main.py ~515), so the count stays honest with what the panel renders.
  Row shape gains `"event_id"` (= `agent_events.id`, needed by the acknowledge button; the
  existing feed rows gain it too — additive, no break).

Badge source: `total_pending` (cheap count query; the portal polls it with the same cadence it
already polls agent state).

## 6. Frontend (portal `static/app.js` + `index.html` + CSS)

The existing notification center (`ncToggle`/`ncOpen`/`ncLoadFeed`/`ncMarkAllRead`,
`#attnPill`) stays as-is. New, per-agent:

- **Bell + badge on each agent roster row** (`agents.html` roster, next to the existing
  `embodBadge()` slot in app.js's roster renderer): shows `total_pending` when > 0.
  Data comes piggybacked on the overview's existing per-agent refresh loop (one added
  `/notifications/pending?limit=1` call per agent per poll is acceptable at Orcha's agent
  counts; if the overview already batch-fetches agent rows, expose `total_pending` there
  instead — decided at implementation by whichever endpoint the overview actually hits, noted
  in the PR).
- **Panel "Pending notifications — <Agent>"** (drawer/modal off the bell):
  - rows: plain-English label (reuse the feed's classified `type`/`preview`/`actor_alias` —
    `_classify_notification` already produces human phrasing), relative timestamp, deeplink.
  - per-row **Acknowledge** → `POST .../notifications/{event_id}/acknowledge`
    `{suppress_wake:true}`, optimistic row removal, rollback on non-2xx.
  - **Acknowledge all** (header) → confirm step → `POST .../notifications/read`
    `{suppress_wake:true}`; clears list.
  - rows whose event is an open task request or ready task get a one-line hint: "the agent
    will still see this open request/task — acknowledging only hides the notification"
    (honest about the §2 scope boundary). Detection: classified `type` for request/task kinds.
  - **Snooze scheduled wake** button — rendered only when the agent has
    `auto_wake_interval_secs` set; choices 1h / 4h / until tomorrow 9am (client computes
    `until_ts`); shows active snooze + a "clear" affordance.
  - empty state per the issue.

## 7. Tests (`tests/`, pytest against the throwaway Postgres, same fixtures as
`test_conversation_lane.py` / `test_wake.py` on this branch)

New file `tests/test_iss89_notification_ack.py`:

1. **ack removes the wake reason**: publish 1 event → wake-scan `should_wake` true → ack it →
   `should_wake` false, `pending_events` 0.
2. **no neighbor swallow (the spec deviation's teeth)**: publish ts1 < ts2, ack ts2 only →
   wake-scan still counts ts1 pending, manifest contains ts1 and not ts2. (This test FAILS
   under the issue's original cursor design — it is the reason for the deviation.)
3. **lane coverage**: an acked directed `prompt` is absent from the `active_conversations`
   resident-drain surface while an unacked one beside it still appears (the veto holds on the
   conversation lane, not just the work lane).
4. **directed-message veto**: acked `prompt` event is absent from `_collect_directed_messages`
   output (wake prompt) while an unacked one beside it still surfaces.
5. **idempotent + guards**: double-ack 200 no-op (`human_acked_at` unchanged on 2nd call); ack
   of a foreign/unknown event id → 404; ack of a `conversation_turn` → 400.
6. **bulk**: `notifications/read {suppress_wake:true}` stamps all rows ≤ through_ts EXCEPT
   `_NOTIF_SUPPRESSED` names (a pending un-consumed `conversation_turn` survives bulk ack and
   still reaches the resident drain — the message-eater guard), leaves newer rows pending;
   without the flag stamps nothing (existing behaviour regression-pinned).
7. **pending feed**: returns only unread+unacked, both zones, `total_pending` matches, rows
   carry `event_id`; acked row still appears in the *regular* feed with `read: true`.
8. **snooze**: `auto_wake_due` true → snooze → false while only the clock reason exists; a
   real event during snooze still yields `should_wake` true; `snooze_seconds: 0` clears;
   expired snooze self-clears (no wake suppression after `snooze_until`).
9. **listener path**: `_fetch_next_event` skips an acked row and returns the next unacked one.

Frontend: new `tests/portal/pending_ack.test.js` following the existing
`tests/portal/notification_center.test.js` vm-sandbox pattern — badge renders from
`total_pending`, per-row ack POSTs and optimistically removes the row, ack-all requires the
confirm step, snooze button only renders with `auto_wake_interval_secs` set.

Teeth-check protocol (per runbook): each production filter stashed → its test goes red.
Full suite + smoke must match the branch baseline (1427 passed / 1 accepted-red / 1 xfailed,
smoke 4) plus the new tests.

## 8. Out of scope (per issue)

- cancelling an in-flight wake already holding the manifest
- per-notification defer/snooze (only the per-agent clock snooze)
- audit trail of who acked (single-human deployments today; `human_acked_at` alone)

## 9. Files touched

- `orcha-cli/orcha_cli/templates/migrations/031_notification_ack.sql` (new)
- `orcha-cli/orcha_cli/templates/portal/main.py` (ack endpoint, read-bulk flag, pending feed,
  snooze endpoint, 7 query-site filters, wake-scan snooze term)
- `orcha-cli/orcha_cli/templates/portal/static/app.js` (+ `agents.html`/CSS as needed): bell,
  badge, panel, snooze UI
- `tests/test_iss89_notification_ack.py` (new), `tests/portal/pending_ack.test.js` (new)
- no notifier-daemon (`notifier.py`) changes: the daemon consumes wake-scan candidates; all
  decisions move through the server, which is where the filters live.
