import { describe, it, expect, vi } from 'vitest'
import { createPlanUsageDisplaySync, DISPLAY_FOCUS_MIN_MS, type PlanUsageDisplaySyncDeps } from './planUsageDisplay'
import { DEFAULT_PLAN_USAGE_DISPLAY, mergePlanUsageDisplays, parsePlanUsageDisplay, type PlanUsageDisplay } from '../../shared/usage'
import type { Stack } from '../../shared/types'

const NOW = Date.parse('2026-10-03T12:00:00.000Z')

function stack(port: number | null, running = true): Stack {
  return { project: `orcha-${port}`, projectShort: String(port), apiPort: port, dbPort: null, portalStatus: 'Up', running, folder: null }
}

const d = (show: boolean, providers: PlanUsageDisplay['providers'], updatedAt: string | null): PlanUsageDisplay => ({ show, providers, updatedAt })
/** Portal wire shape (`updated_at`). */
const wire = (show: boolean, providers: string, updated_at: string | null) => ({ show, providers, updated_at })

/** Fake portals by port: a body to answer GET with, or an HTTP status / a thrown error. */
function portals(byPort: Record<number, unknown>) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const port = Number(/:(\d+)\//.exec(String(url))![1])
    const r = byPort[port]
    if (r instanceof Error) throw r
    if (typeof r === 'number') return new Response('{}', { status: r })
    if (init?.method === 'PUT') return new Response(JSON.stringify({ ...JSON.parse(String(init.body)), updated_at: new Date(NOW).toISOString() }))
    return new Response(JSON.stringify(r))
  })
}

function sync(over: Partial<PlanUsageDisplaySyncDeps> & { ports?: number[] } = {}) {
  const deps: PlanUsageDisplaySyncDeps = {
    listStacks: async () => (over.ports ?? [8000, 8001]).map((p) => stack(p)),
    fetch: portals({}),
    now: () => NOW,
    load: () => null,
    save: vi.fn(),
    onChange: vi.fn(),
    log: vi.fn(),
    ...over
  }
  return { s: createPlanUsageDisplaySync(deps), deps }
}

describe('mergePlanUsageDisplays (the sync rule)', () => {
  it('newest updated_at wins; never-set loses to any set value; all never-set → default (off, both)', () => {
    const old = d(true, 'claude', '2026-10-01T10:00:00Z')
    const newer = d(false, 'codex', '2026-10-02T10:00:00.123456+00:00')
    expect(mergePlanUsageDisplays([old, newer])).toEqual(newer)
    expect(mergePlanUsageDisplays([newer, old])).toEqual(newer)
    expect(mergePlanUsageDisplays([d(false, 'both', null), old, null])).toEqual(old)
    expect(mergePlanUsageDisplays([d(true, 'codex', null), d(true, 'claude', null)])).toEqual(DEFAULT_PLAN_USAGE_DISPLAY)
    expect(mergePlanUsageDisplays([])).toEqual({ show: false, providers: 'both', updatedAt: null })
  })

  it('parses the portal shape strictly (microsecond timestamps ok)', () => {
    expect(parsePlanUsageDisplay(wire(true, 'codex', '2026-10-02T10:00:00.123456+00:00'))).toEqual(d(true, 'codex', '2026-10-02T10:00:00.123456+00:00'))
    expect(parsePlanUsageDisplay(wire(false, 'both', null))).toEqual(d(false, 'both', null))
    expect(parsePlanUsageDisplay(wire(true, 'gemini', null))).toBeNull()
    expect(parsePlanUsageDisplay({ show: 'yes', providers: 'both' })).toBeNull()
    expect(parsePlanUsageDisplay(wire(true, 'both', 'not a date'))).toBeNull()
  })
})

