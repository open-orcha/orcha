import { dockerExec, type Exec } from './dockerExec'
import type { PreflightReport } from '../shared/types'

export interface PreflightDeps {
  exec?: Exec
  /** Open a macOS app by name (default: `open -a <name>`). */
  open?: (appName: string) => Promise<void>
  pollMs?: number
  timeoutMs?: number
}

const defaultOpen = (appName: string): Promise<void> =>
  dockerExec('open', ['-a', appName]).then(() => undefined)

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function daemonUp(exec: Exec): Promise<'ok' | 'down' | 'missing'> {
  try {
    await exec('docker', ['info', '--format', '{{.ServerVersion}}'])
    return 'ok'
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return 'missing'
    return 'down'
  }
}

export async function preflight(deps: PreflightDeps = {}): Promise<PreflightReport> {
  const exec = deps.exec ?? dockerExec
  const open = deps.open ?? defaultOpen
  const pollMs = deps.pollMs ?? 1500
  const timeoutMs = deps.timeoutMs ?? 60000

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
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(pollMs)
    state = await daemonUp(exec)
    if (state === 'ok') return { docker: 'ok', autoStarted: true, hint: null }
  }
  return {
    docker: 'daemon-down',
    autoStarted: false,
    hint: 'Docker is installed but its daemon did not start. Open Docker Desktop manually, then re-check.'
  }
}
