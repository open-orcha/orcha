import { describe, it, expect } from 'vitest'
import {
  clampStripHeight,
  STRIP_MAX,
  fitToWorkArea,
  portalViewVisible,
  scaleInset,
  clampSidebarWidth,
  computeViewBounds,
  insetForMode,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  SIDEBAR_RAIL,
  TOPBAR_HEIGHT
} from './viewBounds'

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

describe('computeViewBounds — V2 host sidebar layout (arch §7.4)', () => {
  it('places the view right of the sidebar at full height', () => {
    expect(computeViewBounds({ width: 1200, height: 800 }, { left: 248, top: 0 })).toEqual({
      x: 248,
      y: 0,
      width: 952,
      height: 800
    })
  })

  it('tracks sidebar resize and collapse to the rail', () => {
    expect(computeViewBounds({ width: 1000, height: 700 }, { left: 360, top: 0 }).width).toBe(640)
    expect(computeViewBounds({ width: 1000, height: 700 }, { left: SIDEBAR_RAIL, top: 0 })).toEqual({
      x: SIDEBAR_RAIL,
      y: 0,
      width: 1000 - SIDEBAR_RAIL,
      height: 700
    })
  })

  it('never covers the sidebar or goes negative when the window is narrower than it', () => {
    const b = computeViewBounds({ width: 150, height: 400 }, { left: 248, top: 0 })
    expect(b.x).toBe(150)
    expect(b.width).toBe(0)
  })

  it('treats NaN input as zero instead of throwing Electron-invalid bounds', () => {
    const b = computeViewBounds({ width: Number.NaN, height: 500 }, { left: Number.NaN, top: 0 })
    expect(b).toEqual({ x: 0, y: 0, width: 0, height: 500 })
  })
})

describe('insetForMode', () => {
  it('lays out pending and v2 views right of the sidebar, legacy views below the top bar', () => {
    expect(insetForMode('v2', 300)).toEqual({ left: 300, top: 8, right: 8, bottom: 8 })
    expect(insetForMode('pending', 248)).toEqual({ left: 248, top: 8, right: 8, bottom: 8 })
    expect(insetForMode('legacy', 300)).toEqual({ left: 0, top: TOPBAR_HEIGHT })
  })

  it('V2 view is the inset raised panel: 8px from the top/right/bottom edges (D5)', () => {
    expect(computeViewBounds({ width: 1440, height: 900 }, insetForMode('v2', 248))).toEqual({
      x: 248,
      y: 8,
      width: 1440 - 248 - 8,
      height: 900 - 16
    })
  })

  it('never goes negative when the right/bottom insets exceed the window', () => {
    const b = computeViewBounds({ width: 250, height: 10 }, { left: 248, top: 8, right: 8, bottom: 8 })
    expect(b.width).toBe(0)
    expect(b.height).toBe(0)
  })
})

describe('radiusForMode', () => {
  it('rounds V2/pending panels and scales with zoom; legacy stays square', async () => {
    const { radiusForMode, PANEL_RADIUS } = await import('./viewBounds')
    expect(radiusForMode('v2')).toBe(PANEL_RADIUS)
    expect(radiusForMode('pending', 1.5)).toBe(15)
    expect(radiusForMode('legacy')).toBe(0)
    expect(radiusForMode('v2', NaN)).toBe(PANEL_RADIUS)
  })
})

describe('clampSidebarWidth', () => {
  it('clamps to 200–360, returns the rail when collapsed and the default for garbage', () => {
    expect(clampSidebarWidth(100)).toBe(SIDEBAR_MIN)
    expect(clampSidebarWidth(999)).toBe(SIDEBAR_MAX)
    expect(clampSidebarWidth(260.4)).toBe(260)
    expect(clampSidebarWidth(300, true)).toBe(SIDEBAR_RAIL)
    expect(clampSidebarWidth('wide')).toBe(SIDEBAR_DEFAULT)
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY)).toBe(SIDEBAR_DEFAULT)
  })
})

describe('scaleInset (manager zoom, QA)', () => {
  it('scales the CSS-px sidebar inset into DIP by the manager zoom factor', async () => {
    const { scaleInset, insetForMode, computeViewBounds } = await import('./viewBounds')
    const inset = scaleInset(insetForMode('v2', 248), 1.1)
    expect(inset).toEqual({ left: 273, top: 9, right: 9, bottom: 9 })
    expect(computeViewBounds({ width: 1100, height: 760 }, inset).x).toBe(273)
    expect(scaleInset(insetForMode('legacy', 248), 1.25).top).toBeGreaterThan(insetForMode('legacy', 248).top)
  })
  it('garbage zoom factors fall back to 1', async () => {
    const { scaleInset } = await import('./viewBounds')
    expect(scaleInset({ left: 248, top: 0 }, NaN)).toEqual({ left: 248, top: 0 })
    expect(scaleInset({ left: 248, top: 0 }, 0)).toEqual({ left: 248, top: 0 })
  })
})

