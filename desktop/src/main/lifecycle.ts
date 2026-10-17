import { dockerExec, type Exec } from './dockerExec'
import { runOrcha, type OrchaRun } from './hostWorker'
import type { StackRuntime } from '../shared/types'

const defaultExec: Exec = dockerExec

// Belt-and-braces: main/index.ts also validates against the discovery snapshot;
// this guard makes lifecycle safe in isolation (argv is never renderer-controlled
// beyond choosing a known orcha-* project).
const SAFE_PROJECT = /^orcha-[A-Za-z0-9_-]+$/

const STDERR_TAIL = 500

/** What lifecycle needs from a discovered stack. A bare project name = a Docker stack. */
export interface StackRef {
  project: string
  runtime: StackRuntime
  folder: string | null
}

async function compose(project: string, action: 'start' | 'stop', exec: Exec): Promise<void> {
  if (!SAFE_PROJECT.test(project)) {
    throw { code: 'UNKNOWN_STACK' } as const
  }
  try {
    await exec('docker', ['compose', '-p', project, action])
  } catch (err) {
    const stderr = String((err as { stderr?: string }).stderr ?? '')
    throw { code: 'COMPOSE_FAILED', stderr: stderr.slice(-STDERR_TAIL) } as const
  }
}

/** Native project (GH #258 D1): `orcha up` / `orcha down` with cwd = the project folder, through
 *  the same host-tool PATH + scrubbed env the worker start uses. `orcha up` returns once the
 *  project's own launchd service (or a detached `orcha serve`) is running; the app never
 *  supervises it (D-D4). */
async function orcha(stack: StackRef, action: 'up' | 'down', run: OrchaRun): Promise<void> {
  if (!SAFE_PROJECT.test(stack.project) || !stack.folder) {
    throw { code: 'UNKNOWN_STACK' } as const
  }
  try {
    await run(stack.folder, [action])
  } catch (err) {
    const stderr = String((err as { stderr?: string }).stderr ?? (err as Error)?.message ?? '')
    throw { code: 'ORCHA_FAILED', stderr: stderr.slice(-STDERR_TAIL) } as const
  }
}

export const startStack = (stack: string | StackRef, exec: Exec = defaultExec, run: OrchaRun = runOrcha): Promise<void> =>
  typeof stack !== 'string' && stack.runtime === 'native'
    ? orcha(stack, 'up', run)
    : compose(typeof stack === 'string' ? stack : stack.project, 'start', exec)

export const stopStack = (stack: string | StackRef, exec: Exec = defaultExec, run: OrchaRun = runOrcha): Promise<void> =>
  typeof stack !== 'string' && stack.runtime === 'native'
    ? orcha(stack, 'down', run)
    : compose(typeof stack === 'string' ? stack : stack.project, 'stop', exec)
