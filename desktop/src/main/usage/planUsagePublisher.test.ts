import { describe, it, expect, vi } from 'vitest'
import { buildPlanUsagePayload, createPlanUsagePublisher, planHeadline } from './planUsagePublisher'
import { defaultUsagePrefs, localDay, ZERO_TOKENS, type LocalUsage, type ProviderUsage, type UsageSnapshot } from '../../shared/usage'
import type { Stack } from '../../shared/types'

const NOW = Date.parse('2026-10-02T13:20:00.000Z')
const H = 3_600_000

function local(tokens: number, costUsd: number): LocalUsage {
  return {
    tokens: ZERO_TOKENS, costUsd, unpricedTokens: 0, sessions: 1, turns: 1, events: 1, models: [],
    days: [{ date: localDay(NOW), tokens, costUsd }, { date: '2020-01-01', tokens: 5, costUsd: 1 }],
    prsCreated: 0, activeSeconds: 0, firstSeen: null, lastSeen: null
  }
}

function provider(over: Partial<ProviderUsage>): ProviderUsage {
  return {
    id: 'claude', label: 'Claude', state: 'ok', installed: true, enabled: true, hasLogAdapter: true, hasLimits: true,
    limitsNeedOptIn: true, limitsEnabled: true,
    limitsExplainer: 'Reads Claude Code’s sign-in from your macOS Keychain',
    limits: null, local: null, logPath: '~/.claude/projects', ...over
  }
}

function snapshot(): UsageSnapshot {
  return {
    updatedAt: NOW,
    scanning: false,
    app: { agentsSpawned: 0, agentSeconds: 0, trackingSince: null },
    prefs: defaultUsagePrefs(),
    error: null,
    providers: [
      provider({
        limits: {
          status: 'ok', source: 'Anthropic usage API', fetchedAt: NOW, plan: 'Max', note: 'secret-note',
          windows: [
            { key: '5h', label: '5h', usedPercent: 8, resetsAt: NOW + 3 * H + 26 * 60_000, windowMinutes: 300 },
            { key: 'wk', label: 'wk', usedPercent: 6, resetsAt: NOW + 50 * H, windowMinutes: 10080 },
            { key: 'wk:fable', label: 'Fable', usedPercent: 2, resetsAt: NOW + 50 * H, windowMinutes: 10080 }
          ]
        },
        local: local(601_000_000, 237.6149)
      }),
      provider({
        id: 'codex', label: 'Codex', limitsNeedOptIn: false, limitsExplainer: null, logPath: '~/.codex/sessions',
        limits: {
          status: 'ok', source: 'Codex session log', fetchedAt: NOW, plan: 'Plus',
          windows: [{ key: 'secondary', label: 'wk', usedPercent: 34, resetsAt: NOW + 25 * H, windowMinutes: 10080 }]
        }
      }),
      provider({ id: 'gemini', label: 'Gemini', limits: null, local: local(10, 1) })
    ]
  }
}

