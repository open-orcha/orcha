import { describe, it, expect, vi } from 'vitest'
import { defaultAgentPrefs, AGENT_IDS, type AgentsSnapshot } from '../../shared/agents'
import { UsageService, type UsageServiceDeps } from './service'
import { emptyAgg } from './logParsers'
import type { ProviderAgg } from './scanner'

const NOW = Date.parse('2026-09-30T15:00:00.000Z')

function agents(installed: string[]): AgentsSnapshot {
  const p = defaultAgentPrefs()
  return {
    permissionMode: p.permissionMode,
    defaultAgent: 'claude',
    detection: 'ready',
    detectedAt: 1,
    agents: AGENT_IDS.map((id) => ({ id, enabled: true, extraArgs: [], installed: installed.includes(id), path: null }))
  }
}

function claudeAgg(): ProviderAgg {
  const agg = emptyAgg()
  agg.b['2026-09-30\tclaude-opus-5-5'] = [100, 50, 1000, 0, 0, 0, 2]
  agg.turns = 1
  agg.sessions = ['s']
  return { agg, sessions: 1, files: 1, codexLimits: null }
}

function service(over: Partial<UsageServiceDeps> = {}) {
  let prefs: unknown = null
  const deps: UsageServiceDeps = {
    env: {},
    home: '/Users/dev',
    loadPrefs: () => prefs,
    savePrefs: (p) => (prefs = p),
    scan: vi.fn().mockResolvedValue({ claude: claudeAgg() }),
    readClaudeCredentials: vi.fn().mockResolvedValue(null),
    fetch: vi.fn(),
    now: () => NOW,
    agents: () => agents(['claude', 'codex']),
    appStats: () => ({ agentsSpawned: 2, agentSeconds: 60, trackingSince: 5 }),
    onChange: vi.fn(),
    ...over
  }
  return { svc: new UsageService(deps), deps }
}

describe('UsageService', () => {
  it('scans Claude + Codex logs (read-only roots under the home dir) and prices local usage', async () => {
    const { svc, deps } = service()
    const s = await svc.refresh()
    const roots = (deps.scan as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(roots).toEqual([
      { provider: 'claude', dir: '/Users/dev/.claude/projects' },
      { provider: 'codex', dir: '/Users/dev/.codex/sessions' },
      { provider: 'codex', dir: '/Users/dev/.codex/archived_sessions' }
    ])
    const claude = s.providers.find((p) => p.id === 'claude')!
    expect(claude.state).toBe('ok')
    expect(claude.local?.costUsd).toBeCloseTo((100 * 4 + 50 * 20 + 1000 * 0.2) / 1e6, 12)
    expect(s.app.agentsSpawned).toBe(2)
  })

  it('Claude limits are opt-in: Off by default, no credential read, no network', async () => {
    const { svc, deps } = service()
    const s = await svc.refresh()
    const claude = s.providers.find((p) => p.id === 'claude')!
    expect(claude.limits?.status).toBe('off')
    expect(claude.limitsExplainer).toMatch(/Keychain/)
    expect(deps.readClaudeCredentials).not.toHaveBeenCalled()
    expect(deps.fetch).not.toHaveBeenCalled()
  })

  it('enabling limits reads them; a rejected sign-in is reported as expired', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }))
    const creds = JSON.stringify({ claudeAiOauth: { accessToken: 't' } })
    const { svc, deps } = service({ fetch, readClaudeCredentials: vi.fn().mockResolvedValue(creds) })
    svc.update({ op: 'limits', id: 'claude', enabled: true })
    const s = await svc.refresh({ manual: true })
    expect(deps.readClaudeCredentials).toHaveBeenCalled()
    expect(s.providers.find((p) => p.id === 'claude')!.limits?.status).toBe('expired')
    expect(s.prefs.providers.claude).toEqual({ enabled: true, limits: true })
  })

  it('shows uninstalled featured CLIs honestly, hides uninstalled non-featured ones', async () => {
    const { svc } = service()
    const s = await svc.refresh()
    const ids = s.providers.map((p) => p.id)
    expect(ids.slice(0, 5)).toEqual(['claude', 'codex', 'gemini', 'cursor', 'opencode'])
    expect(s.providers.find((p) => p.id === 'gemini')!.state).toBe('not-installed')
    expect(ids).not.toContain('aider')
  })

  it('Off stops reading a provider and hides its numbers', async () => {
    const { svc, deps } = service()
    svc.update({ op: 'provider', id: 'codex', enabled: false })
    const s = await svc.refresh()
    const roots = (deps.scan as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as { provider: string }[]
    expect(roots.every((r) => r.provider === 'claude')).toBe(true)
    const codex = s.providers.find((p) => p.id === 'codex')!
    expect(codex.state).toBe('off')
    expect(codex.local).toBeNull()
  })

  it('rejects malformed updates and persists valid ones', () => {
    const { svc } = service()
    expect(svc.update({ op: 'trayTitle', on: 'no' })).toBeNull()
    expect(svc.update({ op: 'trayTitle', on: false })?.prefs.trayTitle).toBe(false)
  })

  it('a scan failure keeps going and says so', async () => {
    const { svc } = service({ scan: vi.fn().mockRejectedValue(new Error('EACCES')) })
    const s = await svc.refresh()
    expect(s.error).toMatch(/EACCES/)
    expect(s.scanning).toBe(false)
  })
})
