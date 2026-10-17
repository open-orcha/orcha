// node-pty ships N-API prebuilds (prebuilds/<platform>-<arch>/pty.node + spawn-helper), so it
// loads in Electron with NO electron-rebuild: N-API is ABI-stable across Node/Electron.
// But npm drops the exec bit on the prebuilt `spawn-helper` (node-pty 1.1.0), and every
// spawn then fails with "posix_spawnp failed". Restore it after install and before any
// build/package (electron-builder copies the file mode into the .app). Idempotent.
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const prebuilds = path.resolve(here, '..', 'node_modules', 'node-pty', 'prebuilds')

if (!existsSync(prebuilds)) {
  console.warn('[fix-node-pty] node-pty prebuilds not found — skipping (is node-pty installed?)')
  process.exit(0)
}
let fixed = 0
for (const dir of readdirSync(prebuilds)) {
  const helper = path.join(prebuilds, dir, 'spawn-helper')
  if (!existsSync(helper)) continue
  const mode = statSync(helper).mode
  if ((mode & 0o111) !== 0o111) {
    chmodSync(helper, mode | 0o755)
    fixed++
  }
}
console.log(`[fix-node-pty] spawn-helper exec bit ok${fixed ? ` (fixed ${fixed})` : ''}`)
