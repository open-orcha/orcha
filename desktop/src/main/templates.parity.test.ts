import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'

const desktopRoot = path.resolve(__dirname, '..', '..')
const repoRoot = path.resolve(desktopRoot, '..')
const cliTemplates = path.join(repoRoot, 'orcha-cli', 'orcha_cli', 'templates')
const bundled = path.join(desktopRoot, 'resources', 'orcha-templates')

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
    const bundledFiles = walk(bundled)
    expect(bundledFiles).toEqual(cliFiles)
    for (const rel of cliFiles) {
      const a = readFileSync(path.join(cliTemplates, rel))
      const b = readFileSync(path.join(bundled, rel))
      expect(b.equals(a), `mismatch in ${rel}`).toBe(true)
    }
  })
})
