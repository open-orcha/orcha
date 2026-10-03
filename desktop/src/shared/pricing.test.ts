import { describe, it, expect } from 'vitest'
import { claudeFamily, costFor, modelLabel, normalizeModel, priceFor } from './pricing'
import { ZERO_TOKENS } from './usage'

describe('price table', () => {
  it('covers the current Claude 5 family and Haiku 4.5', () => {
    expect(priceFor('claude-opus-5-5')).toMatchObject({ input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 })
    expect(priceFor('claude-sonnet-5-5')).toMatchObject({ input: 2, output: 10, cacheRead: 0.2 })
    expect(priceFor('claude-fable-5-1')).toMatchObject({ input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 })
    expect(priceFor('claude-haiku-4-5-20251001')).toMatchObject({ input: 1, output: 5, cacheRead: 0.1 })
    expect(modelLabel('claude-fable-5-1')).toBe('Fable 5.1')
  })

  it('normalises provider prefixes, dates and context tags; matches only at a version boundary', () => {
    expect(normalizeModel('us.anthropic.claude-opus-4-5-20251101-v1:0')).toBe('claude-opus-4-5')
    expect(normalizeModel('claude-opus-4-6[1m]')).toBe('claude-opus-4-6')
    expect(priceFor('anthropic/claude-sonnet-4-5')?.label).toBe('Sonnet 4.5')
    expect(priceFor('claude-fable-5-2')).toBeNull() // not Fable 5
    expect(priceFor('claude-opus-4-9')).toBeNull() // not Opus 4
    expect(priceFor('gpt-5.9')).toBeNull() // not GPT-5
    expect(priceFor('gpt-5.3-codex')?.label).toBe('GPT-5.3 Codex')
    expect(priceFor('totally-new-model')).toBeNull()
  })

  it('Claude cost: new input + output + cache reads + 5m/1h writes', () => {
    const t = { ...ZERO_TOKENS, input: 12, output: 300, cacheRead: 10000, cacheWrite: 2000, cacheWrite1h: 500 }
    // 12×4 + 300×20 + 10000×0.2 + 1500×5 + 500×8 = 19548 → /1e6
    expect(costFor(priceFor('claude-opus-5-5'), t)).toBeCloseTo(0.019548, 9)
  })

  it('Codex cost: cached input at the cached rate, reasoning not billed twice, long-context rates', () => {
    const t = { ...ZERO_TOKENS, input: 2000, cacheRead: 8000, output: 500, reasoning: 200 }
    expect(costFor(priceFor('gpt-5.3-codex'), t)).toBeCloseTo((2000 * 1.75 + 8000 * 0.175 + 500 * 14) / 1e6, 12)
    const long = { ...ZERO_TOKENS, input: 300000, output: 1000 }
    expect(costFor(priceFor('gpt-6-astra#long'), long)).toBeCloseTo(6.075, 9)
    expect(costFor(priceFor('gpt-6-astra'), long)).toBeCloseTo((300000 * 10 + 1000 * 50) / 1e6, 9)
    expect(modelLabel('gpt-6-astra#long')).toBe('GPT-6 Astra')
  })

  it('unpriced models cost null (never guessed)', () => {
    expect(costFor(priceFor('mystery-1'), { ...ZERO_TOKENS, input: 1e6 })).toBeNull()
  })

  it('claudeFamily', () => {
    expect(claudeFamily('claude-fable-5-1')).toBe('Fable')
    expect(claudeFamily('gpt-5')).toBeNull()
  })
})
