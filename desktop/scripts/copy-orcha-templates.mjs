// Copies the CLI's canonical template assets into the app bundle resources so the
// desktop app can lay them down without the orcha CLI installed. Single source of
// truth = orcha-cli/orcha_cli/templates; this is a verbatim copy (parity-tested).
import { cp, rm, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const desktopRoot = path.resolve(here, '..')
const repoRoot = path.resolve(desktopRoot, '..')
const src = path.join(repoRoot, 'orcha-cli', 'orcha_cli', 'templates')
const dst = path.join(desktopRoot, 'resources', 'orcha-templates')

if (!existsSync(src)) {
  console.error(`[copy-orcha-templates] source not found: ${src}`)
  process.exit(1)
}
await rm(dst, { recursive: true, force: true })
await mkdir(path.dirname(dst), { recursive: true })
await cp(src, dst, { recursive: true })
console.log(`[copy-orcha-templates] copied ${src} -> ${dst}`)
