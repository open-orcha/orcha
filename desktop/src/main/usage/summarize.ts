/** Scan aggregate → the LocalUsage the UI shows: tokens by type, per model, per day, with
 *  Est. cost from the price table. Pure — summarize.test.ts. */

import { costFor, modelLabel, priceFor } from '../../shared/pricing'
import { addTokens, totalTokens, ZERO_TOKENS, type DayUsage, type LocalUsage, type ModelUsage, type TokenCounts } from '../../shared/usage'
import { LONG_SUFFIX, type Vec } from './logParsers'
import type { ProviderAgg } from './scanner'

export function vecTokens(v: Vec): TokenCounts {
  return { input: v[0] ?? 0, output: v[1] ?? 0, cacheRead: v[2] ?? 0, cacheWrite: v[3] ?? 0, reasoning: v[4] ?? 0, cacheWrite1h: v[5] ?? 0 }
}

export function summarize(p: ProviderAgg | undefined): LocalUsage | null {
  if (!p || p.files === 0) return null
  const models = new Map<string, ModelUsage>()
  const days = new Map<string, DayUsage>()
  let tokens = ZERO_TOKENS
  let costUsd = 0
  let unpricedTokens = 0
  let events = 0
  for (const [key, v] of Object.entries(p.agg.b)) {
    const tab = key.indexOf('\t')
    const date = key.slice(0, tab)
    const modelKey = key.slice(tab + 1)
    const model = modelKey.endsWith(LONG_SUFFIX) ? modelKey.slice(0, -LONG_SUFFIX.length) : modelKey
    const t = vecTokens(v)
    const cost = costFor(priceFor(modelKey), t)
    const n = totalTokens(t)
    tokens = addTokens(tokens, t)
    events += v[6] ?? 0
    if (cost === null) unpricedTokens += n
    else costUsd += cost
    const m = models.get(model) ?? { model, label: modelLabel(model), tokens: ZERO_TOKENS, costUsd: priceFor(model) ? 0 : null, events: 0 }
    m.tokens = addTokens(m.tokens, t)
    m.events += v[6] ?? 0
    if (cost !== null) m.costUsd = (m.costUsd ?? 0) + cost
    models.set(model, m)
    const d = days.get(date) ?? { date, tokens: 0, costUsd: 0 }
    d.tokens += n
    d.costUsd += cost ?? 0
    days.set(date, d)
  }
  return {
    tokens,
    costUsd,
    unpricedTokens,
    sessions: p.sessions,
    turns: p.agg.turns,
    events,
    models: [...models.values()].sort((a, b) => totalTokens(b.tokens) - totalTokens(a.tokens)),
    days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    prsCreated: p.agg.prs,
    activeSeconds: Math.round(p.agg.activeMs / 1000),
    firstSeen: p.agg.first,
    lastSeen: p.agg.last
  }
}
