/** D14 project-icon value — the ONE shape the portal and the desktop share, stored per project
 *  in the portal's `containers.icon` column (mig 050), written through
 *  PUT /api/containers/{cid}/icon {icon} and read from `icon` on GET /api/containers.
 *
 *  Mirrors portal_backend/project_icons.py and frontend/src/cloud/projects/projectIcons.ts
 *  (portal commit 5f79b97b): same glyph list, same emoji rule, colour = a slot 0–9 of the
 *  shared avatar palette (AVATAR_HUES, D13) or null. */

export const GLYPH_NAMES = [
  'box',
  'folder',
  'code',
  'terminal',
  'rocket',
  'globe',
  'smartphone',
  'server',
  'database',
  'cloud',
  'cpu',
  'bot',
  'zap',
  'flask',
  'shield',
  'book',
  'briefcase',
  'cart',
  'gamepad',
  'music',
  'camera',
  'palette',
  'heart',
  'star',
  'leaf',
  'wrench',
  'chart',
  'mail'
] as const

export type GlyphName = (typeof GLYPH_NAMES)[number]

export type ProjectIcon =
  | { kind: 'emoji'; value: string }
  /** `color`: a slot of the shared avatar palette (AVATAR_HUES) or null = neutral. */
  | { kind: 'glyph'; value: GlyphName; color: number | null }

/** len(AVATAR_HUES) — the server rejects any other colour. */
export const ICON_COLORS = 10
const EMOJI_MAX_LEN = 16

/** Short text with at least one pictographic code point (flags = regional indicators,
 *  keycaps = U+20E3) — never a word, never markup (the portal's rule). */
export function isEmoji(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    v.length > 0 &&
    v.length <= EMOJI_MAX_LEN &&
    /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u.test(v) &&
    !/[A-Za-z<>&"']/.test(v)
  )
}

/** Validate one stored / incoming icon (never trust storage or the wire); null = malformed. */
export function parseIcon(raw: unknown): ProjectIcon | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as { kind?: unknown; value?: unknown; color?: unknown }
  if (r.kind === 'emoji' && isEmoji(r.value)) return { kind: 'emoji', value: r.value }
  if (r.kind === 'glyph' && typeof r.value === 'string' && (GLYPH_NAMES as readonly string[]).includes(r.value)) {
    const c = r.color
    const color = typeof c === 'number' && Number.isInteger(c) && c >= 0 && c < ICON_COLORS ? c : null
    return { kind: 'glyph', value: r.value as GlyphName, color }
  }
  return null
}

/** A container row's `icon` field as the desktop types it: `undefined` = the key is absent (an
 *  older portal without the shared store), `null` = unset (or malformed), else the icon. */
export function containerIcon(row: unknown): ProjectIcon | null | undefined {
  if (typeof row !== 'object' || row === null || !('icon' in row)) return undefined
  const raw = (row as { icon?: unknown }).icon
  if (raw === undefined) return undefined
  return raw === null ? null : parseIcon(raw)
}

export function sameIcon(a: ProjectIcon | null | undefined, b: ProjectIcon | null | undefined): boolean {
  if (!a || !b) return !a && !b
  return a.kind === b.kind && a.value === b.value && (a.kind === 'glyph' && b.kind === 'glyph' ? a.color === b.color : true)
}
