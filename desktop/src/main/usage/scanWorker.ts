/** Worker-thread entry for the usage scan: parsing gigabytes of JSONL must never run on the
 *  Electron main thread (it would stall every window and the tray). One scanner lives here
 *  for the app's lifetime; main posts `scan` and gets the merged aggregates back.
 *
 *  Writes ONLY its own cache file (<userData>/usage-cache.json, atomic tmp + rename). The
 *  log roots are read-only inputs. */
import { parentPort } from 'node:worker_threads'
import { readFile, rename, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { parseCache, UsageScanner, type LogRoot } from './scanner'

interface ScanRequest {
  id: number
  cachePath: string
  roots: LogRoot[]
}

let scanner: UsageScanner | null = null
let loadedFrom: string | null = null

async function load(cachePath: string): Promise<UsageScanner> {
  if (scanner && loadedFrom === cachePath) return scanner
  let raw: unknown = null
  try {
    raw = JSON.parse(await readFile(cachePath, 'utf8'))
  } catch {
    raw = null
  }
  scanner = new UsageScanner(parseCache(raw))
  loadedFrom = cachePath
  return scanner
}

async function save(cachePath: string, s: UsageScanner): Promise<void> {
  await mkdir(path.dirname(cachePath), { recursive: true })
  const tmp = `${cachePath}.tmp`
  await writeFile(tmp, JSON.stringify(s.snapshotCache()), { mode: 0o600 })
  await rename(tmp, cachePath)
}

parentPort?.on('message', (msg: ScanRequest) => {
  void (async () => {
    try {
      const s = await load(msg.cachePath)
      const stats = await s.scan(msg.roots)
      if (stats.filesParsed > 0) await save(msg.cachePath, s).catch(() => {})
      parentPort?.postMessage({ id: msg.id, ok: true, aggs: s.aggregate(), stats })
    } catch (err) {
      parentPort?.postMessage({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })()
})
