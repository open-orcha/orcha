import { dockerExec, type Exec } from './dockerExec'

const defaultExec: Exec = dockerExec

// Belt-and-braces: main/index.ts also validates against the discovery snapshot;
// this guard makes lifecycle safe in isolation (argv is never renderer-controlled
// beyond choosing a known orcha-* project).
const SAFE_PROJECT = /^orcha-[A-Za-z0-9_-]+$/

const STDERR_TAIL = 500

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

export const startStack = (project: string, exec: Exec = defaultExec): Promise<void> =>
  compose(project, 'start', exec)

export const stopStack = (project: string, exec: Exec = defaultExec): Promise<void> =>
  compose(project, 'stop', exec)
