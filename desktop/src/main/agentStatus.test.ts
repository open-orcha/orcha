import { afterEach, describe, it, expect, vi } from 'vitest'
import { HookStatus, nextHookState, parseHookEvent, type HookEvent, type HookEventName, type HookMode } from './agentStatus'
import { HOOK_STALL_MS, MetaThrottle, META_BUSY_WINDOW_MS, META_MIN_INTERVAL_MS } from './termMeta'
import type { TermMeta } from '../shared/terminal'

const ev = (event: HookEventName, detail: string | null = null): HookEvent => ({ event, detail })

describe('parseHookEvent (receiver body schema)', () => {
  it('accepts {event} and {event, detail}', () => {
    expect(parseHookEvent({ event: 'Stop' })).toEqual({ event: 'Stop', detail: null })
    expect(parseHookEvent({ event: 'Notification', detail: 'idle_prompt' })).toEqual({ event: 'Notification', detail: 'idle_prompt' })
    expect(parseHookEvent({ event: 'Stop', detail: '' })).toEqual({ event: 'Stop', detail: null })
  })
  it('rejects unknown events, extra keys, bad detail, non-objects', () => {
    for (const bad of [
      null,
      [],
      'Stop',
      {},
      { event: 'Rm' },
      { event: 'Stop', extra: 1 },
      { event: 'Stop', detail: 'Bad Detail' },
      { event: 'Stop', detail: 'x'.repeat(65) },
      { event: 'Stop', detail: 3 },
      { event: 'toString' }
    ]) {
      expect(parseHookEvent(bad)).toBeNull()
    }
  })
})

describe('nextHookState (Orca-style event → status mapping)', () => {
  it('prompt / tools → working; permission → attention; Stop → done; StopFailure → error', () => {
    expect(nextHookState(null, ev('UserPromptSubmit'))).toBe('working')
    expect(nextHookState('done', ev('UserPromptSubmit'))).toBe('working')
    expect(nextHookState('attention', ev('PreToolUse'))).toBe('working')
    expect(nextHookState('attention', ev('PostToolUse'))).toBe('working')
    expect(nextHookState('working', ev('PostToolUseFailure'))).toBe('working') // the agent carries on
    expect(nextHookState('working', ev('PermissionRequest'))).toBe('attention')
    expect(nextHookState('working', ev('Stop'))).toBe('done')
    expect(nextHookState('working', ev('TurnComplete'))).toBe('done')
    expect(nextHookState('working', ev('StopFailure'))).toBe('error')
    expect(nextHookState(null, ev('SessionStart'))).toBe('idle')
  })
  it('Notification: permission / untyped → attention; idle_prompt never overrides ✓; auth_success ignored', () => {
    expect(nextHookState('working', ev('Notification', 'permission_prompt'))).toBe('attention')
    expect(nextHookState('working', ev('Notification'))).toBe('attention')
    expect(nextHookState('done', ev('Notification', 'idle_prompt'))).toBe('done')
    expect(nextHookState('working', ev('Notification', 'idle_prompt'))).toBe('idle') // interrupted turn
    expect(nextHookState('done', ev('Notification', 'auth_success'))).toBe('done')
  })
  it('SubagentStop keeps the lead working, and never undoes a finished turn', () => {
    expect(nextHookState('working', ev('SubagentStop'))).toBe('working')
    expect(nextHookState('attention', ev('SubagentStop'))).toBe('working')
    expect(nextHookState('done', ev('SubagentStop'))).toBe('done')
  })
})

describe('HookStatus', () => {
  it('records when the state began, not every event', () => {
    const h = new HookStatus('lifecycle')
    expect(h.apply(ev('UserPromptSubmit'), 10)).toBe(true)
    expect(h.apply(ev('PreToolUse'), 20)).toBe(false)
    expect(h.since).toBe(10)
    expect(h.lastEventAt).toBe(20)
    expect(h.apply(ev('Stop'), 30)).toBe(true)
    expect(h.since).toBe(30)
  })
  it('Enter only hands a turn-complete agent back to heuristics', () => {
    const codex = new HookStatus('turn-complete')
    expect(codex.userSubmitted()).toBe(true) // first prompt
    expect(codex.submitted).toBe(true)
    codex.apply(ev('TurnComplete'), 1)
    expect(codex.userSubmitted()).toBe(true)
    expect(codex.state).toBeNull()
    const claude = new HookStatus('lifecycle')
    claude.apply(ev('Stop'), 1)
    expect(claude.userSubmitted()).toBe(false)
    expect(claude.state).toBe('done')
  })
})

