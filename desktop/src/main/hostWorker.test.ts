import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  checkWorkerReady,
  hostToolPath,
  resolveOrcha,
  runBounded,
  scrubWorkerEnv,
  workerStartResult,
  type WorkerReadyDeps
} from './hostWorker'

describe('scrubWorkerEnv', () => {
  it('deletes ANTHROPIC_API_KEY, ORCHA_LLM_API_KEY, and every CLAUDE_CODE_* key', () => {
    const env = {
      ANTHROPIC_API_KEY: 'sk-ant-shell-leftover',
      ORCHA_LLM_API_KEY: 'llm-key',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_SOMETHING_ELSE: 'x',
      PATH: '/usr/bin',
      HOME: '/Users/x'
    }
    const scrubbed = scrubWorkerEnv(env)
    expect(scrubbed.ANTHROPIC_API_KEY).toBeUndefined()
    expect(scrubbed.ORCHA_LLM_API_KEY).toBeUndefined()
    expect(scrubbed.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
    expect(scrubbed.CLAUDE_CODE_SOMETHING_ELSE).toBeUndefined()
    // unrelated vars survive untouched.
    expect(scrubbed.PATH).toBe('/usr/bin')
    expect(scrubbed.HOME).toBe('/Users/x')
  })

  it('drops the personal-session marker so managed workers never inherit it', () => {
    expect(scrubWorkerEnv({ ORCHA_PERSONAL_SESSION: '1', PATH: '/usr/bin' }).ORCHA_PERSONAL_SESSION).toBeUndefined()
  })

  it('does not mutate the input object', () => {
    const env = { ANTHROPIC_API_KEY: 'sk-ant-x', PATH: '/usr/bin' }
    scrubWorkerEnv(env)
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-x')
  })

  it('is a no-op on an env with none of the dangerous keys', () => {
    const env = { PATH: '/usr/bin', HOME: '/Users/x' }
    expect(scrubWorkerEnv(env)).toEqual(env)
  })
})

describe('hostToolPath', () => {
  it('includes brew, pipx, npm-global and Claude Code locations, de-duped', () => {
    const p = hostToolPath({ PATH: '/usr/bin' }, '/Users/x').split(':')
    expect(p).toContain('/Users/x/.local/bin') // pipx (orcha)
    expect(p).toContain('/Users/x/.claude/local') // Claude Code native installer
    expect(p).toContain('/opt/homebrew/bin')
    expect(p).toContain('/usr/bin') // preserves the inherited PATH
    expect(new Set(p).size).toBe(p.length) // no duplicates
  })

  it('merges the login-shell PATH (where nvm/volta node + claude actually live), de-duped', () => {
    const login = '/Users/x/.nvm/versions/node/v20/bin:/opt/homebrew/bin:/usr/bin'
    const p = hostToolPath({ PATH: '/usr/bin' }, '/Users/x', login).split(':')
    expect(p).toContain('/Users/x/.nvm/versions/node/v20/bin') // would be missing without login PATH
    expect(p[0]).toBe('/Users/x/.nvm/versions/node/v20/bin') // login dirs take precedence
    expect(p).toContain('/Users/x/.local/bin') // hardcoded fallbacks still present
    expect(new Set(p).size).toBe(p.length) // still de-duped across login + base + extras
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

describe('checkWorkerReady (#295: verify, never a second orcha up)', () => {
  const running = (pid = 51086, status = 'running') => ({
    status: 'running',
    children: { portal: { pid: 1, status: 'running' }, notifier: { pid, status } }
  })
  /** Fake clock + sleep: `sleep` advances the clock, so a 60 s deadline costs no real time. */
  const clock = () => {
    let t = 1_000_000
    return { now: () => t, sleep: vi.fn(async (ms: number) => void (t += ms)) }
  }
  const deps = (over: Partial<WorkerReadyDeps> = {}): WorkerReadyDeps => {
    const c = clock()
    return {
      which: vi.fn(async (cmd: string) => (cmd === 'claude' ? '/bin/claude' : null)),
      isNative: () => true,
      readState: () => running(),
      dockerNotifierPid: () => null,
      isAlive: () => true,
      pathEnv: '/stub/path',
      now: c.now,
      sleep: c.sleep,
      ...over
    }
  }

  it('a running notifier under serve → started, with no waiting and no orcha subprocess', async () => {
    const d = deps()
    const lines: string[] = []
    expect(await checkWorkerReady('/proj', d, (l) => lines.push(l))).toEqual({ started: true })
    expect(d.sleep).not.toHaveBeenCalled()
    expect(d.which).toHaveBeenCalledTimes(1) // claude only — no orcha lookup, no `orcha up`
    expect(lines[0]).toMatch(/agent worker running \(pid 51086\)/)
  })

  it('waits for serve to start the notifier (gated on the portal), then reports it', async () => {
    const states = [null, { status: 'running', children: { notifier: { pid: null, status: 'waiting' } } }, running()]
    const d = deps({ readState: () => (states.length > 1 ? states.shift()! : states[0]) as never })
    const lines: string[] = []
    expect(await checkWorkerReady('/proj', d, (l) => lines.push(l))).toEqual({ started: true })
    expect(d.sleep).toHaveBeenCalledTimes(2)
    expect(lines.some((l) => l.includes('agent worker is waiting'))).toBe(true)
  })

  it('a worker that never comes up → a bounded, non-fatal warning (fake clock, no real wait)', async () => {
    const d = deps({ readState: () => ({ status: 'running', children: { notifier: { pid: null, status: 'restarting' } } }) })
    const r = await checkWorkerReady('/proj', { ...d, deadlineMs: 60_000, pollMs: 1_000 })
    expect(r.started).toBe(false)
    expect(r.reason).toMatch(/wasn’t up after 60 s \(the agent worker is restarting\)/)
    expect(r.reason).toMatch(/orcha status/)
    expect((d.sleep as ReturnType<typeof vi.fn>).mock.calls.length).toBe(60)
  })

  it('a dead pid in state.json is not "running"', async () => {
    const r = await checkWorkerReady('/proj', deps({ isAlive: () => false, deadlineMs: 3_000 }))
    expect(r.started).toBe(false)
  })

  it('a crashlooping notifier is reported at once, without waiting out the deadline', async () => {
    const d = deps({ readState: () => running(7, 'crashlooping') })
    const r = await checkWorkerReady('/proj', d)
    expect(r.started).toBe(false)
    expect(r.reason).toMatch(/keeps crashing/)
    expect(d.sleep).not.toHaveBeenCalled()
  })

  it('docker projects: the notifier pidfile decides', async () => {
    const ok = await checkWorkerReady('/proj', deps({ isNative: () => false, dockerNotifierPid: () => 42 }))
    expect(ok).toEqual({ started: true })
    const missing = await checkWorkerReady('/proj', deps({ isNative: () => false, deadlineMs: 2_000 }))
    expect(missing.started).toBe(false)
    expect(missing.reason).toMatch(/orcha-notifier\.pid/)
  })

  it('worker up but Claude Code missing → started WITH the caveat', async () => {
    const r = await checkWorkerReady('/proj', deps({ which: vi.fn(async () => null) }))
    expect(r.started).toBe(true)
    expect(r.reason).toMatch(/Claude Code/)
  })

  it('a state reader that throws is a not-ready state, not a crash', async () => {
    const r = await checkWorkerReady('/proj', deps({ readState: () => { throw new Error('EACCES') }, deadlineMs: 1_000 }))
    expect(r.started).toBe(false)
    expect(r.reason).toMatch(/EACCES/)
  })
})

/** A fake child process: stdout/stderr streams, scripted exit, recorded kills. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough
    stderr: PassThrough
    exitCode: number | null
    signalCode: NodeJS.Signals | null
    kills: string[]
    kill: (sig: string) => boolean
  }
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.exitCode = null
  child.signalCode = null
  child.kills = []
  child.kill = (sig: string) => {
    child.kills.push(sig)
    return true
  }
  return child
}

describe('runBounded (#295: hung orcha subprocesses end in a clear error)', () => {
  afterEach(() => vi.useRealTimers())

  it('streams stdout lines and resolves on exit 0', async () => {
    const child = fakeChild()
    const lines: string[] = []
    const p = runBounded('orcha', ['up'], { label: 'orcha up', onLine: (l) => lines.push(l), spawnImpl: () => child as never })
    child.stdout.write('[orcha] +0.1s one\n[orcha] +0.2s two\npartial')
    await new Promise((r) => setImmediate(r))
    child.emit('close', 0, null)
    await p
    expect(lines).toEqual(['[orcha] +0.1s one', '[orcha] +0.2s two', 'partial'])
  })

  it('rejects with the stderr tail on a non-zero exit', async () => {
    const child = fakeChild()
    const p = runBounded('orcha', ['up'], { label: 'orcha up', spawnImpl: () => child as never })
    child.stderr.write('port 8095 in use')
    await new Promise((r) => setImmediate(r))
    child.emit('close', 1, null)
    await expect(p).rejects.toMatchObject({ stderr: 'port 8095 in use' })
  })

  it('a child that never exits (and keeps its pipes open) is stopped at the deadline', async () => {
    vi.useFakeTimers()
    const child = fakeChild()
    const p = runBounded('orcha', ['up'], { label: 'orcha up', timeoutMs: 300_000, spawnImpl: () => child as never })
    const settled = vi.fn()
    p.catch(settled)
    await vi.advanceTimersByTimeAsync(299_999)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await expect(p).rejects.toMatchObject({ timedOut: true })
    const err = await p.catch((e) => e)
    expect(err.stderr).toMatch(/orcha up did not finish within 5 min and was stopped/)
    expect(child.kills).toEqual(['SIGTERM'])
    await vi.advanceTimersByTimeAsync(5_000) // still alive after the grace → SIGKILL
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL'])
    child.emit('close', null, 'SIGKILL') // a late close changes nothing
  })

  it('no timeout → never killed by a timer', async () => {
    vi.useFakeTimers()
    const child = fakeChild()
    const p = runBounded('orcha', ['init'], { label: 'orcha init', spawnImpl: () => child as never })
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(child.kills).toEqual([])
    child.emit('close', 0, null)
    await p
  })

  it('a missing binary rejects with a readable reason', async () => {
    const child = fakeChild()
    const p = runBounded('orcha', ['up'], { label: 'orcha up', spawnImpl: () => child as never })
    child.emit('error', Object.assign(new Error('spawn orcha ENOENT'), { code: 'ENOENT' }))
    await expect(p).rejects.toMatchObject({ stderr: 'orcha up could not be started: spawn orcha ENOENT' })
  })
})

describe('resolveOrcha (GH #258 plan D3 resolution order)', () => {
  const RES = '/Applications/Embodent.app/Contents/Resources'
  const SIDECAR = `${RES}/orcha-runtime/bin/orcha`
  const LINK = '/Users/x/.local/bin/orcha'
  const has = (...paths: string[]) => (p: string) => paths.includes(p)

  it('1) prefers the runtime bundled in the app, even when ~/.local/bin/orcha exists', () => {
    expect(resolveOrcha({ resourcesPath: RES, home: '/Users/x', exists: has(SIDECAR, LINK) })).toBe(SIDECAR)
  })

  it('2) falls back to ~/.local/bin/orcha when the app has no bundled runtime', () => {
    expect(resolveOrcha({ resourcesPath: RES, home: '/Users/x', exists: has(LINK) })).toBe(LINK)
    // dev / tests: no resources dir at all
    expect(resolveOrcha({ resourcesPath: null, home: '/Users/x', exists: has(LINK) })).toBe(LINK)
  })

  it('3) else plain `orcha`, looked up on the host-tool PATH', () => {
    expect(resolveOrcha({ resourcesPath: RES, home: '/Users/x', exists: has() })).toBe('orcha')
  })
})

