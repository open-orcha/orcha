/** Per-stack embed-mode state machine for portal WebContentsViews (arch §7.2 / §7.5).
 *  Pure (timers injected) so it's unit-testable without Electron.
 *
 *    new view ──load──▶ pending ──ready──▶ v2
 *                          │
 *                          └──no ready within EMBED_READY_TIMEOUT_MS──▶ legacy
 *
 *  Every full (re)load of a view re-arms the timer: a V2 portal answers `ready` on every boot,
 *  so a view that was v2 stays v2 while it reloads, and flips to legacy only if the new page
 *  never answers (e.g. the stack was downgraded). A legacy view flips to v2 as soon as a load
 *  answers `ready` (e.g. after `orcha upgrade`). */
import { EMBED_READY_TIMEOUT_MS, type EmbedMode } from '../shared/embed'

export interface EmbedTrackerDeps {
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  /** Called whenever a project's mode actually changes. */
  onChange(project: string, mode: EmbedMode): void
  timeoutMs?: number
}

export class EmbedTracker {
  private modes = new Map<string, EmbedMode>()
  private timers = new Map<string, unknown>()

  constructor(private deps: EmbedTrackerDeps) {}

  modeOf(project: string): EmbedMode {
    return this.modes.get(project) ?? 'pending'
  }

  /** A full navigation of this project's view started (first load, reload, deep link). */
  loadStarted(project: string): void {
    this.clear(project)
    if (!this.modes.has(project)) this.set(project, 'pending')
    // `ready` clears this timer, so firing means this load never answered.
    const handle = this.deps.setTimer(() => {
      this.timers.delete(project)
      this.set(project, 'legacy')
    }, this.deps.timeoutMs ?? EMBED_READY_TIMEOUT_MS)
    this.timers.set(project, handle)
  }

  /** The portal in this project's view sent a valid `ready`. */
  ready(project: string): void {
    this.clear(project)
    this.set(project, 'v2')
  }

  /** The view is gone (window closed, stack removed). */
  forget(project: string): void {
    this.clear(project)
    this.modes.delete(project)
  }

  private clear(project: string): void {
    const t = this.timers.get(project)
    if (t !== undefined) this.deps.clearTimer(t)
    this.timers.delete(project)
  }

  private set(project: string, mode: EmbedMode): void {
    if (this.modes.get(project) === mode) return
    this.modes.set(project, mode)
    this.deps.onChange(project, mode)
  }
}
