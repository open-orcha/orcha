/** Subscription windows (5-hour / weekly / per-model weekly), from the provider itself —
 *  adapted from Orca's rate-limit readers (github.com/stablyai/orca, MIT © Lovecast Inc.).
 *
 *  Claude — OPT-IN (it uses a credential): Claude Code's own OAuth access token, read from
 *  the macOS Keychain item Claude Code created ("Claude Code-credentials", via
 *  /usr/bin/security) or, when that is absent, from `~/.claude/.credentials.json` (read-only).
 *  The token is sent ONLY to Anthropic (GET https://api.anthropic.com/api/oauth/usage), held
 *  in memory for that one request, and never logged or persisted. The token is never
 *  refreshed here and nothing in ~/.claude is written: an expired sign-in is reported as
 *  "Sign-in expired" and Claude Code refreshes it the next time it runs.
 *
 *  Codex — no credential: the Codex CLI writes its plan's `rate_limits` into its own session
 *  log on every response, so the newest record IS the current window as of the last Codex
 *  response (logParsers.ts). A window whose reset time has passed since then is shown as
 *  reset (0 %), never as the stale figure. */

import { createHash } from 'node:crypto'
import type { LimitWindow, ProviderLimits } from '../../shared/usage'
import type { CodexLimitsRecord, CodexWindowRecord } from './logParsers'

export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
export const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function pct(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null
}

function resetMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e10 ? v * 1000 : v
  if (typeof v === 'string' && v) {
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : null
  }
  return null
}

function windowFrom(key: string, label: string, raw: unknown, minutes: number | null): LimitWindow | null {
  if (!isRecord(raw)) return null
  const p = pct(raw.utilization ?? raw.used_percentage ?? raw.percent)
  if (p === null) return null
  return { key, label, usedPercent: p, resetsAt: resetMs(raw.resets_at), windowMinutes: minutes }
}

/** Anthropic's OAuth usage response → windows. Utilization is 0–100. */
export function parseClaudeUsage(json: unknown): LimitWindow[] {
  if (!isRecord(json)) return []
  const out: LimitWindow[] = []
  const five = windowFrom('5h', '5h', json.five_hour, 300)
  if (five) out.push(five)
  const week = windowFrom('wk', 'wk', json.seven_day, 10080)
  if (week) out.push(week)
  const perModel = new Map<string, LimitWindow>()
  // Newer responses: limits[] with weekly_scoped entries naming the model.
  if (Array.isArray(json.limits)) {
    for (const l of json.limits) {
      if (!isRecord(l) || l.kind !== 'weekly_scoped' || !isRecord(l.scope) || !isRecord(l.scope.model)) continue
      const name = l.scope.model.display_name
      if (typeof name !== 'string' || !name.trim()) continue
      const label = name.trim().replace(/^claude\s+/i, '')
      const w = windowFrom(`wk:${label.toLowerCase()}`, label.charAt(0).toUpperCase() + label.slice(1), l, 10080)
      if (w) perModel.set(w.key, w)
    }
  }
  // Older / alternative field names: seven_day_<family>, <family>_weekly, <family>_seven_day.
  for (const [k, v] of Object.entries(json)) {
    const m = /^(?:seven_day_([a-z]+)|([a-z]+)_(?:weekly|seven_day))$/.exec(k)
    const fam = m ? (m[1] ?? m[2]) : null
    if (!fam || fam === 'oauth' || fam === 'apps' || fam === 'cowork') continue
    const label = fam.charAt(0).toUpperCase() + fam.slice(1)
    const key = `wk:${fam}`
    if (perModel.has(key)) continue
    const w = windowFrom(key, label, v, 10080)
    if (w) perModel.set(key, w)
  }
  return [...out, ...perModel.values()]
}

/** Keychain service name Claude Code uses for a custom CLAUDE_CONFIG_DIR (Orca's rule). */
export function claudeKeychainServices(configDir: string | undefined): string[] {
  if (!configDir) return [CLAUDE_KEYCHAIN_SERVICE]
  const h = createHash('sha256').update(configDir.normalize('NFC')).digest('hex').slice(0, 8)
  return [`${CLAUDE_KEYCHAIN_SERVICE}-${h}`, CLAUDE_KEYCHAIN_SERVICE]
}

