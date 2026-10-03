/** Usage service (main process): owns the prefs, runs the incremental log scan (in a worker,
 *  injected as `scan`), reads subscription windows, and publishes one UsageSnapshot to the
 *  manager, the tray popover and the menu-bar title. No telemetry: the only network request
 *  is the opt-in Claude usage call to Anthropic (limits.ts). */

import path from 'node:path'
import { AGENT_IDS, agentDef, isAgentId, type AgentId, type AgentsSnapshot } from '../../shared/agents'
import {
  defaultUsagePrefs,
  parseUsagePrefs,
  parseUsageUpdate,
  providerPref,
  totalTokens,
  type AppStats,
  type LocalUsage,
  type ProviderLimits,
  type ProviderUsage,
  type UsagePrefs,
  type UsageProviderId,
  type UsageSnapshot
} from '../../shared/usage'
import { codexLimitsFromLog, readClaudeLimits } from './limits'
import type { LogProvider, LogRoot, ProviderAgg } from './scanner'
import { summarize } from './summarize'

export interface ProviderDef {
  id: UsageProviderId
  /** Log roots (relative to home unless absolute) this provider's usage is read from. */
  logs?: { provider: LogProvider; dirs: string[]; display: string }
  limits?: 'claude' | 'codex'
  /** Always listed in Stats & Usage (others only when installed). */
  featured?: boolean
}

export function providerDefs(env: NodeJS.ProcessEnv, home: string): ProviderDef[] {
  const claudeDir = env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CONFIG_DIR : path.join(home, '.claude')
  const codexHome = env.CODEX_HOME ? env.CODEX_HOME : path.join(home, '.codex')
  const defs: ProviderDef[] = [
    {
      id: 'claude',
      logs: { provider: 'claude', dirs: [path.join(claudeDir, 'projects')], display: tildify(path.join(claudeDir, 'projects'), home) },
      limits: 'claude',
      featured: true
    },
    {
      id: 'codex',
      logs: {
        provider: 'codex',
        dirs: [path.join(codexHome, 'sessions'), path.join(codexHome, 'archived_sessions')],
        display: tildify(path.join(codexHome, 'sessions'), home)
      },
      limits: 'codex',
      featured: true
    },
    { id: 'gemini', featured: true },
    { id: 'cursor', featured: true },
    { id: 'opencode', featured: true }
  ]
  const listed = new Set(defs.map((d) => d.id))
  for (const id of AGENT_IDS) if (!listed.has(id)) defs.push({ id })
  return defs
}

function tildify(p: string, home: string): string {
  return p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p
}

export const CLAUDE_LIMITS_EXPLAINER =
  'Reads Claude Code’s sign-in from your macOS Keychain (macOS may ask you to allow it) and asks Anthropic for your plan’s 5-hour and weekly usage. The token goes only to Anthropic, is never stored or logged, and nothing in ~/.claude is changed.'

export interface UsageServiceDeps {
  env: NodeJS.ProcessEnv
  home: string
  loadPrefs(): unknown
  savePrefs(p: UsagePrefs): void
  scan(roots: LogRoot[]): Promise<Partial<Record<LogProvider, ProviderAgg>>>
  readClaudeCredentials(): Promise<string | null>
  fetch: typeof fetch
  now(): number
  agents(): AgentsSnapshot | null
  appStats(): AppStats
  onChange(s: UsageSnapshot): void
  setTimer?(fn: () => void, ms: number): unknown
  clearTimer?(h: unknown): void
}

/** Scan cadence (incremental — unchanged files are only stat'ed). */
export const SCAN_EVERY_MS = 90_000
/** Anthropic usage polling: at most this often automatically… */
export const CLAUDE_LIMITS_EVERY_MS = 5 * 60_000
/** …and a manual refresh no more often than this. */
export const CLAUDE_LIMITS_MIN_MS = 30_000

export class UsageService {
  private prefs: UsagePrefs
  private readonly defs: ProviderDef[]
  private aggs: Partial<Record<LogProvider, ProviderAgg>> = {}
  private local: Partial<Record<LogProvider, LocalUsage | null>> = {}
  private claudeLimits: ProviderLimits | null = null
  private claudeLimitsAt = 0
  private scanning = false
  private inflight: Promise<UsageSnapshot> | null = null
  private updatedAt: number | null = null
  private error: string | null = null
  private timer: unknown = null

  constructor(private readonly deps: UsageServiceDeps) {
    this.defs = providerDefs(deps.env, deps.home)
    this.prefs = parseUsagePrefs(deps.loadPrefs(), isAgentId)
  }

  start(): void {
    void this.refresh()
    const tick = (): void => {
      this.timer = this.deps.setTimer?.(() => {
        void this.refresh().finally(tick)
      }, SCAN_EVERY_MS)
    }
    tick()
  }

  stop(): void {
    if (this.timer !== null) this.deps.clearTimer?.(this.timer)
    this.timer = null
  }

  currentPrefs(): UsagePrefs {
    return this.prefs
  }

