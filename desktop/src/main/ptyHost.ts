/** PTY host for the desktop's terminal tabs. Owns every pseudo-terminal the app starts; the
 *  renderer only holds numeric ids minted here. node-pty is injected (`spawn`) so the
 *  bookkeeping — batching, backlog, exit, kill-all — is unit-tested without real processes.
 *
 *  Lifetime rule: no pty outlives the manager window. index.ts calls `killAll()` when the
 *  window closes and on app quit; `kill()` escalates SIGHUP → SIGKILL so a wedged TUI can't
 *  linger as an orphan. */
import type { TermEvent, TermExit, TermInfo, TermKind } from '../shared/terminal'
import { MetaThrottle } from './termMeta'
import type { HookEvent, HookMode } from './agentStatus'
import { PERSONAL_SESSION_ENV } from './terminalLaunch'

export interface PtyProcess {
  readonly pid: number
  onData(cb: (data: string) => void): unknown
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): unknown
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

export interface PtySpawnOptions {
  name: string
  cols: number
  rows: number
  cwd: string
  env: Record<string, string>
}

export interface PtyHostDeps {
  spawn(file: string, args: string[], opts: PtySpawnOptions): PtyProcess
  /** Deliver an event to the host renderer (no-op when the window is gone). */
  emit(event: TermEvent): void
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  /** Signal a whole process group (negative pid) — best effort, used by killAll. */
  killGroup?(pid: number, signal: string): void
  /** Clock for session meta (last activity, throttling); defaults to Date.now. */
  now?(): number
  /** A session's agent reported (or changed) its conversation id — main/sessionRestore.ts
   *  persists it so a relaunch can resume exactly that conversation. */
  onAgentSession?(id: number): void
}

export interface CreateSpec {
  kind: TermKind
  project: string | null
  file: string
  args: string[]
  cwd: string
  /** Git branch of the checkout `cwd` is (null = unknown / not a repo). */
  branch?: string | null
  /** A "Test launch" session (`<bin> --version`). */
  probe?: boolean
  note: string | null
  shell: string
  cols: number
  rows: number
  env: Record<string, string>
  /** This session's agent reports its lifecycle through hooks (main/agentHooks.ts): the pty
   *  env then carries ORCHA_TERM_ID (the id minted here) + ORCHA_HOOK_ENDPOINT (the file the
   *  hook script reads the receiver's port + token from). */
  hooks?: { mode: HookMode; endpointFile: string } | null
  /** Conversation id this session resumed (a restored `claude --resume <id>`): kept until the
   *  agent reports its own, so quitting again before a new prompt still resumes it. */
  agentSession?: string | null
}

/** What main knows about one session, for persisting the tab set (main/sessionRestore.ts). */
export interface SessionFacts {
  id: number
  kind: TermKind
  project: string | null
  branch: string | null
  cwd: string
  pid: number
  probe: boolean
  exited: boolean
  agentSession: string | null
}

/** Hook events whose conversation id is trustworthy for a resume: the conversation exists on
 *  disk once a prompt was submitted or a turn ended. */
const SESSION_EVENTS = new Set<string>(['UserPromptSubmit', 'Stop', 'TurnComplete'])

/** Output is coalesced for this long before one IPC message (keeps `yes` from flooding). */
export const FLUSH_MS = 8
/** A pending batch this large is sent immediately. */
export const FLUSH_BYTES = 64 * 1024
/** Recent output kept per pty for re-attach after a renderer reload. */
export const BACKLOG_MAX = 256 * 1024
/** Grace between SIGHUP and SIGKILL on an explicit close. */
export const KILL_GRACE_MS = 1500

interface Entry {
  info: TermInfo
  proc: PtyProcess
  pending: string
  timer: unknown
  backlog: string
  exit: TermExit | null
  killTimer: unknown
  meta: MetaThrottle
  agentSession: string | null
}

export class PtyHost {
  private next = 1
  private readonly entries = new Map<number, Entry>()

  constructor(private readonly deps: PtyHostDeps) {}

  create(spec: CreateSpec): TermInfo {
    // The id is minted before the spawn: a hooked agent's env must already carry it.
    const id = this.next
    // Every pty the desktop starts is the user's own session — never an Orcha agent's
    // (terminalLaunch.PERSONAL_SESSION_ENV), whatever env the caller composed.
    const base = { ...spec.env, [PERSONAL_SESSION_ENV]: '1' }
    const env = spec.hooks
      ? { ...base, ORCHA_TERM_ID: String(id), ORCHA_HOOK_ENDPOINT: spec.hooks.endpointFile }
      : base
    const proc = this.deps.spawn(spec.file, spec.args, {
      name: 'xterm-256color',
      cols: spec.cols,
      rows: spec.rows,
      cwd: spec.cwd,
      env
    })
    this.next++
    const info: TermInfo = {
      id,
      kind: spec.kind,
      project: spec.project,
      cwd: spec.cwd,
      shell: spec.shell.slice(spec.shell.lastIndexOf('/') + 1),
      note: spec.note,
      branch: spec.branch ?? null,
      ...(spec.probe ? { probe: true } : {})
    }
    const now = this.deps.now ?? (() => Date.now())
    const meta = new MetaThrottle({
      now,
      hooks: spec.hooks?.mode ?? null,
      setTimer: (fn, ms) => this.deps.setTimer(fn, ms),
      clearTimer: (h) => this.deps.clearTimer(h),
      emit: (m) => {
        // Output already batched for the renderer goes first, so a row never runs ahead of
        // the terminal it describes.
        this.flush(entry)
        this.deps.emit({ type: 'meta', id, ...m })
      }
    })
    const entry: Entry = {
      info,
      proc,
      pending: '',
      timer: null,
      backlog: '',
      exit: null,
      killTimer: null,
      meta,
      agentSession: spec.agentSession ?? null
    }
    this.entries.set(id, entry)
    proc.onData((data) => this.onData(entry, data))
    proc.onExit((e) => this.onExit(entry, e))
    return { ...info }
  }

