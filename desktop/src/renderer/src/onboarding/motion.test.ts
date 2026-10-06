// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { formatElapsed, motionAllowed, useReducedMotion, useStageTransition } from './motion'

function setMotion(reduce: boolean): void {
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches: q.includes('no-preference') ? !reduce : reduce,
    media: q,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  })) as never
}

afterEach(() => {
  delete (window as { matchMedia?: unknown }).matchMedia
  delete (document as { startViewTransition?: unknown }).startViewTransition
})

describe('motion helpers', () => {
  it('motion is opt-in: off without matchMedia, off under reduce, on with no-preference', () => {
    expect(motionAllowed()).toBe(false)
    setMotion(true)
    expect(motionAllowed()).toBe(false)
    setMotion(false)
    expect(motionAllowed()).toBe(true)
  })

  it('useReducedMotion follows the setting', () => {
    setMotion(true)
    expect(renderHook(() => useReducedMotion()).result.current).toBe(true)
    setMotion(false)
    expect(renderHook(() => useReducedMotion()).result.current).toBe(false)
  })

  it('stage transition updates instantly when motion is reduced, even if the API exists', () => {
    setMotion(true)
    const vt = vi.fn()
    ;(document as { startViewTransition?: unknown }).startViewTransition = vt
    const update = vi.fn()
    renderHook(() => useStageTransition()).result.current('forward', update)
    expect(update).toHaveBeenCalledTimes(1)
    expect(vt).not.toHaveBeenCalled()
  })

  it('formats elapsed time as m:ss', () => {
    expect(formatElapsed(9)).toBe('0:09')
    expect(formatElapsed(75)).toBe('1:15')
  })
})
