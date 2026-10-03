/** Tab colours (Orca's "Tab Color" row): none + nine hues. The eight chromatic ones are slots
 *  of the D13 identity palette (shared/palette AVATAR_HUES) so a tab colour reads as the same
 *  family as avatars and project glyphs; grey is the neutral text token. Rendered as a small
 *  dot on the strip tab and on the sidebar row — never a filled background or an underline
 *  (the strip's only underline marks the active tab). */
import { AVATAR_HUES } from '../../../shared/palette'
import { isTabColor, TAB_COLORS, type TabColor } from '../../../shared/terminal'

export { isTabColor, TAB_COLORS, type TabColor }

/** Palette slot (index into AVATAR_HUES) per chromatic colour. */
const SLOT: Record<Exclude<TabColor, 'grey'>, number> = {
  blue: 6, // 208°
  purple: 8, // 272°
  pink: 9, // 318°
  red: 0, // 4°
  orange: 1, // 30°
  yellow: 2, // 50°
  green: 4, // 145°
  teal: 5 // 178°
}

/** Human name ("Blue") — the swatch's accessible name. */
export function tabColorName(color: TabColor): string {
  return color.charAt(0).toUpperCase() + color.slice(1)
}

/** CSS colour for markers and swatches: the palette hue at marker strength (the avatar fill
 *  is too dark for a 6px dot). */
export function tabColorCss(color: TabColor): string {
  if (color === 'grey') return 'var(--color-text-3)'
  return `hsl(${AVATAR_HUES[SLOT[color]]} var(--marker-sl, 62% 62%))`
}
