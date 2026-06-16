import type { StackAttention } from './attention'
import type { AttentionItem, Stack } from '../shared/types'

export interface PollerDeps {
  listStacks(): Promise<Stack[]>
  fetchStackAttention(stack: Stack): Promise<StackAttention>
  /** Fire a user-facing notification (system Notification in production). */
  notify(item: AttentionItem): void
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
  private lastRunning = new Map<string, boolean>()
  private cached: AttentionItem[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false

  constructor(
    private deps: PollerDeps,
    private intervalMs = 15_000
  ) {}

  current(): AttentionItem[] {
    return this.cached
  }

  start(): void {
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
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
          this.deps.notify({
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
      const details = new Map<string, StackAttention>()
      for (const s of stacks) {
        if (!s.running) continue
        try {
          const detail = await this.deps.fetchStackAttention(s)
          details.set(s.project, detail)
          items.push(...detail.items)
        } catch {
          // one stack's API hiccup must not kill the tick
        }
      }

      if (this.baselined) {
        for (const i of items) {
          if (!this.seen.has(key(i))) this.deps.notify(i)
        }
      }
      this.seen = new Set(items.map(key))
      this.cached = items
      this.baselined = true
      this.deps.onUpdate?.(items, stacks, details)
    } finally {
      this.ticking = false
    }
  }
}
