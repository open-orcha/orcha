# GH #88 — Recycle a live resident after a same-runtime model switch

Issue: https://github.com/open-orcha/orcha/issues/88
Branch: `feat/gh88-model-switch-recycle`, based on `feat/gh91-90-conversation-work-lanes`
(PR #104's branch — CLEAN, awaiting merge). Basing on `main` is not viable: #104 rewrites
large parts of `service_residents` and `tests/test_resident_session.py`, the exact seams
this fix lands in. #88 runs PARALLEL to PR #106 (zero file overlap — #106 touches portal
`main.py`/frontend/migration only, never `notifier.py`). Merge order: #104 first, then
#106 and #88 in either order; GitHub auto-retargets both to `main`.

## Problem

`set_agent_model` (portal `main.py`, GAP B) already clears the pinned
`conversations.session_id` on an actual model change, so the **next resident spawn** is
forced cold and picks up the new `--model`. The remaining gap (the issue): if the resident
**process is still alive**, `service_residents` §1 only recycles it on a **runtime**
change (`runtime_changed` branch). A same-runtime switch (Opus → Sonnet) keeps the live
old-model process, and the next human turn is fed into it — the UI shows the new model
while the old model answers.

## Fix — `orcha-cli/orcha_cli/notifier.py`, `service_residents` only

No server/portal changes (GAP B already exists). No migration. No UI changes.

**1. Record the boot model on the live resident dict.**
- Claude boot dict (§2, next to `"runtime": RUNTIME_CLAUDE`): add `"model": c.get("model")`.
- Codex worker dict: add the same field for parity/observability only — no Codex check is
  needed, because Codex conversation workers are per-turn processes that exit after
  replying; the next spawn already reads `c.get("model")` fresh.

**2. Model-change recycle in §1**, immediately after the existing runtime-change check
(same shape, same deferral discipline):

```python
desired_model = cand.get("model") if cand else None
if (desired_model
        and _resident_runtime(r) == RUNTIME_CLAUDE
        and r.get("model") != desired_model
        and not r.get("awaiting_result")):
    if not quiet:
        print(f"[notifier] resident {r.get('alias')} model changed "
              f"{r.get('model')}→{desired_model} — recycling for a cold boot on the new model")
    _RESIDENT_RESUME_FAILED.add(conv_id)      # force COLD even if a session id is still pinned
    _close_resident(api_base, r, reason="model_changed")
    _retire_resident(api_base, live_residents, conv_id)
    continue
```

