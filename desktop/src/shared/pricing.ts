/** Maintained price table for the "Est." cost in Stats & Usage and the popover. USD per
 *  million tokens. Costs are ESTIMATES of API list price for the tokens the agents' logs
 *  report — a subscription (Claude Max/Pro, ChatGPT Plus/Pro) is billed differently, which is
 *  why every figure carries an "Est." label.
 *
 *  Sources (checked 2026-09-30):
 *  - Anthropic: platform.claude.com pricing / Claude API model table (first-party rates).
 *    Cache writes are 1.25× input for the 5-minute TTL and 2× for the 1-hour TTL; cache reads
 *    are listed per model (0.1× on most, $0.25 on Fable 5.1, $0.20 on Opus 5.5 / Sonnet 5.5).
 *  - OpenAI: openai.com/api/pricing (standard tier), as maintained in Orca's Codex price table
 *    (github.com/stablyai/orca, MIT © Lovecast Inc.) for the GPT-5.3+ / GPT-6 Codex models,
 *    including their long-context (>272K input) rates. OpenAI bills cached input at the
 *    "cached input" rate and has no cache-write charge; reasoning tokens are billed as output
 *    (they are already inside `output_tokens`).
 *
 *  Match rule: the logged model id is normalised (lower-case, provider prefixes such as
 *  `anthropic/` or `us.anthropic.` and `-YYYYMMDD` / `@YYYYMMDD` date suffixes stripped, `[1m]`
 *  context tags removed) and then matched by longest known prefix, so `claude-opus-4-5-20251101`
 *  prices as `claude-opus-4-5`. An id that matches nothing is UNPRICED — its tokens still
 *  count, its cost is left out and the UI says so. Nothing is guessed. */

import type { TokenCounts } from './usage'

export interface Price {
  /** Display name. */
  label: string
  input: number
  output: number
  /** Cache read (Anthropic) / cached input (OpenAI). */
  cacheRead: number
  /** 5-minute cache write (Anthropic); 0 where the provider has no write charge. */
  cacheWrite5m: number
  /** 1-hour cache write (Anthropic). */
  cacheWrite1h: number
  /** Long-context rates (responses tagged `#long` by the log parsers), when they differ. */
  long?: Price
}

function anthropic(label: string, input: number, output: number, cacheRead: number): Price {
  return { label, input, output, cacheRead, cacheWrite5m: input * 1.25, cacheWrite1h: input * 2 }
}

function withLong(p: Price, long: Price): Price {
  return { ...p, long }
}

/** `long` = [input, output, cached input] above the long-context threshold. */
function openai(label: string, input: number, output: number, cachedInput: number, long?: [number, number, number]): Price {
  const p: Price = { label, input, output, cacheRead: cachedInput, cacheWrite5m: 0, cacheWrite1h: 0 }
  if (long) p.long = { label, input: long[0], output: long[1], cacheRead: long[2], cacheWrite5m: 0, cacheWrite1h: 0 }
  return p
}

