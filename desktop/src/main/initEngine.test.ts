import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { provision, type EngineDeps, type OrchaLines } from './initEngine'
import type { ProgressEvent } from '../shared/types'

const FOLDER = '/work/proj'
const OK_LINES = readFileSync(path.join(__dirname, '__fixtures__', 'initProgress', 'ok.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
const CONFIG = { api_base_url: 'http://localhost:8095', project_name: 'proj', api_port: 8095, runtime: 'native' }

/** An OrchaLines fake that replays `lines` on stdout, then resolves or rejects with stderr. */
function replay(lines: string[], fail?: string): OrchaLines & ReturnType<typeof vi.fn> {
  return vi.fn(async (_folder: string, _args: string[], onLine: (l: string) => void) => {
    for (const l of lines) onLine(l)
    if (fail !== undefined) throw Object.assign(new Error('orcha exited 1'), { stderr: fail })
  }) as never
}

function deps(over: Partial<EngineDeps> = {}): EngineDeps {
  return { orcha: replay(OK_LINES), readConfig: () => CONFIG, user: 'kedar', ...over }
}

async function run(opts: Partial<Parameters<typeof provision>[0]> = {}, d: EngineDeps = deps()) {
  const events: ProgressEvent[] = []
  const res = await provision({ folder: FOLDER, mode: 'init', ...opts }, (e) => events.push(e), d)
  return { res, events, seq: events.map((e) => `${e.step}:${e.status}`) }
}

async function runFail(opts: Partial<Parameters<typeof provision>[0]>, d: EngineDeps) {
  const events: ProgressEvent[] = []
  const err = await provision({ folder: FOLDER, mode: 'init', ...opts }, (e) => events.push(e), d).catch((e) => e)
  return { err, events, last: events[events.length - 1] }
}

describe('provision init (orcha init --progress-json)', () => {
  it('runs orcha init native in the folder with name, objective, alias and the reserved ports', async () => {
    const d = deps({ ports: { api: 8095, bridge: 8798 } })
    await run({ name: 'proj', objective: ' Ship it ', alias: 'ana' }, d)
    expect(d.orcha).toHaveBeenCalledWith(
      FOLDER,
      ['init', '--runtime', 'native', '--progress-json', '--name', 'proj', '--objective', 'Ship it', '--as', 'ana',
        '--api-port', '8095', '--bridge-port', '8798'],
      expect.any(Function)
    )
  })

  it('leaves name/objective/ports to the CLI when not given; alias falls back to the profile user', async () => {
    const d = deps()
    await run({}, d)
    expect((d.orcha as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual([
      'init', '--runtime', 'native', '--progress-json', '--as', 'kedar'
    ])
  })

  it('maps the real CLI step lines 1:1 onto progress events and returns project + api port', async () => {
    const { res, seq } = await run()
    expect(seq).toEqual([
      'ports:ok', 'config:ok', 'service:skip', 'start:start', 'start:ok', 'wait-portal:start', 'wait-portal:ok',
      'create-container:start', 'create-container:ok', 'register-human:start', 'register-human:ok', 'start-daemons:skip'
    ])
    expect(res).toEqual({ project: 'orcha-proj', apiPort: 8095, warnings: [] })
  })

  it('falls back to the done line api_base_url when orcha.json has no api_port', async () => {
    const { res } = await run({}, deps({ readConfig: () => ({ project_name: 'proj' }) }))
    expect(res.apiPort).toBe(8095)
  })

  it('streams non-JSON stdout as log lines on the current step', async () => {
    const lines = [OK_LINES[3], 'something chatty', ...OK_LINES.slice(4)]
    const { events } = await run({}, deps({ orcha: replay(lines) }))
    expect(events).toContainEqual(expect.objectContaining({ step: 'start', status: 'log', line: 'something chatty' }))
  })

  it('a service install error is a warning, not a failure', async () => {
    const lines = OK_LINES.map((l) =>
      l.includes('"service"') ? JSON.stringify({ step: 'service', status: 'error', detail: 'launchctl said no' }) : l
    )
    const { res, seq } = await run({}, deps({ orcha: replay(lines) }))
    expect(seq).toContain('service:skip')
    expect(res.warnings.join(' ')).toMatch(/launchctl said no/)
  })

  it('a register-human error is a warning and the step reads ok', async () => {
    const lines = OK_LINES.filter((l) => !l.includes('"register-human", "status": "ok"')).map((l) =>
      l.includes('"register-human", "status": "start"')
        ? `${l}\n${JSON.stringify({ step: 'register-human', status: 'error', detail: 'HTTP 500' })}`
        : l
    ).flatMap((l) => l.split('\n'))
    const { res, seq } = await run({}, deps({ orcha: replay(lines) }))
    expect(seq).toContain('register-human:ok')
    expect(res.warnings.join(' ')).toMatch(/HTTP 500/)
  })

  it('done/error names the failed step → fail event + PROVISION_FAILED with the stderr tail', async () => {
    const lines = [...OK_LINES.slice(0, 4), JSON.stringify({ step: 'done', status: 'error', detail: { failed_step: 'start', error: 'serve crashed' } })]
    const { err, last } = await runFail({}, deps({ orcha: replay(lines, 'Traceback: boom') }))
    expect(last).toMatchObject({ step: 'start', status: 'fail', code: 'PROVISION_FAILED' })
    expect(err).toMatchObject({ code: 'PROVISION_FAILED', step: 'start' })
    expect(err.stderr).toMatch(/serve crashed[\s\S]*Traceback: boom/)
  })

  it('an existing container → CONTAINER_EXISTS', async () => {
    const lines = [...OK_LINES.slice(0, 8), JSON.stringify({ step: 'done', status: 'error', detail: { failed_step: 'create-container', error: 'error: this stack already has a container; its data was preserved.' } })]
    const { err, last } = await runFail({}, deps({ orcha: replay(lines, '') }))
    expect(last).toMatchObject({ step: 'create-container', code: 'CONTAINER_EXISTS' })
    expect(err.code).toBe('CONTAINER_EXISTS')
  })

  it('a portal that never answers → PORTAL_TIMEOUT', async () => {
    const lines = [...OK_LINES.slice(0, 6), JSON.stringify({ step: 'done', status: 'error', detail: { failed_step: 'wait-portal', error: 'portal did not come up' } })]
    const { err } = await runFail({}, deps({ orcha: replay(lines, '') }))
    expect(err.code).toBe('PORTAL_TIMEOUT')
  })

  it('a CLI that dies with no done line fails on the last step seen, with stderr', async () => {
    const { err, last } = await runFail({}, deps({ orcha: replay(OK_LINES.slice(0, 2), 'orcha: command not found') }))
    expect(last).toMatchObject({ step: 'config', status: 'fail' })
    expect(err).toMatchObject({ code: 'PROVISION_FAILED', step: 'config', stderr: 'orcha: command not found' })
  })

  it('starts the agent worker after a good init and keeps its caveat as a warning', async () => {
    const startWorker = vi.fn().mockResolvedValue({ started: true, reason: 'No API key yet' })
    const { res, seq } = await run({}, deps({ startWorker }))
    expect(startWorker).toHaveBeenCalledWith(FOLDER)
    expect(seq.slice(-2)).toEqual(['start-daemons:start', 'start-daemons:ok'])
    expect(res.warnings).toEqual(['No API key yet'])
  })
})

describe('provision upgrade (orcha up)', () => {
  it('runs orcha up in the folder and reads the port from orcha.json', async () => {
    const d = deps({ orcha: replay(['[orcha] ✓ portal up at http://localhost:8095/']) })
    const { res, seq, events } = await run({ mode: 'upgrade' }, d)
    expect((d.orcha as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual(['up'])
    expect(seq).toEqual(['start:start', 'start:log', 'start:ok', 'start-daemons:skip'])
    expect(events[1]).toMatchObject({ line: '[orcha] ✓ portal up at http://localhost:8095/' })
    expect(res).toEqual({ project: 'orcha-proj', apiPort: 8095, warnings: [] })
  })

  it('a failing orcha up → PROVISION_FAILED on start', async () => {
    const { err, last } = await runFail({ mode: 'upgrade' }, deps({ orcha: replay([], 'port 8095 in use') }))
    expect(last).toMatchObject({ step: 'start', status: 'fail' })
    expect(err).toMatchObject({ code: 'PROVISION_FAILED', step: 'start', stderr: 'port 8095 in use' })
  })
})

describe('provision migrate (orcha migrate-runtime --json)', () => {
  const progress = (message: string) => JSON.stringify({ event: 'progress', stage: 's', message })

  it('streams progress messages and returns the native port', async () => {
    const lines = [progress('stopping the notifier'), progress('copying the database'), JSON.stringify({ event: 'result', ok: true, message: 'done' })]
    const d = deps({ orcha: replay(lines) })
    const { res, seq, events } = await run({ mode: 'migrate' }, d)
    expect((d.orcha as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual(['migrate-runtime', '--json'])
    expect(seq).toEqual(['migrate:start', 'migrate:log', 'migrate:log', 'migrate:ok', 'start-daemons:skip'])
    expect(events[2]).toMatchObject({ line: 'copying the database' })
    expect(res.apiPort).toBe(8095)
  })

  it('an error event (e.g. Docker is off) fails the migrate step with its message', async () => {
    const lines = [JSON.stringify({ event: 'error', ok: false, error: 'Start Docker once so Orcha can copy your data.' })]
    const { err, last } = await runFail({ mode: 'migrate' }, deps({ orcha: replay(lines, '') }))
    expect(last).toMatchObject({ step: 'migrate', status: 'fail', detail: 'Start Docker once so Orcha can copy your data.' })
    expect(err).toMatchObject({ code: 'PROVISION_FAILED', step: 'migrate' })
  })

  it('no result line is a failure even on exit 0', async () => {
    const { err } = await runFail({ mode: 'migrate' }, deps({ orcha: replay([progress('x')]) }))
    expect(err).toMatchObject({ code: 'PROVISION_FAILED', step: 'migrate' })
  })
})
