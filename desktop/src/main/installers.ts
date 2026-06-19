import os from 'node:os'
import type { BootstrapStatus, DependencyName } from '../shared/types'

/** One guided install step the user explicitly confirms BEFORE it runs. The plan is ordered:
 *  Homebrew first (the others install through it), then a Docker engine, then the Orcha CLI.
 *
 *  Why a consent step at all: installing system software is irreversible, and kedar's explicit
 *  instruction is to tell the user about macOS's own password / fingerprint popup and ask before
 *  every install — Homebrew AND Docker. So each step carries the plain-language copy we show. */
export interface InstallStepPlan {
  name: DependencyName
  /** Short title for the consent dialog, e.g. "Install Homebrew". */
  title: string
  /** Plain-language body shown BEFORE running. Always names macOS's own password / Touch ID
   *  prompt as Apple's, not Orcha's, per the working agreement on consent. */
  consentMessage: string
  /** The exact shell command this step runs — surfaced verbatim if the step fails, so the user
   *  can run it themselves in Terminal. */
  command: string
  /** True when this step triggers macOS's native admin authentication (password / fingerprint).
   *  Only Homebrew needs root to create its prefix; brew/colima/CLI all run as the user. */
  needsAdmin: boolean
}

/** The Homebrew install is a non-interactive run of the official installer. We run it AS THE USER
 *  (Homebrew refuses to run as root) after a separate admin step pre-creates its prefix — see
 *  homebrewPrepCommand.
 *
 *  On Apple Silicon we force the installer to run natively with `arch -arm64`. The official
 *  installer chooses its prefix from the architecture it sees: an un-forced run that happens to be
 *  translated under Rosetta detects x86_64, installs the Intel build under /usr/local, and then
 *  dies with "Bad CPU type in executable" when its bundled Ruby can't run. Pinning to arm64 lays
 *  down the correct build under /opt/homebrew — matching the prefix homebrewPrepCommand prepares.
 *  Intel Macs only run x86, so they need no flag. `arch` MUST be the true hardware arch (see
 *  detectMacArch in index.ts), not process.arch — which Rosetta misreports as x64. */
export function homebrewInstallCommand(arch: string = process.arch): string {
  const native = arch === 'arm64' ? 'arch -arm64 ' : ''
  return `NONINTERACTIVE=1 ${native}/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`
}

/** Normalise the Mac's CPU to the two values the Homebrew prefix logic cares about, from the output
 *  of `sysctl -n hw.optional.arm64`. That key reads "1" on Apple Silicon even when the asking
 *  process is translated under Rosetta — which is exactly why we ask the hardware instead of
 *  trusting process.arch. Anything else (including the sysctl key being absent on Intel) is x64. */
export function macArchFromSysctl(sysctlOut: string): 'arm64' | 'x64' {
  return sysctlOut.trim() === '1' ? 'arm64' : 'x64'
}

/** Homebrew's installer normally uses sudo to create and chown its prefix. To surface macOS's
 *  OWN native popup (password + Touch ID) rather than a tty sudo prompt, we do that one privileged
 *  step ourselves via `do shell script with administrator privileges`, then run the installer as
 *  the user — it finds the prefix ready and needs no further elevation.
 *
 *  Apple Silicon installs to /opt/homebrew; Intel uses /usr/local. We chown to the invoking user
 *  in the `admin` group (the macOS default primary group for admin accounts). */
export function homebrewPrepCommand(
  arch: string = process.arch,
  user: string = os.userInfo().username
): string {
  if (arch === 'arm64') {
    return `mkdir -p /opt/homebrew && chown -R ${user}:admin /opt/homebrew`
  }
  // Intel: only Homebrew's own subdirectories under /usr/local — never chown all of /usr/local.
  const dirs = [
    '/usr/local/Homebrew',
    '/usr/local/Cellar',
    '/usr/local/Caskroom',
    '/usr/local/var/homebrew'
  ]
  return `mkdir -p ${dirs.join(' ')} && chown -R ${user}:admin ${dirs.join(' ')}`
}

/** What to do about Docker, honouring "Colima only when nothing is present; reuse Docker Desktop
 *  or OrbStack if already installed". Detection already sets docker.installed from `docker --version`,
 *  so any existing engine (Desktop/OrbStack/Colima) means we never reinstall — we just start it. */
export function dockerCommand(status: BootstrapStatus): string {
  if (!status.docker.installed) {
    // Nothing present → lightweight Colima (no Docker Desktop licence).
    return 'brew install colima docker && colima start'
  }
  // CLI present but daemon down → start whichever engine is already installed; don't reinstall.
  return 'colima start 2>/dev/null || open -a Docker 2>/dev/null || open -a OrbStack'
}

/** Install the Orcha CLI from the public Homebrew tap. */
export function cliInstallCommand(): string {
  return 'brew install open-orcha/orcha/orcha'
}

const APPLE_POPUP_NOTE =
  'macOS will show its OWN password or fingerprint prompt to authorise this — that prompt is ' +
  'Apple asking, not Orcha. Orcha never sees your password.'

const MAYBE_POPUP_NOTE =
  'This runs through Homebrew and usually will not need your password, but if macOS asks, that ' +
  'prompt is Apple’s, not Orcha’s.'

