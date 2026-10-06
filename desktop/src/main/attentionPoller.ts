import type { StackAttention } from './attention'
import type { AttentionItem, AttentionProjectStatus, AttentionSnapshot, Stack } from '../shared/types'

export interface PollerDeps {
  listStacks(): Promise<Stack[]>
  fetchStackAttention(stack: Stack): Promise<StackAttention>
  /** Fire a user-facing notification (system Notification in production). */
  notify(item: AttentionItem): void
  /** Optional gate asked before `notify` (the person's notification settings, portal
   *  mig 063 — notifyPrefs.shouldShowAttention). Only the ALERT is gated: the item still
   *  counts as seen and still appears in `current()` / the badge / the popover. */
  gate?(item: AttentionItem): Promise<boolean>
  /** Called with the full current item list, stacks, and per-project fetch
   *  details (running stacks only) after every successful tick. */
  onUpdate?(items: AttentionItem[], stacks: Stack[], details: Map<string, StackAttention>): void
}

const key = (i: AttentionItem): string => `${i.project}:${i.kind}:${i.id}`

/** Polls stacks for human-attention items. First tick is a silent baseline;
 *  afterwards every newly-appearing item notifies exactly once (and again if
 *  it disappears and comes back). Health transitions notify directly. */
export class AttentionPoller {
  private seen = new Set<string>()
  private baselined = false
  /** Projects whose items have been fetched successfully at least once. A project's FIRST
   *  successful fetch is its own silent baseline — so a stack that was unreachable at
   *  startup, or restarting (upgrade, Docker restart, wake from sleep), never floods the
   *  person with its whole existing queue when it comes back. */
  private baselinedProjects = new Set<string>()
  private lastRunning = new Map<string, boolean>()
  private cached: AttentionItem[] = []
  /** Per running stack: what the last tick fetched (or that it failed) — lets the host
   *  sidebar tell "unavailable" from "zero" (V2). Stopped stacks are absent. */
  private projects = new Map<string, AttentionProjectStatus>()
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false

  constructor(
    private deps: PollerDeps,
    private intervalMs = 15_000
  ) {}

  current(): AttentionItem[] {
    return this.cached
  }

  /** Items plus per-project availability (V2 host sidebar). */
  snapshot(): AttentionSnapshot {
    return { items: this.cached, projects: [...this.projects.values()] }
  }

  /** A project was removed: drop everything cached for it, so its items vanish now and a
   *  re-added stack of the same name starts from a clean baseline (no "back up" alert). */
  forget(project: string): void {
    this.lastRunning.delete(project)
    this.projects.delete(project)
    this.cached = this.cached.filter((i) => i.project !== project)
    for (const k of [...this.seen]) if (k.startsWith(`${project}:`)) this.seen.delete(k)
    this.baselinedProjects.delete(project)
  }

  start(): void {
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** notify(), unless the gate says the person turned this alert off. A gate that
   *  throws fails OPEN (the alert shows) — settings trouble must never silence alerts. */
  private async alert(item: AttentionItem): Promise<void> {
    let show = true
    if (this.deps.gate) {
      try {
        show = await this.deps.gate(item)
      } catch {
        show = true
      }
    }
    if (show) this.deps.notify(item)
  }

  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      let stacks: Stack[]
      try {
        stacks = await this.deps.listStacks()
      } catch {
        return // docker down: keep the previous cache; recover next tick
      }

      for (const s of stacks) {
        const was = this.lastRunning.get(s.project)
        if (this.baselined && was !== undefined && was !== s.running) {
          await this.alert({
            project: s.project,
            projectShort: s.projectShort,
            kind: 'health',
            id: `health:${s.project}:${s.running ? 'up' : 'down'}`,
            title: s.running ? `${s.projectShort} is back up` : `${s.projectShort} went down`,
            path: '/'
          })
        }
        this.lastRunning.set(s.project, s.running)
      }

      const items: AttentionItem[] = []
      const fetchedOk = new Set<string>()
      const details = new Map<string, StackAttention>()
      const projects = new Map<string, AttentionProjectStatus>()
      for (const s of stacks) {
        if (!s.running) continue
        try {
          const detail = await this.deps.fetchStackAttention(s)
          details.set(s.project, detail)
          items.push(...detail.items)
          fetchedOk.add(s.project)
          projects.set(s.project, {
            project: s.project,
            containers: detail.containers ?? [],
            unavailable: detail.unavailable ?? [],
            fetchedAt: new Date().toISOString(),
            ok: true
          })
        } catch {
          // one stack's API hiccup must not kill the tick — but record it as unavailable
          // (keeping the last good fetch time) so the UI never shows it as "zero".
          const prev = this.projects.get(s.project)
          projects.set(s.project, {
            project: s.project,
            containers: [],
            unavailable: [],
            fetchedAt: prev?.fetchedAt ?? null,
            ok: false
          })
        }
      }
      this.projects = projects

      // Alert only for projects that already have a baseline; a project fetched for the
      // first time (or the first time since it was forgotten) is recorded silently.
      for (const i of items) {
        if (this.baselinedProjects.has(i.project) && !this.seen.has(key(i))) await this.alert(i)
      }
      // A project we couldn't read this tick (down, restarting, API hiccup) KEEPS what we'd
      // already seen for it — replacing the whole set would make its queue look new later.
      const kept = [...this.seen].filter((k) => !fetchedOk.has(k.slice(0, k.indexOf(':'))))
      this.seen = new Set([...kept, ...items.map(key)])
      for (const p of fetchedOk) this.baselinedProjects.add(p)
      this.cached = items
      this.baselined = true
      this.deps.onUpdate?.(items, stacks, details)
    } finally {
      this.ticking = false
    }
  }
}
