import { describe, it, expect, vi } from 'vitest'
import { hostToolPath, workerStartResult, startHostWorker, type HostWorkerDeps } from './hostWorker'

describe('hostToolPath', () => {
  it('includes brew, pipx, npm-global and Claude Code locations, de-duped', () => {
    const p = hostToolPath({ PATH: '/usr/bin' }, '/Users/x').split(':')
    expect(p).toContain('/Users/x/.local/bin') // pipx (orcha)
    expect(p).toContain('/Users/x/.claude/local') // Claude Code native installer
    expect(p).toContain('/opt/homebrew/bin')
    expect(p).toContain('/usr/bin') // preserves the inherited PATH
    expect(new Set(p).size).toBe(p.length) // no duplicates
  })
})

describe('workerStartResult (pure messaging)', () => {
  it('orcha CLI missing → not started, points at installing the helper', () => {
    const r = workerStartResult({ orchaFound: false, claudeFound: false })
    expect(r.started).toBe(false)
    expect(r.reason).toMatch(/isn’t installed on this Mac/)
  })

  it('orcha up failed → not started, surfaces the (tail of the) error', () => {
    const r = workerStartResult({ orchaFound: true, claudeFound: true, upError: 'boom: docker not running' })
    expect(r.started).toBe(false)
    expect(r.reason).toMatch(/Couldn’t start the agent worker/)
    expect(r.reason).toMatch(/docker not running/)
  })

  it('worker up but Claude Code missing → started WITH a caveat warning', () => {
    const r = workerStartResult({ orchaFound: true, claudeFound: false })
    expect(r.started).toBe(true)
    expect(r.reason).toMatch(/Claude Code isn’t installed/)
  })

  it('everything present → started, no warning', () => {
    expect(workerStartResult({ orchaFound: true, claudeFound: true })).toEqual({ started: true })
  })
})

describe('startHostWorker', () => {
  const deps = (over: Partial<HostWorkerDeps> = {}): HostWorkerDeps => ({
    which: vi.fn(async (cmd: string) => (cmd === 'orcha' || cmd === 'claude' ? `/bin/${cmd}` : null)),
    orchaUp: vi.fn(async () => undefined),
    pathEnv: '/stub/path',
    ...over
  })

  it('starts the worker when orcha + claude are present', async () => {
    const d = deps()
    const r = await startHostWorker('/proj', d)
    expect(r).toEqual({ started: true })
    expect(d.orchaUp).toHaveBeenCalledWith('/proj', '/stub/path')
  })

  it('does not run orcha up when the CLI is missing', async () => {
    const d = deps({ which: vi.fn(async () => null) })
    const r = await startHostWorker('/proj', d)
    expect(r.started).toBe(false)
    expect(d.orchaUp).not.toHaveBeenCalled()
  })

  it('maps an orcha up failure to a not-started reason', async () => {
    const d = deps({ orchaUp: vi.fn(async () => { throw Object.assign(new Error('x'), { stderr: 'compose 125' }) }) })
    const r = await startHostWorker('/proj', d)
    expect(r.started).toBe(false)
    expect(r.reason).toMatch(/compose 125/)
  })

  it('reports started-with-caveat when claude is absent', async () => {
    const d = deps({ which: vi.fn(async (cmd: string) => (cmd === 'orcha' ? '/bin/orcha' : null)) })
    const r = await startHostWorker('/proj', d)
    expect(r.started).toBe(true)
    expect(r.reason).toMatch(/Claude Code/)
  })
})
