// electron-vite fails with a bare "Error: Electron uninstall" when the `electron` package is in
// node_modules but its own postinstall (install.js, which downloads the Electron binary and
// writes path.txt) never finished — an interrupted `npm install`, `--ignore-scripts`, or an
// install that failed on another dependency after pulling a branch with new deps. Detect that
// before `dev`/`build` and finish the download instead of leaving the cryptic error. Idempotent.
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const electronDir = path.resolve(here, '..', 'node_modules', 'electron')

export function electronInstalled(dir = electronDir) {
  const pathFile = path.join(dir, 'path.txt')
  if (!existsSync(pathFile)) return false
  const rel = readFileSync(pathFile, 'utf8').trim()
  return rel.length > 0 && existsSync(path.join(dir, 'dist', rel))
}

function main() {
  if (!existsSync(electronDir)) {
    console.error('[ensure-electron] electron is not installed — run `npm install` in desktop/ first.')
    process.exit(1)
  }
  if (electronInstalled()) return
  console.log('[ensure-electron] Electron binary missing (its install step did not finish) — downloading it now…')
  const r = spawnSync(process.execPath, [path.join(electronDir, 'install.js')], { stdio: 'inherit', cwd: electronDir })
  if (r.status !== 0 || !electronInstalled()) {
    console.error(
      '[ensure-electron] Could not download Electron. Re-run a clean install from desktop/:\n' +
        '  rm -rf node_modules && npm install\n' +
        'and check the npm output for the first error (often a native module build).'
    )
    process.exit(1)
  }
  console.log('[ensure-electron] Electron ready.')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
