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

// The portal container imports three shared modules (secret_box/llm_util/digest_curate)
// that sit next to main.py. They live OUTSIDE templates/ in the CLI (orcha_cli/<mod>.py),
// so bundle them into resources/orcha-templates/portal-shared/; the init engine merges them
// into the deployed .orcha/portal/ (mirrors the CLI's _install_llm_util). Missing these →
// portal crashes ModuleNotFoundError on startup.
const PORTAL_SHARED_MODULES = ['llm_util.py', 'secret_box.py', 'digest_curate.py']
const cliPkg = path.join(repoRoot, 'orcha-cli', 'orcha_cli')

if (!existsSync(src)) {
  console.error(`[copy-orcha-templates] source not found: ${src}`)
  process.exit(1)
}
for (const mod of PORTAL_SHARED_MODULES) {
  if (!existsSync(path.join(cliPkg, mod))) {
    console.error(`[copy-orcha-templates] shared module not found: ${path.join(cliPkg, mod)}`)
    process.exit(1)
  }
}
await rm(dst, { recursive: true, force: true })
await mkdir(path.dirname(dst), { recursive: true })
await cp(src, dst, { recursive: true })
const sharedDst = path.join(dst, 'portal-shared')
await mkdir(sharedDst, { recursive: true })
for (const mod of PORTAL_SHARED_MODULES) {
  await cp(path.join(cliPkg, mod), path.join(sharedDst, mod))
}
console.log(`[copy-orcha-templates] copied ${src} -> ${dst}`)
console.log(`[copy-orcha-templates] copied ${PORTAL_SHARED_MODULES.length} portal-shared modules -> ${sharedDst}`)
