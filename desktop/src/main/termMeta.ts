/** Session facts derived from a pty's raw output, for the sidebar's session rows:
 *
 *  - title:     the last OSC 0 / OSC 2 window title the program set (Claude Code sets a task
 *               summary such as "✳ Fix the login flow"); leading spinner glyphs trimmed.
 *  - snippet:   the last MEANINGFUL output line — ANSI/OSC stripped, carriage-return
 *               overwrites honoured, prompts / spinners / box-drawing / key hints skipped.
 *  - attention: a BEL (outside an OSC), an OSC 9 notification (not the 9;4 progress form) or
 *               an OSC 777 "notify" — the program wants the user. Cleared when the user types.
 *
 *  Pure and incremental: `push()` takes chunks as they arrive (escape sequences may straddle
 *  chunk boundaries). Throttling lives in MetaThrottle below; both are unit-tested without a
 *  real pty (termMeta.test.ts). */
import { TERM_META_TEXT_MAX, type TermMeta, type TermStatus } from '../shared/terminal'
import { HookStatus, type HookEvent, type HookMode } from './agentStatus'

/** Longest line kept while parsing (a runaway line without newlines is truncated). */
const LINE_MAX = 1000

type Mode = 'text' | 'esc' | 'csi' | 'osc' | 'osc-esc' | 'str' | 'str-esc'

