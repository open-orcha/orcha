import { dockerExec, type Exec } from './dockerExec'
import type { BootstrapStatus, DependencyName, DependencyStatus, InstallStep } from '../shared/types'

const defaultExec: Exec = dockerExec

/** First non-empty line of a `--version` style output, trimmed (or null if none). */
function firstLine(stdout: string): string | null {
  const line = stdout.split('\n').map((l) => l.trim()).find((l) => l.length > 0)
  return line ?? null
}

/** Probe a tool by running a cheap command; resolve its first output line or null if absent. */
async function probe(exec: Exec, cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await exec(cmd, args)
    return firstLine(stdout)
  } catch {
    return null
  }
}

async function detectHomebrew(exec: Exec): Promise<DependencyStatus> {
  const version = await probe(exec, 'brew', ['--version'])
  return { name: 'homebrew', installed: version !== null, version }
}

/** Docker needs two things: the CLI on PATH *and* a reachable daemon. `docker --version`
 *  succeeds even when Docker Desktop/Colima isn't started, so we check `docker info` too. */
async function detectDocker(exec: Exec): Promise<DependencyStatus> {
  const version = await probe(exec, 'docker', ['--version'])
  if (version === null) return { name: 'docker', installed: false, running: false, version: null }
  // `docker info` exits non-zero when the daemon is unreachable — that's our "running" signal.
  let running = false
  try {
    await exec('docker', ['info', '--format', '{{.ServerVersion}}'])
    running = true
  } catch {
    running = false
  }
  return { name: 'docker', installed: true, running, version }
}

async function detectCli(exec: Exec): Promise<DependencyStatus> {
  const version = await probe(exec, 'orcha', ['--version'])
  return { name: 'cli', installed: version !== null, version }
}

/** Snapshot of the three things a fresh Mac needs before `orcha init` can run.
 *  Read-only: this never installs anything. */
export async function checkDependencies(exec: Exec = defaultExec): Promise<BootstrapStatus> {
  const [homebrew, docker, cli] = await Promise.all([
    detectHomebrew(exec),
    detectDocker(exec),
    detectCli(exec)
  ])
  // `orcha init` needs the CLI present and a live Docker daemon. Homebrew is only a means to
  // install the other two, so it isn't itself part of "ready".
  const ready = cli.installed && docker.installed && docker.running === true
  return { homebrew, docker, cli, ready }
}

/** The commands a human would run to install a missing dependency. We surface these in the UI
 *  and STOP — actually running system-software installers is destructive/irreversible, so it
 *  stays an explicit, human-confirmed action rather than something the app does silently. */
export function installPlan(status: BootstrapStatus): InstallStep[] {
  const steps: InstallStep[] = []
  if (!status.homebrew.installed) {
    steps.push({
      name: 'homebrew',
      label: 'Install Homebrew',
      command:
        '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
      docsUrl: 'https://brew.sh'
    })
  }
  if (!status.docker.installed) {
    steps.push({
      name: 'docker',
      label: 'Install Docker (Colima — lightweight, no Docker Desktop license)',
      command: 'brew install colima docker && colima start',
      docsUrl: 'https://github.com/abiosoft/colima'
    })
  } else if (status.docker.running === false) {
    steps.push({
      name: 'docker',
      label: 'Start the Docker daemon',
      command: 'colima start  # or open -a Docker',
      docsUrl: 'https://docs.docker.com/desktop/'
    })
  }
  if (!status.cli.installed) {
    steps.push({
      name: 'cli',
      label: 'Install the Orcha CLI',
      command: 'brew install open-orcha/orcha/orcha',
      docsUrl: 'https://github.com/open-orcha/orcha'
    })
  }
  return steps
}

export type { DependencyName }