Guards, and why each exists:
- `desired_model` truthy — never churn when `active-conversations` omits the model
  (mirrors the runtime check's `desired_runtime is not None` conservatism).
- `_resident_runtime(r) == RUNTIME_CLAUDE` — Codex dicts carry no `awaiting_result`
  (the guard below would misread a mid-turn Codex worker as idle and kill it); cross-runtime
  switches are already handled by the runtime check one block above.
- `not r.get("awaiting_result")` — a mid-turn resident **finishes its current turn
  safely**; the recycle is NOT lost to the deferral because the §2 pre-feed guard (step 3)
  catches the resident the moment it goes idle. Same deferral pattern as `runtime_changed`
  and the #222 `cold_required` restart. This is the issue's "if the resident is mid-turn,
  finish the current turn, then force the next turn cold".
- Fires on an **idle** resident even with no pending turn (like `runtime_changed`) — closing
  an idle warm session is cheap and guarantees the next answer is on the new model. This
  idle-no-pending-turn case is the one §2 never reaches (it `continue`s on
  `last_turn_seq <= serviced`), which is why the §1 check stays even with step 3 added.

**3. Pre-feed guard in §2 (plan-review R1 fix — closes the same-tick capture race).**
The §1 check alone is insufficient: it runs **before** the in-flight result is captured.
In one tick, §1's capture block clears `awaiting_result` for a resident that just finished
its turn, and §2 then feeds an already-queued next human turn into that same old-model
process — and since the feed re-sets `awaiting_result`, §1's check defers again next tick;
with back-to-back queued turns the old-model resident survives indefinitely. So §2 gets a
guard on the **existing-resident feed path**, placed after the busy-skip
(`awaiting_result` → continue) and after the nothing-newer skip
(`last_turn_seq <= serviced` → continue), immediately before the `r is None` boot branch:

```python
desired_model = c.get("model")
if (r is not None
        and desired_model
        and _resident_runtime(r) == RUNTIME_CLAUDE
        and r.get("model") != desired_model):
    # Old-model resident is idle (a just-captured turn cleared awaiting_result this
    # same tick, or it was already idle). NEVER feed the queued turn into it —
    # recycle now and fall through to the r-is-None boot branch below, so the SAME
    # tick cold-boots on the new model and feeds the queued turn there.
    if not quiet:
        print(f"[notifier] resident {r.get('alias')} model changed "
              f"{r.get('model')}→{desired_model} — recycling before feed (cold boot)")
    _RESIDENT_RESUME_FAILED.add(conv_id)      # force COLD even if a session id is still pinned
    _close_resident(api_base, r, reason="model_changed")
    _retire_resident(api_base, live_residents, conv_id)
    r = None                                   # boot branch below spawns cold on the new model
```

Falling through with `r = None` (instead of `continue`) means the queued human turn is
answered on the new model **in the same tick** — no extra latency tick. The boot branch
recomputes `serviced` from `resolved_through`, claims a fresh resident lease, and
`_RESIDENT_RESUME_FAILED` forces the cold path even if the conversation still has a
pinned session id (the out-of-band-change case). Same guard set as §1's check
(`desired_model` truthy, Claude-only) for the same reasons.

**4. Cold guarantee.** In the API path, `set_agent_model` cleared `session_id` in the same
transaction that changed the model, so the same `active-conversations` scan that shows the
new model also shows `session_id=None` → §2 boots **cold with `--model <new>` in the same
tick** when a human turn is pending. The `_RESIDENT_RESUME_FAILED.add(conv_id)` is
belt-and-braces for out-of-band model changes (e.g. a direct DB edit) that skip the session
clear — it forces the next boot cold; the flag self-clears on that cold boot (existing
behavior) and on conversation end.

`_close_resident(reason="model_changed")` posts wake-ack kind `resident_model_changed` —
kinds are free-form strings there (`resident_runtime_changed`, `resident_digest_resync`
already exist), so no server change.

## Tests — `tests/test_resident_session.py` (reuse the existing `_wire` harness)

1. `test_service_residents_recycles_idle_resident_on_model_change` — the issue's requested
   test, end-to-end in one tick: live **idle** Claude resident with `model="claude-opus-4-8"`;
   scan candidate has the same runtime `claude`, `model="claude-sonnet-5"`, `session_id=None`,
   and a pending human turn. Assert: `resident_model_changed` wake-ack posted, old resident
   retired, AND §2 booted a fresh resident in the same tick with
   `spawn_resident(model="claude-sonnet-5", resume_session_id=None)` (cold).
2. `test_service_residents_defers_model_change_recycle_while_mid_turn` — same setup but
   `awaiting_result=True` and NO result ready in the log → resident kept this tick, no
   `resident_model_changed` ack, no kill (the turn is allowed to finish).
3. `test_service_residents_no_feed_to_old_model_resident_after_same_tick_capture` — the
   plan-review R1 race, end-to-end in ONE tick: live Claude resident mid-turn
   (`awaiting_result=True`) on `model="claude-opus-4-8"` with its finished `result` already
   in the log (so §1 captures it THIS tick); scan candidate shows same runtime,
   `model="claude-sonnet-5"`, and a NEWER human turn already queued
   (`last_turn_seq > serviced_seq`). Assert: the reply is captured and posted; the old
   process is NEVER fed the queued turn (`_send_user_turn` not called on the old proc);
   `resident_model_changed` ack posted; old resident retired; and a fresh resident is
   booted cold in the same tick with `spawn_resident(model="claude-sonnet-5",
   resume_session_id=None)` and fed the queued turn. Deleting the §2 pre-feed guard turns
   this red (the old proc gets the feed).
4. `test_service_residents_keeps_resident_when_model_unchanged` — candidate model equals the
   boot model → no recycle in §1 OR §2, feed proceeds to the existing resident (anti-churn
   tooth for both checks).
5. `test_service_residents_no_recycle_when_scan_omits_model` — candidate without `model`
   → no recycle (missing-data tooth).
6. `test_service_residents_records_boot_model` — after a §2 boot, the live dict carries the
   candidate's model (the field both checks depend on).

Teeth: each test is phrased so deleting the new check (or the new dict field) turns it red.

## Verification

- Full suite + smoke per `docs/orcha-test-runbook.md` (local `.venv-test`), plus the file's
  focused run. Expected baseline: the known pre-existing failures only.

## Non-goals

- Hard-interrupting a mid-turn resident (we defer to turn completion — matches the issue).
- Codex same-runtime model switching (per-turn workers already pick the new model up on the
  next spawn; stated here so the reviewer sees it was considered, not missed).
- Any change to `set_agent_model` — GAP B is already correct.