/** Pull the access token (and plan) out of Claude Code's stored credentials JSON. */
export function parseClaudeCredentials(text: string | null): { token: string; plan: string | null } | null {
  if (!text) return null
  try {
    const j = JSON.parse(text) as unknown
    if (!isRecord(j) || !isRecord(j.claudeAiOauth)) return null
    const o = j.claudeAiOauth
    if (typeof o.accessToken !== 'string' || !o.accessToken) return null
    const plan = typeof o.subscriptionType === 'string' && o.subscriptionType ? o.subscriptionType : null
    return { token: o.accessToken, plan }
  } catch {
    return null
  }
}

export interface ClaudeLimitsDeps {
  /** Claude Code's credentials JSON (Keychain first, then the file), or null. */
  readCredentials(): Promise<string | null>
  fetch: typeof fetch
  now(): number
}

function planLabel(p: string | null): string | null {
  if (!p) return null
  return p.charAt(0).toUpperCase() + p.slice(1)
}

export async function readClaudeLimits(deps: ClaudeLimitsDeps): Promise<ProviderLimits> {
  const now = deps.now()
  const base = { source: 'Anthropic usage API', fetchedAt: now }
  const creds = parseClaudeCredentials(await deps.readCredentials().catch(() => null))
  if (!creds) {
    return { ...base, status: 'signed-out', windows: [], note: 'No Claude Code sign-in found on this Mac (API-key billing has no subscription limits).' }
  }
  let res: Response
  try {
    res = await deps.fetch(CLAUDE_USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${creds.token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'claude-code/2.1.0',
        Accept: 'application/json'
      },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000)
    })
  } catch {
    return { ...base, status: 'error', windows: [], plan: planLabel(creds.plan), note: 'Couldn’t reach Anthropic — will retry.' }
  }
  if (res.status === 401 || res.status === 403) {
    return { ...base, status: 'expired', windows: [], plan: planLabel(creds.plan), note: 'Sign-in expired — run `claude` once to refresh it.' }
  }
  if (!res.ok) {
    const note = res.status === 429 ? 'Rate limited by Anthropic — will retry later.' : `Anthropic returned ${res.status} — will retry.`
    return { ...base, status: 'error', windows: [], plan: planLabel(creds.plan), note }
  }
  let json: unknown
  try {
    json = await res.json()
  } catch {
    return { ...base, status: 'error', windows: [], plan: planLabel(creds.plan), note: 'Unreadable response from Anthropic.' }
  }
  const windows = parseClaudeUsage(json)
  if (windows.length === 0) return { ...base, status: 'unavailable', windows: [], plan: planLabel(creds.plan), note: 'No subscription windows reported for this account.' }
  return { ...base, status: 'ok', windows, plan: planLabel(creds.plan) }
}

function codexLabel(minutes: number | null, fallback: string): string {
  if (minutes === null) return fallback
  if (Math.abs(minutes - 300) <= 1) return '5h'
  if (Math.abs(minutes - 10080) <= 1) return 'wk'
  if (minutes % 1440 === 0) return `${minutes / 1440}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

function codexWindow(key: string, w: CodexWindowRecord, fallback: string, now: number): LimitWindow {
  // The window rolled over since the last Codex response: its usage restarted at zero.
  const rolled = w.resetsAt !== null && w.resetsAt <= now
  return {
    key,
    label: codexLabel(w.windowMinutes, fallback),
    usedPercent: rolled ? 0 : w.usedPercent,
    resetsAt: rolled ? null : w.resetsAt,
    windowMinutes: w.windowMinutes
  }
}

export function codexLimitsFromLog(rec: CodexLimitsRecord | null, now: number): ProviderLimits {
  if (!rec) {
    return { status: 'unavailable', windows: [], source: 'Codex session log', fetchedAt: null, note: 'No rate-limit record in the Codex logs yet — run Codex once.' }
  }
  const windows: LimitWindow[] = []
  if (rec.primary) windows.push(codexWindow('primary', rec.primary, '5h', now))
  if (rec.secondary) windows.push(codexWindow('secondary', rec.secondary, 'wk', now))
  return {
    status: 'ok',
    windows,
    source: 'Codex session log',
    fetchedAt: rec.at,
    plan: rec.plan ? rec.plan.charAt(0).toUpperCase() + rec.plan.slice(1) : null
  }
}
