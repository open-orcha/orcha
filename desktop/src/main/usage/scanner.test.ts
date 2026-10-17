process.env.TZ = 'UTC'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { appendFileSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { emptyCache, parseCache, UsageScanner, CACHE_VERSION, type LogRoot } from './scanner'
import { summarize } from './summarize'

const FIX = path.join(__dirname, '__fixtures__')
let tmp: string
let roots: LogRoot[]
let claudeFile: string

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'usage-scan-'))
  cpSync(FIX, tmp, { recursive: true })
  roots = [
    { provider: 'claude', dir: path.join(tmp, 'claude') },
    { provider: 'codex', dir: path.join(tmp, 'codex') }
  ]
  const dir = path.join(tmp, 'claude', '-Users-dev-proj')
  claudeFile = path.join(dir, readdirSync(dir)[0])
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const line = (o: unknown): string => JSON.stringify(o) + '\n'
const assistant = (id: string, ts: string, output: number) =>
  line({
    type: 'assistant',
    sessionId: 'sess-2',
    requestId: `req_${id}`,
    timestamp: ts,
    message: { id: `msg_${id}`, model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
  })

describe('UsageScanner (incremental cache)', () => {
  it('scans both providers and summarises', async () => {
    const s = new UsageScanner(null)
    const st = await s.scan(roots)
    expect(st.filesParsed).toBe(2)
    const a = s.aggregate()
    expect(a.claude.sessions).toBe(1)
    expect(a.codex.codexLimits?.plan).toBe('plus')
    const claude = summarize(a.claude)!
    expect(claude.events).toBe(3)
    expect(claude.turns).toBe(2)
    expect(claude.costUsd).toBeCloseTo(0.019548 + 0.00805 + 0.002, 9)
  })

  it('skips unchanged files entirely on the next scan', async () => {
    const s = new UsageScanner(null)
    await s.scan(roots)
    const st = await s.scan(roots)
    expect(st.filesParsed).toBe(0)
    expect(st.bytesRead).toBe(0)
  })

  it('resumes an appended file from its saved offset (only new bytes are read)', async () => {
    const s = new UsageScanner(null)
    await s.scan(roots)
    const before = readFileSync(claudeFile).length
    const extra = assistant('NEW', '2026-09-30T12:00:00.000Z', 50)
    appendFileSync(claudeFile, extra)
    const st = await s.scan(roots)
    expect(st.filesParsed).toBe(1)
    expect(st.bytesRead).toBe(Buffer.byteLength(extra))
    expect(readFileSync(claudeFile).length).toBe(before + st.bytesRead)
    expect(s.aggregate().claude.agg.b['2026-09-30\tclaude-sonnet-5-5']).toEqual([10, 50, 0, 0, 0, 0, 1])
  })

  it('a partial trailing line is left for the next scan, then counted once', async () => {
    const s = new UsageScanner(null)
    await s.scan(roots)
    const full = assistant('P', '2026-09-30T13:00:00.000Z', 7)
    appendFileSync(claudeFile, full.slice(0, 40))
    await s.scan(roots)
    expect(s.aggregate().claude.agg.b['2026-09-30\tclaude-sonnet-5-5']).toBeUndefined()
    appendFileSync(claudeFile, full.slice(40))
    await s.scan(roots)
    expect(s.aggregate().claude.agg.b['2026-09-30\tclaude-sonnet-5-5']).toEqual([10, 7, 0, 0, 0, 0, 1])
  })

  it('a later streamed copy arriving in the NEXT scan still max-merges', async () => {
    const s = new UsageScanner(null)
    await s.scan(roots)
    appendFileSync(claudeFile, assistant('S', '2026-09-30T14:00:00.000Z', 10))
    await s.scan(roots)
    appendFileSync(claudeFile, assistant('S', '2026-09-30T14:00:01.000Z', 90))
    await s.scan(roots)
    expect(s.aggregate().claude.agg.b['2026-09-30\tclaude-sonnet-5-5']).toEqual([10, 90, 0, 0, 0, 0, 1])
  })

  it('a rewritten file is re-parsed from scratch (its old keys released)', async () => {
    const s = new UsageScanner(null)
    await s.scan(roots)
    writeFileSync(claudeFile, assistant('R', '2026-09-30T15:00:00.000Z', 5))
    await s.scan(roots)
    const b = s.aggregate().claude.agg.b
    expect(Object.keys(b)).toEqual(['2026-09-30\tclaude-sonnet-5-5'])
  })

  it('a copied transcript does not double count; a deleted one keeps its history', async () => {
    const s = new UsageScanner(null)
    await s.scan(roots)
    cpSync(claudeFile, path.join(path.dirname(claudeFile), 'copy.jsonl'))
    await s.scan(roots)
    expect(summarize(s.aggregate().claude)!.events).toBe(3)
    rmSync(claudeFile)
    rmSync(path.join(path.dirname(claudeFile), 'copy.jsonl'))
    await s.scan(roots)
    expect(summarize(s.aggregate().claude)!.events).toBe(3)
  })

  it('round-trips through the persisted cache (a new scanner resumes without re-reading)', async () => {
    const s1 = new UsageScanner(null)
    await s1.scan(roots)
    const saved = JSON.parse(JSON.stringify(s1.snapshotCache()))
    const s2 = new UsageScanner(parseCache(saved))
    const st = await s2.scan(roots)
    expect(st.filesParsed).toBe(0)
    expect(summarize(s2.aggregate().claude)).toEqual(summarize(s1.aggregate().claude))
  })

  it('discards a cache of another version', () => {
    expect(parseCache({ version: CACHE_VERSION + 1, files: { x: {} } })).toEqual(emptyCache())
    expect(parseCache(null)).toEqual(emptyCache())
  })

  it('never writes into the log roots', async () => {
    const list = (d: string): string[] => readdirSync(d, { recursive: true }) as string[]
    const before = list(tmp).sort()
    const s = new UsageScanner(null)
    await s.scan(roots)
    expect(list(tmp).sort()).toEqual(before)
  })
})