  private onData(entry: Entry, data: string): void {
    entry.backlog += data
    if (entry.backlog.length > BACKLOG_MAX) entry.backlog = entry.backlog.slice(entry.backlog.length - BACKLOG_MAX)
    entry.pending += data
    if (entry.pending.length >= FLUSH_BYTES) {
      this.flush(entry)
      return
    }
    if (entry.timer === null) entry.timer = this.deps.setTimer(() => this.flush(entry), FLUSH_MS)
    if (this.entries.has(entry.info.id)) entry.meta.push(data)
  }

  private flush(entry: Entry): void {
    if (entry.timer !== null) {
      this.deps.clearTimer(entry.timer)
      entry.timer = null
    }
    if (!entry.pending) return
    const data = entry.pending
    entry.pending = ''
    this.deps.emit({ type: 'data', id: entry.info.id, data })
  }

  private onExit(entry: Entry, e: { exitCode: number; signal?: number }): void {
    this.flush(entry) // never lose the last line (e.g. "CLI not found") behind the exit
    if (entry.killTimer !== null) {
      this.deps.clearTimer(entry.killTimer)
      entry.killTimer = null
    }
    entry.exit = { exitCode: e.exitCode, signal: e.signal ? e.signal : null }
    // Final facts (the unfinished last line, attention cleared) go out BEFORE the exit event.
    if (this.entries.has(entry.info.id)) entry.meta.end()
    else entry.meta.dispose()
    this.deps.emit({ type: 'exit', id: entry.info.id, ...entry.exit })
  }

  has(id: number): boolean {
    return this.entries.has(id)
  }

  write(id: number, data: string): boolean {
    const entry = this.entries.get(id)
    if (!entry || entry.exit) return false
    entry.proc.write(data)
    entry.meta.userInput(data)
    return true
  }

  /** Does a live, hooked session with this id exist? (The hook receiver answers 403 otherwise.) */
  acceptsHooks(id: number): boolean {
    const entry = this.entries.get(id)
    return !!entry && !entry.exit && entry.meta.hook !== null
  }

  /** An agent lifecycle event for session `id` (main/hookReceiver.ts). */
  hookEvent(id: number, e: HookEvent): boolean {
    if (!this.acceptsHooks(id)) return false
    const entry = this.entries.get(id)!
    entry.meta.hookEvent(e)
    if (e.session && SESSION_EVENTS.has(e.event) && entry.agentSession !== e.session) {
      entry.agentSession = e.session
      this.deps.onAgentSession?.(id)
    }
    return true
  }

  /** Facts for every session (live or exited, not probes' output), in creation order. */
  facts(): SessionFacts[] {
    return [...this.entries.values()].map((e) => ({
      id: e.info.id,
      kind: e.info.kind,
      project: e.info.project,
      branch: e.info.branch ?? null,
      cwd: e.info.cwd,
      pid: e.proc.pid,
      probe: e.info.probe === true,
      exited: e.exit !== null,
      agentSession: e.agentSession
    }))
  }

  resize(id: number, cols: number, rows: number): boolean {
    const entry = this.entries.get(id)
    if (!entry || entry.exit) return false
    try {
      entry.proc.resize(cols, rows)
    } catch {
      return false // resizing a pty whose process just died throws; harmless
    }
    return true
  }

  /** Close a tab's process: SIGHUP (what closing a terminal window sends), SIGKILL if it is
   *  still alive after the grace period. The entry is forgotten either way. */
  kill(id: number): boolean {
    const entry = this.entries.get(id)
    if (!entry) return false
    this.entries.delete(id)
    if (entry.timer !== null) this.deps.clearTimer(entry.timer)
    entry.meta.dispose()
    if (entry.exit) return true
    try {
      entry.proc.kill('SIGHUP')
    } catch {
      return true
    }
    entry.killTimer = this.deps.setTimer(() => {
      entry.killTimer = null
      if (entry.exit) return
      try {
        entry.proc.kill('SIGKILL')
      } catch {
        // already gone
      }
    }, KILL_GRACE_MS)
    return true
  }

  /** Window closed / app quitting: hang up every live pty and its process group now. */
  killAll(): void {
    for (const [id, entry] of this.entries) {
      this.entries.delete(id)
      if (entry.timer !== null) this.deps.clearTimer(entry.timer)
      entry.meta.dispose()
      if (entry.exit) continue
      try {
        this.deps.killGroup?.(entry.proc.pid, 'SIGHUP')
      } catch {
        // group already gone
      }
      try {
        entry.proc.kill('SIGHUP')
      } catch {
        // already gone
      }
    }
  }

  /** Live + exited tabs with their recent output, for a reloaded renderer to re-attach. */
  list(): TermInfo[] {
    // Flush first: pending output is already in the backlog, so it must not ALSO arrive later
    // as a data event for a tab the renderer is about to rebuild from this backlog.
    for (const e of this.entries.values()) this.flush(e)
    return [...this.entries.values()].map((e) => ({ ...e.info, backlog: e.backlog, exit: e.exit, meta: e.meta.current() }))
  }

  get size(): number {
    return this.entries.size
  }
}
