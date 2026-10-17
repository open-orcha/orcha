import { describe, it, expect, vi } from 'vitest'
import { cleanTitle, isMeaningfulLine, MetaThrottle, META_BUSY_WINDOW_MS, META_MIN_INTERVAL_MS, TermMetaParser } from './termMeta'
import type { TermMeta } from '../shared/terminal'

function parse(...chunks: string[]): TermMetaParser {
  const p = new TermMetaParser()
  for (const c of chunks) p.push(c)
  return p
}

describe('TermMetaParser — snippet', () => {
  it('strips ANSI colours / SGR and keeps the last meaningful line', () => {
    const p = parse('\x1b[1;32mcompiled\x1b[0m 42 files\r\n\x1b[2mdone in 3.1s\x1b[0m\r\n')
    expect(p.snippet).toBe('done in 3.1s')
  })

  it('skips shell prompts, so `echo hi` leaves "hi" (not the next prompt)', () => {
    const p = parse('me@mac fleet-mate % echo hi\r\n', 'hi\r\n', 'me@mac fleet-mate % ')
    expect(p.snippet).toBe('hi')
    expect(parse('❯ \r\n').snippet).toBeNull()
    expect(parse('~/src $ \r\n').snippet).toBeNull()
  })

  it('skips echoed commands after a prompt and strips TUI status bullets', () => {
    expect(parse('out\n➜  fleet-mate git:(main) ✗ exit 1\n').snippet).toBe('out')
    expect(parse('out\nme@mac fleet-mate % ls -la\n').snippet).toBe('out')
    expect(parse('⏺agents-md: AGENTS.md loaded\n').snippet).toBe('agents-md: AGENTS.md loaded')
    expect(parse('  ⎿  Read 3 files\n').snippet).toBe('Read 3 files')
  })

  it('skips spinners, box-drawing, rules and TUI key hints', () => {
    const p = parse(
      'Tests passed\n',
      '╭──────────────╮\n',
      '│              │\n',
      '⠋ ⠙ ⠹\n',
      '────────────\n',
      '⏵⏵ auto mode on (shift+tab to cycle)\n',
      '? for shortcuts\n',
      'Try "fix lint errors"\n'
    )
    expect(p.snippet).toBe('Tests passed')
    expect(isMeaningfulLine('--')).toBe(false)
    expect(isMeaningfulLine('Build OK')).toBe(true)
  })

  it('honours carriage-return overwrites (progress bars / spinners keep only the final text)', () => {
    const p = parse('Downloading 10%\rDownloading 80%\rDownloaded 3 packages\n')
    expect(p.snippet).toBe('Downloaded 3 packages')
  })

  it('a TUI redraw (cursor move) finishes the current line; erase-line after CR clears it', () => {
    expect(parse('Reading files…\x1b[2A').snippet).toBe('Reading files…')
    expect(parse('junk\r\x1b[Kreal output\n').snippet).toBe('real output')
  })

  it('escape sequences split across chunks are still stripped', () => {
    const p = parse('\x1b[3', '1mred text\x1b', '[0m\n')
    expect(p.snippet).toBe('red text')
  })

  it('DCS / APC strings never leak into text', () => {
    expect(parse('\x1bPq#0;2;0;0;0\x1b\\visible\n').snippet).toBe('visible')
  })

  it('an unfinished last line counts once the stream ends', () => {
    const p = parse('Claude Code CLI not found')
    expect(p.snippet).toBeNull()
    p.endOfStream()
    expect(p.snippet).toBe('Claude Code CLI not found')
  })
})

describe('TermMetaParser — OSC title', () => {
  it('reads OSC 0 and OSC 2 (BEL- or ST-terminated) and does NOT treat the BEL as attention', () => {
    const p = parse('\x1b]0;✳ Fix the login flow\x07')
    expect(p.title).toBe('Fix the login flow')
    expect(p.attention).toBe(false)
    p.push('\x1b]2;vim README.md\x1b\\')
    expect(p.title).toBe('vim README.md')
  })

  it('a title split across chunks', () => {
    expect(parse('\x1b]2;Project work', ' commitment\x07').title).toBe('Project work commitment')
  })

  it('shell default titles (user@host:path, a path) clear the title instead of naming the session', () => {
    const p = parse('\x1b]2;exit 1\x07')
    expect(p.title).toBe('exit 1')
    p.push('\x1b]2;me@Mac-Pro:~/Desktop/future/fleet-mate\x07')
    expect(p.title).toBeNull()
    expect(cleanTitle('~/src')).toBeNull()
    expect(cleanTitle('/Users/me')).toBeNull()
  })

  it('cleans spinner glyphs and control chars from titles; empty → null', () => {
    expect(cleanTitle('⠋ Building\x01 app')).toBe('Building app')
    expect(cleanTitle('✳ ')).toBeNull()
  })
})

