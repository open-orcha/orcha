import type {
  InstallProgress,
  InstallResult,
  InstallStep,
  Prereq,
  PrereqProbe
} from '../shared/types'

/** Guided installer for the host prerequisites a fresh Mac needs before Orcha agents run:
 *  Homebrew → the Docker engine (Colima) → the orcha CLI → Claude Code → an Anthropic API
 *  key. Everything here is PURE (plan building, command + AppleScript construction, the
 *  run orchestration over injected deps) so it's unit-testable without touching the machine;
 *  the real exec + native dialogs live in main/index.ts. */

const BREW_INSTALLER = 'https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh'
const CLAUDE_INSTALLER = 'https://claude.ai/install.sh'

/** Escape a POSIX shell script for embedding inside an AppleScript string literal
 *  (`do shell script "<here>"`). AppleScript escapes backslash and double-quote; order
 *  matters — backslashes first so we don't double-escape the ones we just added. */
export function appleScriptEscape(script: string): string {
  return script.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** osascript args that run `script` as root behind the native admin (Touch ID / password)
 *  popup. Passed via execFile (no shell), so only AppleScript escaping applies. */
export function adminOsascriptArgs(script: string): string[] {
  return ['-e', `do shell script "${appleScriptEscape(script)}" with administrator privileges`]
}

/** Homebrew's install prefix for a macOS arch: Apple Silicon → /opt/homebrew; Intel must
 *  live under /usr/local. */
export function homebrewPrefix(arch: string): string {
  return arch === 'arm64' ? '/opt/homebrew' : '/usr/local'
}

/** Homebrew install. We pre-create + chown the prefix as root (the ONE admin step), then run
 *  the official installer as the user (brew refuses to run as root). Pre-owning the prefix
 *  means the installer needs no sudo for it; NONINTERACTIVE keeps it from waiting on a TTY.
 *  Apple Silicon owns /opt/homebrew outright; Intel must own the standard /usr/local subdirs
 *  the installer writes to. We use the official installer (not a tarball) so the result is a
 *  real git checkout — needed for `brew update` and for tapping open-orcha/orcha. */
export function homebrewStep(arch: string, user: string): InstallStep {
  const detail =
    'The package manager Orcha uses to install everything else. Creating its folder needs ' +
    'your Mac password once.'
  const installer = `NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL ${BREW_INSTALLER})"`
  if (arch === 'arm64') {
    const prefix = '/opt/homebrew'
    return {
      id: 'homebrew',
      title: 'Homebrew',
      detail,
      actions: [
        { kind: 'admin', script: `mkdir -p ${prefix} && chown -R ${user}:admin ${prefix}` },
        { kind: 'user', script: installer }
      ]
    }
  }
  const subdirs = ['Homebrew', 'bin', 'etc', 'include', 'lib', 'opt', 'sbin', 'share', 'var', 'Cellar', 'Caskroom']
    .map((d) => `/usr/local/${d}`)
    .join(' ')
  return {
    id: 'homebrew',
    title: 'Homebrew',
    detail,
    actions: [
      { kind: 'admin', script: `mkdir -p ${subdirs} && chown -R ${user}:admin ${subdirs}` },
      { kind: 'user', script: installer }
    ]
  }
}

/** Docker engine via Colima — no Docker Desktop license / GUI needed. `colima start`
 *  brings the daemon up so the existing preflight then sees `docker info` succeed. */
export function dockerEngineStep(): InstallStep {
  return {
    id: 'dockerEngine',
    title: 'Docker engine',
    detail: 'Runs Orcha’s projects in the background (via Colima — no Docker Desktop needed).',
    actions: [{ kind: 'user', script: 'brew install colima docker docker-compose && colima start' }]
  }
}

/** The orcha CLI from the public tap. The `user/repo/formula` shorthand does NOT auto-tap a
 *  third-party tap — `brew install open-orcha/orcha/orcha` errors with "requires the tap
 *  open-orcha/orcha" — so we tap it explicitly first, then install. */
export function orchaCliStep(): InstallStep {
  return {
    id: 'orcha',
    title: 'Orcha helper',
    detail: 'The small command-line helper that launches your agents.',
    actions: [
      { kind: 'user', script: 'brew tap open-orcha/orcha && brew install open-orcha/orcha/orcha' }
    ]
  }
}

/** Claude Code via its official installer (lands in ~/.local/bin & ~/.claude/local, both
 *  already on the host-tool PATH the worker uses). */
export function claudeStep(): InstallStep {
  return {
    id: 'claude',
    title: 'Claude Code',
    detail: 'The AI coding tool your agents use to do the work.',
    actions: [{ kind: 'user', script: `curl -fsSL ${CLAUDE_INSTALLER} | bash` }]
  }
}

/** The Anthropic API key. No shell actions — the orchestrator prompts for it and stores it
 *  (see runInstall). */
export function apiKeyStep(): InstallStep {
  return {
    id: 'apiKey',
    title: 'Anthropic API key',
    detail: 'Lets your agents talk to Claude. Stored only on this Mac.',
    actions: []
  }
}

/** Ordered install plan: only the missing prerequisites, in dependency order (Homebrew first
 *  since the engine/orcha installs use it). */
export function planInstall(probe: PrereqProbe, opts: { arch: string; user: string }): InstallStep[] {
  const steps: InstallStep[] = []
  if (!probe.homebrew) steps.push(homebrewStep(opts.arch, opts.user))
  if (!probe.dockerEngine) steps.push(dockerEngineStep())
  if (!probe.orcha) steps.push(orchaCliStep())
  if (!probe.claude) steps.push(claudeStep())
  if (!probe.apiKey) steps.push(apiKeyStep())
  return steps
}

/** Injectable surface so runInstall is testable without spawning processes or popping
 *  dialogs. `runAdmin` receives the raw script (the caller wraps it via adminOsascriptArgs);
 *  `promptSecret` returns the API key or null if the user cancels. */
export interface InstallDeps {
  runUser: (script: string, onLine: (line: string) => void) => Promise<void>
  runAdmin: (script: string) => Promise<void>
  promptSecret: () => Promise<string | null>
  persistApiKey: (key: string) => Promise<void>
  onProgress: (e: InstallProgress) => void
}

const FAIL_TAIL = 600

/** Run the plan step by step, streaming progress. Stops at the first failed step and returns
 *  what completed (installs are independent + idempotent, so a re-run resumes from there). A
 *  cancelled API-key prompt is a soft skip, not a failure — the portal still works, agents
 *  just won't run until a key is added. Never throws. */
export async function runInstall(steps: InstallStep[], deps: InstallDeps): Promise<InstallResult> {
  const completed: Prereq[] = []
  for (const step of steps) {
    deps.onProgress({ id: step.id, status: 'start', title: step.title })
    try {
      if (step.id === 'apiKey') {
        const key = await deps.promptSecret()
        if (!key) {
          deps.onProgress({ id: step.id, status: 'skip', title: step.title })
          continue
        }
        await deps.persistApiKey(key)
      } else {
        for (const action of step.actions) {
          if (action.kind === 'admin') await deps.runAdmin(action.script)
          else await deps.runUser(action.script, (line) => deps.onProgress({ id: step.id, status: 'log', line }))
        }
      }
      deps.onProgress({ id: step.id, status: 'ok', title: step.title })
      completed.push(step.id)
    } catch (err) {
      const detail = String((err as { stderr?: string }).stderr ?? (err as Error).message ?? err)
        .slice(-FAIL_TAIL)
        .trim()
      deps.onProgress({ id: step.id, status: 'fail', title: step.title, detail })
      return { ok: false, completed, failedAt: step.id, detail }
    }
  }
  return { ok: true, completed }
}