/** Keyed by normalised model-id PREFIX (longest match wins). */
export const PRICE_TABLE: Readonly<Record<string, Price>> = {
  // ---- Anthropic — Claude 5 family (current) ----
  'claude-fable-5-1': anthropic('Fable 5.1', 10, 50, 0.25),
  'claude-mythos-5-1': anthropic('Mythos 5.1', 10, 50, 0.25),
  'claude-fable-5': anthropic('Fable 5', 10, 50, 1),
  'claude-mythos-5': anthropic('Mythos 5', 10, 50, 1),
  'claude-opus-5-5': anthropic('Opus 5.5', 4, 20, 0.2),
  'claude-opus-5': anthropic('Opus 5', 5, 25, 0.5),
  'claude-sonnet-5-5': anthropic('Sonnet 5.5', 2, 10, 0.2),
  'claude-sonnet-5': anthropic('Sonnet 5', 2, 10, 0.2),
  // ---- Anthropic — Claude 4.x ----
  'claude-opus-4-8': anthropic('Opus 4.8', 5, 25, 0.5),
  'claude-opus-4-7': anthropic('Opus 4.7', 5, 25, 0.5),
  'claude-opus-4-6': anthropic('Opus 4.6', 5, 25, 0.5),
  'claude-opus-4-5': anthropic('Opus 4.5', 5, 25, 0.5),
  'claude-opus-4-1': anthropic('Opus 4.1', 15, 75, 1.5),
  'claude-opus-4': anthropic('Opus 4', 15, 75, 1.5),
  'claude-sonnet-4-6': anthropic('Sonnet 4.6', 3, 15, 0.3),
  'claude-sonnet-4-5': withLong(anthropic('Sonnet 4.5', 3, 15, 0.3), anthropic('Sonnet 4.5', 6, 22.5, 0.6)),
  'claude-sonnet-4': withLong(anthropic('Sonnet 4', 3, 15, 0.3), anthropic('Sonnet 4', 6, 22.5, 0.6)),
  'claude-haiku-4-5': anthropic('Haiku 4.5', 1, 5, 0.1),
  'claude-3-7-sonnet': anthropic('Sonnet 3.7', 3, 15, 0.3),
  'claude-3-5-haiku': anthropic('Haiku 3.5', 0.8, 4, 0.08),
  // ---- OpenAI (Codex) — standard tier; `long` = requests above 272K input ----
  'gpt-5-codex': openai('GPT-5 Codex', 1.25, 10, 0.125),
  'gpt-5-mini': openai('GPT-5 mini', 0.25, 2, 0.025),
  'gpt-5-nano': openai('GPT-5 nano', 0.05, 0.4, 0.005),
  'gpt-5': openai('GPT-5', 1.25, 10, 0.125),
  'gpt-5.1-codex-mini': openai('GPT-5.1 Codex mini', 0.25, 2, 0.025),
  'gpt-5.1-codex-max': openai('GPT-5.1 Codex Max', 1.25, 10, 0.125),
  'gpt-5.1-codex': openai('GPT-5.1 Codex', 1.25, 10, 0.125),
  'gpt-5.1': openai('GPT-5.1', 1.25, 10, 0.125),
  'gpt-5.2-pro': openai('GPT-5.2 Pro', 21, 168, 21),
  'gpt-5.2-codex': openai('GPT-5.2 Codex', 1.75, 14, 0.175),
  'gpt-5.2': openai('GPT-5.2', 1.75, 14, 0.175),
  'gpt-5.3-codex-spark': openai('GPT-5.3 Codex Spark', 1.75, 14, 0.175),
  'gpt-5.3-codex': openai('GPT-5.3 Codex', 1.75, 14, 0.175),
  'gpt-5.3': openai('GPT-5.3', 1.75, 14, 0.175),
  'gpt-5.4-mini': openai('GPT-5.4 mini', 0.75, 4.5, 0.075),
  'gpt-5.4-nano': openai('GPT-5.4 nano', 0.2, 1.25, 0.02),
  'gpt-5.4-pro': openai('GPT-5.4 Pro', 30, 180, 30, [60, 270, 60]),
  'gpt-5.4': openai('GPT-5.4', 2.5, 15, 0.25, [5, 22.5, 0.5]),
  'gpt-5.5-pro': openai('GPT-5.5 Pro', 30, 180, 30, [60, 270, 60]),
  'gpt-5.5': openai('GPT-5.5', 5, 30, 0.5, [10, 45, 1]),
  'gpt-5.6-sol': openai('GPT-5.6 Sol', 4, 20, 0.4, [8, 30, 0.8]),
  'gpt-5.6-terra': openai('GPT-5.6 Terra', 2, 12, 0.2, [4, 18, 0.4]),
  'gpt-5.6-luna': openai('GPT-5.6 Luna', 0.2, 1.2, 0.02, [0.4, 1.8, 0.04]),
  'gpt-6-astra': openai('GPT-6 Astra', 10, 50, 1, [20, 75, 2]),
  'gpt-6-sol': openai('GPT-6 Sol', 2, 10, 0.2, [4, 15, 0.4]),
  'gpt-6-luna': openai('GPT-6 Luna', 0.1, 0.5, 0.01, [0.2, 0.75, 0.02]),
  'codex-mini-latest': openai('codex-mini', 1.5, 6, 0.375)
}

/** Normalise a logged model id for lookup (see the file comment). */
export function normalizeModel(raw: string): string {
  let m = raw.trim().toLowerCase()
  m = m.replace(/\[[^\]]*\]$/, '') // `claude-opus-4-6[1m]`
  m = m.replace(/^(?:[a-z0-9-]+\.)?anthropic[./]/, '') // `us.anthropic.` / `anthropic/`
  m = m.replace(/^(?:openai|anthropic|models)\//, '')
  m = m.replace(/[-@]\d{8}(?:-v\d+:\d+)?$/, '') // `-20251101`, `@20251101`, bedrock `-v1:0`
  m = m.replace(/-v\d+:\d+$/, '')
  return m
}

const KEYS_BY_LENGTH = Object.keys(PRICE_TABLE).sort((a, b) => b.length - a.length)

/** Price for a logged model id, or null (unpriced). A prefix only matches at a boundary:
 *  `gpt-5` must not price `gpt-50`, `gpt-5.3` or `gpt-5-9` (different, possibly pricier
 *  models) — only a word suffix such as `-latest` / `-fast` may follow a key. */
export function priceFor(model: string): Price | null {
  if (model.endsWith('#long')) {
    const base = priceFor(model.slice(0, -5))
    return base ? (base.long ?? base) : null
  }
  const m = normalizeModel(model)
  for (const key of KEYS_BY_LENGTH) {
    if (!m.startsWith(key)) continue
    const rest = m.slice(key.length)
    // `-latest`, `-codex`… extend a key; `-9` or `.3` would be a different version.
    if (rest === '' || /^-[a-z]/.test(rest)) return PRICE_TABLE[key]
  }
  return null
}

/** Display name for a model id: the table's label, else a tidied raw id. */
export function modelLabel(model: string): string {
  const base = model.endsWith('#long') ? model.slice(0, -5) : model
  return priceFor(base)?.label ?? normalizeModel(base)
}

/** Est. USD for token counts at a price (null price → null). */
export function costFor(price: Price | null, t: TokenCounts): number | null {
  if (!price) return null
  const write1h = Math.min(t.cacheWrite1h, t.cacheWrite)
  const write5m = t.cacheWrite - write1h
  return (
    (t.input * price.input +
      t.output * price.output +
      t.cacheRead * price.cacheRead +
      write5m * price.cacheWrite5m +
      write1h * price.cacheWrite1h) /
    1e6
  )
}

/** Short family name for a per-model limit window (`Fable`, `Opus`, `Sonnet`). */
export function claudeFamily(model: string): string | null {
  const m = /claude-(?:\d-\d-)?(fable|mythos|opus|sonnet|haiku)/.exec(normalizeModel(model))
  return m ? m[1].charAt(0).toUpperCase() + m[1].slice(1) : null
}
