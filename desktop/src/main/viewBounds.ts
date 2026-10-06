/** Pure bounds math for the embedded portal WebContentsView. Kept side-effect-free (no
 *  Electron imports) so it's unit-testable without a running app — index.ts calls this on
 *  window creation, on 'resize', whenever the host sidebar is resized/collapsed, and whenever
 *  a view's embed mode changes (arch §7.4).
 *
 *  Two layouts:
 *  - V2 embedded (portal answered `ready`, or still loading): the host renderer owns a
 *    persistent LEFT sidebar sitting on the canvas; the view is the INSET RAISED PANEL right
 *    of it — PANEL_GAP from the window's top/right/bottom edges, flush with the sidebar's
 *    own inner padding, clipped to PANEL_RADIUS (Linear "pop", design directive D5).
 *  - Legacy fallback (older portal, no `ready` within 3 s): the old slim TOP bar
 *    ("← Projects" + name + status dot) above a full-width view (`{ left: 0, top: TOPBAR_HEIGHT }`),
 *    so the old portal's own sidebar is never doubled with the host's. */
import { TOPBAR_HEIGHT } from '../shared/types'
import type { EmbedMode } from '../shared/embed'

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

export interface Inset {
  left: number
  top: number
  /** Optional right/bottom insets (the V2 inset panel); 0 when absent. */
  right?: number
  bottom?: number
}

/** The inset raised content panel (D5): gap to the window edges and corner radius, CSS px.
 *  Mirrors the renderer's `.host-panel` (styles.css) so the native view lands exactly on
 *  the DOM panel drawn underneath it. */
export const PANEL_GAP = 8
export const PANEL_RADIUS = 10

export { TOPBAR_HEIGHT }

/** Host sidebar geometry (CSS px) — mirrors docs/orcha-v2-design-system.md `--v2-sidebar-w`. */
export const SIDEBAR_DEFAULT = 272
export const SIDEBAR_MIN = 200
export const SIDEBAR_MAX = 360
export const SIDEBAR_RAIL = 56

function finite(n: number): number {
  return Number.isFinite(n) ? n : 0
}

/** Clamp a renderer-reported sidebar width: the rail width when collapsed, else [MIN, MAX].
 *  Garbage (NaN, strings coerced upstream, negatives) falls back to the default. */
export function clampSidebarWidth(width: unknown, collapsed = false): number {
  if (collapsed) return SIDEBAR_RAIL
  if (typeof width !== 'number' || !Number.isFinite(width)) return SIDEBAR_DEFAULT
  return Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width)))
}

/** Compute the embedded portal view's bounds: the window's content area minus the host
 *  chrome reserved at the left (sidebar) and/or top (legacy bar). A bare number is the legacy
 *  signature (top inset only). Clamped so a window shrunk below the chrome never yields
 *  negative bounds (Electron throws on negative sizes). */
export function computeViewBounds(windowSize: Size, inset: number | Inset = TOPBAR_HEIGHT): Rect {
  const { left, top, right = 0, bottom = 0 } = typeof inset === 'number' ? { left: 0, top: inset } : inset
  const w = Math.max(0, finite(windowSize.width))
  const h = Math.max(0, finite(windowSize.height))
  const x = Math.max(0, Math.min(finite(left), w))
  const y = Math.max(0, Math.min(finite(top), h))
  const width = Math.max(0, w - x - Math.max(0, finite(right)))
  const height = Math.max(0, h - y - Math.max(0, finite(bottom)))
  return { x, y, width, height }
}

/** Upper bound for the renderer-reported session tab strip height (CSS px). */
export const STRIP_MAX = 200

/** Clamp the height of the host's session tab strip — the Orca-style strip at the top of
 *  the content panel (project portal tab + terminal tabs) that the portal view sits BELOW.
 *  0 when there are no terminal tabs. Garbage → 0. */
export function clampStripHeight(height: unknown): number {
  if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return 0
  return Math.round(Math.min(STRIP_MAX, height))
}

/** The inset for a view in a given embed mode. `pending` lays out as V2 (the portal gets the
 *  `?embed=desktop` pre-paint hint, so a V2 portal never flashes its own sidebar); only a
 *  confirmed `legacy` view gets the old top-bar layout.
 *
 *  `stripHeight`: the host's session tab strip occupies the top of the panel; the view
 *  starts right under it (terminals are full-panel sessions, not a dock under the view). */
export function insetForMode(mode: EmbedMode, sidebarWidth: number, stripHeight = 0): Inset {
  const strip = clampStripHeight(stripHeight)
  if (mode === 'legacy') return { left: 0, top: TOPBAR_HEIGHT + strip }
  return { left: sidebarWidth, top: PANEL_GAP + strip, right: PANEL_GAP, bottom: PANEL_GAP }
}

/** Whether the active portal view should be drawn: never under a host dialog (DOM can't draw
 *  above a native view) and never while a terminal session fills the panel (the view stays
 *  alive, just hidden, so switching back is instant). */
export function portalViewVisible(s: { hostModalOpen: boolean; terminalShown: boolean }): boolean {
  return !s.hostModalOpen && !s.terminalShown
}

/** Keep a window reachable: if it no longer overlaps the display's work area enough (a
 *  monitor was unplugged, the saved/remembered frame sits off-screen, it was dragged past the
 *  left edge), pull it back fully inside — shrinking only when it is larger than the area.
 *  A window that is already fully inside is returned unchanged. */
export function fitToWorkArea(win: Rect, area: Rect): Rect {
  const width = Math.min(Math.max(0, finite(win.width)), Math.max(0, finite(area.width)))
  const height = Math.min(Math.max(0, finite(win.height)), Math.max(0, finite(area.height)))
  const maxX = area.x + area.width - width
  const maxY = area.y + area.height - height
  const x = Math.round(Math.min(maxX, Math.max(area.x, finite(win.x))))
  const y = Math.round(Math.min(maxY, Math.max(area.y, finite(win.y))))
  return { x, y, width, height }
}

/** Corner radius for a view in a given embed mode (legacy keeps its square full-bleed view). */
export function radiusForMode(mode: EmbedMode, zoomFactor = 1): number {
  const z = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1
  return mode === 'legacy' ? 0 : Math.round(PANEL_RADIUS * z)
}

/** Scale a CSS-px inset reported by (or implied for) the manager renderer into window DIP.
 *  The renderer reports its sidebar width in CSS px; when the manager webContents is zoomed
 *  (View → Zoom In with host chrome focused) one CSS px is `zoomFactor` DIP, so an unscaled
 *  inset would let the native view cover the sidebar's right edge (brief item 12). */
export function scaleInset(inset: Inset, zoomFactor: number): Inset {
  const z = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1
  const out: Inset = { left: Math.round(inset.left * z), top: Math.round(inset.top * z) }
  if (inset.right !== undefined) out.right = Math.round(inset.right * z)
  if (inset.bottom !== undefined) out.bottom = Math.round(inset.bottom * z)
  return out
}
