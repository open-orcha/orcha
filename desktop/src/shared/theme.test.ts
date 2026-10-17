import { describe, it, expect } from 'vitest'
import { DEFAULT_THEME_MODE, isThemeMode, THEME_MODES } from './theme'
import { HOST_CAPABILITIES } from './embed'
import { paletteColor } from './palette'

describe('shared/theme', () => {
  it('knows exactly system / light / dark, defaulting to dark (today’s look)', () => {
    expect(THEME_MODES).toEqual(['system', 'light', 'dark'])
    expect(DEFAULT_THEME_MODE).toBe('dark')
    for (const m of THEME_MODES) expect(isThemeMode(m)).toBe(true)
    for (const bad of ['auto', 'DARK', '', null, undefined, 0]) expect(isThemeMode(bad)).toBe(false)
  })

  it('the host advertises the theme capability to embedded portals', () => {
    expect(HOST_CAPABILITIES).toContain('theme')
    expect(HOST_CAPABILITIES).toEqual(['sidebar', 'notifications', 'stackControl', 'theme', 'revealPath'])
  })

  it('identity palette lightness is theme-driven with the dark values as fallback', () => {
    expect(paletteColor(0)).toEqual({
      background: 'hsl(4 var(--avatar-bg-sl, 34% 28%))',
      color: 'hsl(4 var(--avatar-fg-sl, 72% 86%))'
    })
  })
})
