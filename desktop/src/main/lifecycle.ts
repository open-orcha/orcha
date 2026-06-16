import { execFile } from 'node:child_process'

export interface ExecResult {
  stdout: string
}
export type Exec = (cmd: string, args: string[]) => Promise<ExecResult>

const defaultExec: Exec = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }))
      else resolve({ stdout })
    })
  })

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
