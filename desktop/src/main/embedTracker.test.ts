import { describe, it, expect, vi } from 'vitest'
import { EmbedTracker } from './embedTracker'

function make() {
  const timers: Array<{ fn: () => void; cleared: boolean }> = []
  const onChange = vi.fn()
  const tracker = new EmbedTracker({
    setTimer: (fn) => {
      const t = { fn, cleared: false }
      timers.push(t)
      return t
    },
    clearTimer: (h) => {
      ;(h as { cleared: boolean }).cleared = true
    },
    onChange
  })
  const fireLive = (): void => timers.filter((t) => !t.cleared).forEach((t) => t.fn())
  return { tracker, onChange, fireLive, timers }
}

describe('EmbedTracker', () => {
  it('starts pending and becomes v2 when the portal answers ready', () => {
    const { tracker, onChange, fireLive } = make()
    expect(tracker.modeOf('orcha-a')).toBe('pending')
    tracker.loadStarted('orcha-a')
    tracker.ready('orcha-a')
    fireLive() // timer was cleared — nothing fires
    expect(tracker.modeOf('orcha-a')).toBe('v2')
    expect(onChange.mock.calls).toEqual([
      ['orcha-a', 'pending'],
      ['orcha-a', 'v2']
    ])
  })

  it('falls back to legacy when an older portal never answers within the timeout', () => {
    const { tracker, fireLive } = make()
    tracker.loadStarted('orcha-old')
    fireLive()
    expect(tracker.modeOf('orcha-old')).toBe('legacy')
  })

  it('keeps v2 across a reload that answers, and downgrades to legacy on one that does not', () => {
    const { tracker, fireLive } = make()
    tracker.loadStarted('orcha-a')
    tracker.ready('orcha-a')
    tracker.loadStarted('orcha-a')
    expect(tracker.modeOf('orcha-a')).toBe('v2')
    tracker.ready('orcha-a')
    expect(tracker.modeOf('orcha-a')).toBe('v2')
    tracker.loadStarted('orcha-a')
    fireLive()
    expect(tracker.modeOf('orcha-a')).toBe('legacy')
  })

  it('upgrades a legacy view to v2 when a later load answers ready (after orcha upgrade)', () => {
    const { tracker, fireLive } = make()
    tracker.loadStarted('orcha-a')
    fireLive()
    expect(tracker.modeOf('orcha-a')).toBe('legacy')
    tracker.loadStarted('orcha-a')
    tracker.ready('orcha-a')
    expect(tracker.modeOf('orcha-a')).toBe('v2')
  })

  it('tracks projects independently and forgets destroyed views', () => {
    const { tracker, fireLive } = make()
    tracker.loadStarted('orcha-a')
    tracker.loadStarted('orcha-b')
    tracker.ready('orcha-a')
    fireLive()
    expect(tracker.modeOf('orcha-a')).toBe('v2')
    expect(tracker.modeOf('orcha-b')).toBe('legacy')
    tracker.forget('orcha-b')
    expect(tracker.modeOf('orcha-b')).toBe('pending')
  })

  it('re-arming the timer on a new load cancels the previous one', () => {
    const { tracker, timers } = make()
    tracker.loadStarted('orcha-a')
    tracker.loadStarted('orcha-a')
    expect(timers[0].cleared).toBe(true)
    expect(timers[1].cleared).toBe(false)
  })
})
