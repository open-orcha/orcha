import { describe, it, expect, beforeAll } from 'vitest'

// Vitest's test runner is Node, so a plain fs read works even though this file lives under
// the renderer tree — but tsconfig.web.json has no Node types (by design, so app code never
// leans on process/Buffer). Route the read through a dynamically-imported, untyped module
// handle instead of a static `import ... from 'fs'`, so this test-only file doesn't need
// "node" added to the whole renderer tsconfig's `types`.
let css = ''

beforeAll(async () => {
  const fsModule = 'node:fs'
  const urlModule = 'node:url'
  const fs = (await import(/* @vite-ignore */ fsModule)) as { readFileSync: (p: string, enc: string) => string }
  const nodeUrl = (await import(/* @vite-ignore */ urlModule)) as { fileURLToPath: (u: URL) => string }
  const here = nodeUrl.fileURLToPath(new URL('.', import.meta.url))
  css = fs.readFileSync(`${here}styles.css`, 'utf8')
})

/** Every cinematic-onboarding keyframe class must have a prefers-reduced-motion override
 *  that freezes it to its END state (not just animation:none) — a simple string check on
 *  the stylesheet, per the design-system rule. */
describe('styles.css — reduced motion', () => {
  it('declares a prefers-reduced-motion override block', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
  })

  it('every onb- keyframe animation class has a matching reduced-motion override', () => {
    const reducedBlockMatch = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*)\}\s*$/)
    expect(reducedBlockMatch).not.toBeNull()
    const reducedBlock = reducedBlockMatch![1]

    const animatedClasses = Array.from(
      new Set(Array.from(css.matchAll(/\.(onb-[a-z-]+)\s*\{[^}]*animation:/g)).map((m) => m[1]))
    )
    expect(animatedClasses.length).toBeGreaterThan(5)

    for (const cls of animatedClasses) {
      expect(reducedBlock, `expected .${cls} to have a reduced-motion override`).toContain(`.${cls}`)
    }
  })

  it('reduced-motion overrides freeze to an end state, not just animation:none', () => {
    // Spot-check a representative sample rather than every property on every rule —
    // freezing means each override also pins opacity/transform, not merely animation:none.
    expect(css).toMatch(/\.onb-rise-in,\s*\n\s*\.onb-stagger > \*\s*\{\s*\n\s*animation: none;\s*\n\s*opacity: 1;/)
    expect(css).toMatch(/\.onb-check-pop\s*\{\s*\n\s*animation: none;\s*\n\s*opacity: 1;\s*\n\s*transform: scale\(1\);/)
  })
})
