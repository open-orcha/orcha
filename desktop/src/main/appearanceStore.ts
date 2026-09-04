/** Appearance (theme + skin) persistence, owned by the desktop app rather than any single
 *  portal's localStorage. Each embedded portal WebContentsView is a SEPARATE origin
 *  (http://localhost:<port-per-stack>), so localStorage never carries across stacks or across
 *  a rebuilt container — a user's theme/skin choice was getting silently lost. The desktop
 *  keeps ONE small JSON file as the source of truth and pushes it into every live view.
 *
 *  Contract (must match the portal's own read/write exactly — see resources/orcha-templates/
 *  portal/frontend/src/cloud/settings/AppearanceSection.tsx):
 *    - localStorage "orcha:theme": "auto" | "dark" | "light", mirrored to <html data-theme>.
 *    - localStorage "orcha:skin": a skin id; "classic" (or absent) means NO data-skin
 *      attribute, any other id sets it.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface Appearance {
  theme: string | null
  skin: string | null
}

const EMPTY: Appearance = { theme: null, skin: null }

/** Where the bag lives: <userData>/appearance.json. Kept as a pure path fn (no app.* calls)
 *  so callers inject the actual userData dir — testable without a real Electron `app`. */
export function appearanceFilePath(userDataDir: string): string {
  return path.join(userDataDir, 'appearance.json')
}

/** Read the persisted bag, or {theme:null, skin:null} if the file is absent/unreadable/
 *  malformed — never throws. "Empty" (both fields null) is the signal callers use to know
 *  "adopt whatever the view currently has" (first-run seeding). */
export function readAppearance(userDataDir: string): Appearance {
  try {
    const raw = readFileSync(appearanceFilePath(userDataDir), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return { ...EMPTY }
    const obj = parsed as Record<string, unknown>
    return {
      theme: typeof obj.theme === 'string' ? obj.theme : null,
      skin: typeof obj.skin === 'string' ? obj.skin : null
    }
  } catch {
    return { ...EMPTY }
  }
}

/** Write the bag (mkdirp'd parent dir). Swallows write failures (disk full, permissions) —
 *  appearance sync is a nice-to-have, never worth crashing the app over. */
export function writeAppearance(userDataDir: string, appearance: Appearance): void {
  try {
    mkdirSync(userDataDir, { recursive: true })
    writeFileSync(appearanceFilePath(userDataDir), JSON.stringify(appearance, null, 2) + '\n')
  } catch {
    // best-effort — see doc comment above.
  }
}

/** True iff the bag has nothing set yet (first-run: adopt from whatever view we see first). */
export function isEmpty(appearance: Appearance): boolean {
  return appearance.theme === null && appearance.skin === null
}

export { EMPTY as EMPTY_APPEARANCE }
