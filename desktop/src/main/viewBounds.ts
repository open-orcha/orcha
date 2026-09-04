/** Pure bounds math for the embedded portal WebContentsView. Kept side-effect-free (no
 *  Electron imports) so it's unit-testable without a running app — index.ts calls this on
 *  window creation, on 'resize', and whenever the top bar's visibility could change.
 *
 *  The left icon rail is gone (superseded by the project-cards home screen) — the embedded
 *  view now reserves space at the TOP for a slim bar ("← Projects" + name + status dot)
 *  instead of on the left for a rail. */
import { TOPBAR_HEIGHT } from '../shared/types'

export interface Size {
  width: number
  height: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export { TOPBAR_HEIGHT }

/** Compute the embedded portal view's bounds: the window's content area minus the top bar
 *  reserved above it. Clamped to zero so a window shrunk below the bar height never yields a
 *  negative-height view (Electron throws on negative bounds). */
export function computeViewBounds(windowSize: Size, topBarHeight: number = TOPBAR_HEIGHT): Rect {
  const y = Math.max(0, Math.min(topBarHeight, windowSize.height))
  const width = Math.max(0, windowSize.width)
  const height = Math.max(0, windowSize.height - y)
  return { x: 0, y, width, height }
}