describe('createPlanUsageDisplaySync', () => {
  it('starts from the cache (no flash at launch), else the default', () => {
    expect(sync({ load: () => d(true, 'codex', '2026-10-01T00:00:00Z') }).s.get()).toEqual(d(true, 'codex', '2026-10-01T00:00:00Z'))
    expect(sync({ load: () => ({ junk: 1 }) }).s.get()).toEqual(DEFAULT_PLAN_USAGE_DISPLAY)
  })

  it('reads every running portal and takes the newest; 404s and errors are ignored', async () => {
    const fetch = portals({
      8000: wire(true, 'claude', '2026-10-01T10:00:00Z'),
      8001: wire(true, 'codex', '2026-10-02T10:00:00Z'),
      8002: 404,
      8003: new Error('ECONNREFUSED')
    })
    const { s, deps } = sync({ fetch, ports: [8000, 8001, 8002, 8003] })
    expect(await s.refresh()).toEqual(d(true, 'codex', '2026-10-02T10:00:00Z'))
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(String(fetch.mock.calls[0][0])).toBe('http://localhost:8000/api/plan-usage/display')
    expect(deps.save).toHaveBeenCalledWith(d(true, 'codex', '2026-10-02T10:00:00Z'))
    expect(deps.onChange).toHaveBeenCalledTimes(1)
    // same answer again: no change event
    await s.refresh()
    expect(deps.onChange).toHaveBeenCalledTimes(1)
  })

  it('a newer cached value beats older portals; portals all never-set keep a set cache; nothing reachable keeps the cache', async () => {
    const cached = d(true, 'claude', '2026-10-03T11:00:00Z')
    const older = sync({ load: () => cached, fetch: portals({ 8000: wire(false, 'both', '2026-10-01T00:00:00Z'), 8001: wire(false, 'both', null) }) })
    expect(await older.s.refresh()).toEqual(cached)
    const down = sync({ load: () => cached, fetch: portals({ 8000: new Error('down'), 8001: 404 }) })
    expect(await down.s.refresh()).toEqual(cached)
    const fresh = sync({ fetch: portals({ 8000: wire(false, 'both', null), 8001: wire(false, 'both', null) }) })
    expect(await fresh.s.refresh()).toEqual(DEFAULT_PLAN_USAGE_DISPLAY)
  })

  it('set: applies at once, then PUTs {show, providers} to every running portal (one per port)', async () => {
    const fetch = portals({ 8000: {}, 8001: 404 })
    const log = vi.fn()
    const { s, deps } = sync({
      fetch,
      log,
      listStacks: async () => [stack(8000), stack(8000), stack(8001), stack(8002, false), stack(null)]
    })
    expect(s.set({ show: true, providers: 'both' })).toEqual(d(true, 'both', new Date(NOW).toISOString()))
    expect(s.get().show).toBe(true)
    expect(deps.onChange).toHaveBeenCalledWith(d(true, 'both', new Date(NOW).toISOString()))
    await s.flush()
    const puts = fetch.mock.calls.filter(([, init]) => init?.method === 'PUT')
    expect(puts.map(([u]) => String(u))).toEqual(['http://localhost:8000/api/plan-usage/display', 'http://localhost:8001/api/plan-usage/display'])
    expect(JSON.parse(String(puts[0][1]!.body))).toEqual({ show: true, providers: 'both' })
    expect(log).not.toHaveBeenCalled() // a 404 is an older portal: quiet
  })

  it('set: rejects junk; a failed PUT is logged, never thrown', async () => {
    const log = vi.fn()
    const { s } = sync({ fetch: portals({ 8000: 500, 8001: new Error('boom') }), log })
    expect(s.set({ show: true, providers: 'gemini' })).toBeNull()
    expect(s.set({ show: true, providers: 'claude', extra: 1 })).not.toBeNull()
    await s.flush()
    expect(log).toHaveBeenCalledWith('[plan-usage-display] PUT http://localhost:8000 -> 500')
    expect(log).toHaveBeenCalledWith('[plan-usage-display] PUT http://localhost:8001 failed: boom')
  })

  it('a read racing a change does not undo it', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const fetch = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'PUT') return new Response('{}')
      await gate
      return new Response(JSON.stringify(wire(false, 'both', '2026-10-03T11:59:00Z')))
    })
    const { s } = sync({ fetch, ports: [8000] })
    const reading = s.refresh()
    s.set({ show: true, providers: 'codex' })
    release()
    expect(await reading).toEqual(d(true, 'codex', new Date(NOW).toISOString()))
  })

  it('focus re-reads are skipped while the last read is fresh; polls (force) always read', async () => {
    let now = NOW
    const fetch = portals({ 8000: wire(false, 'both', null) })
    const { s } = sync({ fetch, ports: [8000], now: () => now })
    await s.refresh()
    await s.refresh({ force: false })
    expect(fetch).toHaveBeenCalledTimes(1)
    now += DISPLAY_FOCUS_MIN_MS
    await s.refresh({ force: false })
    await s.refresh()
    expect(fetch).toHaveBeenCalledTimes(3)
  })
})
