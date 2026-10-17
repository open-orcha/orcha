/** Plan-usage display setting sync (main process): the portal-wide "Show plan usage" switch
 *  and its provider choice (portal mig 070, `GET`/`PUT /api/plan-usage/display`).
 *
 *  Read: GET every running portal; the newest `updated_at` wins and a never-set (null) value
 *  loses to any set one (shared/usage.ts mergePlanUsageDisplays). The last value is cached in
 *  <userData> so the sidebar is right at launch before any portal answers, and that cached
 *  value takes part in the merge — a change made while no project runs is kept, not reset.
 *  A 404 (older portal) or a network error is ignored; when no portal answers at all the
 *  cached value stands.
 *
 *  Write: the new value applies at once (cache + renderer), then is PUT to every running
 *  portal — fire-and-forget, failures logged. PUTs to one portal are serialised so rapid
 *  toggles land in order. Same base URLs and headers as the plan-usage publisher. */

import {
  DEFAULT_PLAN_USAGE_DISPLAY,
  mergePlanUsageDisplays,
  parsePlanUsageDisplay,
  parsePlanUsageDisplayInput,
  type PlanUsageDisplay
} from '../../shared/usage'
import type { Stack } from '../../shared/types'
import { portalBases } from './planUsagePublisher'

/** Re-read alongside the plan-usage polling. */
export const DISPLAY_POLL_MS = 120_000
/** A focus re-read is skipped when the last read is this fresh. */
export const DISPLAY_FOCUS_MIN_MS = 15_000
const PATH = '/api/plan-usage/display'

export interface PlanUsageDisplaySyncDeps {
  listStacks(): Promise<Stack[]>
  fetch: typeof fetch
  now(): number
  /** The cached value (any shape; validated here), null when there is none. */
  load(): unknown
  save(d: PlanUsageDisplay): void
  onChange(d: PlanUsageDisplay): void
  log?(msg: string): void
}

export interface PlanUsageDisplaySync {
  get(): PlanUsageDisplay
  /** Re-read the portals; `force: false` skips when the last read is fresh (focus). */
  refresh(opts?: { force?: boolean }): Promise<PlanUsageDisplay>
  /** Apply a change (validated); resolves with the new value before the PUTs finish. */
  set(raw: unknown): PlanUsageDisplay | null
  /** Resolves when every PUT started so far has settled (tests). */
  flush(): Promise<void>
}

const same = (a: PlanUsageDisplay, b: PlanUsageDisplay): boolean =>
  a.show === b.show && a.providers === b.providers && a.updatedAt === b.updatedAt

export function createPlanUsageDisplaySync(deps: PlanUsageDisplaySyncDeps): PlanUsageDisplaySync {
  const log = deps.log ?? ((m: string) => console.warn(m))
  let value = parsePlanUsageDisplay(deps.load()) ?? DEFAULT_PLAN_USAGE_DISPLAY
  let lastRead = -Infinity
  let inflight: Promise<PlanUsageDisplay> | null = null
  const putChains = new Map<string, Promise<void>>()
  let lastSet: Promise<void> = Promise.resolve()

  const commit = (next: PlanUsageDisplay): void => {
    if (same(value, next)) return
    value = next
    deps.save(next)
    deps.onChange(next)
  }

  const bases = async (): Promise<string[]> => {
    try {
      return portalBases(await deps.listStacks())
    } catch (err) {
      log(`[plan-usage-display] listing stacks failed: ${err instanceof Error ? err.message : String(err)}`)
      return []
    }
  }

  /** One portal's value; null when it can't say (older portal, down, junk). */
  const readOne = async (base: string): Promise<PlanUsageDisplay | null> => {
    try {
      const res = await deps.fetch(`${base}${PATH}`, { signal: AbortSignal.timeout(5000) })
      if (res.status === 404) return null // older portal without the route — skip quietly
      if (!res.ok) {
        log(`[plan-usage-display] GET ${base} -> ${res.status}`)
        return null
      }
      return parsePlanUsageDisplay(await res.json())
    } catch {
      return null // stopped / starting portal: not worth a log line every poll
    }
  }

  const read = async (): Promise<PlanUsageDisplay> => {
    lastRead = deps.now()
    const answers = (await Promise.all((await bases()).map(readOne))).filter((d): d is PlanUsageDisplay => d !== null)
    // Merge against the CURRENT value (a set() during the read must not be undone).
    if (answers.length > 0) commit(mergePlanUsageDisplays([value, ...answers]))
    return value
  }

  const put = (base: string, body: string): void => {
    const prev = putChains.get(base) ?? Promise.resolve()
    const next = prev.then(async () => {
      try {
        const res = await deps.fetch(`${base}${PATH}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(5000)
        })
        if (res.status === 404) return // older portal without the route — skip quietly
        if (!res.ok) log(`[plan-usage-display] PUT ${base} -> ${res.status}`)
      } catch (err) {
        log(`[plan-usage-display] PUT ${base} failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    })
    putChains.set(base, next)
  }

  return {
    get: () => value,
    refresh(opts = {}) {
      if (inflight) return inflight
      if (opts.force === false && deps.now() - lastRead < DISPLAY_FOCUS_MIN_MS) return Promise.resolve(value)
      inflight = read().finally(() => {
        inflight = null
      })
      return inflight
    },
    set(raw) {
      const input = parsePlanUsageDisplayInput(raw)
      if (!input) return null
      commit({ ...input, updatedAt: new Date(deps.now()).toISOString() })
      const body = JSON.stringify(input)
      lastSet = bases().then((list) => {
        for (const base of list) put(base, body)
      })
      return value
    },
    async flush() {
      await lastSet
      await Promise.all([...putChains.values()])
    }
  }
}
