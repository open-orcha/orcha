/** Node adapters for removeEngine / storageScan, plus the kept-data ledger.
 *
 *  The ledger (`<userData>/kept-data.json`) remembers projects removed with "keep data": the
 *  compose project and its folder, so Settings › Storage can say "data kept for <folder> —
 *  add it again to bring it back" instead of calling that volume an orphan. An entry is
 *  dropped when the data is deleted or the project is added back. */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dockerPath } from './dockerExec'
import { orchaBin } from './hostWorker'
import { folderBelongsTo, SAFE_PROJECT } from './projectCleanup'
import type { RemoveFs } from './removeEngine'
import type { KeptData } from './storageScan'

const MAX_BUFFER = 32 * 1024 * 1024

/** `docker <args>` — argv array, Finder-safe PATH, and a neutral cwd so a stray compose file
 *  in the app's own cwd can never be picked up by `docker compose -p …`. */
export function nodeDocker(args: string[], timeoutMs = 0): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      'docker',
      args,
      { cwd: os.tmpdir(), encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: timeoutMs, killSignal: 'SIGKILL', env: { ...process.env, PATH: dockerPath() } },
      (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve({ stdout }))
    )
  })
}

/** A host tool (`orcha`, `git`) in `cwd` — argv array, never a shell. */
export function nodeRun(env: NodeJS.ProcessEnv): (cmd: string, args: string[], cwd: string) => Promise<{ stdout: string }> {
  return (cmd, args, cwd) =>
    new Promise((resolve, reject) => {
      // `orcha` resolves like everywhere else in the app: bundled runtime first (GH #258 D3).
      execFile(cmd === 'orcha' ? orchaBin() : cmd, args, { cwd, env, encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: 180_000, killSignal: 'SIGKILL' }, (err, stdout, stderr) =>
        err ? reject(Object.assign(err, { stderr })) : resolve({ stdout })
      )
    })
}

export const nodeRemoveFs: RemoveFs = {
  readText: (p) => {
    try {
      return readFileSync(p, 'utf8')
    } catch {
      return null
    }
  },
  exists: (p) => existsSync(p),
  listDir: (p) => {
    try {
      return readdirSync(p)
    } catch {
      return null
    }
  },
  writeText: (p, text) => {
    const tmp = `${p}.${process.pid}.tmp`
    writeFileSync(tmp, text)
    renameSync(tmp, p)
  },
  rmrf: (p) => rmSync(p, { recursive: true, force: true }),
  rmFile: (p) => rmSync(p, { force: true }),
  rmdirIfEmpty: (p) => {
    try {
      if (readdirSync(p).length === 0) rmdirSync(p)
    } catch {
      // missing / not empty / not a dir
    }
  }
}

// ---- kept-data ledger ---------------------------------------------------------------------

export const KEPT_FILE = 'kept-data.json'

interface Ledger {
  version: 1
  projects: Record<string, { folder: string; removedAt: string }>
}

export function readKeptLedger(userDataDir: string): Ledger['projects'] {
  try {
    const raw = JSON.parse(readFileSync(path.join(userDataDir, KEPT_FILE), 'utf8')) as Partial<Ledger>
    const out: Ledger['projects'] = {}
    for (const [k, v] of Object.entries(raw.projects ?? {})) {
      if (SAFE_PROJECT.test(k) && v && typeof v.folder === 'string' && typeof v.removedAt === 'string') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

function writeLedger(userDataDir: string, projects: Ledger['projects']): void {
  mkdirSync(userDataDir, { recursive: true })
  const file = path.join(userDataDir, KEPT_FILE)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ version: 1, projects } satisfies Ledger, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, file)
}

export function recordKept(userDataDir: string, project: string, folder: string, now = new Date()): void {
  writeLedger(userDataDir, { ...readKeptLedger(userDataDir), [project]: { folder, removedAt: now.toISOString() } })
}

export function dropKept(userDataDir: string, project: string): void {
  const all = readKeptLedger(userDataDir)
  if (!(project in all)) return
  delete all[project]
  writeLedger(userDataDir, all)
}

/** The ledger with whether each folder still holds its project. */
export function keptStatus(userDataDir: string, fs: RemoveFs = nodeRemoveFs): Record<string, KeptData> {
  const out: Record<string, KeptData> = {}
  for (const [project, { folder }] of Object.entries(readKeptLedger(userDataDir))) {
    const present = folderBelongsTo(
      project,
      fs.readText(path.join(folder, '.orcha', 'docker-compose.yml')),
      fs.readText(path.join(folder, '.claude', 'orcha.json'))
    )
    out[project] = { folder, present }
  }
  return out
}
