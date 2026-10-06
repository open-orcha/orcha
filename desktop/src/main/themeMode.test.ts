import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { appearanceFilePath, readAppearance, writeAppearance } from './appearanceStore'
import { createThemeController, readThemeMode, writeThemeMode, type NativeThemeLike } from './themeMode'
import { CANVAS, type ThemeMode } from '../shared/theme'

/** A fake nativeTheme: themeSource drives shouldUseDarkColors like Electron (system → osDark),
 *  and every themeSource write (or OS flip) emits 'updated'. */
function fakeNativeTheme(osDark = true) {
  const listeners: (() => void)[] = []
  let source: ThemeMode = 'system'
  let os = osDark
  const nt = {
    get themeSource() {
      return source
    },
    set themeSource(v: ThemeMode) {
      source = v
      listeners.forEach((l) => l())
    },
    get shouldUseDarkColors() {
      return source === 'dark' || (source === 'system' && os)
    },
    on(_e: 'updated', l: () => void) {
      listeners.push(l)
      return nt
    },
    flipOs(dark: boolean) {
      os = dark
      listeners.forEach((l) => l())
    }
  }
  return nt as NativeThemeLike & { flipOs(dark: boolean): void }
}

describe('readThemeMode / writeThemeMode', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('defaults to dark when never chosen, unreadable or invalid', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'orcha-theme-'))
    expect(readThemeMode(dir)).toBe('dark')
    writeFileSync(appearanceFilePath(dir), '{not json')
    expect(readThemeMode(dir)).toBe('dark')
    writeFileSync(appearanceFilePath(dir), JSON.stringify({ mode: 'sepia' }))
    expect(readThemeMode(dir)).toBe('dark')
  })

  it('round-trips each mode and keeps the legacy theme/skin fields intact', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'orcha-theme-'))
    writeAppearance(dir, { theme: 'dark', skin: 'gold' })
    for (const m of ['light', 'system', 'dark'] as const) {
      writeThemeMode(dir, m)
      expect(readThemeMode(dir)).toBe(m)
    }
    expect(readAppearance(dir)).toEqual({ theme: 'dark', skin: 'gold' })
    expect(JSON.parse(readFileSync(appearanceFilePath(dir), 'utf8')).mode).toBe('dark')
  })
})

describe('createThemeController (nativeTheme wiring)', () => {
  it('applies the stored mode to nativeTheme.themeSource at creation', () => {
    const nt = fakeNativeTheme(true)
    const ctl = createThemeController({ nativeTheme: nt, read: () => 'light', write: () => {} })
    expect(nt.themeSource).toBe('light')
    expect(ctl.state()).toEqual({ mode: 'light', resolved: 'light' })
  })

  it('set() validates, persists, applies and notifies', () => {
    const nt = fakeNativeTheme(false)
    const write = vi.fn()
    const onChange = vi.fn()
    const ctl = createThemeController({ nativeTheme: nt, read: () => 'dark', write, onChange })
    expect(ctl.set('light')).toEqual({ mode: 'light', resolved: 'light' })
    expect(nt.themeSource).toBe('light')
    expect(write).toHaveBeenCalledWith('light')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith({ mode: 'light', resolved: 'light' })
  })

  it('rejects anything but system/light/dark without touching nativeTheme or disk', () => {
    const nt = fakeNativeTheme()
    const write = vi.fn()
    const ctl = createThemeController({ nativeTheme: nt, read: () => 'dark', write })
    for (const bad of ['auto', 'Light', '', null, 1, { mode: 'light' }]) {
      expect(() => ctl.set(bad)).toThrow()
      try {
        ctl.set(bad)
      } catch (e) {
        expect(e).toEqual({ code: 'INVALID_THEME' })
      }
    }
    expect(nt.themeSource).toBe('dark')
    expect(write).not.toHaveBeenCalled()
  })

  it('under System, relays a live OS appearance flip (once, de-duplicated)', () => {
    const nt = fakeNativeTheme(true)
    const onChange = vi.fn()
    const ctl = createThemeController({ nativeTheme: nt, read: () => 'system', write: () => {}, onChange })
    expect(ctl.resolved()).toBe('dark')
    nt.flipOs(false)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith({ mode: 'system', resolved: 'light' })
    nt.flipOs(false) // same state again: no duplicate event
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('an explicit mode ignores OS flips', () => {
    const nt = fakeNativeTheme(true)
    const onChange = vi.fn()
    const ctl = createThemeController({ nativeTheme: nt, read: () => 'dark', write: () => {}, onChange })
    nt.flipOs(false)
    expect(ctl.resolved()).toBe('dark')
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('main/index.ts wiring (source contract)', () => {
  const src = readFileSync(path.join(__dirname, 'index.ts'), 'utf8')
  const ready = src.slice(src.indexOf('app.whenReady().then('))

  it('creates the theme controller from the stored mode BEFORE any window is created', () => {
    const ctl = ready.indexOf('createThemeController(')
    expect(ctl).toBeGreaterThan(-1)
    expect(ready.slice(ctl, ctl + 200)).toContain('nativeTheme')
    expect(ready.slice(ctl, ctl + 200)).toContain('readThemeMode(userDataDir)')
    expect(ctl).toBeLessThan(ready.indexOf('createManagerWindow()'))
    expect(ctl).toBeLessThan(ready.indexOf('createTray('))
  })

  it('paints every native surface with the resolved canvas (no hard-coded dark)', () => {
    expect(src).not.toMatch(/backgroundColor:\s*CANVAS/)
    expect(src.match(/backgroundColor: canvas\(\)/g)?.length).toBe(2)
    expect(src).toContain('view.setBackgroundColor(canvas())')
  })

  it('serves get/set on the theme channels to its own windows only', () => {
    expect(ready).toContain('ipcMain.handle(THEME_CHANNELS.get')
    expect(ready).toContain('ipcMain.handle(THEME_CHANNELS.set')
    expect(ready).toMatch(/if \(!themeSender\(event\)\) throw \{ code: 'INVALID_THEME' \}/)
  })
})

describe('native canvas = renderer --color-bg per theme (no first-paint flash)', () => {
  it('matches styles.css for dark and light', () => {
    const css = readFileSync(path.join(__dirname, '../renderer/src/styles.css'), 'utf8')
    const dark = /@theme\s*\{[^}]*--color-bg:\s*(#[0-9a-f]{6})/i.exec(css)?.[1]
    const light = /prefers-color-scheme: light\)\s*\{\s*:root\s*\{[^}]*--color-bg:\s*(#[0-9a-f]{6})/i.exec(css)?.[1]
    expect(dark?.toLowerCase()).toBe(CANVAS.dark.toLowerCase())
    expect(light?.toLowerCase()).toBe(CANVAS.light.toLowerCase())
  })
})
