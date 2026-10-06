import fs from 'node:fs'
import path from 'node:path'
import type { RegistryEntry } from './nativeStacks'

/** GH #258 D3: an app update IS a CLI update (the runtime ships inside the app), but a running
 *  `orcha serve` keeps the old code in memory. On the first launch of a new app version, every
 *  native project in the CLI registry (= running ones; `orcha down` unregisters) gets
 *  `orcha upgrade`, which refreshes skills/hooks and restarts serve on the new package; the
 *  portal applies pending migrations on startup. Plan drift: the plan said `orcha up`, but a
 *  native `up` leaves an already-running serve as is (cli_native_lifecycle.up). */
export interface AppUpdateDeps {
  readLastVersion(): string | null
  writeLastVersion(version: string): void
  registry(): Record<string, RegistryEntry>
  upgrade(folder: string): Promise<void>
  warn?(msg: string): void
}

/** Returns the folders it upgraded. A failed project is logged and skipped (the next app
 *  update tries again; `orcha upgrade` in Terminal does the same by hand). */
export async function restartNativeAfterUpdate(version: string, deps: AppUpdateDeps): Promise<string[]> {
  if (deps.readLastVersion() === version) return []
  const folders = Object.values(deps.registry())
    .filter((e) => e.runtime === 'native')
    .map((e) => e.path)
  const done: string[] = []
  for (const folder of folders) {
    try {
      await deps.upgrade(folder)
      done.push(folder)
    } catch (err) {
      deps.warn?.(`orcha upgrade failed in ${folder}: ${(err as Error)?.message ?? String(err)}`)
    }
  }
  deps.writeLastVersion(version)
  return done
}

const VERSION_FILE = 'last-app-version'

export function fileVersionStore(userDataDir: string): Pick<AppUpdateDeps, 'readLastVersion' | 'writeLastVersion'> {
  const file = path.join(userDataDir, VERSION_FILE)
  return {
    readLastVersion: () => {
      try {
        return fs.readFileSync(file, 'utf8').trim() || null
      } catch {
        return null
      }
    },
    writeLastVersion: (v) => {
      try {
        fs.mkdirSync(userDataDir, { recursive: true })
        fs.writeFileSync(file, `${v}\n`)
      } catch {
        // best effort: worst case the next launch upgrades once more
      }
    }
  }
}