describe('session tab strip + full-panel terminals (bounds)', () => {
  const win = { width: 1440, height: 900 }
  const sidebar = 272
  it('no terminal tabs: the V2 view fills the inset panel', () => {
    expect(computeViewBounds(win, insetForMode('v2', sidebar, 0))).toEqual({ x: 272, y: 8, width: 1440 - 272 - 8, height: 900 - 16 })
  })
  it('with tabs: the view starts under the tab strip and keeps the full height below it', () => {
    const b = computeViewBounds(win, insetForMode('v2', sidebar, 37))
    expect(b).toEqual({ x: 272, y: 8 + 37, width: 1160, height: 900 - 8 - 37 - 8 })
    // no bottom dock any more: the view reaches the panel's bottom gap
    expect(b.y + b.height).toBe(900 - 8)
  })
  it('pending mode lays out like V2', () => {
    expect(insetForMode('pending', sidebar, 37)).toEqual(insetForMode('v2', sidebar, 37))
  })
  it('legacy mode: the strip sits under the top bar', () => {
    expect(insetForMode('legacy', sidebar, 0)).toEqual({ left: 0, top: TOPBAR_HEIGHT })
    expect(insetForMode('legacy', sidebar, 36)).toEqual({ left: 0, top: TOPBAR_HEIGHT + 36 })
  })
  it('garbage strip heights mean no strip; huge ones are capped and never yield negative bounds', () => {
    expect(clampStripHeight('36')).toBe(0)
    expect(clampStripHeight(NaN)).toBe(0)
    expect(clampStripHeight(-5)).toBe(0)
    expect(clampStripHeight(36.6)).toBe(37)
    expect(clampStripHeight(1e9)).toBe(STRIP_MAX)
    const b = computeViewBounds({ width: 800, height: 150 }, insetForMode('v2', sidebar, 1e9))
    expect(b.height).toBe(0)
    expect(b.width).toBeGreaterThanOrEqual(0)
  })
  it('scales with the host zoom factor', () => {
    expect(scaleInset(insetForMode('v2', 200, 36), 1.25)).toEqual({ left: 250, top: 55, right: 10, bottom: 10 })
  })
  it('the portal view is hidden while a terminal fills the panel or a host dialog is open', () => {
    expect(portalViewVisible({ hostModalOpen: false, terminalShown: false })).toBe(true)
    expect(portalViewVisible({ hostModalOpen: false, terminalShown: true })).toBe(false)
    expect(portalViewVisible({ hostModalOpen: true, terminalShown: false })).toBe(false)
  })
})

describe('fitToWorkArea (sidebar clipped at the left edge: window off-screen)', () => {
  const area = { x: 0, y: 25, width: 1512, height: 944 }
  it('leaves a window that is fully on screen alone', () => {
    const w = { x: 100, y: 60, width: 1100, height: 760 }
    expect(fitToWorkArea(w, area)).toEqual(w)
  })
  it('pulls a window hanging off the left edge back so the sidebar is fully visible', () => {
    expect(fitToWorkArea({ x: -24, y: 60, width: 1100, height: 760 }, area)).toEqual({ x: 0, y: 60, width: 1100, height: 760 })
  })
  it('pulls back from the right/bottom and under the menu bar', () => {
    expect(fitToWorkArea({ x: 900, y: 0, width: 1100, height: 760 }, area)).toEqual({ x: 412, y: 25, width: 1100, height: 760 })
  })
  it('shrinks only a window larger than the area (unplugged big monitor)', () => {
    expect(fitToWorkArea({ x: -2000, y: 10, width: 2560, height: 1400 }, area)).toEqual({ x: 0, y: 25, width: 1512, height: 944 })
  })
  it('works on a secondary display with negative origin', () => {
    const left = { x: -1920, y: 0, width: 1920, height: 1080 }
    expect(fitToWorkArea({ x: -1950, y: 100, width: 1100, height: 760 }, left)).toEqual({ x: -1920, y: 100, width: 1100, height: 760 })
  })
})