  /** Scan logs + (when due) read limits. Concurrent calls share one run. */
  refresh(opts: { manual?: boolean } = {}): Promise<UsageSnapshot> {
    if (this.inflight) return this.inflight
    this.inflight = this.run(opts.manual === true).finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async run(manual: boolean): Promise<UsageSnapshot> {
    this.scanning = true
    this.emit()
    const roots: LogRoot[] = []
    for (const d of this.defs) {
      if (!d.logs || !providerPref(this.prefs, d.id, d.limits === 'claude').enabled) continue
      for (const dir of d.logs.dirs) roots.push({ provider: d.logs.provider, dir })
    }
    const tasks: Promise<void>[] = []
    tasks.push(
      (async () => {
        try {
          if (roots.length > 0) this.aggs = { ...this.aggs, ...(await this.deps.scan(roots)) }
          for (const d of this.defs) if (d.logs) this.local[d.logs.provider] = summarize(this.aggs[d.logs.provider])
          this.error = null
        } catch (err) {
          this.error = `Couldn’t read agent logs: ${err instanceof Error ? err.message : String(err)}`
        }
      })()
    )
    const claudePref = providerPref(this.prefs, 'claude', true)
    const now = this.deps.now()
    const due = now - this.claudeLimitsAt >= (manual ? CLAUDE_LIMITS_MIN_MS : CLAUDE_LIMITS_EVERY_MS)
    if (claudePref.enabled && claudePref.limits && due) {
      tasks.push(
        (async () => {
          this.claudeLimitsAt = now
          const next = await readClaudeLimits({ readCredentials: this.deps.readClaudeCredentials, fetch: this.deps.fetch, now: this.deps.now })
          // A transient failure keeps the last good windows (marked with the error note).
          if (next.status === 'error' && this.claudeLimits?.status === 'ok') this.claudeLimits = { ...this.claudeLimits, note: next.note }
          else this.claudeLimits = next
        })()
      )
    }
    await Promise.all(tasks)
    this.scanning = false
    this.updatedAt = this.deps.now()
    return this.emit()
  }

  update(raw: unknown): UsageSnapshot | null {
    const u = parseUsageUpdate(raw, isAgentId)
    if (!u) return null
    const next: UsagePrefs = { ...this.prefs, providers: { ...this.prefs.providers } }
    if (u.op === 'trayTitle') next.trayTitle = u.on
    else if (u.op === 'popoverMode') next.popoverMode = u.mode
    else {
      const def = this.defs.find((d) => d.id === u.id)
      const cur = providerPref(this.prefs, u.id, def?.limits === 'claude')
      next.providers[u.id] = u.op === 'provider' ? { ...cur, enabled: u.enabled } : { ...cur, limits: u.enabled, enabled: u.enabled ? true : cur.enabled }
    }
    const turnedOnLimits = u.op === 'limits' && u.enabled
    if (u.op === 'limits' && !u.enabled && u.id === 'claude') {
      this.claudeLimits = null
      this.claudeLimitsAt = 0
    }
    this.prefs = next
    this.deps.savePrefs(next)
    const snap = this.emit()
    if (turnedOnLimits || (u.op === 'provider' && u.enabled)) {
      this.claudeLimitsAt = 0
      void this.refresh()
    }
    return snap
  }

  private emit(): UsageSnapshot {
    const s = this.snapshot()
    this.deps.onChange(s)
    return s
  }

  snapshot(): UsageSnapshot {
    const agents = this.deps.agents()
    const installedOf = (id: AgentId): boolean | null => {
      if (!agents || agents.detection !== 'ready') return null
      return agents.agents.find((a) => a.id === id)?.installed ?? null
    }
    const now = this.deps.now()
    const providers: ProviderUsage[] = []
    for (const d of this.defs) {
      const installed = installedOf(d.id)
      const needOptIn = d.limits === 'claude'
      const pref = providerPref(this.prefs, d.id, needOptIn)
      const local = d.logs ? (this.local[d.logs.provider] ?? null) : null
      const hasLocal = !!local && totalTokens(local.tokens) > 0
      if (!d.featured && installed !== true && !hasLocal) continue
      let limits: ProviderLimits | null = null
      if (d.limits === 'claude') {
        limits = !pref.enabled
          ? null
          : !pref.limits
            ? { status: 'off', windows: [], source: null, fetchedAt: null, note: 'Off — enable to read your plan’s 5-hour and weekly windows.' }
            : (this.claudeLimits ?? { status: 'unavailable', windows: [], source: 'Anthropic usage API', fetchedAt: null, note: 'Checking…' })
      } else if (d.limits === 'codex') {
        limits = pref.enabled ? codexLimitsFromLog(this.aggs.codex?.codexLimits ?? null, now) : null
      }
      const state: ProviderUsage['state'] = !pref.enabled
        ? 'off'
        : installed === false && !hasLocal
          ? 'not-installed'
          : hasLocal || limits?.status === 'ok'
            ? 'ok'
            : 'no-data'
      providers.push({
        id: d.id,
        label: agentDef(d.id).short ?? agentDef(d.id).label,
        state,
        installed,
        enabled: pref.enabled,
        hasLogAdapter: !!d.logs,
        hasLimits: !!d.limits,
        limitsNeedOptIn: needOptIn,
        limitsEnabled: pref.limits,
        limitsExplainer: needOptIn ? CLAUDE_LIMITS_EXPLAINER : null,
        limits,
        local: pref.enabled ? local : null,
        logPath: d.logs?.display ?? null
      })
    }
    return {
      updatedAt: this.updatedAt,
      scanning: this.scanning,
      providers,
      app: this.deps.appStats(),
      prefs: this.prefs,
      error: this.error
    }
  }
}

export { defaultUsagePrefs }
