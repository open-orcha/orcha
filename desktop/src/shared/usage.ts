/** Agent usage & spend tracking — the contract shared by main (usage service), the preload
 *  bridge (types only) and the renderer (status indicator, popover, Stats & Usage screen).
 *  Pure: no Electron / Node imports.
 *
 *  Approach adapted from Orca's usage panel (github.com/stablyai/orca, MIT © Lovecast Inc.):
 *  subscription windows come from the provider itself (Claude's OAuth usage endpoint, opt-in;
 *  Codex's own `rate_limits` records in its session logs) and token analytics from the
 *  agents' local session logs, priced with a maintained table (always labelled "Est.").
 *
 *  HONESTY RULES: a number is shown only when a real source produced it. A provider with no
 *  logs says "No local usage yet"; one that is not installed says so; limits that need an
 *  opt-in say "Off"; a rejected credential says "Sign-in expired". Nothing is guessed. */

import type { AgentId } from './agents'

// ---------------------------------------------------------------------------------------
// Tokens + cost.

/** Token counts by type. `input` is NEW (uncached) input; cache reads/writes are separate;
 *  `reasoning` is the part of `output` the provider reports as reasoning (informational — it
 *  is already inside `output` for OpenAI models, so it is never added twice). */
export interface TokenCounts {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  /** The part of `cacheWrite` written with a 1-hour TTL (priced at 2× input, not 1.25×). */
  cacheWrite1h: number
}

export const ZERO_TOKENS: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cacheWrite1h: 0 }

export function addTokens(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: a.reasoning + b.reasoning,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h
  }
}

/** Billable total: input + output + cache reads + cache writes (reasoning is inside output). */
export function totalTokens(t: TokenCounts): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite
}

/** Share of all input-side tokens served from cache (0..1), null when there is no input. */
export function cacheShare(t: TokenCounts): number | null {
  const inputSide = t.input + t.cacheRead + t.cacheWrite
  return inputSide > 0 ? t.cacheRead / inputSide : null
}

// ---------------------------------------------------------------------------------------
// Snapshot shapes.

/** Providers the usage service knows how to read (a subset of the agent registry). */
export type UsageProviderId = AgentId

export interface ModelUsage {
  /** Raw model id as logged (`claude-opus-5-5`, `gpt-5.5-codex` …). */
  model: string
  /** Display name (`Opus 5.5`, `GPT-5.5 Codex`) from the price table, else the raw id. */
  label: string
  tokens: TokenCounts
  /** Est. USD — null when the model is not in the price table (tokens still count). */
  costUsd: number | null
  /** API responses (assistant messages / token_count deltas) attributed to this model. */
  events: number
}

export interface DayUsage {
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string
  tokens: number
  costUsd: number
}

export interface LocalUsage {
  tokens: TokenCounts
  /** Est. USD over priced models only. */
  costUsd: number
  /** Tokens from models missing in the price table (their cost is not in `costUsd`). */
  unpricedTokens: number
  sessions: number
  /** Human prompts. */
  turns: number
  /** API responses with usage. */
  events: number
  models: ModelUsage[]
  days: DayUsage[]
  /** `gh pr create` commands the agent ran (from its own tool-call records). */
  prsCreated: number
  /** Sum over sessions of (last event − first event), capped per gap — "time agents worked". */
  activeSeconds: number
  firstSeen: number | null
  lastSeen: number | null
}

/** One subscription window: `5h`, `wk`, or a per-model weekly window (`Fable`, `Opus` …). */
export interface LimitWindow {
  key: string
  /** Short label for the bar (`5h`, `wk`, `Fable`). */
  label: string
  /** 0..100. */
  usedPercent: number
  /** Epoch ms, null when the provider did not say. */
  resetsAt: number | null
  windowMinutes: number | null
}

export type LimitsStatus =
  | 'ok'
  /** The per-provider opt-in (Enable) is off — nothing was read. */
  | 'off'
  /** No credential found (never signed in on this Mac). */
  | 'signed-out'
  /** The provider rejected the stored credential (401/403). */
  | 'expired'
  /** The provider has no obtainable limits (no API, nothing in its logs). */
  | 'unavailable'
  /** Transient failure (network, 5xx, rate limited) — the last good windows may be kept. */
  | 'error'

