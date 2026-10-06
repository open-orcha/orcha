/** Plan-usage publisher (main process): after a limits refresh, PUT a privacy-safe snapshot of
 *  the Usage panel's plan limits to every running Embodent portal on this Mac, so the iOS /
 *  Android apps can show it (portal mig 069, `PUT /api/plan-usage`).
 *
 *  PRIVACY (hard rule): the payload is built field-by-field from an allow-list — plan names,
 *  window labels / used % / reset times, today's tokens + Est. cost. Nothing else from the
 *  UsageSnapshot (log paths, notes, explainers, sources) and never a credential: the OAuth
 *  token never reaches the snapshot in the first place (limits.ts holds it for one request).
 *
 *  Pacing: at most once per PUBLISH_MIN_MS per portal. Fire-and-forget: failures are logged,
 *  never thrown; a 404 means an older portal without the route and is skipped quietly. */

import { formatResetIn, localDay, type LimitWindow, type ProviderUsage, type UsageSnapshot } from '../../shared/usage'
import type { Stack } from '../../shared/types'

export const PUBLISH_MIN_MS = 60_000
/** Mirrors the portal's Pydantic limits (plan_usage_routes.py). */
const MAX_WINDOWS = 10
const LABEL_MAX = 40
const HEADLINE_MAX = 80
const PLAN_MAX = 30
const HOST_MAX = 120

export type PlanUsageProviderId = 'claude' | 'codex'

export interface PlanUsageWindowPayload {
  key: string
  label: string
  used_pct: number
  resets_at: string | null
}

export interface PlanUsageProviderPayload {
  provider: PlanUsageProviderId
  plan: string | null
  headline: string | null
  windows: PlanUsageWindowPayload[]
  today: { tokens: number; cost_usd: number } | null
}

export interface PlanUsagePayload {
  host: string
  captured_at: string
  providers: PlanUsageProviderPayload[]
}

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s)

/** The panel's headline ("5h resets in 3h 26m"): the 5-hour window when there is one, else
 *  the first window with a reset — same rule as the renderer's headlineReset(). */
export function planHeadline(windows: readonly LimitWindow[], now: number): string | null {
  const primary = windows.find((w) => w.key === '5h' || w.key === 'primary') ?? windows[0]
  const withReset = primary?.resetsAt ? primary : windows.find((w) => w.resetsAt)
  const text = withReset ? formatResetIn(withReset.resetsAt, now) : null
  if (!text || !withReset) return null
  return `${withReset.label} ${text.charAt(0).toLowerCase()}${text.slice(1)}`
}

function windowKey(key: string): string {
  // per-model weekly windows: desktop `wk:fable` → contract `model:fable`
  return clip(key.startsWith('wk:') ? `model:${key.slice(3)}` : key, LABEL_MAX)
}

function providerPayload(p: ProviderUsage, now: number): PlanUsageProviderPayload | null {
  if (p.id !== 'claude' && p.id !== 'codex') return null
  if (!p.enabled) return null
  // API-key billing has no plan limits: publish today's spend under the plan name "API key".
  const apiKey = p.billing === 'api-key'
  const ok = !apiKey && p.limits?.status === 'ok' ? p.limits : null
  const windows = (ok?.windows ?? []).slice(0, MAX_WINDOWS)
  const day = p.local?.days.find((d) => d.date === localDay(now))
  const today = day && day.tokens > 0 ? { tokens: Math.round(day.tokens), cost_usd: Math.round(Math.max(0, day.costUsd) * 100) / 100 } : null
  if (windows.length === 0 && !today) return null
  const headline = ok ? planHeadline(windows, now) : null
  const plan = apiKey ? 'API key' : (p.limits?.plan ?? null)
  return {
    provider: p.id,
    plan: plan ? clip(plan, PLAN_MAX) : null,
    headline: headline ? clip(headline, HEADLINE_MAX) : null,
    windows: windows.map((w) => ({
      key: windowKey(w.key),
      label: clip(w.label, LABEL_MAX),
      used_pct: Math.min(100, Math.max(0, Number.isFinite(w.usedPercent) ? w.usedPercent : 0)),
      resets_at: w.resetsAt !== null && Number.isFinite(w.resetsAt) ? new Date(w.resetsAt).toISOString() : null
    })),
    today
  }
}

/** UsageSnapshot → the portal payload, or null when there is nothing worth publishing. */
export function buildPlanUsagePayload(snap: UsageSnapshot, host: string, now: number): PlanUsagePayload | null {
  const providers = snap.providers.map((p) => providerPayload(p, now)).filter((p): p is PlanUsageProviderPayload => p !== null)
  if (providers.length === 0) return null
  return { host: clip(host.trim() || 'desktop', HOST_MAX), captured_at: new Date(snap.updatedAt ?? now).toISOString(), providers }
}

/** Base URL of every running portal on this Mac (one per stack, de-duplicated). */
export function portalBases(stacks: readonly Stack[]): string[] {
  const bases = new Set<string>()
  for (const s of stacks) if (s.running && s.apiPort !== null) bases.add(`http://localhost:${s.apiPort}`)
  return [...bases]
}

export interface PlanUsagePublisherDeps {
  listStacks(): Promise<Stack[]>
  fetch: typeof fetch
  host(): string
  now(): number
  log?(msg: string): void
  minIntervalMs?: number
}

/** Throttled, fire-and-forget PUT of the snapshot to every running portal. */
export function createPlanUsagePublisher(deps: PlanUsagePublisherDeps): { publish(snap: UsageSnapshot): Promise<void> } {
  const lastSent = new Map<string, number>()
  const minMs = deps.minIntervalMs ?? PUBLISH_MIN_MS
  const log = deps.log ?? ((m: string) => console.warn(m))
  return {
    async publish(snap) {
      try {
        // Only a finished refresh with real numbers — never the "scanning…" emit.
        if (snap.scanning) return
        const now = deps.now()
        const payload = buildPlanUsagePayload(snap, deps.host(), now)
        if (!payload) return
        const bases = portalBases(await deps.listStacks())
        const body = JSON.stringify(payload)
        await Promise.all(
          bases.map(async (base) => {
            const last = lastSent.get(base)
            if (last !== undefined && now - last < minMs) return
            lastSent.set(base, now)
            try {
              const res = await deps.fetch(`${base}/api/plan-usage`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body,
                signal: AbortSignal.timeout(5000)
              })
              if (res.status === 404) return // older portal without the route — skip quietly
              if (!res.ok) log(`[plan-usage] PUT ${base} -> ${res.status}`)
            } catch (err) {
              log(`[plan-usage] PUT ${base} failed: ${err instanceof Error ? err.message : String(err)}`)
            }
          })
        )
      } catch (err) {
        log(`[plan-usage] publish failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
}
