/** Embodent's own agent stats — agents spawned from its terminals and the time they spent
 *  working — persisted in <userData>/usage-stats.json. Follows Orca's stats tracker
 *  (github.com/stablyai/orca, MIT © Lovecast Inc.): a session entering `working` opens a timer,
 *  leaving it (done / attention / error / idle / exit) closes it and adds the duration.
 *  Pure apart from the injected load/save — appStats.test.ts. */

import type { AppStats } from '../../shared/usage'
import type { TermStatus } from '../../shared/terminal'

export interface StatsFile {
  version: 1
  agentsSpawned: number
  agentMs: number
  since: number | null
}

export function parseStatsFile(raw: unknown): StatsFile {
  const out: StatsFile = { version: 1, agentsSpawned: 0, agentMs: 0, since: null }
  if (!raw || typeof raw !== 'object') return out
  const r = raw as Record<string, unknown>
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
  out.agentsSpawned = Math.floor(n(r.agentsSpawned))
  out.agentMs = n(r.agentMs)
  out.since = typeof r.since === 'number' && Number.isFinite(r.since) ? r.since : null
  return out
}

/** One working stretch longer than this is capped (a wedged status must not count days). */
export const MAX_STRETCH_MS = 6 * 60 * 60_000

export class AppStatsLedger {
  private data: StatsFile
  private readonly agents = new Set<number>()
  private readonly working = new Map<number, number>()

  constructor(
    private readonly deps: { load(): unknown; save(f: StatsFile): void; now(): number }
  ) {
    this.data = parseStatsFile(deps.load())
  }

  private ensureSince(now: number): void {
    if (this.data.since === null) this.data.since = now
  }

  /** An agent terminal (not a shell, not a --version probe) was launched. */
  spawned(id: number): void {
    const now = this.deps.now()
    this.agents.add(id)
    this.ensureSince(now)
    this.data.agentsSpawned++
    this.deps.save(this.data)
  }

  status(id: number, status: TermStatus): void {
    if (!this.agents.has(id)) return
    const now = this.deps.now()
    if (status === 'working') {
      if (!this.working.has(id)) this.working.set(id, now)
      return
    }
    this.close(id, now)
  }

  exited(id: number): void {
    this.close(id, this.deps.now())
    this.agents.delete(id)
  }

  private close(id: number, now: number): void {
    const start = this.working.get(id)
    if (start === undefined) return
    this.working.delete(id)
    this.data.agentMs += Math.min(MAX_STRETCH_MS, Math.max(0, now - start))
    this.deps.save(this.data)
  }

  /** Flush open timers (app quitting). */
  flush(): void {
    const now = this.deps.now()
    for (const id of [...this.working.keys()]) this.close(id, now)
  }

  snapshot(): AppStats {
    const now = this.deps.now()
    let open = 0
    for (const start of this.working.values()) open += Math.min(MAX_STRETCH_MS, Math.max(0, now - start))
    return {
      agentsSpawned: this.data.agentsSpawned,
      agentSeconds: Math.round((this.data.agentMs + open) / 1000),
      trackingSince: this.data.since
    }
  }
}
