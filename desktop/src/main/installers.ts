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

/** Where Homebrew lives for each chip. Apple Silicon keeps the brew git checkout AT the prefix
 *  (/opt/homebrew); Intel keeps the prefix at /usr/local but the checkout under /usr/local/Homebrew
 *  with brew symlinked into /usr/local/bin (which is already on the default PATH). */
export function homebrewLayout(arch: string = process.arch): {
  prefix: string
  repo: string
  brewBin: string
} {
  if (arch === 'arm64') {
    return { prefix: '/opt/homebrew', repo: '/opt/homebrew', brewBin: '/opt/homebrew/bin/brew' }
  }
  return { prefix: '/usr/local', repo: '/usr/local/Homebrew', brewBin: '/usr/local/bin/brew' }
}

/** Install Homebrew via its OFFICIAL MANUAL method — a plain `git clone` of the brew repo into the
 *  prefix — rather than the curl|bash `install.sh`.
 *
 *  Why not install.sh: on macOS it runs an UNCONDITIONAL `execute_sudo chown -R … $REPOSITORY`,
 *  and under `NONINTERACTIVE=1` that probes sudo with `sudo -n` (no prompt). An admin who has not
 *  recently typed their password has no cached credential, so `sudo -n` fails and the installer
 *  aborts with "Need sudo access on macOS (… needs to be an Administrator)!" — even though they ARE
 *  an admin. Pre-creating the prefix can't avoid it (the chown is unconditional). So install.sh
 *  cannot run fully unattended on macOS without the user typing a password into a terminal.
 *
 *  The manual clone needs ZERO sudo: homebrewPrepCommand has already created and chowned the prefix
 *  to the user via the one native popup, so the user owns everything brew touches. We run this whole
 *  command under the true hardware arch (see userShellArgv) so a Rosetta-translated app can't pull
 *  down the Intel build and die with "Bad CPU type". On Intel we also symlink brew onto PATH. */
export function homebrewInstallCommand(arch: string = process.arch): string {
  const { repo, brewBin } = homebrewLayout(arch)
  const parts = [`git clone https://github.com/Homebrew/brew ${repo}`]
  // Intel keeps the checkout under /usr/local/Homebrew, so expose `brew` on the default PATH.
  if (arch !== 'arm64') parts.push(`ln -sf ${repo}/bin/brew ${brewBin}`)
  // First run downloads the matching (native) portable-ruby and primes the formula API cache.
  parts.push(`${brewBin} update --force --quiet`)
  // Apple Silicon's bin dir is not on the default PATH; add brew to the user's login shell so it
  // also works in their own Terminal (our app already finds it via dockerPath). Guarded so re-runs
  // don't duplicate the line; best-effort so it can never fail the install.
  if (arch === 'arm64') {
    parts.push(
      `(grep -qs 'brew shellenv' ~/.zprofile || echo 'eval "$(${brewBin} shellenv)"' >> ~/.zprofile) || true`
    )
  }
  return parts.join(' && ')
}

/** Run user-level shell commands under the Mac's TRUE architecture. If the Electron app is itself
 *  translated under Rosetta on Apple Silicon, every child it spawns inherits the x86 slice — so a
 *  bare `brew` would run as Intel, install the wrong build, and hit "Bad CPU type in executable".
 *  Pinning the login shell to `arch -arm64` makes brew/colima — and everything they spawn — run
 *  natively. Intel Macs have only the x86 slice, so they need no flag. Returns the argv pair for
 *  child_process so quoting never round-trips through a second shell. */
export function userShellArgv(cmd: string, arch: string = process.arch): [string, string[]] {
  return arch === 'arm64'
    ? ['arch', ['-arm64', '/bin/bash', '-lc', cmd]]
    : ['/bin/bash', ['-lc', cmd]]
}

/** Normalise the Mac's CPU to the two values the Homebrew prefix logic cares about, from the output
 *  of `sysctl -n hw.optional.arm64`. That key reads "1" on Apple Silicon even when the asking
 *  process is translated under Rosetta — which is exactly why we ask the hardware instead of
 *  trusting process.arch. Anything else (including the sysctl key being absent on Intel) is x64. */
export function macArchFromSysctl(sysctlOut: string): 'arm64' | 'x64' {
  return sysctlOut.trim() === '1' ? 'arm64' : 'x64'
}

/** The ONE privileged step: create and hand the Homebrew directories to the user, via macOS's own
 *  native popup (`do shell script with administrator privileges` — password + Touch ID). After this
 *  the user owns everything the manual install (homebrewInstallCommand) writes, so the clone and
 *  every later `brew` run need no sudo at all — which is the whole point: it lets us avoid the
 *  installer's unattended-sudo abort while still never letting Orcha see the password.
 *
 *  Apple Silicon owns the whole dedicated /opt/homebrew prefix. Intel must NOT chown all of
 *  /usr/local (it is shared with other software), so we create+own only Homebrew's own dirs under
 *  it — the same set Homebrew itself would chown — including /usr/local/bin for the brew symlink.
 *  We chown to the invoking user in the `admin` group (the default primary group for admin accounts). */
export function homebrewPrepCommand(
  arch: string = process.arch,
  user: string = os.userInfo().username
): string {
  if (arch === 'arm64') {
    return `mkdir -p /opt/homebrew && chown -R ${user}:admin /opt/homebrew`
  }
  // Intel: Homebrew's own subdirectories under /usr/local only — never chown all of /usr/local.
  const dirs = [
    '/usr/local/Homebrew',
    '/usr/local/bin',
    '/usr/local/etc',
    '/usr/local/include',
    '/usr/local/lib',
    '/usr/local/opt',
    '/usr/local/sbin',
    '/usr/local/share',
    '/usr/local/var',
    '/usr/local/Cellar',
    '/usr/local/Caskroom',
    '/usr/local/Frameworks'
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
