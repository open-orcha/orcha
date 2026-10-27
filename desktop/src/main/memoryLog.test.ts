import { describe, it, expect, vi } from 'vitest'
import path from 'node:path'
import {
  appendSample,
  memorySample,
  startMemoryLog,
  MEMORY_LOG_FILE,
  MEMORY_FIRST_SAMPLE_MS,
  MEMORY_LOG_OLD,
  MEMORY_SAMPLE_MS,
  type MemoryLogFs,
  type ProcessMetricLike
} from './memoryLog'

const kb = (mb: number): { workingSetSize: number; peakWorkingSetSize: number } => ({ workingSetSize: mb * 1024, peakWorkingSetSize: mb * 1024 * 2 })

const METRICS: ProcessMetricLike[] = [
  { pid: 1, type: 'Browser', memory: kb(369) },
  { pid: 2, type: 'GPU', memory: kb(297) },
  { pid: 3, type: 'Tab', memory: kb(7042) },
  { pid: 4, type: 'Tab', memory: kb(223) },
  { pid: 5, type: 'Tab', memory: kb(121) },
  { pid: 6, type: 'Utility', serviceName: 'network.mojom.NetworkService', memory: kb(40) },
  { pid: 7, type: 'Tab', memory: kb(80) }
]

/** In-memory fs: file name → contents. */
function memFs(files: Record<string, string> = {}): MemoryLogFs & { files: Record<string, string> } {
  return {
    files,
    mkdir: async () => undefined,
    stat: async (f) => {
      if (!(f in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return { size: Buffer.byteLength(files[f]) }
    },
    rename: async (from, to) => {
      files[to] = files[from]
      delete files[from]
    },
    appendFile: async (f, data) => {
      files[f] = (files[f] ?? '') + data
    }
  }
}

describe('memorySample', () => {
  it('names each process by the window it renders, else by its Electron type, largest first', () => {
    const s = memorySample(
      METRICS,
      [
        { pid: 3, role: 'manager' },
        { pid: 4, role: 'tray' },
        { pid: 5, role: 'portal:fleet-mate' }
      ],
      new Date('2026-10-27T16:00:00Z')
    )
    expect(s.at).toBe('2026-10-27T16:00:00.000Z')
    expect(s.procs.map((p) => p.role)).toEqual(['manager', 'main', 'gpu', 'tray', 'portal:fleet-mate', 'renderer', 'utility:network.mojom.NetworkService'])
    expect(s.procs[0]).toEqual({ role: 'manager', pid: 3, mb: 7042, peakMB: 14084 })
    expect(s.totalMB).toBe(369 + 297 + 7042 + 223 + 121 + 40 + 80)
  })

  it('joins windows that share one renderer and skips unknown pids', () => {
    const s = memorySample(
      METRICS,
      [
        { pid: 4, role: 'tray' },
        { pid: 4, role: 'tray' },
        { pid: 0, role: 'manager' }
      ],
      new Date(0)
    )
    expect(s.procs.find((p) => p.pid === 4)?.role).toBe('tray+tray')
    expect(s.procs.find((p) => p.pid === 3)?.role).toBe('renderer')
  })
})

describe('appendSample', () => {
  const dir = '/logs'
  const file = path.join(dir, MEMORY_LOG_FILE)
  const old = path.join(dir, MEMORY_LOG_OLD)
  const sample = memorySample(METRICS, [], new Date(0))

  it('appends one JSON line per sample', async () => {
    const fs = memFs()
    await appendSample(fs, dir, sample)
    await appendSample(fs, dir, sample)
    const lines = fs.files[file].trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0])).toEqual(sample)
  })

  it('rolls a full file over to memory.1.jsonl, keeping one old file', async () => {
    const fs = memFs({ [file]: 'x'.repeat(100), [old]: 'older' })
    await appendSample(fs, dir, sample, 100)
    expect(fs.files[old]).toBe('x'.repeat(100))
    expect(fs.files[file]).toBe(`${JSON.stringify(sample)}\n`)
  })
})

describe('startMemoryLog', () => {
  it('samples once the windows are up, then every MEMORY_SAMPLE_MS, and stop() clears the timer', async () => {
    const fs = memFs()
    const timers: Array<{ fn: () => void; ms: number }> = []
    const clearTimer = vi.fn()
    const stop = startMemoryLog({
      dir: '/logs',
      fs,
      metrics: () => METRICS,
      windows: () => [{ pid: 3, role: 'manager' }],
      now: () => new Date(0),
      setTimer: (fn, ms) => timers.push({ fn, ms }) - 1,
      clearTimer
    })
    const file = path.join('/logs', MEMORY_LOG_FILE)
    // nothing at launch: the renderers don't exist yet
    expect(timers.map((t) => t.ms)).toEqual([MEMORY_FIRST_SAMPLE_MS])
    expect(fs.files[file]).toBeUndefined()
    timers[0].fn()
    timers[1].fn()
    expect(timers.map((t) => t.ms)).toEqual([MEMORY_FIRST_SAMPLE_MS, MEMORY_SAMPLE_MS, MEMORY_SAMPLE_MS])
    await vi.waitFor(() => expect(fs.files[file]?.trimEnd().split('\n')).toHaveLength(2))
    expect(JSON.parse(fs.files[file].split('\n')[0]).procs[0].role).toBe('manager')
    stop()
    expect(clearTimer).toHaveBeenCalledWith(2)
  })

  it('warns once about a failing disk and never throws', async () => {
    const warn = vi.fn()
    const fs: MemoryLogFs = { ...memFs(), appendFile: async () => Promise.reject(new Error('EACCES')) }
    const timers: Array<() => void> = []
    startMemoryLog({
      dir: '/logs',
      fs,
      metrics: () => METRICS,
      windows: () => [],
      now: () => new Date(0),
      setTimer: (fn) => timers.push(fn),
      clearTimer: () => {},
      warn
    })
    timers[0]()
    timers[1]()
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
    expect(warn.mock.calls[0][0]).toContain('EACCES')
  })
})
