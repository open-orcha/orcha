import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'

const desktopRoot = path.resolve(__dirname, '..', '..')
const repoRoot = path.resolve(desktopRoot, '..')
const cliPkg = path.join(repoRoot, 'orcha-cli', 'orcha_cli')
const cliTemplates = path.join(cliPkg, 'templates')
const bundled = path.join(desktopRoot, 'resources', 'orcha-templates')

// Bundled but NOT from templates/ — the portal-shared modules come from orcha_cli/ directly
// (see scripts/copy-orcha-templates.mjs / the engine's _install_llm_util mirror). Excluded from
// the templates parity check and verified separately below.
const PORTAL_SHARED = ['llm_util.py', 'secret_box.py', 'digest_curate.py']

function walk(root: string, base: string = root): string[] {
  const out: string[] = []
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full, base))
    else out.push(path.relative(base, full))
  }
  return out.sort()
}

describe('template parity', () => {
  it('bundled templates byte-match the CLI templates', () => {
    expect(existsSync(bundled)).toBe(true)
    const cliFiles = walk(cliTemplates)
    // Ignore the portal-shared/ dir we add from outside templates/.
    const bundledFiles = walk(bundled).filter((rel) => !rel.startsWith(`portal-shared${path.sep}`))
    expect(bundledFiles).toEqual(cliFiles)
    for (const rel of cliFiles) {
      const a = readFileSync(path.join(cliTemplates, rel))
      const b = readFileSync(path.join(bundled, rel))
      expect(b.equals(a), `mismatch in ${rel}`).toBe(true)
    }
  })

  it('bundled portal-shared modules byte-match their orcha_cli sources', () => {
    for (const mod of PORTAL_SHARED) {
      const a = readFileSync(path.join(cliPkg, mod))
      const b = readFileSync(path.join(bundled, 'portal-shared', mod))
      expect(b.equals(a), `mismatch in portal-shared/${mod}`).toBe(true)
    }
  })
})
