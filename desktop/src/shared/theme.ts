/** Desktop Appearance (Settings › Appearance): System / Light / Dark.
 *
 *  PURE module (no Electron / Node imports) shared by main, the index preload (types +
 *  inlined channel names) and the renderer.
 *
 *  How the theme travels: main sets `nativeTheme.themeSource` to the chosen mode. Electron
 *  then makes `prefers-color-scheme` match in EVERY WebContents — the manager window, the
 *  tray popover and each embedded portal view — live, with no messages. The renderer's
 *  light tokens hang off that media query (styles.css), and a V2 portal that sees the host
 *  `theme` capability (shared/embed.ts) follows it too, so chrome and portal never disagree. */

export type ThemeMode = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_MODES: readonly ThemeMode[] = ['system', 'light', 'dark']

/** Never chosen → dark: the look every existing install already has. */
export const DEFAULT_THEME_MODE: ThemeMode = 'dark'

export function isThemeMode(v: unknown): v is ThemeMode {
  return typeof v === 'string' && (THEME_MODES as readonly string[]).includes(v)
}

/** What main reports to the renderer: the preference and what it resolves to right now. */
export interface ThemeState {
  mode: ThemeMode
  resolved: ResolvedTheme
}

export const THEME_CHANNELS = {
  get: 'orcha:theme:get',
  set: 'orcha:theme:set',
  changed: 'orcha:theme:changed'
} as const

/** Window canvas painted by native surfaces before first paint (BrowserWindow /
 *  WebContentsView backgroundColor) — equal to styles.css `--color-bg` per theme, so no
 *  window ever flashes the wrong tone. */
export const CANVAS: Record<ResolvedTheme, string> = {
  dark: '#101113',
  light: '#F4F4F5'
}

export function canvasFor(resolved: ResolvedTheme): string {
  return CANVAS[resolved]
}

export interface ThemeApi {
  get(): Promise<ThemeState>
  /** Rejects with {code:'INVALID_THEME'} for anything but system/light/dark. */
  set(mode: ThemeMode): Promise<ThemeState>
  /** Fires on a preference change AND when the OS appearance flips under 'system'. */
  onChanged(cb: (s: ThemeState) => void): () => void
}
