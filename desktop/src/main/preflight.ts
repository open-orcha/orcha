import { dockerExec, dockerExecWithTimeout, type Exec } from './dockerExec'
import type { PreflightReport } from '../shared/types'

export interface PreflightDeps {
  exec?: Exec
  /** Open a macOS app by name (default: `open -a <name>`). */
  open?: (appName: string) => Promise<void>
  pollMs?: number
  timeoutMs?: number
  /** Total budget once the FIRST probe hung (CLI timed out, not refused). A wedged Docker
   *  Desktop rarely recovers on its own and `open -a Docker` can't unstick it, so waiting the
   *  full `timeoutMs` (each poll probe itself up to 8 s) left onboarding spinning ~70 s with
   *  no explanation (desktop r1 review). Measured from the start of preflight. */
  hungBudgetMs?: number
}

const defaultOpen = (appName: string): Promise<void> =>
  dockerExec('open', ['-a', appName]).then(() => undefined)

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

type DaemonState = 'ok' | 'down' | 'hung' | 'missing'

async function daemonUp(exec: Exec): Promise<DaemonState> {
  try {
    await exec('docker', ['info', '--format', '{{.ServerVersion}}'])
    return 'ok'
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return 'missing'
    if ((err as { timedOut?: boolean }).timedOut === true) return 'hung'
    return 'down'
  }
}

export const HUNG_HINT =
  'Docker isn’t responding — its command line stopped answering. Quit and reopen Docker Desktop (or choose Restart from its menu), then re-check.'

export async function preflight(deps: PreflightDeps = {}): Promise<PreflightReport> {
  // `docker info` is a probe: a wedged CLI times out and reads as "daemon down".
  const exec = deps.exec ?? dockerExecWithTimeout()
  const open = deps.open ?? defaultOpen
  const pollMs = deps.pollMs ?? 1500
  const timeoutMs = deps.timeoutMs ?? 60000
  const hungBudgetMs = deps.hungBudgetMs ?? 15000
  const started = Date.now()

  let state = await daemonUp(exec)
  if (state === 'ok') return { docker: 'ok', autoStarted: false, hint: null }
  if (state === 'missing') {
    return {
      docker: 'not-installed',
      autoStarted: false,
      hint: 'Install Docker Desktop (or OrbStack/Colima) and start it, then re-check.'
    }
  }

  // daemon down → try to auto-start Docker Desktop and poll until up.
  try {
    await open('Docker')
  } catch {
    // ignore — we still poll in case the user starts it manually.
  }
  const hung = state === 'hung'
  const deadline = hung ? started + hungBudgetMs : Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(pollMs)
    state = await daemonUp(exec)
    if (state === 'ok') return { docker: 'ok', autoStarted: true, hint: null }
  }
  if (hung || state === 'hung') {
    return { docker: 'daemon-down', autoStarted: false, hint: HUNG_HINT, unresponsive: true }
  }
  return {
    docker: 'daemon-down',
    autoStarted: false,
    hint: 'Docker is installed but its daemon did not start. Open Docker Desktop manually, then re-check.'
  }
}
