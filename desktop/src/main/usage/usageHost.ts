/// <reference types="electron-vite/node" />
/** Electron-side wiring for the usage service: the scan worker thread, the Keychain read
 *  and the prefs file. Imported only by main/index.ts (the `?modulePath` import is an
 *  electron-vite build feature). */
import { Worker } from 'node:worker_threads'
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import scanWorkerPath from './scanWorker?modulePath'
import type { UsagePrefs } from '../../shared/usage'
import { claudeKeychainServices } from './limits'
import type { LogProvider, LogRoot, ProviderAgg } from './scanner'

export function usagePrefsPath(userData: string): string {
  return path.join(userData, 'usage.json')
}

export function readUsagePrefsFile(userData: string): unknown {
  try {
    return JSON.parse(readFileSync(usagePrefsPath(userData), 'utf8'))
  } catch {
    return null
  }
}

export function writeUsagePrefsFile(userData: string, prefs: UsagePrefs): void {
  try {
    mkdirSync(userData, { recursive: true })
    const file = usagePrefsPath(userData)
    writeFileSync(`${file}.tmp`, JSON.stringify(prefs, null, 2) + '\n', { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
  } catch {
    /* best-effort: in-memory prefs stay */
  }
}

/** One long-lived scan worker; requests are serialised by the service (one run at a time). */
export function createScanClient(cachePath: string): { scan(roots: LogRoot[]): Promise<Partial<Record<LogProvider, ProviderAgg>>>; stop(): void } {
  let worker: Worker | null = null
  let seq = 0
  const pending = new Map<number, { resolve(v: Partial<Record<LogProvider, ProviderAgg>>): void; reject(e: Error): void }>()
  const ensure = (): Worker => {
    if (worker) return worker
    const w = new Worker(scanWorkerPath)
    w.on('message', (m: { id: number; ok: boolean; aggs?: Partial<Record<LogProvider, ProviderAgg>>; error?: string; stats?: unknown }) => {
      const p = pending.get(m.id)
      if (!p) return
      pending.delete(m.id)
      if (m.ok && m.aggs) p.resolve(m.aggs)
      else p.reject(new Error(m.error ?? 'scan failed'))
    })
    const fail = (err: Error): void => {
      for (const p of pending.values()) p.reject(err)
      pending.clear()
      worker = null
    }
    w.on('error', fail)
    w.on('exit', (code) => fail(new Error(`scan worker exited (${code})`)))
    // The worker must never keep the app alive at quit.
    w.unref()
    worker = w
    return w
  }
  return {
    scan(roots) {
      const id = ++seq
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        ensure().postMessage({ id, cachePath, roots })
      })
    },
    stop() {
      void worker?.terminate()
      worker = null
    }
  }
}

function security(service: string, account: string | null): Promise<string | null> {
  const args = ['find-generic-password', '-s', service, ...(account ? ['-a', account] : []), '-w']
  return new Promise((resolve) => {
    execFile('/usr/bin/security', args, { timeout: 5000, maxBuffer: 256 * 1024 }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim() || null)
    })
  })
}

/** Claude Code's stored OAuth credentials (READ-ONLY): the Keychain item it created, then its
 *  `.credentials.json`. Returned to the caller only; never logged or written anywhere. */
export async function readClaudeCredentials(env: NodeJS.ProcessEnv, home: string): Promise<string | null> {
  const user = env.USER && /^[A-Za-z0-9._-]+$/.test(env.USER) ? env.USER : null
  if (process.platform === 'darwin') {
    for (const svc of claudeKeychainServices(env.CLAUDE_CONFIG_DIR)) {
      const hit = (await security(svc, user)) ?? (user ? await security(svc, null) : null)
      if (hit) return hit
    }
  }
  const dir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')
  try {
    return await readFile(path.join(dir, '.credentials.json'), 'utf8')
  } catch {
    return null
  }
}
