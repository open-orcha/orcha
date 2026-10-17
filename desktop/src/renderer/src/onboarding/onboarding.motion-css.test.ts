import { beforeAll, describe, expect, it } from 'vitest'

/** The wizard's motion contract, checked on the stylesheet itself (node env, like
 *  styles.reduced-motion.test.ts): compositor-only keyframes and a reduced-motion freeze. */
describe('onboarding.css motion contract', () => {
  // Same untyped dynamic-import route as styles.reduced-motion.test.ts: the renderer
  // tsconfig deliberately has no Node types.
  let css = ''
  beforeAll(async () => {
    const fsModule = 'node:fs'
    const urlModule = 'node:url'
    const fs = (await import(/* @vite-ignore */ fsModule)) as { readFileSync: (p: string, enc: string) => string }
    const nodeUrl = (await import(/* @vite-ignore */ urlModule)) as { fileURLToPath: (u: URL) => string }
    css = fs.readFileSync(nodeUrl.fileURLToPath(new URL('./onboarding.css', import.meta.url)), 'utf8')
  })

  it('animates only transform and opacity in every keyframe (compositor-only, 60 fps)', () => {
    const frames = [...css.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\n\}/g)]
    expect(frames.length).toBeGreaterThan(10)
    for (const [, name, body] of frames) {
      const props = [...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1])
      for (const p of props) expect([name, p]).toEqual([name, expect.stringMatching(/^(transform|opacity)$/)])
    }
  })

  it('freezes every animation and transition under prefers-reduced-motion', () => {
    const block = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'))
    expect(block).toMatch(/\.ob-window \*,[\s\S]*animation: none !important;[\s\S]*transition: none !important;/)
    expect(block).toMatch(/::view-transition-old\(\*\)/)
  })
})
