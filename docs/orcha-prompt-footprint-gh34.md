# Per-wake prompt footprint + stable prefix ordering (GH #34, scoped)

GH #34 proposes adopting [Headroom](https://github.com/chopratejas/headroom) to cut agent-run
cost via prompt-cache hits (CacheAligner) and reversible digest compression (CCR). This doc
covers only the scoped, no-external-dependency slice of that issue: (1) measuring where per-wake
prompt tokens actually go, and (2) reordering prompt assembly so the parts that don't change
between wakes form a consistent, cache-friendly prefix. Adopting Headroom itself is out of scope
here — this is the low-hanging groundwork a future decision on that would build on.

## 1. Where a wake's prompt comes from

A headless wake (`orcha-cli/orcha_cli/notifier.py`) sends the model **two separate strings**:

- **The system prompt** — `notifier.format_persona(...)`, injected via Claude's
  `--append-system-prompt` (or prepended for Codex). Built from: the agent's persona, a fixed
  human-comms guardrail, the resolved task's full body (title/description/DoD), the task's
  standing protocol (RULES), and the agent's memory digest.
- **The user-turn prompt** — `notifier.build_wake_prompt(...)`, the positional prompt passed to
  `claude -p`. Built from: fixed one-shot-worker operating instructions, plus a per-wake
  "RANKED WAKE MANIFEST" of pending events/requests and any directed message.

These map onto the four sections GH #34 names: **protocol** and **task body** live in the system
prompt (`_render_protocol` / `_render_task_body`); **digest** is the rest of the system prompt;
**manifest** is the volatile half of the user-turn prompt.

## 2. Per-section footprint (measured)

`tools/efficiency/prompt_footprint.py` renders each section through the SAME functions a real
wake calls, against representative fixture data (sized like a moderately-active agent mid-task —
not an empty cold boot, not the append-only-accretion worst case `digest_curation_delta.py`
already covers), so this can't drift from the code it measures. No network, no LLM key, fully
reproducible:

```
PYTHONPATH=orcha-cli python3 tools/efficiency/prompt_footprint.py
```

Output (captured 2026-07-13, against this branch):

```
GH #34 — per-wake prompt footprint by section (fixture data, offline/reproducible)
  section                                           chars    ~tokens (4ch/tok)
  --------------------------------------------   --------   ------------------
  protocol (standing RULES)                           880                  220
  digest (memory digest, incl. audience)            1,236                  309
  manifest (ranked wake events + directed msg)        847                  211
  task body (title + description + DoD)               897                  224

  sum of the four sections above: 3,860 chars (~965 tokens)
  full system prompt (persona+guardrail+task body+protocol+digest), as actually injected via --append-system-prompt: 3,880 chars (~970 tokens)
  full user-turn wake prompt (fixed instructions + manifest), as actually passed to `claude -p`: 1,802 chars (~450 tokens)
```

Approximate-token counts use the conventional ~4-chars/token proxy (same heuristic
`digest_curation_delta.py` uses) — a rough-order-of-magnitude figure, not a provider tokenizer
count. Takeaways from the fixture:

- **Digest is the single biggest section** (~32% of the four), and it is also the section that
  changes on nearly every wake (an agent rewrites its own memory as it works) — it is the worst
  candidate for prefix-stability and the best candidate for future compression (this is exactly
  what `digest_curate.py` already targets, and what GH #34's CCR idea would extend if adopted).
- **Protocol and task body are comparable in size** to the digest and manifest, but far more
  stable — both are pinned to whichever task the wake resolves and typically don't change
  wake-to-wake within that task's lifetime.
- **Manifest is entirely per-wake** by construction (it reports "what happened since last
  wake") — there's no stable subset within it to hoist; the fix for it is ordering it *last*,
  not shrinking it (see below).

## 3. Stable-prefix ordering (the code change)

Anthropic's prompt cache (and any KV-cache-based provider cache) hits on a **byte-identical
prefix**, not on the request as a whole. If a request's early content differs from a nearby
prior request, everything after that point of divergence is a cache miss too — so content that's
identical across a busy agent's consecutive wakes should render *first*, and content that's
almost certainly different every wake should render *last*.

**`format_persona`** (`orcha-cli/orcha_cli/notifier.py`) already put persona → guardrail →
lane-directive → task body → protocol ahead of the digest, which is correct — those are the
most stable sections. One section was out of place: the self-wake **resume context** (GH #122,
`render_resume=True`) rendered *between* the task body and the protocol, splitting the stable
block in two. Since a resume context is a fresh wait-point most times it fires (about as
volatile as the digest), it now renders *after* the protocol, grouped with the digest at the
tail:

```
persona → guardrail → [lane directive] → task body → protocol → [resume context] → digest
```

**`build_wake_prompt`** had the opposite problem at the top level: the entirely-fixed one-shot
operating instructions ("You are a ONE-SHOT headless worker: drain your FULL inbox...") rendered
*after* the always-unique `[orcha wake] <alias>: <count>.<manifest>...` summary — so the very
first byte of the prompt differed on almost every wake, and no shared prefix was possible at
all. The two blocks are now swapped: the fixed instructions lead, the per-wake summary trails.
Same content, same information — only the order changed.

Both changes are covered by tests in `tests/test_wake.py` that assert the shared prefix is a
real string prefix (not just "contains the same substrings") across two renders with different
volatile inputs:

- `test_format_persona_stable_sections_form_consistent_prefix`
- `test_format_persona_resume_context_renders_after_protocol_grouped_with_digest`
- `test_build_wake_prompt_stable_instructions_form_consistent_prefix`

## 4. What's deliberately out of scope

- Adopting Headroom (or any external dependency) — GH #34's larger ask, left for a future,
  separate decision.
- Compressing/shrinking any section's content — this pass only reorders; `digest_curate.py`
  already owns digest-size reduction and is untouched here.
- Verifying an actual Anthropic cache-hit / cost delta on live wakes — that requires the control
  container + token-usage meter (`docs/orcha-efficiency-baseline.md`,
  `tools/efficiency/control_baseline.py`) run against a deployed build over real consecutive
  wakes, which is beyond a static, no-network measurement pass.
