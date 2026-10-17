/** Lint-style guards for the light theme: every renderer colour comes from a token, and the
 *  light token set keeps text AA. Fails if a new hard-coded dark colour creeps in. */
import { describe, it, expect, beforeAll } from 'vitest'
import { AVATAR_HUES } from '../../../shared/palette'

// tsconfig.web.json has no Node types (see styles.reduced-motion.test.ts): fs/path/url come
// in through untyped dynamic imports.
interface Fs {
  readFileSync(p: string, enc: string): string
  readdirSync(p: string): string[]
  statSync(p: string): { isDirectory(): boolean }
}
interface Path {
  join(...p: string[]): string
  relative(a: string, b: string): string
  sep: string
}
let fs: Fs
let path: Path
let ROOT = ''
beforeAll(async () => {
  const [f, p, u] = ['node:fs', 'node:path', 'node:url']
  fs = (await import(/* @vite-ignore */ f)) as Fs
  path = ((await import(/* @vite-ignore */ p)) as { default: Path }).default
  const url = (await import(/* @vite-ignore */ u)) as { fileURLToPath: (u: URL) => string }
  ROOT = url.fileURLToPath(new URL('..', import.meta.url))
})
function files(dir: string): string[] {
  return fs.readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n)
    if (fs.statSync(p).isDirectory()) return files(p)
    return /\.(tsx?|css)$/.test(n) && !/\.test\./.test(n) ? [p] : []
  })
}
const readFileSync = (p: string, enc: string): string => fs.readFileSync(p, enc)
/** Files allowed to hold literal colours, each for a stated reason. */
const ALLOWED = new Set([
  'styles.css', // the token definitions themselves
  'terminal/TerminalView.tsx', // xterm palettes (one per theme) — xterm needs literal colours
  'terminal/brandMarks.tsx', // official brand hexes
  'components/BrandMark.tsx', // the product mark's fixed artwork
  'settings/AppearanceSettings.tsx', // the theme previews depict each theme literally
  'icons/emojiData.ts'
])

describe('renderer colour hygiene (light theme has no dark islands)', () => {
  it('no hard-coded hex / rgb / hsl colours, black/white utilities outside the token files', () => {
    const offenders: string[] = []
    for (const f of files(ROOT)) {
      const rel = path.relative(ROOT, f).split(path.sep).join('/')
      if (ALLOWED.has(rel)) continue
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line: string, i: number) => {
          const code = line.replace(/\/\/.*$|\/\*.*?\*\/|^\s*\*.*$/g, '')
          if (/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![\w-])|rgba?\(\s*\d|hsla?\(\s*\d+\s+\d|\b(bg|text|border)-(black|white)\b/.test(code))
            offenders.push(`${rel}:${i + 1}: ${line.trim()}`)
        })
    }
    expect(offenders).toEqual([])
  })

  it('light tokens keep every text colour AA on the light window, card and hover tones', () => {
    const css = readFileSync(path.join(ROOT, 'styles.css'), 'utf8')
    const block = /prefers-color-scheme: light\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    const tok = (n: string): string => new RegExp(`--color-${n}:\\s*(#[0-9a-fA-F]{6})`).exec(block)?.[1] ?? 'missing'
    const lum = (hex: string): number => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
    }
    const cr = (a: string, b: string): number => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
      return (x + 0.05) / (y + 0.05)
    }
    for (const bg of ['bg', 'card', 'hover']) {
      for (const fg of ['text', 'text-2', 'text-3', 'accent', 'ok', 'warning', 'danger', 'info']) {
        expect(cr(tok(fg), tok(bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('light identity palette: every hue’s initial is ≥ 4.5:1 on its fill', () => {
    const css = readFileSync(path.join(ROOT, 'styles.css'), 'utf8')
    const block = /prefers-color-scheme: light\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    const sl = (n: string): [number, number] => {
      const m = new RegExp(`--${n}:\\s*(\\d+)%\\s+(\\d+)%`).exec(block)
      return [Number(m?.[1]) / 100, Number(m?.[2]) / 100]
    }
    const hslLum = (h: number, [s, l]: [number, number]): number => {
      const k = (n: number) => (n + h / 30) % 12
      const a = s * Math.min(l, 1 - l)
      const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
      const c = [f(0), f(8), f(4)].map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
    }
    for (const h of AVATAR_HUES) {
      const bg = hslLum(h, sl('avatar-bg-sl'))
      const fg = hslLum(h, sl('avatar-fg-sl'))
      expect((Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05), `hue ${h}`).toBeGreaterThanOrEqual(4.5)
    }
  })
})
