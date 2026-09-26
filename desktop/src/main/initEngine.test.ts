import { afterEach, describe, it, expect, vi } from 'vitest'
import { provision, type EngineDeps } from './initEngine'
import type { ProgressEvent, ProvisionStep } from '../shared/types'

/** A fake fs that records writes and lets us seed reads. `dirs` seeds readDir
 *  listings (e.g. migration dirs for the downgrade guard). */
function fakeFs(seed: Record<string, string> = {}, dirs: Record<string, string[]> = {}) {
  const files = new Map<string, string>(Object.entries(seed))
  return {
    files,
    readFile: vi.fn((p: string) => {
      const v = files.get(p)
      if (v === undefined) throw Object.assign(new Error('enoent'), { code: 'ENOENT' })
      return v
    }),
    writeFile: vi.fn((p: string, c: string) => void files.set(p, c)),
    copyTree: vi.fn(),
    mkdirp: vi.fn(),
    chmod: vi.fn(),
    exists: vi.fn((p: string) => files.has(p)),
    readDir: vi.fn((p: string) => dirs[p] ?? [])
  }
}

function deps(over: Partial<EngineDeps> = {}): EngineDeps {
  return {
    exec: vi.fn().mockResolvedValue({ stdout: '' }),
    fetchJson: vi.fn(),
    fs: fakeFs(),
    templatesRoot: () => '/tpl',
    findFreePort: vi.fn((start: number) => start), // deterministic ports
    readComposeTemplate: () =>
      'name: orcha-{{ project_name }}\nports a:["{{ api_port }}:8000"] d:["{{ db_port }}:5432"] b:{{ bridge_port }}',
    genSecret: () => 'SECRET',
    user: 'kedar',
    ...over
  }
}

function steps(events: ProgressEvent[]): Array<[ProvisionStep, string]> {
  return events.map((e) => [e.step, e.status])
}

describe('provision — init mode', () => {
  it('runs the full sequence and calls docker compose up --build', async () => {
    const d = deps()
    ;(d.fetchJson as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(undefined) // wait-portal GET /
      .mockResolvedValueOnce({ container_id: 'c1' }) // POST /api/containers
      .mockResolvedValueOnce({ agent_id: 'h1' }) // POST .../agents
    const events: ProgressEvent[] = []
    const res = await provision(
      { folder: '/proj', mode: 'init', name: 'demo', objective: 'Build it', alias: 'kedar' },
      (e) => events.push(e),
      d
    )
    expect(res.project).toBe('orcha-demo')
    // docker compose up -d --build was invoked with the project's compose file dir.
    const calls = (d.exec as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1])
    const up = calls.find((a: string[]) => a.includes('up'))
    expect(up).toEqual(expect.arrayContaining(['compose', 'up', '-d', '--build']))
    // The six steps the desktop app actually performs complete with 'ok', in order.
    const ok = steps(events).filter(([, s]) => s === 'ok').map(([st]) => st)
    expect(ok).toEqual([
      'render-compose',
      'copy-templates',
      'compose-up',
      'wait-portal',
      'create-container',
      'register-human'
    ])
    // With no startWorker dep injected, start-daemons is skipped (worker start is opt-in).
    const skipped = steps(events).filter(([, s]) => s === 'skip').map(([st]) => st)
    expect(skipped).toContain('start-daemons')

    // The shared python modules (secret_box/llm_util/digest_curate) must be copied INTO
    // .orcha/portal so the portal container can `import secret_box`. Without this the portal
    // crashes with ModuleNotFoundError and wait-portal times out. (mirrors CLI _install_llm_util)
    const treeCopies = (d.fs.copyTree as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string]>
    expect(
      treeCopies.some(([src, dst]) => src.endsWith('portal-shared') && dst.endsWith('/.orcha/portal'))
    ).toBe(true)

    // every event carries a runId
    expect(events.every((e) => typeof e.runId === 'string' && e.runId.length > 0)).toBe(true)
  })

  it('start-daemons reports ok when the injected startWorker succeeds', async () => {
    const startWorker = vi.fn().mockResolvedValue({ started: true })
    const d = deps({ startWorker })
    ;(d.fetchJson as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ container_id: 'c1' })
      .mockResolvedValueOnce({ agent_id: 'h1' })
    const events: ProgressEvent[] = []
    const res = await provision({ folder: '/proj', mode: 'init', name: 'demo' }, (e) => events.push(e), d)
    expect(startWorker).toHaveBeenCalledWith('/proj')
    expect(steps(events).filter(([, s]) => s === 'ok').map(([st]) => st)).toContain('start-daemons')
    expect(res.warnings).toEqual([])
  })

  it('start-daemons skips and surfaces the reason when the worker cannot start', async () => {
    const startWorker = vi.fn().mockResolvedValue({ started: false, reason: 'Orcha helper not installed' })
    const d = deps({ startWorker })
    ;(d.fetchJson as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ container_id: 'c1' })
      .mockResolvedValueOnce({ agent_id: 'h1' })
    const events: ProgressEvent[] = []
    const res = await provision({ folder: '/proj', mode: 'init', name: 'demo' }, (e) => events.push(e), d)
    expect(steps(events).filter(([, s]) => s === 'skip').map(([st]) => st)).toContain('start-daemons')
    expect(res.warnings).toContain('Orcha helper not installed')
  })

  it('maps a 409 on container create to CONTAINER_EXISTS', async () => {
    const d = deps()
    ;(d.fetchJson as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(undefined) // wait-portal
      .mockRejectedValueOnce(Object.assign(new Error('HTTP 409 already has a container'), { status: 409 }))
    const events: ProgressEvent[] = []
    await expect(
      provision({ folder: '/proj', mode: 'init', name: 'demo' }, (e) => events.push(e), d)
    ).rejects.toMatchObject({ code: 'CONTAINER_EXISTS' })
    expect(events.some((e) => e.status === 'fail' && e.step === 'create-container')).toBe(true)
  })

  it('maps a portal that never returns 200 to PORTAL_TIMEOUT', async () => {
    const d = deps({ waitPortalTimeoutMs: 5, waitPortalPollMs: 1 })
    ;(d.fetchJson as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(
      provision({ folder: '/proj', mode: 'init', name: 'demo' }, () => {}, d)
    ).rejects.toMatchObject({ code: 'PORTAL_TIMEOUT' })
  })
})