function homebrewStep(arch: string): InstallStepPlan {
  return {
    name: 'homebrew',
    title: 'Install Homebrew',
    consentMessage:
      'Next, Orcha will install Homebrew — the macOS package manager it uses to install ' +
      `everything else.\n\n${APPLE_POPUP_NOTE}\n\nInstall Homebrew now?`,
    command: homebrewInstallCommand(arch),
    needsAdmin: true
  }
}

function dockerInstallStep(status: BootstrapStatus): InstallStepPlan {
  return {
    name: 'docker',
    title: 'Set up Docker',
    consentMessage:
      'Next, Orcha will set up Docker using Colima — a lightweight engine that needs no ' +
      `Docker Desktop licence.\n\n${MAYBE_POPUP_NOTE}\n\nSet up Docker now?`,
    command: dockerCommand(status),
    needsAdmin: false
  }
}

function dockerStartStep(status: BootstrapStatus): InstallStepPlan {
  return {
    name: 'docker',
    title: 'Start Docker',
    consentMessage:
      'Docker is installed but not running. Next, Orcha will start the Docker engine you already ' +
      'have.\n\nThis should not need your password.\n\nStart Docker now?',
    command: dockerCommand(status),
    needsAdmin: false
  }
}

function cliStep(): InstallStepPlan {
  return {
    name: 'cli',
    title: 'Install the Orcha CLI',
    consentMessage:
      'Next, Orcha will install the Orcha command-line tool through Homebrew.\n\n' +
      `${MAYBE_POPUP_NOTE}\n\nInstall the Orcha CLI now?`,
    command: cliInstallCommand(),
    needsAdmin: false
  }
}

/** The ordered set of confirmed steps needed to make this machine ready, derived from a read-only
 *  dependency snapshot. Empty when nothing needs doing. Homebrew is sequenced first because the
 *  Docker and CLI installs run through it. */
export function planBootstrap(
  status: BootstrapStatus,
  arch: string = process.arch
): InstallStepPlan[] {
  const steps: InstallStepPlan[] = []
  if (!status.homebrew.installed) steps.push(homebrewStep(arch))
  if (!status.docker.installed) steps.push(dockerInstallStep(status))
  else if (status.docker.running === false) steps.push(dockerStartStep(status))
  if (!status.cli.installed) steps.push(cliStep())
  return steps
}

/** Build the AppleScript that runs `cmd` with macOS's native admin authentication. Passed to
 *  `osascript -e`, so only AppleScript-level escaping is needed (the arg never hits a shell). */
export function osascriptAdmin(cmd: string): string {
  const escaped = cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `do shell script "${escaped}" with administrator privileges`
}

/** Thrown when the user dismisses a consent dialog or cancels macOS's native auth popup. Distinct
 *  from a real failure so the orchestrator can report "you cancelled" rather than "it broke". */
export class BootstrapCancelled extends Error {
  constructor(public readonly step: DependencyName) {
    super(`bootstrap cancelled at ${step}`)
    this.name = 'BootstrapCancelled'
  }
}

/** osascript reports a user-dismissed auth popup as error -128 ("User canceled."). Detect it so a
 *  cancel at the OS prompt is treated as a cancellation, not an install failure. */
export function isOsascriptCancel(err: unknown): boolean {
  const text = `${(err as { stderr?: string }).stderr ?? ''} ${(err as Error)?.message ?? ''}`
  return /-128|User canceled|User cancelled/i.test(text)
}

export type BootstrapOutcome =
  | { result: 'nothing_to_do' }
  | { result: 'completed' }
  | { result: 'cancelled'; at: DependencyName; title: string }
  | { result: 'failed'; at: DependencyName; title: string; command: string; error: string }

/** Drives the guided install: for each planned step, ask the user (confirm) and only then perform
 *  it. Stops cleanly on the first cancel or failure — nothing runs without an explicit yes, so
 *  there is never a half-applied step past the point the user declined. Pure orchestration: the
 *  caller injects the real dialog (confirm) and execution (perform), so this is fully unit-tested. */
export interface BootstrapDriver {
  /** Show the consent dialog. Resolve true to proceed, false to cancel the whole run. */
  confirm(step: InstallStepPlan): Promise<boolean>
  /** Actually perform the step. Throw BootstrapCancelled if the user cancels macOS's auth popup;
   *  throw any other error to report a failure. */
  perform(step: InstallStepPlan): Promise<void>
}

export async function runGuidedBootstrap(
  status: BootstrapStatus,
  driver: BootstrapDriver,
  arch: string = process.arch
): Promise<BootstrapOutcome> {
  const steps = planBootstrap(status, arch)
  if (steps.length === 0) return { result: 'nothing_to_do' }
  for (const step of steps) {
    const proceed = await driver.confirm(step)
    if (!proceed) return { result: 'cancelled', at: step.name, title: step.title }
    try {
      await driver.perform(step)
    } catch (err) {
      if (err instanceof BootstrapCancelled) {
        return { result: 'cancelled', at: step.name, title: step.title }
      }
      const error = String(
        (err as { stderr?: string }).stderr || (err as Error)?.message || err
      ).slice(-800)
      return { result: 'failed', at: step.name, title: step.title, command: step.command, error }
    }
  }
  return { result: 'completed' }
}
