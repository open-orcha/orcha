import { describe, it, expect, vi } from 'vitest'
import { provision, type EngineDeps } from './initEngine'
import type { ProgressEvent, ProvisionStep } from '../shared/types'

/** A fake fs that records writes and lets us seed reads. */
function fakeFs(seed: Record<string, string> = {}) {
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
    exists: vi.fn((p: string) => files.has(p))
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