describe('provision — upgrade mode', () => {
  it('preserves ports from orcha.json, skips container/human, no down -v', async () => {
    const d = deps({
      fs: fakeFs({
        '/proj/.claude/orcha.json': JSON.stringify({
          project_name: 'demo',
          api_port: 8001,
          db_port: 5433,
          bridge_port: 8766
        })
      })
    })
    const events: ProgressEvent[] = []
    await provision({ folder: '/proj', mode: 'upgrade' }, (e) => events.push(e), d)
    const calls = (d.exec as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1])
    expect(calls.some((a: string[]) => a.includes('-v'))).toBe(false) // never wipes
    const skipped = events.filter((e) => e.status === 'skip').map((e) => e.step)
    expect(skipped).toEqual(expect.arrayContaining(['create-container', 'register-human']))
    expect((d.findFreePort as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled() // ports preserved
  })

  it('refuses to downgrade: stack migration tip above the bundled templates aborts before any write', async () => {
    const fs = fakeFs(
      {
        '/proj/.claude/orcha.json': JSON.stringify({
          project_name: 'demo',
          api_port: 8001,
          db_port: 5433,
          bridge_port: 8766
        })
      },
      {
        '/tpl/migrations': ['001_init.sql', '026_old_tip.sql'],
        '/proj/.orcha/migrations': ['001_init.sql', '048_wake_backoff.sql']
      }
    )
    const d = deps({ fs })
    await expect(
      provision({ folder: '/proj', mode: 'upgrade' }, () => {}, d)
    ).rejects.toMatchObject({ code: 'PROVISION_FAILED' })
    expect(fs.writeFile).not.toHaveBeenCalled() // refused BEFORE rendering compose
    expect(fs.copyTree).not.toHaveBeenCalled()
  })

  it('equal or newer bundled templates pass the guard (upgrade proceeds)', async () => {
    const fs = fakeFs(
      {
        '/proj/.claude/orcha.json': JSON.stringify({
          project_name: 'demo',
          api_port: 8001,
          db_port: 5433,
          bridge_port: 8766
        })
      },
      {
        '/tpl/migrations': ['048_wake_backoff.sql'],
        '/proj/.orcha/migrations': ['048_wake_backoff.sql']
      }
    )
    const d = deps({ fs })
    await provision({ folder: '/proj', mode: 'upgrade' }, () => {}, d)
    expect(fs.copyTree).toHaveBeenCalled()
  })
})

describe('provision — reset mode', () => {
  it('runs docker compose down -v before up', async () => {
    const d = deps()
    ;(d.fetchJson as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ container_id: 'c1' })
      .mockResolvedValueOnce({ agent_id: 'h1' })
    await provision({ folder: '/proj', mode: 'reset', name: 'demo' }, () => {}, d)
    const calls = (d.exec as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1])
    const downIdx = calls.findIndex((a: string[]) => a.includes('down') && a.includes('-v'))
    const upIdx = calls.findIndex((a: string[]) => a.includes('up'))
    expect(downIdx).toBeGreaterThanOrEqual(0)
    expect(downIdx).toBeLessThan(upIdx)
  })
})

