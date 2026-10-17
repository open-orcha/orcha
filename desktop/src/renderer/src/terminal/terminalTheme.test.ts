// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { TERMINAL_THEME, TERMINAL_THEME_LIGHT, terminalOptionsFor } from './TerminalView'

function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
const contrast = (a: string, b: string): number => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

describe('xterm theme follows the app theme', () => {
  it('light → the light palette with an AA contrast floor; dark → the dark palette unchanged', () => {
    expect(terminalOptionsFor('light')).toEqual({ theme: TERMINAL_THEME_LIGHT, minimumContrastRatio: 4.5 })
    expect(terminalOptionsFor('dark')).toEqual({ theme: TERMINAL_THEME, minimumContrastRatio: 1 })
  })

  it('light: the foreground and every normal ANSI colour are AA on the white background', () => {
    const bg = TERMINAL_THEME_LIGHT.background as string
    const keys = ['foreground', 'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan'] as const
    for (const k of keys) expect(contrast(TERMINAL_THEME_LIGHT[k] as string, bg), k).toBeGreaterThanOrEqual(4.5)
  })
})
