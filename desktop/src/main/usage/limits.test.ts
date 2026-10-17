import { describe, it, expect, vi } from 'vitest'
import { claudeKeychainServices, codexLimitsFromLog, parseClaudeCredentials, parseClaudeUsage, readClaudeLimits, CLAUDE_USAGE_URL } from './limits'

const NOW = Date.parse('2026-09-30T15:00:00.000Z')
const creds = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat-TEST', refreshToken: 'r', subscriptionType: 'max' } })

describe('parseClaudeUsage', () => {
  it('reads 5h, weekly and per-model weekly windows (utilization 0–100)', () => {
    const w = parseClaudeUsage({
      five_hour: { utilization: 10, resets_at: '2026-09-30T16:45:00+00:00' },
      seven_day: { utilization: 77.4, resets_at: '2026-10-03T00:00:00Z' },
      seven_day_opus: null,
      seven_day_oauth_apps: null,
      seven_day_sonnet: { utilization: 5, resets_at: null },
      limits: [{ kind: 'weekly_scoped', scope: { model: { display_name: 'Fable' } }, percent: 24, resets_at: 1791000000 }]
    })
    expect(w.map((x) => [x.key, x.label, x.usedPercent])).toEqual([
      ['5h', '5h', 10],
      ['wk', 'wk', 77.4],
      ['wk:fable', 'Fable', 24],
      ['wk:sonnet', 'Sonnet', 5]
    ])
    expect(w[0].resetsAt).toBe(Date.parse('2026-09-30T16:45:00Z'))
    expect(w[2].resetsAt).toBe(1791000000 * 1000)
  })
  it('clamps and ignores junk', () => {
    expect(parseClaudeUsage({ five_hour: { utilization: 140 } })[0].usedPercent).toBe(100)
    expect(parseClaudeUsage('nope')).toEqual([])
  })
})

describe('Claude credentials', () => {
  it('pulls the token + plan; rejects anything else', () => {
    expect(parseClaudeCredentials(creds)).toEqual({ token: 'sk-ant-oat-TEST', plan: 'max' })
    expect(parseClaudeCredentials('{"claudeAiOauth":{}}')).toBeNull()
    expect(parseClaudeCredentials('not json')).toBeNull()
    expect(parseClaudeCredentials(null)).toBeNull()
  })
  it('keychain service names (custom CLAUDE_CONFIG_DIR first)', () => {
    expect(claudeKeychainServices(undefined)).toEqual(['Claude Code-credentials'])
    const s = claudeKeychainServices('/tmp/cfg')
    expect(s[0]).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/)
    expect(s[1]).toBe('Claude Code-credentials')
  })
})

describe('readClaudeLimits', () => {
  const ok = (body: unknown, status = 200) => vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }))
  it('sends the token only to Anthropic with the OAuth beta header', async () => {
    const fetch = ok({ five_hour: { utilization: 10, resets_at: null }, seven_day: { utilization: 77 } })
    const r = await readClaudeLimits({ readCredentials: async () => creds, fetch, now: () => NOW })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe(CLAUDE_USAGE_URL)
    expect(new URL(url).host).toBe('api.anthropic.com')
    expect(init.headers).toMatchObject({ Authorization: 'Bearer sk-ant-oat-TEST', 'anthropic-beta': 'oauth-2025-04-20' })
    expect(r).toMatchObject({ status: 'ok', plan: 'Max', source: 'Anthropic usage API' })
    expect(JSON.stringify(r)).not.toContain('sk-ant-oat-TEST')
  })
  it('no credentials → signed-out, with no request', async () => {
    const fetch = vi.fn()
    const r = await readClaudeLimits({ readCredentials: async () => null, fetch, now: () => NOW })
    expect(r.status).toBe('signed-out')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('401/403 → Sign-in expired; 429/5xx/network → error', async () => {
    expect((await readClaudeLimits({ readCredentials: async () => creds, fetch: ok({}, 401), now: () => NOW })).status).toBe('expired')
    expect((await readClaudeLimits({ readCredentials: async () => creds, fetch: ok({}, 403), now: () => NOW })).status).toBe('expired')
    expect((await readClaudeLimits({ readCredentials: async () => creds, fetch: ok({}, 429), now: () => NOW })).status).toBe('error')
    const down = vi.fn().mockRejectedValue(new Error('offline'))
    expect((await readClaudeLimits({ readCredentials: async () => creds, fetch: down, now: () => NOW })).status).toBe('error')
  })
})

describe('codexLimitsFromLog', () => {
  it('labels windows by length and shows a window that rolled over as reset (never stale)', () => {
    const r = codexLimitsFromLog(
      {
        at: NOW - 3600_000,
        plan: 'plus',
        primary: { usedPercent: 40, windowMinutes: 300, resetsAt: NOW - 60_000 },
        secondary: { usedPercent: 28, windowMinutes: 10080, resetsAt: NOW + 86400_000 }
      },
      NOW
    )
    expect(r.status).toBe('ok')
    expect(r.plan).toBe('Plus')
    expect(r.windows).toEqual([
      { key: 'primary', label: '5h', usedPercent: 0, resetsAt: null, windowMinutes: 300 },
      { key: 'secondary', label: 'wk', usedPercent: 28, resetsAt: NOW + 86400_000, windowMinutes: 10080 }
    ])
  })
  it('no record → unavailable (honest)', () => {
    expect(codexLimitsFromLog(null, NOW)).toMatchObject({ status: 'unavailable', windows: [] })
  })
})
