import { describe, it, expect, vi } from 'vitest'
import { AppStatsLedger, MAX_STRETCH_MS, parseStatsFile } from './appStats'

function ledger(initial: unknown = null) {
  let t = 1_000_000
  const save = vi.fn()
  const l = new AppStatsLedger({ load: () => initial, save, now: () => t })
  return { l, save, tick: (ms: number) => (t += ms) }
}

describe('AppStatsLedger', () => {
  it('counts agent spawns and working stretches (working → any other status closes it)', () => {
    const { l, tick } = ledger()
    l.spawned(1)
    l.status(1, 'working')
    tick(90_000)
    l.status(1, 'done')
    l.status(1, 'working')
    tick(30_000)
    expect(l.snapshot()).toMatchObject({ agentsSpawned: 1, agentSeconds: 120, trackingSince: 1_000_000 })
    l.exited(1)
    expect(l.snapshot().agentSeconds).toBe(120)
  })
  it('ignores sessions it did not see spawn (shells, probes) and caps a wedged stretch', () => {
    const { l, tick } = ledger()
    l.status(7, 'working')
    tick(60_000)
    l.status(7, 'idle')
    expect(l.snapshot().agentSeconds).toBe(0)
    l.spawned(2)
    l.status(2, 'working')
    tick(MAX_STRETCH_MS * 2)
    l.flush()
    expect(l.snapshot().agentSeconds).toBe(MAX_STRETCH_MS / 1000)
  })
  it('persists and reloads totals', () => {
    expect(parseStatsFile({ version: 1, agentsSpawned: 4, agentMs: 5000, since: 12 })).toEqual({ version: 1, agentsSpawned: 4, agentMs: 5000, since: 12 })
    expect(parseStatsFile({ agentsSpawned: -3, agentMs: 'x' })).toEqual({ version: 1, agentsSpawned: 0, agentMs: 0, since: null })
    const { l } = ledger({ version: 1, agentsSpawned: 4, agentMs: 5000, since: 12 })
    expect(l.snapshot()).toEqual({ agentsSpawned: 4, agentSeconds: 5, trackingSince: 12 })
  })
})
