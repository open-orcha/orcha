import path from 'node:path'
import type {
  BridgeError,
  ProgressEvent,
  ProvisionOptions,
  ProvisionResult,
  ProvisionStep
} from '../shared/types'

/** Run `orcha <args>` in a folder, handing each stdout line to `onLine`; rejects with
 *  {stderr} on a non-zero exit (GH #258 D2: the CLI owns provisioning, the app drives it). */
export type OrchaLines = (folder: string, args: string[], onLine: (line: string) => void) => Promise<void>

/** Best-effort start of the host-side agent worker (the orcha CLI's notifier daemon,
 *  which is what actually spawns `claude -p` runs). Returns started=false with a
 *  plain-language reason when a prerequisite is missing — never throws (worker startup
 *  is non-fatal to provisioning). Optional so unit tests can omit it. */
export type StartWorker = (folder: string) => Promise<{ started: boolean; reason?: string }>

export interface EngineDeps {
  orcha: OrchaLines
  /** The project's `.claude/orcha.json`, or null when missing/unreadable. */
  readConfig: (folder: string) => Record<string, unknown> | null
  /** Ports the app reserved (free on the host and not published by Docker); omitted → the
   *  CLI picks its own. */
  ports?: { api: number; bridge: number }
  user: string
  startWorker?: StartWorker
}

const STDERR_TAIL = 500

/** `orcha init --progress-json` step names; the app's ProvisionStep ids match them 1:1. */
const CLI_STEPS = new Set<ProvisionStep>([
  'ports',
  'config',
  'service',
  'start',
  'wait-portal',
  'create-container',
  'register-human'
])

/** Steps whose `error` line the CLI treats as a warning and carries on past. */
const NON_FATAL = new Set<ProvisionStep>(['service', 'register-human'])

function fail(step: ProvisionStep, code: BridgeError['code'], detail: string): never {
  if (code === 'PROVISION_FAILED') {
    throw { code, step, stderr: detail.slice(-STDERR_TAIL) } as const
  }
  throw { code, detail } as unknown as BridgeError
}