describe('buildPlanUsagePayload', () => {
  it('mirrors the Usage panel: plans, windows, headline, today', () => {
    const p = buildPlanUsagePayload(snapshot(), 'Husseins-MacBook-Pro.local', NOW)!
    expect(p.host).toBe('Husseins-MacBook-Pro.local')
    expect(p.captured_at).toBe('2026-10-02T13:20:00.000Z')
    expect(p.providers.map((x) => x.provider)).toEqual(['claude', 'codex'])
    const [claude, codex] = p.providers
    expect(claude.plan).toBe('Max')
    expect(claude.headline).toBe('5h resets in 3h 26m')
    expect(claude.windows).toEqual([
      { key: '5h', label: '5h', used_pct: 8, resets_at: new Date(NOW + 3 * H + 26 * 60_000).toISOString() },
      { key: 'wk', label: 'wk', used_pct: 6, resets_at: new Date(NOW + 50 * H).toISOString() },
      { key: 'model:fable', label: 'Fable', used_pct: 2, resets_at: new Date(NOW + 50 * H).toISOString() }
    ])
    expect(claude.today).toEqual({ tokens: 601_000_000, cost_usd: 237.61 })
    expect(codex.plan).toBe('Plus')
    expect(codex.headline).toBe('wk resets in 1d 1h')
    expect(codex.today).toBeNull()
  })

  it('privacy: carries no token, credential, path, note, source or email', () => {
    const snap = snapshot()
    const json = JSON.stringify(buildPlanUsagePayload(snap, 'host', NOW))
    for (const bad of ['token"', 'credential', 'oauth', 'accessToken', 'Bearer', 'email', 'path', 'logPath', '.claude', '.codex', 'Keychain', 'secret-note', 'source', 'explainer', 'prompt']) {
      expect(json).not.toContain(bad)
    }
    // allow-list: exactly the contract's keys at every level
    const p = JSON.parse(json)
    expect(Object.keys(p).sort()).toEqual(['captured_at', 'host', 'providers'])
    for (const pr of p.providers) {
      expect(Object.keys(pr).sort()).toEqual(['headline', 'plan', 'provider', 'today', 'windows'])
      for (const w of pr.windows) expect(Object.keys(w).sort()).toEqual(['key', 'label', 'resets_at', 'used_pct'])
      if (pr.today) expect(Object.keys(pr.today).sort()).toEqual(['cost_usd', 'tokens'])
    }
  })

  it('skips disabled / non-ok providers and returns null when nothing is left', () => {
    const snap = snapshot()
    snap.providers[0] = { ...snap.providers[0], enabled: false }
    snap.providers[1] = { ...snap.providers[1], limits: { status: 'expired', windows: [], source: null, fetchedAt: null, note: 'x' } }
    expect(buildPlanUsagePayload(snap, 'h', NOW)).toBeNull()
  })

  it('clamps and caps to the portal limits', () => {
    const snap = snapshot()
    snap.providers[0].limits!.windows = Array.from({ length: 12 }, (_, i) => ({
      key: `k${i}`, label: 'x'.repeat(50), usedPercent: 140, resetsAt: null, windowMinutes: null
    }))
    snap.providers[0].limits!.plan = 'p'.repeat(40)
    const p = buildPlanUsagePayload(snap, 'h'.repeat(200), NOW)!
    expect(p.host.length).toBe(120)
    expect(p.providers[0].windows).toHaveLength(10)
    expect(p.providers[0].windows[0]).toMatchObject({ used_pct: 100, resets_at: null })
    expect(p.providers[0].windows[0].label.length).toBe(40)
    expect(p.providers[0].plan!.length).toBe(30)
    expect(p.providers[0].headline).toBeNull()
  })

  it('planHeadline falls back to the first window with a reset', () => {
    expect(planHeadline([{ key: 'wk', label: 'wk', usedPercent: 1, resetsAt: NOW + 30 * 60_000, windowMinutes: null }], NOW)).toBe('wk resets in 30m')
    expect(planHeadline([], NOW)).toBeNull()
  })
})

function stack(port: number | null, running = true): Stack {
  return { project: `orcha-${port}`, projectShort: String(port), apiPort: port, dbPort: null, portalStatus: 'Up', running, folder: null }
}

describe('createPlanUsagePublisher', () => {
  it('PUTs to every running portal, throttled per portal, 404 skipped quietly', async () => {
    let now = NOW
    const fetch = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => new Response('{}', { status: String(url).includes(':8001') ? 404 : 200 }))
    const log = vi.fn()
    const pub = createPlanUsagePublisher({
      listStacks: async () => [stack(8000), stack(8001), stack(8002, false), stack(null)],
      fetch: fetch as unknown as typeof globalThis.fetch,
      host: () => 'mac.local',
      now: () => now,
      log
    })
    await pub.publish(snapshot())
    expect(fetch.mock.calls.map((c) => String(c[0])).sort()).toEqual(['http://localhost:8000/api/plan-usage', 'http://localhost:8001/api/plan-usage'])
    const init = fetch.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('PUT')
    expect(JSON.parse(String(init.body)).host).toBe('mac.local')
    expect(log).not.toHaveBeenCalled()

    now += 30_000
    await pub.publish(snapshot())
    expect(fetch).toHaveBeenCalledTimes(2) // within 60s: debounced

    now += 31_000
    await pub.publish(snapshot())
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('never throws: network errors and listStacks failures are logged; scanning emits are ignored', async () => {
    const log = vi.fn()
    const fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const pub = createPlanUsagePublisher({ listStacks: async () => [stack(8000)], fetch, host: () => 'h', now: () => NOW, log })
    await expect(pub.publish({ ...snapshot(), scanning: true })).resolves.toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
    await expect(pub.publish(snapshot())).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'))

    const pub2 = createPlanUsagePublisher({ listStacks: () => Promise.reject(new Error('docker down')), fetch, host: () => 'h', now: () => NOW, log })
    await expect(pub2.publish(snapshot())).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('docker down'))
  })
})
