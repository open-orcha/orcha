/** Memory log (GH #347): a minute after launch, then every MEMORY_SAMPLE_MS, main appends one JSON line with the resident
 *  memory of each of the app's processes to <userData>/logs/memory.jsonl. A window that grows
 *  slowly then shows up as a curve in that file, instead of being pieced together from macOS
 *  memory-pressure reports. Local only: nothing here is sent anywhere.
 *
 *  Bounded: once the file reaches MEMORY_LOG_MAX it is renamed to memory.1.jsonl (replacing the
 *  previous one) and a new file starts, so at most 2 × MEMORY_LOG_MAX stays on disk (about two
 *  weeks of samples each). Electron-free: index.ts injects app.getAppMetrics() and which
 *  window each renderer pid belongs to. */
import path from 'node:path'

export const MEMORY_SAMPLE_MS = 10 * 60_000
/** The first sample waits for the windows' renderers to start: it is the fresh baseline. */
export const MEMORY_FIRST_SAMPLE_MS = 60_000
export const MEMORY_LOG_MAX = 1024 * 1024
export const MEMORY_LOG_FILE = 'memory.jsonl'
export const MEMORY_LOG_OLD = 'memory.1.jsonl'

/** The fields of Electron's ProcessMetric this log reads (memory sizes are in KB). */
export interface ProcessMetricLike {
  pid: number
  type: string
  name?: string
  serviceName?: string
  memory: { workingSetSize: number; peakWorkingSetSize: number }
}

/** One line of memory.jsonl. `mb` is resident memory (compressed and swapped pages are not
 *  counted, so it is a lower bound on the footprint); `peakMB` is the process's peak. */
export interface MemorySample {
  at: string
  totalMB: number
  procs: Array<{ role: string; pid: number; mb: number; peakMB: number }>
}

const mb = (kb: number): number => Math.round(kb / 1024)

/** A process's role: the window(s) it renders (`manager`, `tray`, `portal:<project>`), else
 *  what Electron calls it (`main`, `gpu`, `utility:<service>`, `renderer`). */
function roleOf(m: ProcessMetricLike, windows: ReadonlyMap<number, string[]>): string {
  const named = windows.get(m.pid)
  if (named) return named.join('+')
  if (m.type === 'Browser') return 'main'
  if (m.type === 'GPU') return 'gpu'
  if (m.type === 'Tab') return 'renderer'
  const service = m.serviceName ?? m.name
  return service ? `${m.type.toLowerCase()}:${service}` : m.type.toLowerCase()
}

/** Build one sample (pure). `windows` lists each window's renderer pid; two windows sharing a
 *  renderer are joined (`tray+tray`). Largest process first. */
export function memorySample(
  metrics: readonly ProcessMetricLike[],
  windows: ReadonlyArray<{ pid: number; role: string }>,
  now: Date
): MemorySample {
  const byPid = new Map<number, string[]>()
  for (const w of windows) {
    if (w.pid <= 0) continue
    const roles = byPid.get(w.pid)
    if (roles) roles.push(w.role)
    else byPid.set(w.pid, [w.role])
  }
  const procs = metrics
    .map((m) => ({ role: roleOf(m, byPid), pid: m.pid, mb: mb(m.memory.workingSetSize), peakMB: mb(m.memory.peakWorkingSetSize) }))
    .sort((a, b) => b.mb - a.mb)
  return { at: now.toISOString(), totalMB: procs.reduce((n, p) => n + p.mb, 0), procs }
}

export interface MemoryLogFs {
  mkdir(dir: string, opts: { recursive: boolean }): Promise<unknown>
  stat(file: string): Promise<{ size: number }>
  rename(from: string, to: string): Promise<unknown>
  appendFile(file: string, data: string): Promise<unknown>
}

/** Append one sample to <dir>/memory.jsonl, rolling the file over first once it is full. */
export async function appendSample(fs: MemoryLogFs, dir: string, sample: MemorySample, max = MEMORY_LOG_MAX): Promise<void> {
  const file = path.join(dir, MEMORY_LOG_FILE)
  await fs.mkdir(dir, { recursive: true })
  const size = await fs.stat(file).then(
    (s) => s.size,
    () => 0
  )
  if (size >= max) await fs.rename(file, path.join(dir, MEMORY_LOG_OLD))
  await fs.appendFile(file, `${JSON.stringify(sample)}\n`)
}

export interface MemoryLogDeps {
  dir: string
  fs: MemoryLogFs
  metrics(): readonly ProcessMetricLike[]
  windows(): ReadonlyArray<{ pid: number; role: string }>
  now(): Date
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  warn?(msg: string): void
}

/** Sample after MEMORY_FIRST_SAMPLE_MS, then every MEMORY_SAMPLE_MS; returns stop(). A failed
 *  write is warned about once and never thrown: the log is a diagnostic, it must not disturb
 *  the app. */
export function startMemoryLog(deps: MemoryLogDeps): () => void {
  let warned = false
  let timer: unknown = null
  const sample = (): void => {
    let s: MemorySample
    try {
      s = memorySample(deps.metrics(), deps.windows(), deps.now())
    } catch {
      return
    }
    void appendSample(deps.fs, deps.dir, s).catch((err: unknown) => {
      if (warned) return
      warned = true
      deps.warn?.(`memory log: ${err instanceof Error ? err.message : String(err)}`)
    })
  }
  const next = (ms: number): void => {
    timer = deps.setTimer(() => {
      sample()
      next(MEMORY_SAMPLE_MS)
    }, ms)
  }
  next(MEMORY_FIRST_SAMPLE_MS)
  return () => {
    if (timer !== null) deps.clearTimer(timer)
    timer = null
  }
}
