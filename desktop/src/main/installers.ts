import type {
  InstallProgress,
  InstallResult,
  InstallStep,
  Prereq,
  PrereqProbe
} from '../shared/types'

/** Guided installer for the host prerequisites a fresh Mac needs before Orcha agents run:
 *  the orcha CLI (dev builds only — a packaged app bundles it) → Claude Code. (An API key is not a
 *  host prerequisite: Settings › API keys stores it on each project.) Everything here is PURE (plan building, command + AppleScript construction, the
 *  run orchestration over injected deps) so it's unit-testable without touching the machine;
 *  the real exec + native dialogs live in main/index.ts. */

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

/** The orcha CLI from the public tap. Two gotchas the command guards against:
 *  1. The `user/repo/formula` shorthand does NOT auto-tap a third-party tap — bare
 *     `brew install open-orcha/orcha/orcha` errors with "requires the tap open-orcha/orcha" — so
 *     we tap explicitly first.
 *  2. Newer Homebrew refuses to load a formula from an un-trusted third-party tap ("Refusing to
 *     load formula … from untrusted tap"), which silently sinks the install during onboarding;
 *     Homebrew itself points the user at `brew trust open-orcha/orcha`, so we run that before
 *     installing. It's stderr-silenced and `|| true`-guarded so older Homebrew — which has no
 *     `trust` subcommand and needs none — isn't broken by the unknown command. */
export function orchaCliStep(): InstallStep {
  return {
    id: 'orcha',
    title: 'Orcha helper',
    detail: 'The small command-line helper that launches your agents.',
    actions: [
      {
        kind: 'user',
        script:
          'brew tap open-orcha/orcha && (brew trust open-orcha/orcha 2>/dev/null || true) && brew install open-orcha/orcha/orcha'
      }
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

/** Ordered install plan: only the missing prerequisites. GH #258: no Homebrew and no Docker
 *  engine any more — a packaged app brings its own runtime, so `orcha` is only missing in a
 *  dev build (or a future Intel build), where the tap install below is the developer path. */
export function planInstall(probe: PrereqProbe): InstallStep[] {
  const steps: InstallStep[] = []
  if (!probe.orcha) steps.push(orchaCliStep())
  if (!probe.claude) steps.push(claudeStep())
  return steps
}

/** Injectable surface so runInstall is testable without spawning processes or popping
 *  dialogs. `runAdmin` receives the raw script (the caller wraps it via adminOsascriptArgs). */
export interface InstallDeps {
  runUser: (script: string, onLine: (line: string) => void) => Promise<void>
  runAdmin: (script: string) => Promise<void>
  onProgress: (e: InstallProgress) => void
}

const FAIL_TAIL = 600

/** Run the plan step by step, streaming progress. Stops at the first failed step and returns
 *  what completed (installs are independent + idempotent, so a re-run resumes from there).
 *  Never throws. */
export async function runInstall(steps: InstallStep[], deps: InstallDeps): Promise<InstallResult> {
  const completed: Prereq[] = []
  for (const step of steps) {
    deps.onProgress({ id: step.id, status: 'start', title: step.title })
    try {
      for (const action of step.actions) {
        if (action.kind === 'admin') await deps.runAdmin(action.script)
        else await deps.runUser(action.script, (line) => deps.onProgress({ id: step.id, status: 'log', line }))
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