/** Lines made only of these are decoration (box art, rules, spinners, bullets, prompts). */
const DECORATION_RE = /^[\s─-▟⠀-⣿■-◿✀-➿·•…*+\-=_|~^`'"<>❯›»$%#:.,;!?()[\]{}\\/]*$/u
/** Shell prompts: "user@host dir %", "~/x $", "❯", "➜  repo git:(main)", "fish> ". */
const PROMPT_RE = /(^|\s)([$%#❯›>➜λ]|\w+@[\w.-]+[^\s]*)\s*$/u
/** TUI key hints that are chrome, not content (Claude Code / Codex footers). */
const HINT_RES = [
  /shift\s*\+\s*tab to cycle/i,
  /\?\s+for shortcuts/i,
  /^try\s+["“]/i,
  /esc to interrupt/i,
  /ctrl\s*\+\s*[a-z] to /i,
  /^\s*\/[a-z-]+\s*$/i
]
/** A command echoed after a prompt ("➜ repo git:(main) ✗ exit 1", "me@mac dir % ls"). */
const PROMPT_LEAD_RE = /^([➜❯›λ$%#]\s|[\w.-]+@[\w.-]+[^\s]*\s.*?[%$#]\s)/u
/** Status bullets TUIs put before a line ("⏺ Read 3 files", "⎿ done", "● note"). */
const LINE_LEAD_RE = /^[\s\u2500-\u257F\u23E9-\u23FA\u25A0-\u25FF\u2700-\u27BF⎿•·*>|]+/u
/** Shell default titles are not session titles: "me@host:~/dir", "~/dir", "/Users/x/dir". */
const SHELL_TITLE_RE = /^([\w.-]+@[\w.-]+(:.*)?|~(\/.*)?|\/\S*)$/u
/** Spinner / status glyphs a program puts before its title ("✳ Claude Code", "⠋ building"). */
// (✀-➿ is the whole Dingbats block, U+2700–U+27BF: it already covers ✳ ✶ ✻ ✽ ✢ and ✰-✿)
const TITLE_LEAD_RE = /^[\s⠀-⣿✀-➿·*•●○◐◓◑◒|/\\-]+/u

export function cleanText(s: string): string {
  // Drop any C0/C1 controls that slipped through, collapse whitespace.
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim()
}

function clip(s: string): string {
  return s.length > TERM_META_TEXT_MAX ? `${s.slice(0, TERM_META_TEXT_MAX - 1)}…` : s
}

export function cleanTitle(raw: string): string | null {
  const plain = cleanText(raw)
  // A shell resetting its title to "user@host:path" means "no program-specific title".
  if (SHELL_TITLE_RE.test(plain)) return null
  const t = plain.replace(TITLE_LEAD_RE, '').trim()
  if (!t || SHELL_TITLE_RE.test(t)) return null
  return clip(t)
}

/** Is this (already cleaned) line worth showing as the session's latest output? */
export function isMeaningfulLine(line: string): boolean {
  if (line.length < 2) return false
  if (DECORATION_RE.test(line)) return false
  if (PROMPT_RE.test(line) && line.length <= 80) return false
  if (PROMPT_LEAD_RE.test(line)) return false
  if (HINT_RES.some((re) => re.test(line))) return false
  return true
}

export class TermMetaParser {
  private mode: Mode = 'text'
  private seq = ''
  private line = ''
  /** After a lone CR the next printable overwrites the line (spinners, progress bars). */
  private crPending = false
  title: string | null = null
  snippet: string | null = null
  attention = false
  /** What the program's own title says about its state: Claude Code animates a braille
   *  spinner before its title while it works and shows ✳ when idle at its prompt. */
  titleState: 'busy' | 'idle' | null = null

  push(data: string): void {
    for (const ch of data) this.step(ch)
  }

  /** No more output will come: commit the unfinished line. */
  endOfStream(): void {
    if (this.line) this.commitLine()
  }

  /** The user typed: they have seen whatever rang the bell. */
  userInput(): void {
    this.attention = false
  }

  private commitLine(): void {
    const raw = cleanText(this.line)
    this.line = ''
    this.crPending = false
    if (PROMPT_LEAD_RE.test(raw)) return // an echoed command, not output
    const text = raw.replace(LINE_LEAD_RE, '').trim()
    if (isMeaningfulLine(text)) this.snippet = clip(text)
  }

  private step(ch: string): void {
    switch (this.mode) {
      case 'text':
        if (ch === '\x1b') {
          this.mode = 'esc'
        } else if (ch === '\x07') {
          this.attention = true
        } else if (ch === '\n') {
          this.commitLine()
        } else if (ch === '\r') {
          this.crPending = true
        } else if (ch === '\b') {
          this.line = this.line.slice(0, -1)
        } else if (ch === '\x9b') {
          this.mode = 'csi'
          this.seq = ''
        } else if (ch === '\x9d') {
          this.mode = 'osc'
          this.seq = ''
        } else if (ch >= ' ' || ch === '\t') {
          if (this.crPending) {
            this.line = ''
            this.crPending = false
          }
          if (this.line.length < LINE_MAX) this.line += ch
        }
        return
      case 'esc':
        this.seq = ''
        if (ch === '[') this.mode = 'csi'
        else if (ch === ']') this.mode = 'osc'
        else if (ch === 'P' || ch === 'X' || ch === '^' || ch === '_') this.mode = 'str' // DCS/SOS/PM/APC: skip
        else this.mode = 'text' // two-byte escape (charset, keypad…): ignore
        return
      case 'csi': {
        const code = ch.charCodeAt(0)
        if (code >= 0x40 && code <= 0x7e) {
          this.mode = 'text'
          // Cursor jumps / erases mean a TUI is redrawing: whatever was on the line is done.
          if ('ABHfJEFd'.includes(ch)) this.flushPartial()
          else if (ch === 'K' && this.crPending) this.line = ''
        } else if (this.seq.length < 64) {
          this.seq += ch
        } else {
          this.mode = 'text'
        }
        return
      }
      case 'osc':
        if (ch === '\x07') this.endOsc()
        else if (ch === '\x1b') this.mode = 'osc-esc'
        else if (this.seq.length < 4096) this.seq += ch
        return
      case 'osc-esc':
        // ESC \ (ST) ends the OSC; anything else aborts it.
        if (ch === '\\') this.endOsc()
        else {
          this.mode = 'text'
          this.seq = ''
        }
        return
      case 'str':
        if (ch === '\x07') this.mode = 'text'
        else if (ch === '\x1b') this.mode = 'str-esc'
        return
      case 'str-esc':
        this.mode = ch === '\\' ? 'text' : 'str'
        return
    }
  }

  /** A redraw moved the cursor away: keep the finished part of the line as a candidate. */
  private flushPartial(): void {
    if (this.line) this.commitLine()
  }

  private endOsc(): void {
    const body = this.seq
    this.seq = ''
    this.mode = 'text'
    const semi = body.indexOf(';')
    const code = semi < 0 ? body : body.slice(0, semi)
    const rest = semi < 0 ? '' : body.slice(semi + 1)
    if (code === '0' || code === '2') {
      this.title = cleanTitle(rest)
      const lead = rest.trimStart().charAt(0)
      this.titleState = /[\u2801-\u28FF]/u.test(lead) ? 'busy' : /[✳✶✻✽✢]/u.test(lead) ? 'idle' : null
    } else if (code === '9') {
      // OSC 9 ; <message> is a notification (iTerm2); OSC 9 ; 4 ; … is ConEmu progress.
      if (!/^4;/.test(rest) && rest.trim()) this.attention = true
    } else if (code === '777') {
      if (/^notify;/.test(rest)) this.attention = true
    }
  }
}

/** Minimum gap between two meta events for one session (≤ 2 per second). */
export const META_MIN_INTERVAL_MS = 500
/** Output that changes nothing visible still refreshes "last activity" this often. */
export const META_ACTIVITY_REFRESH_MS = 30_000
/** Without a title signal, a session counts as working while output arrived this recently. */
export const META_BUSY_WINDOW_MS = 1500
/** A hook-reported "working" whose program title has shown its idle mark (Claude's ✳) this
 *  long, with no hook event meanwhile, was interrupted (Esc emits no Stop): show idle. */
export const HOOK_STALL_MS = 2500

export interface MetaThrottleDeps {
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  emit(meta: TermMeta): void
  /** The agent reports its lifecycle through hooks (main/agentHooks.ts); null = heuristics only. */
  hooks?: HookMode | null
}

/** One per session: feeds the parser and emits a TermMeta at most every 500 ms, only when
 *  something the sidebar shows changed (or activity is 30 s staler than last reported). */
export class MetaThrottle {
  readonly parser = new TermMetaParser()
  private lastActivity: number
  private lastOutput = 0
  private sent: TermMeta | null = null
  private sentAt: number
  private timer: unknown = null
  private decay: unknown = null
  private stall: unknown = null
  /** Hook-reported state (null for shells and agents without hooks). */
  readonly hook: HookStatus | null
  /** When the program's title last switched to its idle mark (0 = not idle). */
  private titleIdleSince = 0

  constructor(private readonly deps: MetaThrottleDeps) {
    this.hook = deps.hooks ? new HookStatus(deps.hooks) : null
    this.lastActivity = deps.now()
    // The first report waits one interval too: a session's opening burst (prompt, banner)
    // becomes one event, not several.
    this.sentAt = this.lastActivity
  }

  push(data: string): void {
    const p = this.parser
    const before = `${p.title}\u0000${p.snippet}\u0000${p.titleState}`
    const titleBefore = p.titleState
    p.push(data)
    const now = this.deps.now()
    if (p.titleState !== titleBefore) {
      this.titleIdleSince = p.titleState === 'idle' ? now : 0
      if (p.titleState === 'idle' && this.hook?.state === 'working') this.armStall()
    }
    this.lastOutput = now
    // "Last active" moves on real change (new line, new title, working) — not on a TUI
    // redrawing the same screen, which would pin every idle session at "now".
    if (`${p.title}\u0000${p.snippet}\u0000${p.titleState}` !== before || this.busy(now)) this.lastActivity = now
    this.schedule()
    // Output-recency "working" ends by itself: re-check once the window has passed.
    if (p.titleState === null) {
      if (this.decay !== null) this.deps.clearTimer(this.decay)
      this.decay = this.deps.setTimer(() => {
        this.decay = null
        this.schedule()
      }, META_BUSY_WINDOW_MS + 50)
    }
  }

  /** Re-check the status once a hook "working" could have stalled (see HOOK_STALL_MS). */
  private armStall(): void {
    if (this.stall !== null) this.deps.clearTimer(this.stall)
    this.stall = this.deps.setTimer(() => {
      this.stall = null
      this.schedule()
    }, HOOK_STALL_MS + 50)
  }

  /** An agent hook event arrived for this session (main/hookReceiver.ts). */
  hookEvent(e: HookEvent): void {
    if (!this.hook) return
    const now = this.deps.now()
    if (this.hook.apply(e, now)) this.lastActivity = now
    if (this.hook.state === 'working' && this.parser.titleState === 'idle') this.armStall()
    this.schedule()
  }

  /** The status the sidebar shows. Hook-reported state wins where the agent reports it:
   *  - lifecycle agents (Claude): the hook state, once any hook has fired — except a
   *    "working" the program itself shows as idle for a while (interrupted: no Stop comes);
   *  - turn-complete agents (Codex): idle until the first Enter, ✓ / error after a turn until
   *    the next Enter;
   *  otherwise the heuristics: a bell / OSC notification = attention, busy = working. */
  private status(now: number): { status: TermStatus; statusAt: number | null } {
    const h = this.hook
    if (h && h.state !== null) {
      if (h.mode === 'lifecycle') {
        if (
          h.state === 'working' &&
          this.titleIdleSince > 0 &&
          now - this.titleIdleSince >= HOOK_STALL_MS &&
          now - (h.lastEventAt ?? 0) >= HOOK_STALL_MS
        ) {
          return { status: 'idle', statusAt: null }
        }
        return { status: h.state, statusAt: h.since }
      }
      if (h.state === 'done' || h.state === 'error') return { status: h.state, statusAt: h.since }
    }
    if (h && h.mode === 'turn-complete' && h.state === null && !h.submitted) {
      return { status: this.parser.attention ? 'attention' : 'idle', statusAt: null }
    }
    if (this.parser.attention) return { status: 'attention', statusAt: null }
    return { status: this.busy(now) ? 'working' : 'idle', statusAt: null }
  }

  /** Working right now: the program's title says so, or (no title signal) output is streaming. */
  private busy(now = this.deps.now()): boolean {
    const t = this.parser.titleState
    if (t === 'busy') return true
    if (t === 'idle') return false
    return this.lastOutput > 0 && now - this.lastOutput < META_BUSY_WINDOW_MS
  }

  /** The user typed `data` into the terminal. */
  userInput(data = ''): void {
    let changed = false
    if (this.parser.attention) {
      this.parser.userInput()
      changed = true
    }
    if (this.hook && data.includes('\r') && this.hook.userSubmitted()) changed = true
    if (changed) this.schedule()
  }

  current(): TermMeta {
    const p = this.parser
    const now = this.deps.now()
    const { status, statusAt } = this.status(now)
    return {
      title: p.title,
      snippet: p.snippet,
      attention: status === 'attention',
      busy: status === 'working',
      lastActivity: this.lastActivity,
      status,
      statusAt
    }
  }

  private changed(m: TermMeta): boolean {
    const s = this.sent
    if (!s) return true
    return (
      s.title !== m.title ||
      s.snippet !== m.snippet ||
      s.attention !== m.attention ||
      s.busy !== m.busy ||
      s.status !== m.status ||
      s.statusAt !== m.statusAt ||
      m.lastActivity - s.lastActivity >= META_ACTIVITY_REFRESH_MS
    )
  }

  private schedule(): void {
    if (this.timer !== null) return
    if (!this.changed(this.current())) return
    const wait = Math.max(0, this.sentAt + META_MIN_INTERVAL_MS - this.deps.now())
    if (wait === 0) {
      this.flush()
      return
    }
    this.timer = this.deps.setTimer(() => {
      this.timer = null
      this.flush()
    }, wait)
  }

  /** The process ended: its unfinished last line ("… not found") counts as output. */
  end(): void {
    this.parser.endOfStream()
    this.parser.userInput() // a finished process isn't waiting for anyone
    this.flush()
    this.dispose()
  }

  /** Send now if anything changed. */
  flush(): void {
    if (this.timer !== null) {
      this.deps.clearTimer(this.timer)
      this.timer = null
    }
    const m = this.current()
    if (!this.changed(m)) return
    this.sent = m
    this.sentAt = this.deps.now()
    this.deps.emit(m)
  }

  dispose(): void {
    if (this.timer !== null) this.deps.clearTimer(this.timer)
    this.timer = null
    if (this.stall !== null) this.deps.clearTimer(this.stall)
    this.stall = null
  }
}
