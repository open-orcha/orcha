/** Incremental, cached scan of the agents' local session logs (READ-ONLY: files are only
 *  ever opened with fs `open(…, 'r')` / `stat` / `readdir`; nothing under ~/.claude or
 *  ~/.codex is written, moved or deleted).
 *
 *  Per file the cache keeps size, mtime, inode, a hash of its first 4 KiB, the byte offset
 *  parsed so far, the parser state and the file's aggregate. On the next scan:
 *    - unchanged size + mtime            → skipped (no read at all);
 *    - grown, same inode + head hash     → resumed from the saved offset (appends only);
 *    - anything else (rewritten/shrunk)  → the file's contribution is dropped and re-parsed.
 *  A file that disappears keeps its aggregate: Claude Code prunes old transcripts, and the
 *  history you already had should not vanish with them.
 *
 *  Adapted from Orca's usage scan cache (github.com/stablyai/orca, MIT © Lovecast Inc.). */

import { createHash } from 'node:crypto'
import { promises as fsp, type Dirent } from 'node:fs'
import path from 'node:path'
import {
  claudeLine,
  codexLine,
  emptyAgg,
  emptyClaudeState,
  emptyCodexState,
  VEC_LEN,
  type ClaudeState,
  type CodexLimitsRecord,
  type CodexState,
  type FileAgg,
  type SeenKeys
} from './logParsers'

export type LogProvider = 'claude' | 'codex'

export interface LogRoot {
  provider: LogProvider
  dir: string
}

export interface FileEntry {
  provider: LogProvider
  size: number
  mtimeMs: number
  ino: number
  head: string
  offset: number
  agg: FileAgg
  claude?: ClaudeState
  codex?: CodexState
  /** Dedup keys this file claimed (released if the file is re-parsed from scratch). */
  keys: string[]
  /** The file was not found on the last scan (kept for history). */
  gone?: boolean
}

export const CACHE_VERSION = 3

export interface ScanCache {
  version: number
  files: Record<string, FileEntry>
}

export function emptyCache(): ScanCache {
  return { version: CACHE_VERSION, files: {} }
}

/** Accept a cache read from disk only when it is this version (else start over). */
export function parseCache(raw: unknown): ScanCache {
  if (!raw || typeof raw !== 'object') return emptyCache()
  const c = raw as Partial<ScanCache>
  if (c.version !== CACHE_VERSION || !c.files || typeof c.files !== 'object') return emptyCache()
  return { version: CACHE_VERSION, files: c.files }
}

/** Merged per-provider aggregate after a scan. */
export interface ProviderAgg {
  agg: FileAgg
  /** Distinct sessions (union of per-file session ids). */
  sessions: number
  files: number
  /** Codex only: the newest plan rate-limit record found in any log. */
  codexLimits: CodexLimitsRecord | null
}

export interface ScanStats {
  filesSeen: number
  filesParsed: number
  bytesRead: number
  ms: number
}

const CHUNK = 4 * 1024 * 1024
const HEAD_BYTES = 4096
const NL = 0x0a

class KeySet implements SeenKeys {
  private readonly set = new Set<string>()
  has(k: string): boolean {
    return this.set.has(k)
  }
  add(k: string): void {
    this.set.add(k)
  }
  delete(k: string): void {
    this.set.delete(k)
  }
}

/** Recursively list `*.jsonl` under `dir` (symlinked dirs are not followed). */
async function listJsonl(dir: string, out: string[], depth = 0): Promise<void> {
  if (depth > 8) return
  let entries: Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) await listJsonl(p, out, depth + 1)
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p)
  }
}

async function headHash(fh: fsp.FileHandle, size: number): Promise<string> {
  const n = Math.min(HEAD_BYTES, size)
  const buf = Buffer.alloc(n)
  if (n > 0) await fh.read(buf, 0, n, 0)
  return createHash('sha1').update(buf).digest('hex')
}

export class UsageScanner {
  private cache: ScanCache
  private readonly seen = new KeySet()

  constructor(cache: ScanCache | null) {
    this.cache = cache ?? emptyCache()
    for (const f of Object.values(this.cache.files)) for (const k of f.keys) this.seen.add(k)
  }

  snapshotCache(): ScanCache {
    return this.cache
  }

