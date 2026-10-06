// Local-calendar maths below assume UTC (works under both the node and web tsconfigs).
;(globalThis as unknown as { process: { env: Record<string, string> } }).process.env.TZ = 'UTC'
import { describe, it, expect } from 'vitest'
import { isAgentId } from './agents'
import {
  barTone,
  bestDay,
  cacheShare,
  defaultUsagePrefs,
  formatDuration,
  formatResetIn,
  formatTokens,
  formatUsd,
  heatmapWeeks,
  localDay,
  parseUsagePrefs,
  parseUsageUpdate,
  sumLocal,
  trayUsageTitle,
  ZERO_TOKENS,
  type LocalUsage,
  type ProviderUsage,
  type UsageSnapshot
} from './usage'

const NOW = Date.parse('2026-09-30T15:00:00.000Z') // a Wednesday

describe('reset countdowns', () => {
  it('formats minutes, hours and days; null when unknown', () => {
    expect(formatResetIn(NOW + (1 * 60 + 45) * 60_000, NOW)).toBe('Resets in 1h 45m')
    expect(formatResetIn(NOW + 4 * 3600_000, NOW)).toBe('Resets in 4h')
    expect(formatResetIn(NOW + 12 * 60_000 - 5_000, NOW)).toBe('Resets in 12m')
    expect(formatResetIn(NOW + (3 * 1440 + 4 * 60) * 60_000, NOW)).toBe('Resets in 3d 4h')
    expect(formatResetIn(NOW - 1000, NOW)).toBe('Resets now')
    expect(formatResetIn(null, NOW)).toBeNull()
  })
})

describe('percent colour thresholds', () => {
  it('neutral ≤ 75, amber above 75, red above 90', () => {
    expect(barTone(0)).toBe('neutral')
    expect(barTone(75)).toBe('neutral')
    expect(barTone(76)).toBe('warn')
    expect(barTone(77)).toBe('warn')
    expect(barTone(90)).toBe('warn')
    expect(barTone(90.5)).toBe('danger')
    expect(barTone(100)).toBe('danger')
  })
})

describe('heatmap bucketing', () => {
  const days = [
    { date: '2026-09-28', tokens: 1000, costUsd: 1 },
    { date: '2026-09-30', tokens: 250, costUsd: 0.2 },
    { date: '2026-08-01', tokens: 99999, costUsd: 9 } // outside the 6-week range
  ]
  it('6 columns × 7 rows, Sunday first, ending with the current week; future days empty', () => {
    const cols = heatmapWeeks(days, NOW, 6)
    expect(cols).toHaveLength(6)
    expect(cols.every((c) => c.length === 7)).toBe(true)
    expect(cols[5][0].date).toBe('2026-09-27') // Sunday of this week
    expect(cols[0][0].date).toBe('2026-08-23')
    const today = cols[5][3]
    expect(today.date).toBe('2026-09-30')
    expect(cols[5][4]).toMatchObject({ date: '2026-10-01', future: true, level: 0 })
  })
  it('levels are quartiles of the busiest day shown; best day found', () => {
    const cols = heatmapWeeks(days, NOW, 6)
    const cell = (d: string) => cols.flat().find((c) => c.date === d)!
    expect(cell('2026-09-28').level).toBe(4)
    expect(cell('2026-09-30').level).toBe(1) // 25 % of max → lowest band
    expect(cell('2026-09-29').level).toBe(0)
    expect(bestDay(cols)?.date).toBe('2026-09-28')
    expect(bestDay(heatmapWeeks([], NOW))).toBeNull()
  })
  it('localDay uses the local calendar', () => {
    expect(localDay(Date.parse('2026-09-30T23:59:59.000Z'))).toBe('2026-09-30')
  })
})

describe('formatting', () => {
  it('tokens, dollars, durations, cache share', () => {
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(12_400)).toBe('12.4K')
    expect(formatTokens(3_210_000)).toBe('3.21M')
    expect(formatTokens(26_492_292_051)).toBe('26.5B')
    expect(formatUsd(3.4)).toBe('$3.40')
    expect(formatUsd(17850.66)).toBe('$17,851')
    expect(formatDuration(3 * 3600 + 20 * 60)).toBe('3h 20m')
    expect(formatDuration(2 * 86400 + 5 * 3600)).toBe('2d 5h')
    expect(cacheShare({ ...ZERO_TOKENS, input: 10, cacheRead: 80, cacheWrite: 10 })).toBeCloseTo(0.8)
    expect(cacheShare(ZERO_TOKENS)).toBeNull()
  })
})

