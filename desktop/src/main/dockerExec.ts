import { execFile } from 'node:child_process'
import os from 'node:os'

export interface ExecResult {
  stdout: string
}
/** `extraEnv` merges (overrides) on top of the process env the exec already builds — used
 *  to pass a deliberate, unpersisted value (e.g. ORCHA_GITHUB_PAT for one compose-up call)
 *  without writing it to any file or the shell's real environment. */
export type Exec = (cmd: string, args: string[], extraEnv?: NodeJS.ProcessEnv) => Promise<ExecResult>

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

/** Shared docker invoker with a Finder-safe PATH. `err.stderr` is populated on failure.
 *  `extraEnv` (e.g. a one-shot ORCHA_GITHUB_PAT for a single compose-up) is merged in last,
 *  so it wins over both the inherited env and PATH. */
export const dockerExec: Exec = (cmd, args, extraEnv) =>
  new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { encoding: 'utf8', env: { ...process.env, PATH: dockerPath(), ...extraEnv } },
      (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stderr }))
        else resolve({ stdout })
      }
    )
  })