describe('MetaThrottle with hooks (the sidebar status)', () => {
  afterEach(() => vi.useRealTimers())
  function setup(hooks: HookMode | null) {
    vi.useFakeTimers()
    let now = 1_000_000
    const sent: TermMeta[] = []
    const t = new MetaThrottle({
      now: () => now,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      emit: (m) => sent.push(m),
      hooks
    })
    const advance = (ms: number): void => {
      now += ms
      vi.advanceTimersByTime(ms)
    }
    const status = (): string => t.current().status
    return { t, sent, advance, status, at: () => now }
  }

  it('Claude: prompt → working → Stop → done (✓ survives typing) → prompt → working', () => {
    const { t, sent, advance, status, at } = setup('lifecycle')
    t.push('\x1b]0;✳ Claude Code\x07') // idle at its prompt
    expect(status()).toBe('idle')
    t.hookEvent(ev('UserPromptSubmit'))
    expect(status()).toBe('working')
    expect(t.current().busy).toBe(true)
    t.push('\x1b]0;⠂ Saying hi\x07')
    t.hookEvent(ev('PreToolUse'))
    advance(1000)
    t.hookEvent(ev('Stop'))
    const doneAt = at()
    t.push('\x1b]0;✳ Saying hi\x07')
    expect(status()).toBe('done')
    advance(META_MIN_INTERVAL_MS)
    expect(sent.at(-1)).toMatchObject({ status: 'done', statusAt: doneAt, busy: false, attention: false })
    // typing a new prompt is not submitting it
    t.userInput('h')
    t.userInput('i')
    advance(60_000)
    expect(status()).toBe('done')
    t.userInput('\r') // Enter alone doesn't clear it either — UserPromptSubmit does
    expect(status()).toBe('done')
    t.hookEvent(ev('UserPromptSubmit'))
    expect(status()).toBe('working')
    advance(META_MIN_INTERVAL_MS)
    expect(sent.at(-1)?.status).toBe('working')
  })

  it('Claude: Notification → attention (bell) → PostToolUse → working', () => {
    const { t, status } = setup('lifecycle')
    t.hookEvent(ev('UserPromptSubmit'))
    t.hookEvent(ev('Notification', 'permission_prompt'))
    expect(status()).toBe('attention')
    expect(t.current().attention).toBe(true)
    t.hookEvent(ev('PostToolUse'))
    expect(status()).toBe('working')
    t.hookEvent(ev('PermissionRequest'))
    expect(status()).toBe('attention')
    t.hookEvent(ev('PreToolUse'))
    expect(status()).toBe('working')
  })

  it('Claude: an interrupted turn (title back to ✳, no hook for a while) reads idle, not working forever', () => {
    const { t, advance, status } = setup('lifecycle')
    t.push('\x1b]0;⠂ Working\x07')
    t.hookEvent(ev('UserPromptSubmit'))
    advance(500)
    t.push('\x1b]0;✳ Working\x07') // Esc: Claude prints its idle mark, sends no Stop
    advance(HOOK_STALL_MS - 100)
    expect(status()).toBe('working')
    advance(200)
    expect(status()).toBe('idle')
    t.hookEvent(ev('UserPromptSubmit'))
    t.push('\x1b]0;⠂ Working\x07')
    expect(status()).toBe('working')
  })

  it('hook status overrides output heuristics; a bell does not turn a ✓ into a bell', () => {
    const { t, advance, status } = setup('lifecycle')
    t.hookEvent(ev('Stop'))
    t.push('streaming output\n\x07')
    expect(status()).toBe('done')
    advance(META_BUSY_WINDOW_MS + 100)
    expect(status()).toBe('done')
  })

  it('Codex (turn-complete only): idle before the first prompt, output heuristics while working, ✓ after the turn until Enter', () => {
    const { t, advance, status } = setup('turn-complete')
    t.push('animated idle TUI redraw\n')
    expect(status()).toBe('idle') // not working before anything was submitted
    t.userInput('say hi')
    expect(status()).toBe('idle')
    t.userInput('\r')
    t.push('thinking…\n')
    expect(status()).toBe('working') // output recency
    advance(META_BUSY_WINDOW_MS + 100)
    expect(status()).toBe('idle')
    t.hookEvent(ev('TurnComplete'))
    expect(status()).toBe('done')
    t.push('redraw\n')
    expect(status()).toBe('done')
    t.userInput('next prompt')
    expect(status()).toBe('done')
    t.userInput('\r')
    t.push('working on it\n')
    expect(status()).toBe('working')
    expect(t.current().statusAt).toBeNull()
  })

  it('no hooks (shells, other agents): heuristics only, never ✓ — hook events are ignored', () => {
    const { t, advance, status } = setup(null)
    t.push('building\n')
    expect(status()).toBe('working')
    advance(META_BUSY_WINDOW_MS + 100)
    expect(status()).toBe('idle')
    t.hookEvent(ev('Stop'))
    expect(status()).toBe('idle')
    t.push('\x07')
    expect(status()).toBe('attention')
    expect(t.current().statusAt).toBeNull()
  })
})