describe('provision — non-fatal steps', () => {
  it('treats human registration failure as a warning, not a failure', async () => {
    const d = deps()
    ;(d.fetchJson as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(undefined) // wait-portal
      .mockResolvedValueOnce({ container_id: 'c1' }) // container
      .mockRejectedValueOnce(new Error('boom')) // human
    const res = await provision({ folder: '/proj', mode: 'init', name: 'demo' }, () => {}, d)
    expect(res.warnings.some((w) => /human/i.test(w))).toBe(true)
  })
})

describe('provision — gh token injection at compose-up (parity with `orcha up`)', () => {
  const origPat = process.env.ORCHA_GITHUB_PAT

  afterEach(() => {
    if (origPat === undefined) delete process.env.ORCHA_GITHUB_PAT
    else process.env.ORCHA_GITHUB_PAT = origPat
  })

  it('passes the resolved gh token as extraEnv on the compose up call when ORCHA_GITHUB_PAT is unset', async () => {
    delete process.env.ORCHA_GITHUB_PAT
    const ghAuthToken = vi.fn().mockResolvedValue('gho_from_host')
    const d = deps({ ghAuthToken })
    ;(d.fetchJson as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ container_id: 'c1' })
      .mockResolvedValueOnce({ agent_id: 'h1' })
    await provision({ folder: '/proj', mode: 'init', name: 'demo' }, () => {}, d)
    expect(ghAuthToken).toHaveBeenCalled()
    const calls = (d.exec as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string[], NodeJS.ProcessEnv?]>
    const upCall = calls.find(([, args]) => args.includes('up'))
    expect(upCall?.[2]).toEqual({ ORCHA_GITHUB_PAT: 'gho_from_host' })
  })

  it('does not call ghAuthToken (or pass extraEnv) when ORCHA_GITHUB_PAT is already set', async () => {
    process.env.ORCHA_GITHUB_PAT = 'preset-token'
    const ghAuthToken = vi.fn().mockResolvedValue('gho_from_host')
    const d = deps({ ghAuthToken })
    ;(d.fetchJson as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ container_id: 'c1' })
      .mockResolvedValueOnce({ agent_id: 'h1' })
    await provision({ folder: '/proj', mode: 'init', name: 'demo' }, () => {}, d)
    expect(ghAuthToken).not.toHaveBeenCalled()
    const calls = (d.exec as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string[], NodeJS.ProcessEnv?]>
    const upCall = calls.find(([, args]) => args.includes('up'))
    expect(upCall?.[2]).toBeUndefined()
  })

  it('does not pass extraEnv when gh has no token (null) or the dep is omitted', async () => {
    delete process.env.ORCHA_GITHUB_PAT
    const ghAuthToken = vi.fn().mockResolvedValue(null)
    const d = deps({ ghAuthToken })
    ;(d.fetchJson as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ container_id: 'c1' })
      .mockResolvedValueOnce({ agent_id: 'h1' })
    await provision({ folder: '/proj', mode: 'init', name: 'demo' }, () => {}, d)
    const calls = (d.exec as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string[], NodeJS.ProcessEnv?]>
    const upCall = calls.find(([, args]) => args.includes('up'))
    expect(upCall?.[2]).toBeUndefined()
  })
})