const local = (over: Partial<LocalUsage> = {}): LocalUsage => ({
  tokens: { ...ZERO_TOKENS, input: 10 },
  costUsd: 1,
  unpricedTokens: 0,
  sessions: 1,
  turns: 1,
  events: 1,
  models: [],
  days: [{ date: '2026-09-30', tokens: 10, costUsd: 1 }],
  prsCreated: 0,
  activeSeconds: 60,
  firstSeen: 1,
  lastSeen: 2,
  ...over
})

describe('sumLocal (Overview)', () => {
  it('adds providers and merges days', () => {
    const s = sumLocal([local(), local({ days: [{ date: '2026-09-30', tokens: 5, costUsd: 2 }], firstSeen: 0 }), null])
    expect(s.tokens.input).toBe(20)
    expect(s.days).toEqual([{ date: '2026-09-30', tokens: 15, costUsd: 3 }])
    expect(s.firstSeen).toBe(0)
  })
})

const provider = (over: Partial<ProviderUsage>): ProviderUsage => ({
  id: 'claude',
  label: 'Claude',
  state: 'ok',
  installed: true,
  enabled: true,
  hasLogAdapter: true,
  hasLimits: true,
  limitsNeedOptIn: true,
  limitsEnabled: true,
  limitsExplainer: null,
  limits: null,
  local: null,
  logPath: null,
  ...over
})

describe('tray title', () => {
  const snap = (providers: ProviderUsage[], trayTitle = true): UsageSnapshot => ({
    updatedAt: 1,
    scanning: false,
    providers,
    app: { agentsSpawned: 0, agentSeconds: 0, trackingSince: null },
    prefs: { ...defaultUsagePrefs(), trayTitle },
    error: null
  })
  const win = (usedPercent: number) => ({ key: 'wk', label: 'wk', usedPercent, resetsAt: null, windowMinutes: 10080 })
  it('shows the provider initial + the highest window', () => {
    const s = snap([
      provider({ limits: { status: 'ok', windows: [win(10), win(77)], source: 'x', fetchedAt: 1 } }),
      provider({ id: 'codex', label: 'Codex', limits: { status: 'ok', windows: [win(28)], source: 'x', fetchedAt: 1 } })
    ])
    expect(trayUsageTitle(s)).toBe('C 77%')
  })
  it('empty when turned off, unknown, or only non-ok limits', () => {
    const p = provider({ limits: { status: 'ok', windows: [win(50)], source: 'x', fetchedAt: 1 } })
    expect(trayUsageTitle(snap([p], false))).toBe('')
    expect(trayUsageTitle(null)).toBe('')
    expect(trayUsageTitle(snap([provider({ limits: { status: 'expired', windows: [], source: 'x', fetchedAt: 1 } })]))).toBe('')
  })
})

describe('prefs + updates (strict)', () => {
  it('parses known fields and drops junk', () => {
    const p = parseUsagePrefs({ trayTitle: false, popoverMode: 'compact', providers: { claude: { enabled: true, limits: true }, nope: { enabled: true, limits: true }, codex: { enabled: 'yes' } } }, isAgentId)
    expect(p).toEqual({ version: 1, trayTitle: false, popoverMode: 'compact', providers: { claude: { enabled: true, limits: true } } })
    expect(parseUsagePrefs('garbage', isAgentId)).toEqual(defaultUsagePrefs())
  })
  it('accepts only exact update shapes', () => {
    expect(parseUsageUpdate({ op: 'limits', id: 'claude', enabled: true }, isAgentId)).toEqual({ op: 'limits', id: 'claude', enabled: true })
    expect(parseUsageUpdate({ op: 'limits', id: 'claude', enabled: true, extra: 1 }, isAgentId)).toBeNull()
    expect(parseUsageUpdate({ op: 'provider', id: 'nope', enabled: true }, isAgentId)).toBeNull()
    expect(parseUsageUpdate({ op: 'popoverMode', mode: 'huge' }, isAgentId)).toBeNull()
    expect(parseUsageUpdate({ op: 'trayTitle', on: false }, isAgentId)).toEqual({ op: 'trayTitle', on: false })
  })
})