  /** Scan every root, updating the cache. `yieldEvery` lets a caller breathe between files. */
  async scan(roots: readonly LogRoot[], onFile?: () => Promise<void> | void): Promise<ScanStats> {
    const t0 = Date.now()
    const stats: ScanStats = { filesSeen: 0, filesParsed: 0, bytesRead: 0, ms: 0 }
    const present = new Set<string>()
    for (const root of roots) {
      const files: string[] = []
      await listJsonl(root.dir, files)
      // Oldest first, so cross-file dedup lets the ORIGINAL session claim a copied response.
      const withTimes = await Promise.all(
        files.map(async (f) => {
          try {
            const st = await fsp.stat(f)
            return { f, st }
          } catch {
            return null
          }
        })
      )
      const ordered = withTimes.filter((x): x is NonNullable<typeof x> => x !== null).sort((a, b) => a.st.mtimeMs - b.st.mtimeMs)
      for (const { f, st } of ordered) {
        present.add(f)
        stats.filesSeen++
        const prev = this.cache.files[f]
        if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs && prev.provider === root.provider) {
          prev.gone = false
          continue
        }
        const read = await this.parseFile(f, root.provider, st.size, st.mtimeMs, st.ino, prev)
        stats.bytesRead += read
        stats.filesParsed++
        if (onFile) await onFile()
      }
    }
    for (const [f, e] of Object.entries(this.cache.files)) if (!present.has(f)) e.gone = true
    stats.ms = Date.now() - t0
    return stats
  }

  private async parseFile(file: string, provider: LogProvider, size: number, mtimeMs: number, ino: number, prev: FileEntry | undefined): Promise<number> {
    let fh: fsp.FileHandle
    try {
      fh = await fsp.open(file, 'r')
    } catch {
      return 0
    }
    try {
      const head = await headHash(fh, size)
      let entry: FileEntry
      if (prev && prev.provider === provider && prev.ino === ino && prev.head === head && size >= prev.offset) {
        entry = prev
      } else {
        if (prev) for (const k of prev.keys) this.seen.delete(k)
        entry = {
          provider,
          size: 0,
          mtimeMs: 0,
          ino,
          head,
          offset: 0,
          agg: emptyAgg(),
          keys: [],
          ...(provider === 'claude' ? { claude: emptyClaudeState() } : { codex: emptyCodexState() })
        }
      }
      let offset = entry.offset
      let bytes = 0
      let carry: Buffer | null = null
      const buf = Buffer.alloc(CHUNK)
      while (offset + (carry?.length ?? 0) < size) {
        const pos = offset + (carry?.length ?? 0)
        const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, size - pos), pos)
        if (bytesRead <= 0) break
        bytes += bytesRead
        const chunk: Buffer = carry ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : Buffer.from(buf.subarray(0, bytesRead))
        const lastNl = chunk.lastIndexOf(NL)
        if (lastNl < 0) {
          carry = chunk
          continue
        }
        const text = chunk.toString('utf8', 0, lastNl)
        let start = 0
        while (start <= text.length) {
          const nl = text.indexOf('\n', start)
          const line = nl < 0 ? text.slice(start) : text.slice(start, nl)
          if (line.length > 0) this.feed(entry, line)
          if (nl < 0) break
          start = nl + 1
        }
        offset += lastNl + 1
        carry = lastNl + 1 < chunk.length ? chunk.subarray(lastNl + 1) : null
      }
      // A trailing line without "\n" is still being written — it is read next time.
      entry.offset = offset
      entry.size = size
      entry.mtimeMs = mtimeMs
      entry.gone = false
      this.cache.files[file] = entry
      return bytes
    } finally {
      await fh.close()
    }
  }

  private feed(entry: FileEntry, line: string): void {
    if (entry.provider === 'claude') claudeLine(line, entry.agg, (entry.claude ??= emptyClaudeState()), this.seen, entry.keys)
    else codexLine(line, entry.agg, (entry.codex ??= emptyCodexState()), this.seen, entry.keys)
  }

  /** Merge every cached file into one aggregate per provider. */
  aggregate(): Record<LogProvider, ProviderAgg> {
    const out = {} as Record<LogProvider, ProviderAgg>
    const sessions: Record<string, Set<string>> = {}
    for (const e of Object.values(this.cache.files)) {
      const p = (out[e.provider] ??= { agg: emptyAgg(), sessions: 0, files: 0, codexLimits: null })
      const s = (sessions[e.provider] ??= new Set())
      p.files++
      const a = e.agg
      for (const [k, v] of Object.entries(a.b)) {
        const cur = p.agg.b[k] ?? (p.agg.b[k] = new Array<number>(VEC_LEN).fill(0))
        for (let i = 0; i < VEC_LEN; i++) cur[i] += v[i] ?? 0
      }
      p.agg.turns += a.turns
      p.agg.prs += a.prs
      p.agg.activeMs += a.activeMs
      if (a.first !== null) p.agg.first = p.agg.first === null ? a.first : Math.min(p.agg.first, a.first)
      if (a.last !== null) p.agg.last = p.agg.last === null ? a.last : Math.max(p.agg.last, a.last)
      // A file that produced usage but logged no session id is still one session.
      if (a.sessions.length > 0) for (const id of a.sessions) s.add(`${e.provider}:${id}`)
      else if (Object.keys(a.b).length > 0) s.add(`file:${e.ino}:${e.head}`)
      const lim = e.codex?.limits
      if (lim && (!p.codexLimits || lim.at > p.codexLimits.at)) p.codexLimits = lim
    }
    for (const [prov, p] of Object.entries(out)) p.sessions = sessions[prov]?.size ?? 0
    return out
  }
}