export interface ProviderLimits {
  status: LimitsStatus
  windows: LimitWindow[]
  /** Where the windows came from, in words (`Anthropic usage API`, `Codex session log`). */
  source: string | null
  /** When the windows were read (epoch ms). */
  fetchedAt: number | null
  /** Plan name when the provider reports one (`Max`, `Pro`, `Plus`). */
  plan?: string | null
  /** One-line human explanation for non-ok states. */
  note?: string | null
}

export type ProviderState =
  /** Tracking switched off in Stats & Usage (nothing is read). */
  | 'off'
  | 'not-installed'
  /** Installed / has logs, nothing to show yet. */
  | 'no-data'
  | 'ok'

export interface ProviderUsage {
  id: UsageProviderId
  label: string
  state: ProviderState
  /** CLI found on the login-shell PATH (null = detection not finished). */
  installed: boolean | null
  /** Tracking enabled (Stats & Usage › Providers › Enable/Off). */
  enabled: boolean
  /** This provider can read local session logs. */
  hasLogAdapter: boolean
  /** This provider has an obtainable subscription-limit source. */
  hasLimits: boolean
  /** Reading limits needs an opt-in because it uses a stored credential. */
  limitsNeedOptIn: boolean
  /** The opt-in is on. */
  limitsEnabled: boolean
  /** What reading limits touches, in words (shown next to the opt-in). */
  limitsExplainer: string | null
  limits: ProviderLimits | null
  local: LocalUsage | null
  /** The log folder read (display only, `~`-relative). */
  logPath: string | null
  /** `api-key`: agent runs bill an API key (Settings › API keys is on for at least one
   *  project) — no plan limits apply, so the surfaces show "API key" + today's spend instead
   *  of windows. Absent/`plan`: the CLI's own subscription. */
  billing?: ProviderBilling
}

export type ProviderBilling = 'plan' | 'api-key'

export function isApiBilled(p: ProviderUsage): boolean {
  return p.billing === 'api-key'
}

/** Today's Est. spend from the local logs (0 when there is none) — the API-key headline. */
export function todaySpendUsd(p: ProviderUsage, today: string): number {
  const d = p.local?.days.find((x) => x.date === today)
  return d && Number.isFinite(d.costUsd) ? Math.max(0, d.costUsd) : 0
}

/** `$1.20 today`. */
export function todaySpendText(p: ProviderUsage, today: string): string {
  return `${formatUsd(todaySpendUsd(p, today))} today`
}

export interface AppStats {
  /** Agent terminals launched from Embodent. */
  agentsSpawned: number
  /** Wall-clock seconds those agent terminals were open. */
  agentSeconds: number
  trackingSince: number | null
}

export interface UsageSnapshot {
  updatedAt: number | null
  /** A scan is running right now. */
  scanning: boolean
  providers: ProviderUsage[]
  app: AppStats
  prefs: UsagePrefs
  /** Last scan failure in words (the previous numbers stay). */
  error: string | null
}

// ---------------------------------------------------------------------------------------
// Preferences (persisted by main in <userData>/usage.json).

export type PopoverMode = 'detailed' | 'compact'

export interface UsageProviderPref {
  /** Track this provider (read its local logs). */
  enabled: boolean
  /** Read subscription limits (may use a stored credential — explicit opt-in). */
  limits: boolean
}

export interface UsagePrefs {
  version: 1
  /** Show the highest usage % next to the menu-bar icon. */
  trayTitle: boolean
  popoverMode: PopoverMode
  providers: Partial<Record<UsageProviderId, UsageProviderPref>>
}

export function defaultUsagePrefs(): UsagePrefs {
  return { version: 1, trayTitle: true, popoverMode: 'detailed', providers: {} }
}

/** Default per provider: tracking on (local logs only — nothing leaves the Mac); limits on
 *  only where they need no credential. */
