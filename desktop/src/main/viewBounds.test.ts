import { describe, it, expect } from 'vitest'
import { computeViewBounds, TOPBAR_HEIGHT } from './viewBounds'

describe('computeViewBounds', () => {
  it('offsets the view by the top bar height and fills the remaining window', () => {
    const bounds = computeViewBounds({ width: 1200, height: 800 })
    expect(bounds).toEqual({ x: 0, y: TOPBAR_HEIGHT, width: 1200, height: 800 - TOPBAR_HEIGHT })
  })

  it('recomputes as the window resizes', () => {
    expect(computeViewBounds({ width: 900, height: 600 })).toEqual({
      x: 0,
      y: TOPBAR_HEIGHT,
      width: 900,
      height: 600 - TOPBAR_HEIGHT
    })
  })

  it('honors a custom top bar height', () => {
    expect(computeViewBounds({ width: 1000, height: 500 }, 80)).toEqual({
      x: 0,
      y: 80,
      width: 1000,
      height: 420
    })
  })

  it('clamps to zero height instead of going negative when the window is shorter than the bar', () => {
    const bounds = computeViewBounds({ width: 300, height: 20 })
    expect(bounds.y).toBe(20)
    expect(bounds.height).toBe(0)
    expect(bounds.height).toBeGreaterThanOrEqual(0)
  })

  it('clamps a zero-size window to zero-size bounds', () => {
    expect(computeViewBounds({ width: 0, height: 0 })).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })

  it('never returns a negative x, y, width, or height for degenerate input', () => {
    const bounds = computeViewBounds({ width: -10, height: -5 })
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.y).toBeGreaterThanOrEqual(0)
    expect(bounds.width).toBeGreaterThanOrEqual(0)
    expect(bounds.height).toBeGreaterThanOrEqual(0)
  })
})