function parseLine(line: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(line) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function portOf(url: unknown): number | null {
  const m = typeof url === 'string' ? /:(\d{2,5})(?:\/|$)/.exec(url) : null
  return m ? Number(m[1]) : null
}

const errText = (err: unknown): string =>
  String((err as { stderr?: string })?.stderr || (err as Error)?.message || err)

/** Provision a project folder through the orcha CLI (GH #258 D2):
 *  - `init`    — `orcha init --runtime native --progress-json …` (fresh folder)
 *  - `upgrade` — `orcha up` (an existing project, either runtime)
 *  - `migrate` — `orcha migrate-runtime --json` (move a Docker project onto the native
 *                runtime; the Docker copy is kept until the user deletes it). */
export async function provision(
  opts: ProvisionOptions,
  onProgress: (e: ProgressEvent) => void,
  deps: EngineDeps
): Promise<ProvisionResult> {
  const runId = `${opts.folder}:${opts.mode}:${Date.now()}`
  const emit = (step: ProvisionStep, status: ProgressEvent['status'], extra?: Partial<ProgressEvent>): void =>
    onProgress({ runId, step, status, ...(extra as object) } as ProgressEvent)
  const warnings: string[] = []

  let apiBase: unknown = null
  if (opts.mode === 'init') apiBase = await runInit(opts, deps, emit, warnings)
  else if (opts.mode === 'migrate') await runMigrate(opts, deps, emit)
  else await runUp(opts, deps, emit)

  const cfg = deps.readConfig(opts.folder) ?? {}
  const name = typeof cfg.project_name === 'string' ? cfg.project_name : opts.name ?? path.basename(opts.folder)
  const apiPort =
    (typeof cfg.api_port === 'number' ? cfg.api_port : null) ?? portOf(apiBase) ?? portOf(cfg.api_base_url)
  if (apiPort === null) fail('config', 'PROVISION_FAILED', `no api_port in ${path.join(opts.folder, '.claude', 'orcha.json')}`)

  // The agent worker: on the native runtime `orcha serve` already supervises the notifier,
  // so this is an idempotent `orcha up` whose real value is the plain-language caveats
  // (Claude Code missing, no API key) it surfaces as warnings.
  if (deps.startWorker) {
    emit('start-daemons', 'start')
    const res = await deps.startWorker(opts.folder)
    emit('start-daemons', res.started ? 'ok' : 'skip')
    if (res.reason) warnings.push(res.reason)
  } else {
    emit('start-daemons', 'skip')
  }

  return { project: `orcha-${name}`, apiPort, warnings }
}

type Emit = (step: ProvisionStep, status: ProgressEvent['status'], extra?: Partial<ProgressEvent>) => void

/** Returns the `api_base_url` from the CLI's final `done` line. */
async function runInit(opts: ProvisionOptions, deps: EngineDeps, emit: Emit, warnings: string[]): Promise<unknown> {
  const args = ['init', '--runtime', 'native', '--progress-json']
  if (opts.name) args.push('--name', opts.name)
  const objective = (opts.objective ?? '').trim()
  if (objective) args.push('--objective', objective)
  args.push('--as', (opts.alias ?? deps.user ?? 'operator').trim() || 'operator')
  if (deps.ports) args.push('--api-port', String(deps.ports.api), '--bridge-port', String(deps.ports.bridge))

  let current: ProvisionStep = 'ports'
  // `as` keeps TS from narrowing these to null: the onLine callback assigns them.
  let done = null as Record<string, unknown> | null
  let failure = null as { step: ProvisionStep | null; error: string } | null
  const onLine = (line: string): void => {
    const ev = parseLine(line)
    if (!ev || typeof ev.step !== 'string') {
      if (line.trim()) emit(current, 'log', { line })
      return
    }
    const detail = ev.detail
    if (ev.step === 'done') {
      if (ev.status === 'ok') done = (detail as Record<string, unknown>) ?? {}
      else {
        const d = (detail ?? {}) as { failed_step?: unknown; error?: unknown }
        const step = typeof d.failed_step === 'string' && CLI_STEPS.has(d.failed_step as ProvisionStep)
          ? (d.failed_step as ProvisionStep)
          : null
        failure = { step, error: String(d.error ?? 'orcha init failed') }
      }
      return
    }
    if (!CLI_STEPS.has(ev.step as ProvisionStep)) return
    const step = ev.step as ProvisionStep
    current = step
    if (ev.status === 'start' || ev.status === 'ok' || ev.status === 'skip') emit(step, ev.status)
    else if (ev.status === 'error' && NON_FATAL.has(step)) {
      warnings.push(
        step === 'service'
          ? `Orcha won’t start by itself after a restart (background service not installed: ${String(detail)}).`
          : `Couldn’t register you in the project (${String(detail)}); register later in the portal.`
      )
      emit(step, step === 'register-human' ? 'ok' : 'skip')
    }
  }

  let stderr = ''
  try {
    await deps.orcha(opts.folder, args, onLine)
  } catch (err) {
    stderr = errText(err)
    failure ??= { step: null, error: stderr }
  }
  if (failure || !done) {
    const f = failure ?? { step: null, error: stderr || 'orcha init ended without finishing' }
    const step = f.step ?? current
    const detail = stderr && !f.error.includes(stderr) ? `${f.error}\n${stderr}` : f.error
    const code: BridgeError['code'] =
      step === 'create-container' && /already has a container|409/.test(detail)
        ? 'CONTAINER_EXISTS'
        : step === 'wait-portal' && !/address already in use|port is already/i.test(detail)
          ? 'PORTAL_TIMEOUT'
          : 'PROVISION_FAILED'
    emit(step, 'fail', { code, detail })
    fail(step, code, detail)
  }
  return done?.api_base_url ?? null
}

async function runUp(opts: ProvisionOptions, deps: EngineDeps, emit: Emit): Promise<void> {
  emit('start', 'start')
  try {
    await deps.orcha(opts.folder, ['up'], (line) => line.trim() && emit('start', 'log', { line }))
  } catch (err) {
    const detail = errText(err)
    emit('start', 'fail', { code: 'PROVISION_FAILED', detail })
    fail('start', 'PROVISION_FAILED', detail)
  }
  emit('start', 'ok')
}

async function runMigrate(opts: ProvisionOptions, deps: EngineDeps, emit: Emit): Promise<void> {
  emit('migrate', 'start')
  let error = null as string | null
  let ok = false as boolean
  try {
    await deps.orcha(opts.folder, ['migrate-runtime', '--json'], (line) => {
      const ev = parseLine(line)
      if (!ev) return void (line.trim() && emit('migrate', 'log', { line }))
      if (ev.event === 'progress') emit('migrate', 'log', { line: String(ev.message ?? ev.stage ?? '') })
      else if (ev.event === 'result') ok = true
      else if (ev.event === 'error') error = String(ev.error ?? 'migrate-runtime failed')
    })
  } catch (err) {
    error ??= errText(err)
  }
  if (error || !ok) {
    const detail = error ?? 'orcha migrate-runtime ended without a result'
    emit('migrate', 'fail', { code: 'PROVISION_FAILED', detail })
    fail('migrate', 'PROVISION_FAILED', detail)
  }
  emit('migrate', 'ok')
}