export function providerPref(prefs: UsagePrefs, id: UsageProviderId, limitsNeedOptIn: boolean): UsageProviderPref {
  return prefs.providers[id] ?? { enabled: true, limits: !limitsNeedOptIn }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function parseUsagePrefs(raw: unknown, isProvider: (id: string) => id is UsageProviderId): UsagePrefs {
  const out = defaultUsagePrefs()
  if (!isRecord(raw)) return out
  if (typeof raw.trayTitle === 'boolean') out.trayTitle = raw.trayTitle
  if (raw.popoverMode === 'detailed' || raw.popoverMode === 'compact') out.popoverMode = raw.popoverMode
  if (isRecord(raw.providers)) {
    for (const [id, v] of Object.entries(raw.providers)) {
      if (!isProvider(id) || !isRecord(v)) continue
      if (typeof v.enabled !== 'boolean' || typeof v.limits !== 'boolean') continue
      out.providers[id] = { enabled: v.enabled, limits: v.limits }
    }
  }
  return out
}

export type UsageUpdate =
  | { op: 'trayTitle'; on: boolean }
  | { op: 'popoverMode'; mode: PopoverMode }
  | { op: 'provider'; id: UsageProviderId; enabled: boolean }
  | { op: 'limits'; id: UsageProviderId; enabled: boolean }

export function parseUsageUpdate(raw: unknown, isProvider: (id: string) => id is UsageProviderId): UsageUpdate | null {
  if (!isRecord(raw)) return null
  const keys = Object.keys(raw)
  const only = (...k: string[]): boolean => keys.length === k.length && k.every((x) => x in raw)
  switch (raw.op) {
    case 'trayTitle':
      return only('op', 'on') && typeof raw.on === 'boolean' ? { op: 'trayTitle', on: raw.on } : null
    case 'popoverMode':
      return only('op', 'mode') && (raw.mode === 'detailed' || raw.mode === 'compact') ? { op: 'popoverMode', mode: raw.mode } : null
    case 'provider':
    case 'limits':
      return only('op', 'id', 'enabled') && typeof raw.id === 'string' && isProvider(raw.id) && typeof raw.enabled === 'boolean'
        ? { op: raw.op, id: raw.id, enabled: raw.enabled }
        : null
    default:
      return null
  }
}

// ---------------------------------------------------------------------------------------
// IPC contract.

export const USAGE_CHANNELS = {
  get: 'orcha:usage:get',
  refresh: 'orcha:usage:refresh',
  update: 'orcha:usage:update',
  changed: 'orcha:usage:changed',
  openStats: 'orcha:usage:openStats',
  displayGet: 'orcha:usage:display:get',
  displaySet: 'orcha:usage:display:set',
  displayChanged: 'orcha:usage:display:changed'
} as const

export interface UsageApi {
  get(): Promise<UsageSnapshot>
  /** Re-scan logs + re-read limits now. */
  refresh(): Promise<UsageSnapshot>
  update(u: UsageUpdate): Promise<UsageSnapshot>
  onChanged(cb: (s: UsageSnapshot) => void): () => void
  /** Tray popover → bring the manager forward on Stats & Usage (or Settings › Agents). */
  openStats(target?: 'stats' | 'accounts'): Promise<void>
  /** Manager: main asks to show Stats & Usage / Settings › Agents (from the tray). */
  onOpenStats?(cb: (target: 'stats' | 'accounts') => void): () => void
  /** The portal-wide "Show plan usage" setting (cached value; main re-reads the portals). */
  getDisplay?(): Promise<PlanUsageDisplay>
  /** Change it: main updates its cache at once, then PUTs to every running portal. */
  setDisplay?(d: PlanUsageDisplayInput): Promise<PlanUsageDisplay>
  onDisplayChanged?(cb: (d: PlanUsageDisplay) => void): () => void
}

// ---------------------------------------------------------------------------------------
// Plan-usage display setting (portal mig 070, `/api/plan-usage/display`): whether the
// sidebar Usage row shows, and for which providers. Portal-wide, synced across every
// portal this Mac knows: the newest `updated_at` wins; null ("never set") loses to any set
// value; when nothing was ever set the default is OFF, both providers.

export type PlanUsageProviders = 'both' | 'claude' | 'codex'

export interface PlanUsageDisplayInput {
  show: boolean
  providers: PlanUsageProviders
}

export interface PlanUsageDisplay extends PlanUsageDisplayInput {
  /** ISO time the setting was last changed (portal clock), null = never set. */
  updatedAt: string | null
}

export const DEFAULT_PLAN_USAGE_DISPLAY: PlanUsageDisplay = { show: false, providers: 'both', updatedAt: null }

export function isPlanUsageProviders(v: unknown): v is PlanUsageProviders {
  return v === 'both' || v === 'claude' || v === 'codex'
}

/** Strict `{show, providers}` (the PUT body / the IPC set argument), else null. */
export function parsePlanUsageDisplayInput(raw: unknown): PlanUsageDisplayInput | null {
  if (!isRecord(raw)) return null
  if (typeof raw.show !== 'boolean' || !isPlanUsageProviders(raw.providers)) return null
  return { show: raw.show, providers: raw.providers }
}

/** A portal's GET/PUT response (`updated_at`) or the local cache (`updatedAt`), else null. */
export function parsePlanUsageDisplay(raw: unknown): PlanUsageDisplay | null {
  const input = parsePlanUsageDisplayInput(raw)
  if (!input || !isRecord(raw)) return null
  const at = raw.updated_at !== undefined ? raw.updated_at : raw.updatedAt
  if (at !== null && at !== undefined && (typeof at !== 'string' || displayTime(at) === null)) return null
  return { ...input, updatedAt: typeof at === 'string' ? at : null }
}

/** Epoch ms of an `updated_at` (Postgres may send microseconds), null when unparseable. */
export function displayTime(iso: string | null): number | null {
  if (iso === null) return null
  const ms = Date.parse(iso.replace(/(\.\d{3})\d+/, '$1'))
  return Number.isFinite(ms) ? ms : null
}

/** The sync rule: newest `updatedAt` wins, never-set loses, all never-set → the default. */
export function mergePlanUsageDisplays(list: readonly (PlanUsageDisplay | null | undefined)[]): PlanUsageDisplay {
  let best: PlanUsageDisplay | null = null
  let bestAt = -Infinity
  for (const d of list) {
    const at = d ? displayTime(d.updatedAt) : null
    if (d && at !== null && at > bestAt) {
      best = d
      bestAt = at
    }
  }
  return best ?? DEFAULT_PLAN_USAGE_DISPLAY
}

// ---------------------------------------------------------------------------------------
// Presentation helpers (pure; used by the renderer, the tray title and tests).

export type BarTone = 'neutral' | 'warn' | 'danger'

/** Bars stay neutral; amber above 75 %, red above 90 %. */
export function barTone(percent: number): BarTone {
  if (percent > 90) return 'danger'
  if (percent > 75) return 'warn'
  return 'neutral'
}

export function clampPercent(p: number): number {
  if (!Number.isFinite(p)) return 0
  return Math.max(0, Math.min(100, p))
}

/** `Resets in 1h 45m` / `Resets in 3d 4h` / `Resets in 12m` / `Resets now`; null = unknown. */
export function formatResetIn(resetsAt: number | null, now: number): string | null {
  if (resetsAt === null || !Number.isFinite(resetsAt)) return null
  const mins = Math.ceil((resetsAt - now) / 60_000)
  if (mins <= 0) return 'Resets now'
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (d > 0) return `Resets in ${d}d${h > 0 ? ` ${h}h` : ''}`
  if (h > 0) return `Resets in ${h}h${m > 0 ? ` ${m}m` : ''}`
  return `Resets in ${m}m`
}

/** `0`, `950`, `12.4K`, `3.2M`, `1.05B`. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 1000) return String(Math.max(0, Math.round(n || 0)))
  const units: [number, string][] = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K']
  ]
  for (const [div, u] of units) {
    if (n >= div) {
      const v = n / div
      return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)}${u}`
    }
  }
  return String(n)
}

/** `$0.00`, `$12.34`, `$1,234`. */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return '$0.00'
  if (n >= 1000) return `$${Math.round(n).toLocaleString('en-US')}`
  return `$${n.toFixed(2)}`
}

