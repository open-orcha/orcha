# Orcha efficiency — tokens-vs-quota meter & control-project baseline (#289)

Part of the EFFICIENCY epic (#284). This is the **measurement backbone**: before we can claim a
runtime fix made boot *cheaper*, we need (a) a meter that says how many tokens a wake actually
spent, and (b) a clean control where that number isn't drowned out by task-specific source reads.

---

## 1. The meter (tokens vs quota)

Every headless/resident wake is a `claude -p --output-format stream-json` invocation whose
terminal `result` event carries a `usage` object + `total_cost_usd`. The daemon now parses that
(`notifier._usage_from_log`) and records it on the wake's `worker_runs` row on `/finish`
(migration `019_worker_run_tokens.sql`):

| column | meaning |
|---|---|
| `input_tokens` | fresh input tokens |
| `output_tokens` | generated tokens |
| `cache_creation_input_tokens` | input tokens written to the prompt cache |
| `cache_read_input_tokens` | **cached input tokens read — cheap in $, still count against quota** |
| `total_cost_usd` | dollar cost the CLI reported |

**Why sum all four against quota.** Cache reads are nearly free in dollars but still consume the
plan's token quota. A wake can look cheap (`$0.02`) while reading millions of cached tokens —
that is the burn that hid behind the dollar figure. So the quota signal is
`total_tokens = input + output + cache_creation + cache_read`; dollars are reported alongside,
never as the quota number.

### Read it

```
GET /api/containers/{cid}/token-usage
```

Returns rolling windows + a per-agent breakdown + the most-recent single wake:

```jsonc
{
  "container_id": "...",
  "windows": {
    "5h":  { "input_tokens": …, "output_tokens": …, "cache_read_input_tokens": …,
             "cache_creation_input_tokens": …, "total_tokens": …, "total_cost_usd": …,
             "runs": …, "quota_tokens": null, "pct_of_quota": null },
    "7d":  { … },          // the weekly quota window
    "all": { … }           // since the container was created
  },
  "per_agent": [ { "agent_id", "alias", "runs", "total_tokens", "total_cost_usd" }, … ],
  "last_wake": { "run_id", "agent_alias", "ended_at", "total_tokens", "total_cost_usd" }
}
```

- `5h` ≈ the rolling session-quota window; `7d` ≈ the weekly quota.
- **pct-of-quota** appears only when an operator pins the ceiling (the server can't know the
  plan), via env on the portal container:
  - `ORCHA_QUOTA_5H_TOKENS` → fills `windows.5h.pct_of_quota`
  - `ORCHA_QUOTA_WEEKLY_TOKENS` → fills `windows.7d.pct_of_quota`

  Unset/invalid → `quota_tokens: null`, `pct_of_quota: null` (raw consumption only — no invented
  number).
- Only wakes that recorded usage contribute. Rows finished before mig 019, still-running runs, or
  runs with no parseable `result` event are simply absent (NULLs treated as 0).

> **Known limitation (V2).** A *resident* worker that handled several turns in one process logs
> one `result` event per turn; `_usage_from_log` reads the **last**, i.e. the cumulative usage of
> its final turn. For the **ephemeral headless** worker — the dominant per-wake cost and the
> control-project case — there is exactly one `result` event, so the recorded number IS the whole
> wake. Per-turn resident accounting is deferred.

---

## 2. The clean control project

In this repo, a wake's tokens = **per-wake runtime overhead + task-specific orcha source reads**.
The second term is large and varies by task, so it masks movement in the first. The control
project removes it: a separate Orcha stack pointed at a *trivial non-orcha* repo, where a wake's
tokens ≈ **just the intrinsic overhead** + a tiny task. That isolates the signal we are trying to
shrink and lets us diff before/after a fix.

> Fixes are developed **here** (the only place orcha source exists to edit). The baseline and the
> before/after validation **run in the control project.**

### Stand it up (once)

1. Make a throwaway project — a directory with a couple of trivial files and nothing orcha-shaped:
   ```bash
   mkdir -p /tmp/orcha-control && cd /tmp/orcha-control
   git init -q && printf 'hello control\n' > README.md && git add -A && git commit -qm init
   ```
2. Init an Orcha stack there on its own ports (do **not** reuse this repo's stack):
   ```bash
   orcha init --as You          # follow the prompts; note the api_base_url it prints
   ```
3. Register **one** agent and give it a **tiny** recurring task (e.g. "append one line to NOTES.md
   and post a one-sentence status"). Keep the task body small so task tokens stay near-zero and
   the overhead dominates.
4. Let it wake a handful of times (event-driven, or enable a slow auto-wake interval). Each wake
   writes a `worker_runs` row with usage.

### Measure & diff

From **this** repo (the script is here; it talks to the control stack over HTTP):

```bash
# capture a baseline BEFORE applying a runtime fix
python3 tools/efficiency/control_baseline.py snapshot \
    --api-base http://localhost:<control-port> --label pre-fix

# … apply the runtime fix here, `orcha upgrade` the control stack, let it wake again …

# capture AFTER, then diff
python3 tools/efficiency/control_baseline.py snapshot \
    --api-base http://localhost:<control-port> --label post-fix
python3 tools/efficiency/control_baseline.py diff          # two most recent, or pass two files
```

`diff` prints per-window deltas for every token kind, the dollar delta, and **mean tokens/wake**
(the headline control number — total ÷ wakes over the `all` window). A successful boot-overhead
fix shows mean tokens/wake going **down** with the task held constant.

Baselines are written to `tools/efficiency/baselines/*.json` (gitignored — they're machine- and
run-specific; commit one only if it's a reference figure worth keeping).

`--container` is optional: with a single container on the stack (the 1:1:1 default) the script
auto-resolves it; pass it explicitly only if you have more than one.

---

## 3. The other axis — continuity quality (#284)

Cost is only half the backbone. A wake-boot exists to give the resumed agent **reasoning
continuity** — it must still know what it was doing, what it decided, what it learned, and what
is still open. The cheapest possible boot ships an empty prompt; it is also useless. So before
we celebrate a fix that drove mean tokens/wake **down**, we have to prove it didn't get there by
**throwing continuity away**. That guardrail is `tools/efficiency/continuity_eval.py` (#284) —
the eval #286/#287 tune against.

### What it scores

A boot's continuity = how much of the agent's snapshotted working-state (its memory **digest**:
`current_focus`, `decisions`, `learnings`, `open_threads`) actually survives into the boot
context the resumed agent sees. That context is composed by the **real** renderer
`notifier.format_persona` — the same `--append-system-prompt` text a cold wake injects — so the
eval can't drift from the code it measures (it imports `format_persona`, never copies it).

Scoring is **mechanical and deterministic** — no LLM, no API key, no provider coupling. Each
atomic digest fact (the focus, plus every decision/learning/thread entry) is scored by
**token-recall** against the rendered boot text: `1.0` = every word of that fact is carried
forward, `0.0` = the fact was dropped, partial = it was paraphrased or truncated. The headline
`continuity_score` is the mean recall over all facts. A digest with no facts scores `1.0` (an
empty boot has nothing to lose, so it isn't punished). Reported alongside is the **boot size**
(chars + a documented ~chars/4 token estimate) — the cost of carrying that continuity.

> Today's `format_persona` dumps every digest field verbatim, so the built-in golden fixtures
> all score `1.0` — that **is** the baseline. The eval earns its keep when #286/#287 start
> curating/summarising the digest to shrink the boot: the moment a fact stops surviving, its
> recall (and the overall score) falls, and `diff` flags it.

### Run & diff

```bash
# offline (no infra): score the golden fixtures through the real renderer, save a result
python3 tools/efficiency/continuity_eval.py run --label pre-fix

# … apply the boot-shrinking fix here (format_persona / digest curation), then …
python3 tools/efficiency/continuity_eval.py run --label post-fix

# diff: continuity Δscore vs boot-size Δ — the trade #286/#287 must win
python3 tools/efficiency/continuity_eval.py diff
```

`diff`'s headline is the pair that matters together: **a good fix shows boot bytes DOWN while
`continuity_score` holds ≈ 1.0** ("✓ boot shrank N% with continuity held"). If the score falls,
it prints **⚠ CONTINUITY REGRESSED** — cheaper boots bought with amnesia, the thing we are
explicitly guarding against. Results are written to `tools/efficiency/baselines/continuity/`
(same gitignored tree as the cost baselines).

**Optional live round-trip.** Add `--api-base <stack> --agent-id <throwaway-uuid>` to `run` and
the harness POSTs each fixture digest, then GETs it back and renders — exercising the real
**store → normalise → retrieve → render** chain (catches DB/serialisation regressions the
offline path can't). It writes throwaway digest rows to the named agent, so point it at a
disposable one.

> An LLM-judge mode (give a model only the boot text, have it reconstruct the working-state,
> score against ground truth) is a deliberate **future** extension — kept out of the default so
> the eval stays deterministic and CI-runnable. If added, it would default to the latest Claude
> per repo standards.
