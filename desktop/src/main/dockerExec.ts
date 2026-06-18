import { execFile } from 'node:child_process'
import os from 'node:os'

export interface ExecResult {
  stdout: string
}
export interface ExecOptions {
  /** Working directory for the child process (e.g. the folder `orcha init` runs in). */
  cwd?: string
}
export type Exec = (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>

/** macOS apps launched from Finder (LaunchServices) inherit a minimal PATH that
 *  omits where Docker installs its CLI, so a bare `docker` call fails with ENOENT
 *  and looks like "Docker isn't running". Prepend the common install locations so
 *  `docker` resolves the same way it does in a login shell. */
export function dockerPath(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const candidates = [
    '/opt/homebrew/bin', // Apple Silicon Homebrew (docker CLI, colima)
    '/usr/local/bin', // Intel Homebrew + Docker Desktop symlink
    '/Applications/Docker.app/Contents/Resources/bin', // Docker Desktop
    `${home}/.orbstack/bin`, // OrbStack
    `${home}/.docker/bin` // Docker Desktop user bin
  ]
  const existing = env.PATH ? env.PATH.split(':') : []
  return [...candidates, ...existing].filter((p, i, a) => p && a.indexOf(p) === i).join(':')
}

/** Shared CLI invoker with a Finder-safe PATH (docker, brew, orcha all install into the
 *  same locations dockerPath() restores). `err.stderr` is populated on failure. */
export const dockerExec: Exec = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { encoding: 'utf8', env: { ...process.env, PATH: dockerPath() }, cwd: opts?.cwd },
      (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stderr }))
        else resolve({ stdout })
      }
    )
  })