describe('TermMetaParser — attention', () => {
  it('a bare BEL means the program wants the user', () => {
    expect(parse('Waiting for input\x07').attention).toBe(true)
  })

  it('OSC 9 notification and OSC 777 notify raise attention; OSC 9;4 progress does not', () => {
    expect(parse('\x1b]9;Claude needs your permission\x07').attention).toBe(true)
    expect(parse('\x1b]777;notify;Codex;Done\x1b\\').attention).toBe(true)
    expect(parse('\x1b]9;4;1;50\x07').attention).toBe(false)
  })

  it('typing clears it', () => {
    const p = parse('\x07')
    p.userInput()
    expect(p.attention).toBe(false)
  })
})

describe('MetaThrottle (≤ 2 updates / s per session)', () => {
  function setup() {
    vi.useFakeTimers()
    let now = 1_000_000
    const sent: TermMeta[] = []
    const t = new MetaThrottle({
      now: () => now,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      emit: (m) => sent.push(m)
    })
    const advance = (ms: number): void => {
      now += ms
      vi.advanceTimersByTime(ms)
    }
    return { t, sent, advance }
  }

  it('coalesces a burst into one event per 500 ms', () => {
    const { t, sent, advance } = setup()
    for (let i = 0; i < 50; i++) {
      t.push(`line ${i}\n`)
      advance(20) // 1 s of output
    }
    advance(META_MIN_INTERVAL_MS)
    expect(sent.length).toBeLessThanOrEqual(3)
    expect(sent.at(-1)?.snippet).toBe('line 49')
  })

  it('output-only programs: working while output streams, idle once it stops (reported once each)', () => {
    const { t, sent, advance } = setup()
    t.push('same\n')
    advance(600)
    expect(sent).toHaveLength(1)
    expect(sent.at(-1)?.busy).toBe(true)
    t.push('\x1b[1A') // redraw inside the window: nothing new to report
    advance(600)
    expect(sent).toHaveLength(1)
    advance(META_BUSY_WINDOW_MS + 100) // quiet → idle, without any new output
    expect(sent.at(-1)?.busy).toBe(false)
    const n = sent.length
    advance(5_000)
    expect(sent).toHaveLength(n) // stays quiet while idle
  })

  it('Claude Code: the title spinner decides — busy while it spins, idle at ✳ even if the TUI redraws', () => {
    const { t, sent, advance } = setup()
    t.push('\x1b]0;\u2810 Fixing the tests\x07')
    advance(600)
    expect(sent.at(-1)).toMatchObject({ busy: true, title: 'Fixing the tests' })
    t.push('\x1b]0;\u2733 Fixing the tests\x07')
    advance(600)
    expect(sent.at(-1)?.busy).toBe(false)
    const n = sent.length
    const at = sent.at(-1)!.lastActivity
    t.push('\x1b[1A\x1b[2K') // idle TUI redraw
    advance(META_BUSY_WINDOW_MS + 600)
    expect(sent).toHaveLength(n) // no flicker to "working", "last active" not bumped
    expect(t.current().lastActivity).toBe(at)
  })

  it('attention raised by BEL, cleared by user input — each reported', () => {
    const { t, sent, advance } = setup()
    t.push('Allow edit? \x07')
    advance(600)
    expect(sent.at(-1)?.attention).toBe(true)
    t.userInput()
    advance(600)
    expect(sent.at(-1)?.attention).toBe(false)
  })

  it('end(): commits the last line and clears attention immediately (before the exit event)', () => {
    const { t, sent } = setup()
    t.push('boom\x07')
    t.end()
    expect(sent.at(-1)).toMatchObject({ snippet: 'boom', attention: false })
  })
})