/** `3h 20m`, `45m`, `2d 5h`. */
export function formatDuration(seconds: number): string {
  const mins = Math.max(0, Math.round(seconds / 60))
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

/** Local `YYYY-MM-DD` for an epoch-ms instant. */
export function localDay(ms: number): string {
  const d = new Date(ms)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

export interface HeatCell {
  date: string
  tokens: number
  costUsd: number
  /** 0 = none, 1..4 = quartile of the busiest day in range. */
  level: 0 | 1 | 2 | 3 | 4
  /** After `now` (drawn empty). */
  future: boolean
}

/** GitHub-style grid: `weeks` columns × 7 rows (Sunday first), ending with the week that
 *  contains `now` (local time). Levels are relative to the busiest day shown. */
export function heatmapWeeks(days: readonly DayUsage[], now: number, weeks = 6): HeatCell[][] {
  const byDate = new Map(days.map((d) => [d.date, d]))
  const today = new Date(now)
  today.setHours(12, 0, 0, 0)
  const start = new Date(today)
  start.setDate(today.getDate() - today.getDay() - (weeks - 1) * 7)
  const todayKey = localDay(today.getTime())
  const cols: HeatCell[][] = []
  let max = 0
  const cursor = new Date(start)
  for (let w = 0; w < weeks; w++) {
    const col: HeatCell[] = []
    for (let r = 0; r < 7; r++) {
      const key = localDay(cursor.getTime())
      const hit = byDate.get(key)
      const future = key > todayKey
      const tokens = future ? 0 : (hit?.tokens ?? 0)
      if (tokens > max) max = tokens
      col.push({ date: key, tokens, costUsd: future ? 0 : (hit?.costUsd ?? 0), level: 0, future })
      cursor.setDate(cursor.getDate() + 1)
    }
    cols.push(col)
  }
  for (const col of cols)
    for (const c of col) {
      if (c.tokens <= 0 || max <= 0) continue
      const q = c.tokens / max
      c.level = q > 0.75 ? 4 : q > 0.5 ? 3 : q > 0.25 ? 2 : 1
    }
  return cols
}

/** Busiest day in the cells (null when all empty). */
export function bestDay(cols: readonly HeatCell[][]): HeatCell | null {
  let best: HeatCell | null = null
  for (const col of cols) for (const c of col) if (c.tokens > 0 && (!best || c.tokens > best.tokens)) best = c
  return best
}

/** The window a provider's headline rests on: the highest used %. */
export function peakWindow(p: ProviderUsage): LimitWindow | null {
  // API-key billing has no plan limits: whatever a subscription login still reports is not
  // what these runs draw on.
  if (isApiBilled(p)) return null
  if (!p.enabled || !p.limits || p.limits.status !== 'ok') return null
  let best: LimitWindow | null = null
  for (const w of p.limits.windows) if (!best || w.usedPercent > best.usedPercent) best = w
  return best
}

/** Menu-bar title: provider initial + the highest used % across providers (`C 77%`), or ''
 *  when nothing is known / the setting is off. */
export function trayUsageTitle(s: UsageSnapshot | null): string {
  if (!s || !s.prefs.trayTitle) return ''
  let best: { p: ProviderUsage; w: LimitWindow } | null = null
  for (const p of s.providers) {
    const w = peakWindow(p)
    if (w && (!best || w.usedPercent > best.w.usedPercent)) best = { p, w }
  }
  if (!best) return ''
  return `${best.p.label.charAt(0).toUpperCase()} ${Math.round(clampPercent(best.w.usedPercent))}%`
}

/** Merge local usage across providers (Overview). */
export function sumLocal(list: readonly (LocalUsage | null)[]): LocalUsage {
  let tokens = ZERO_TOKENS
  let costUsd = 0
  let unpricedTokens = 0
  let sessions = 0
  let turns = 0
  let events = 0
  let prsCreated = 0
  let activeSeconds = 0
  let firstSeen: number | null = null
  let lastSeen: number | null = null
  const models: ModelUsage[] = []
  const days = new Map<string, DayUsage>()
  for (const l of list) {
    if (!l) continue
    tokens = addTokens(tokens, l.tokens)
    costUsd += l.costUsd
    unpricedTokens += l.unpricedTokens
    sessions += l.sessions
    turns += l.turns
    events += l.events
    prsCreated += l.prsCreated
    activeSeconds += l.activeSeconds
    if (l.firstSeen !== null) firstSeen = firstSeen === null ? l.firstSeen : Math.min(firstSeen, l.firstSeen)
    if (l.lastSeen !== null) lastSeen = lastSeen === null ? l.lastSeen : Math.max(lastSeen, l.lastSeen)
    models.push(...l.models)
    for (const d of l.days) {
      const cur = days.get(d.date)
      if (cur) {
        cur.tokens += d.tokens
        cur.costUsd += d.costUsd
      } else days.set(d.date, { ...d })
    }
  }
  return {
    tokens,
    costUsd,
    unpricedTokens,
    sessions,
    turns,
    events,
    models: models.sort((a, b) => totalTokens(b.tokens) - totalTokens(a.tokens)),
    days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    prsCreated,
    activeSeconds,
    firstSeen,
    lastSeen
  }
}

/** Days with any tokens. */
export function activeDays(l: LocalUsage): number {
  return l.days.filter((d) => d.tokens > 0).length
}
