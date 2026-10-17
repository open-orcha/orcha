/** Desktop Appearance mode (System / Light / Dark): persistence + nativeTheme wiring.
 *
 *  Stored as the `mode` field of <userData>/appearance.json — the same file appearanceStore.ts
 *  owns for the legacy (pre-V2 portal) theme/skin pair. Reads/writes here touch ONLY `mode`
 *  and preserve every other field, so the legacy fields keep working for applyLegacyAppearance.
 *
 *  The controller is Electron-free (nativeTheme is injected) so it's unit-testable. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { appearanceFilePath } from './appearanceStore'
import {
  DEFAULT_THEME_MODE,
  isThemeMode,
  type ResolvedTheme,
  type ThemeMode,
  type ThemeState
} from '../shared/theme'

function readRaw(userDataDir: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(appearanceFilePath(userDataDir), 'utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** The stored mode, or 'dark' (the pre-Appearance look) when absent / unreadable / invalid. */
export function readThemeMode(userDataDir: string): ThemeMode {
  const mode = readRaw(userDataDir).mode
  return isThemeMode(mode) ? mode : DEFAULT_THEME_MODE
}

/** Persist `mode`, keeping the legacy theme/skin fields. Best-effort (never throws). */
export function writeThemeMode(userDataDir: string, mode: ThemeMode): void {
  try {
    const raw = readRaw(userDataDir)
    const next = { theme: raw.theme ?? null, skin: raw.skin ?? null, ...raw, mode }
    mkdirSync(userDataDir, { recursive: true })
    writeFileSync(appearanceFilePath(userDataDir), JSON.stringify(next, null, 2) + '\n')
  } catch {
    // cosmetic — a lost write falls back to the default next launch
  }
}

/** The slice of Electron's `nativeTheme` the controller needs. */
export interface NativeThemeLike {
  themeSource: ThemeMode
  readonly shouldUseDarkColors: boolean
  on(event: 'updated', listener: () => void): unknown
}

export interface ThemeController {
  /** Current preference + resolved theme. */
  state(): ThemeState
  resolved(): ResolvedTheme
  /** Validate, persist and apply. Throws {code:'INVALID_THEME'} on a bad value. */
  set(raw: unknown): ThemeState
}

/** Applies the stored mode to nativeTheme IMMEDIATELY (call before creating any window, so
 *  first paint and every backgroundColor already match), then relays every change — a
 *  preference change or an OS appearance flip under 'system' — to `onChange`. */
export function createThemeController(opts: {
  nativeTheme: NativeThemeLike
  read: () => ThemeMode
  write: (mode: ThemeMode) => void
  onChange?: (s: ThemeState) => void
}): ThemeController {
  const { nativeTheme } = opts
  let mode = opts.read()
  nativeTheme.themeSource = mode
  const resolved = (): ResolvedTheme => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
  const state = (): ThemeState => ({ mode, resolved: resolved() })
  // 'updated' fires for our own themeSource writes and for OS changes; de-dupe identical states.
  let last = JSON.stringify(state())
  nativeTheme.on('updated', () => {
    const s = state()
    const key = JSON.stringify(s)
    if (key === last) return
    last = key
    opts.onChange?.(s)
  })
  return {
    state,
    resolved,
    set(raw) {
      if (!isThemeMode(raw)) throw { code: 'INVALID_THEME' as const }
      mode = raw
      opts.write(raw)
      nativeTheme.themeSource = raw
      const s = state()
      const key = JSON.stringify(s)
      if (key !== last) {
        last = key
        opts.onChange?.(s)
      }
      return s
    }
  }
}
