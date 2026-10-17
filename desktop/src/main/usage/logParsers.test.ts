process.env.TZ = 'UTC'
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import {
  ACTIVE_GAP_MS,
  claudeLine,
  codexLine,
  emptyAgg,
  emptyClaudeState,
  emptyCodexState,
  hashKey,
  parseCodexRateLimits,
  type SeenKeys
} from './logParsers'

const FIX = path.join(__dirname, '__fixtures__')
const lines = (rel: string): string[] => {
  const dir = path.join(FIX, rel)
  const file = readdirSync(dir).find((f) => f.endsWith('.jsonl')) as string
  return readFileSync(path.join(dir, file), 'utf8').split('\n').filter(Boolean)
}
const seenSet = (): SeenKeys & { size(): number } => {
  const s = new Set<string>()
  return { has: (k) => s.has(k), add: (k) => void s.add(k), size: () => s.size }
}

describe('claudeLine (Claude Code transcripts)', () => {
  const run = () => {
    const agg = emptyAgg()
    const st = emptyClaudeState()
    const seen = seenSet()
    const own: string[] = []
    for (const l of lines('claude/-Users-dev-proj')) claudeLine(l, agg, st, seen, own)
    return { agg, st, seen, own }
  }

  it('counts each response once at the MAX of its streamed copies (message.id + requestId)', () => {
    const { agg } = run()
    // [input, output, cacheRead, cacheWrite, reasoning, cacheWrite1h, events]
    expect(agg.b['2026-09-28\tclaude-opus-5-5']).toEqual([12, 300, 10000, 2000, 0, 500, 1])
    expect(agg.b['2026-09-28\tclaude-fable-5-1']).toEqual([5, 100, 12000, 0, 0, 0, 1])
    expect(agg.b['2026-09-29\tclaude-haiku-4-5-20251001']).toEqual([1000, 200, 0, 0, 0, 0, 1])
  })

  it('skips <synthetic> and zero-usage lines', () => {
    const { agg } = run()
    expect(Object.keys(agg.b).some((k) => k.includes('synthetic'))).toBe(false)
  })

  it('turns = human prompts only (not tool results, slash commands or meta lines)', () => {
    expect(run().agg.turns).toBe(2)
  })

  it('counts `gh pr create` Bash calls, sessions and active time', () => {
    const { agg } = run()
    expect(agg.prs).toBe(1)
    expect(agg.sessions).toEqual(['0b6c1c9e-1111-4a2b-9c3d-000000000001'])
    expect(agg.activeMs).toBe(55_000) // 10:00:05 → 10:01:00; the next-day gap is idle
    expect(agg.first).toBe(Date.parse('2026-09-28T10:00:05.000Z'))
  })

  it('a response already claimed by another file is not counted again (cross-file dedup)', () => {
    const first = run()
    const agg = emptyAgg()
    const own: string[] = []
    for (const l of lines('claude/-Users-dev-proj')) claudeLine(l, agg, emptyClaudeState(), first.seen, own)
    expect(agg.b).toEqual({})
    expect(agg.prs).toBe(0)
    expect(own).toEqual([])
  })

  it('ignores malformed JSON', () => {
    const agg = emptyAgg()
    claudeLine('{"type":"assistant", nope', agg, emptyClaudeState(), seenSet(), [])
    expect(agg).toEqual(emptyAgg())
  })
})

describe('codexLine (Codex rollouts)', () => {
  const run = () => {
    const agg = emptyAgg()
    const st = emptyCodexState()
    const seen = seenSet()
    for (const l of lines('codex/2026/09/29')) codexLine(l, agg, st, seen, [])
    return { agg, st, seen }
  }

  it('turns cumulative totals into deltas; cached input is a subset of input; repeats count nothing', () => {
    const { agg } = run()
    // new input = input − cached; reasoning is informational (inside output)
    expect(agg.b['2026-09-29\tgpt-5.3-codex']).toEqual([2000 + 3000, 500 + 400, 8000 + 12000, 0, 300, 0, 2])
  })

  it('takes the model from thread_settings_applied and tags >272K-input responses as long-context', () => {
    const { agg } = run()
    expect(agg.b['2026-09-29\tgpt-6-astra#long']).toEqual([300000, 1000, 0, 0, 0, 0, 1])
  })

  it('turns = task_started (the paired user_message is not double counted); PRs from function calls', () => {
    const { agg } = run()
    expect(agg.turns).toBe(2)
    expect(agg.prs).toBe(1)
    expect(agg.sessions).toEqual(['019a0000-0000-7000-8000-00000000c0de'])
    expect(agg.activeMs).toBe(20_000 + ACTIVE_GAP_MS)
  })

  it('keeps the newest plan rate limits (limit_id "codex"), ignoring other meters', () => {
    const { st } = run()
    expect(st.limits).toMatchObject({
      plan: 'plus',
      primary: { usedPercent: 12, windowMinutes: 300, resetsAt: 1790800000 * 1000 },
      secondary: { usedPercent: 28, windowMinutes: 10080, resetsAt: 1791055245000 }
    })
    expect(st.limits?.at).toBe(Date.parse('2026-09-29T08:00:10.500Z'))
  })

  it('reads older rate_limits (no limit_id, resets_in_seconds)', () => {
    const r = parseCodexRateLimits({ primary: { used_percent: 40, window_minutes: 300, resets_in_seconds: 600 } }, 1_000_000)
    expect(r?.primary).toEqual({ usedPercent: 40, windowMinutes: 300, resetsAt: 1_000_000 + 600_000 })
    expect(parseCodexRateLimits({ limit_id: 'premium', primary: { used_percent: 1 } }, 0)).toBeNull()
  })
})

describe('hashKey', () => {
  it('is stable and distinguishes keys', () => {
    expect(hashKey('msg_01A:req_01A')).toBe(hashKey('msg_01A:req_01A'))
    expect(hashKey('msg_01A:req_01A')).not.toBe(hashKey('msg_01A:req_01B'))
  })
})
