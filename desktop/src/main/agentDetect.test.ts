import { describe, it, expect, vi } from 'vitest'
import { AgentDetector, parsePathOutput, pathProbeArgs, PATH_MARKER, resolveBins } from './agentDetect'

describe('pathProbeArgs', () => {
  it('prints PATH from a login+interactive shell (fish joins its list)', () => {
    expect(pathProbeArgs('/bin/zsh').slice(0, 3)).toEqual(['-l', '-i', '-c'])
    expect(pathProbeArgs('/bin/zsh')[3]).toContain('"$PATH"')
    expect(pathProbeArgs('/bin/sh').slice(0, 2)).toEqual(['-l', '-c'])
    expect(pathProbeArgs('/opt/homebrew/bin/fish')[3]).toContain('string join : $PATH')
    // the script never names an agent binary — nothing but the shell runs
    expect(pathProbeArgs('/bin/zsh').join(' ')).not.toMatch(/claude|codex/)
  })
})

describe('parsePathOutput', () => {
  it('takes the marker line (ignoring rc noise) and keeps absolute unique dirs', () => {
    const out = `Welcome banner\n${PATH_MARKER}/opt/homebrew/bin:/usr/bin:relative:/usr/bin::/Users/me/.local/bin\nbye\n`
    expect(parsePathOutput(out)).toEqual(['/opt/homebrew/bin', '/usr/bin', '/Users/me/.local/bin'])
  })
  it('no marker → null', () => {
    expect(parsePathOutput('zsh: no job control')).toBeNull()
  })
})

describe('resolveBins', () => {
  it('first PATH hit wins, like command -v; only executables count', () => {
    const exec = new Set(['/a/claude', '/b/claude', '/b/gemini', '/a/codex.txt'])
    const found = resolveBins(['/a', '/b'], (p) => exec.has(p))
    expect(found).toEqual({ claude: '/a/claude', gemini: '/b/gemini' })
  })
})

describe('AgentDetector (mocked shell)', () => {
  const mk = (run: (f: string, a: string[], t: number) => Promise<string>, execs: string[]) =>
    new AgentDetector({ shell: '/bin/zsh', run: vi.fn(run), isExecutable: (p) => execs.includes(p), now: () => 1000 })

  it('detects via one bounded run of the login shell and caches the result', async () => {
    const run = vi.fn(async (_f: string, _a: string[], _t: number) => `${PATH_MARKER}/opt/homebrew/bin:/usr/bin\n`)
    const d = new AgentDetector({ shell: '/bin/zsh', run, isExecutable: (p) => p === '/opt/homebrew/bin/claude', now: () => 1000 })
    expect(d.current().status).toBe('pending')
    const r = await d.get()
    expect(r).toEqual({ status: 'ready', at: 1000, paths: { claude: '/opt/homebrew/bin/claude' } })
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][0]).toBe('/bin/zsh')
    expect(run.mock.calls[0][2]).toBeLessThanOrEqual(10_000)
    await d.get()
    expect(run).toHaveBeenCalledTimes(1) // cached
    expect(d.pathFor('claude')).toBe('/opt/homebrew/bin/claude')
    expect(d.pathFor('codex')).toBeNull()
  })

  it('refresh re-runs on demand and coalesces concurrent calls', async () => {
    let resolve!: (s: string) => void
    const run = vi.fn(() => new Promise<string>((r) => (resolve = r)))
    const d = new AgentDetector({ shell: '/bin/zsh', run, isExecutable: () => false, now: () => 1 })
    const a = d.refresh()
    const b = d.refresh()
    await vi.waitFor(() => expect(run).toHaveBeenCalled())
    resolve(`${PATH_MARKER}/usr/bin`)
    expect(await a).toBe(await b)
    expect(run).toHaveBeenCalledTimes(1)
    const c = d.refresh()
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    resolve(`${PATH_MARKER}/usr/bin`)
    await c
  })

  it('a failing / timed-out shell reports error first, and keeps an earlier good result later', async () => {
    let fail = true
    const d = mk(async () => {
      if (fail) throw new Error('timeout')
      return `${PATH_MARKER}/bin`
    }, ['/bin/codex'])
    expect((await d.refresh()).status).toBe('error')
    fail = false
    expect((await d.refresh()).paths).toEqual({ codex: '/bin/codex' })
    fail = true
    const kept = await d.refresh()
    expect(kept.status).toBe('ready')
    expect(kept.paths).toEqual({ codex: '/bin/codex' })
  })

  it('a synchronous throw from run still resolves and leaves detection retryable', async () => {
    const d = new AgentDetector({
      shell: '/bin/zsh',
      run: () => {
        throw new Error('spawn EACCES')
      },
      isExecutable: () => false,
      now: () => 1
    })
    expect((await d.refresh()).status).toBe('error')
    expect((await d.refresh()).status).toBe('error')
  })
})
