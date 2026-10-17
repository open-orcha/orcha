/** Renderer-side output router: one bridge subscription fans pty output out to the xterm
 *  instance showing it. It also keeps a bounded replay buffer per pty, so a TerminalView that
 *  (re)mounts — a layout switch, a renderer reload re-attaching from main's backlog — paints
 *  the scrollback it missed instead of a blank screen. Pure apart from the injected bridge. */
import type { TermApi, TermEvent, TermExit } from '../../../shared/terminal'

export const REPLAY_MAX = 256 * 1024

type DataListener = (data: string) => void

export class TermClient {
  private readonly buffers = new Map<number, string>()
  private readonly listeners = new Map<number, Set<DataListener>>()
  private off: (() => void) | null = null

  constructor(
    private readonly api: Pick<TermApi, 'onEvent'> | undefined,
    private readonly onEvent: (
      e: { type: 'data'; id: number } | ({ type: 'exit'; id: number } & TermExit) | Extract<TermEvent, { type: 'meta' }>
    ) => void
  ) {}

  start(): void {
    if (this.off || !this.api) return
    this.off = this.api.onEvent((e) => this.handle(e))
  }

  stop(): void {
    this.off?.()
    this.off = null
  }

  handle(e: TermEvent): void {
    if (e.type === 'data') {
      this.append(e.id, e.data)
      for (const l of this.listeners.get(e.id) ?? []) l(e.data)
      this.onEvent({ type: 'data', id: e.id })
    } else {
      this.onEvent(e)
    }
  }

  /** Seed a pty's replay buffer (re-attach after reload). */
  seed(id: number, backlog: string): void {
    this.buffers.set(id, '')
    this.append(id, backlog)
  }

  private append(id: number, data: string): void {
    let buf = (this.buffers.get(id) ?? '') + data
    if (buf.length > REPLAY_MAX) buf = buf.slice(buf.length - REPLAY_MAX)
    this.buffers.set(id, buf)
  }

  /** Subscribe a view: it first receives everything buffered so far, then live output. */
  attach(id: number, listener: DataListener): () => void {
    const buffered = this.buffers.get(id)
    if (buffered) listener(buffered)
    let set = this.listeners.get(id)
    if (!set) {
      set = new Set()
      this.listeners.set(id, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(id)
    }
  }

  /** The pty is gone for good (tab closed / restarted): drop its buffer. */
  forget(id: number): void {
    this.buffers.delete(id)
    this.listeners.delete(id)
  }
}
