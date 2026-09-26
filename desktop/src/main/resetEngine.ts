import path from 'node:path'
import { dockerExec, type Exec } from './dockerExec'
import { killLingeringDaemons, nodeProcessDeps, type ProcessDeps } from './daemonCleanup'

/** Same orcha-* guard the lifecycle/discovery code uses — argv must name a known orcha stack. */
const SAFE_PROJECT = /^orcha-[A-Za-z0-9_-]+$/
const STDERR_TAIL = 500

/** Run an arbitrary host command (not `docker`/`docker compose`) with a given cwd + env —
 *  used for `orcha down -v`, which must run from the PROJECT folder (it resolves its own
 *  pidfiles and .orcha/docker-compose.yml relative to cwd) rather than the app's cwd. */
export type ExecHost = (
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv }
) => Promise<{ stdout: string }>

export interface ResetDeps {
  exec: Exec
  /** Recursively remove a directory (best-effort; missing is fine). */
  rmrf: (p: string) => void
  /** Remove a single file (best-effort; missing is fine). */
  rmFile: (p: string) => void
  /** Run `orcha down -v` from the project folder — CLI-faithful daemon-stop + compose-down-v
   *  in one step (see notifier.stop_daemon / terminal_bridge.stop_bridge, both called by the
   *  CLI's own `cmd_down`). Optional so callers/tests that don't care about this path can omit
   *  it; when omitted the engine goes straight to the direct compose fallback. */
  execHost?: ExecHost
  /** PATH for locating the `orcha` binary + what it needs — same resolution as hostWorker's
   *  spawns (hostToolPath: login-shell PATH ∪ brew/pipx/npm-global fallbacks). */
  pathEnv?: string
  /** Base env for the `orcha down -v` spawn — same scrubbed env as hostWorker's `orcha up`
   *  spawn (scrubWorkerEnv: strips ANTHROPIC_API_KEY / ORCHA_LLM_API_KEY / CLAUDE_CODE_* so a
   *  stray ambient key never overrides the user's own Claude Code subscription auth). Defaults
   *  to `process.env` unscrubbed when omitted (tests that don't exercise this path). */
  hostEnv?: NodeJS.ProcessEnv
  /** Read a small text file, or null if missing/unreadable (used to pull current_container_id
   *  out of .claude/orcha.json for daemon matching). Optional; daemon cleanup is skipped
   *  without it — never fatal to the reset. */
  readFile?: (p: string) => string | null
  /** List entries directly inside a directory, or null if it doesn't exist (used for the
   *  .agents/skills/orcha-* glob — never touches .agents itself, only named subdirs). */
  listDir?: (p: string) => string[] | null
  /** Best-effort process lookup/kill for lingering daemons; defaults to the real pgrep/lsof
   *  implementation. Injectable so tests never touch the real process table. */
  processDeps?: ProcessDeps
}

const defaultDeps = (): ResetDeps => ({
  exec: dockerExec,
  // Real fs/exec adapters are injected by index.ts; these are overridden in tests.
  rmrf: () => {},
  rmFile: () => {}
})

/** The on-disk Orcha artifacts a reset removes from a project folder. Never the project root,
 *  never .claude wholesale — only Orcha's own files, so the user's code is untouched. */
function orchaArtifacts(folder: string, deps: ResetDeps): { dirs: string[]; files: string[] } {
  const claudeDir = path.join(folder, '.claude')
  const skillsDir = path.join(folder, '.agents', 'skills')
  // Only orcha-prefixed subdirs of .agents/skills — never the whole .agents dir, and only
  // when .agents/skills actually exists (listDir returns null for a missing dir).
  const orchaSkillDirs = (deps.listDir?.(skillsDir) ?? [])
    .filter((name) => name.startsWith('orcha-'))
    .map((name) => path.join(skillsDir, name))

  return {
    dirs: [
      path.join(folder, '.orcha'),
      path.join(claudeDir, 'orcha-tabs'),
      path.join(claudeDir, '.orcha-wakes'),
      path.join(claudeDir, '.orcha-attachments'),
      ...orchaSkillDirs
    ],
    files: [
      path.join(claudeDir, 'orcha.json'),
      path.join(claudeDir, '.orcha-notifier.log'),
      path.join(claudeDir, '.orcha-terminal-bridge.log')
    ]
  }
}

/** Best-effort: pull current_container_id out of folder/.claude/orcha.json for daemon
 *  matching. Returns null on any failure (missing file, unreadable, malformed JSON, absent
 *  key) — daemon cleanup degrades to "skip the notifier match" rather than throwing. */
function readContainerId(folder: string, deps: ResetDeps): string | null {
  if (!deps.readFile) return null
  try {
    const raw = deps.readFile(path.join(folder, '.claude', 'orcha.json'))
    if (!raw) return null
    const cfg = JSON.parse(raw) as { current_container_id?: unknown }
    return typeof cfg.current_container_id === 'string' && cfg.current_container_id ? cfg.current_container_id : null
  } catch {
    return null
  }
}

/** CLI-first teardown: run `orcha down -v` from `folder` — this stops the notifier + terminal
 *  bridge daemons (via their own cwd-scoped pidfiles, exactly like a Terminal `orcha down -v`
 *  would) AND runs the compose down -v, in one CLI-faithful step. Resolves true iff it ran to
 *  a clean exit; false (never throws) on a missing `orcha` binary or any nonzero exit — the
 *  caller falls through to the direct compose path either way, so a stack with no `orcha` CLI
 *  installed (or a CLI-side hiccup) still gets torn down. */
async function tryCliTeardown(folder: string, deps: ResetDeps): Promise<boolean> {
  if (!deps.execHost) return false
  try {
    await deps.execHost('orcha', ['down', '-v'], {
      cwd: folder,
      env: { ...(deps.hostEnv ?? process.env), PATH: deps.pathEnv ?? process.env.PATH ?? '' }
    })
    return true
  } catch {
    // Missing binary (ENOENT) or a nonzero exit (e.g. no .orcha/docker-compose.yml, a
    // mid-teardown docker hiccup) — either way, fall through to the direct compose path
    // below so the volume/data wipe still happens.
    return false
  }
}

/** Fully delete an orcha stack so the project can be re-created clean:
 *   0. (when `folder` known) `orcha down -v` from the folder — CLI-faithful daemon-stop +
 *      compose-down-v. Tolerant of a missing `orcha` binary or nonzero exit.
 *   1. docker compose down -v   (containers + network + the pgdata volume — the data wipe;
 *      always runs, even after a successful step 0, so a partial CLI failure never skips it)
 *   2. docker rmi -f <project>-portal  (so the portal rebuilds fresh; best-effort)
 *   3. best-effort SIGTERM any lingering notifier/terminal-bridge daemon for this project
 *      (belt-and-braces — step 0 should have already stopped them)
 *   4. remove the on-disk Orcha artifacts in `folder` (when known) — never the user's code
 *  Destructive + irreversible; callers gate it behind a type-to-confirm prompt. */
export async function resetStack(
  project: string,
  folder: string | null,
  deps: ResetDeps = defaultDeps()
): Promise<void> {
  if (!SAFE_PROJECT.test(project)) {
    throw { code: 'UNKNOWN_STACK' } as const
  }

  // 0. CLI-first teardown (daemon-stop + compose down -v in one CLI-faithful step). Tolerant
  // of failure — the compose path below still runs regardless, so the data wipe never depends
  // on the CLI having been installed correctly.
  if (folder) {
    await tryCliTeardown(folder, deps)
  }

  // 1. down -v — the load-bearing teardown. A failure here is fatal (nothing was wiped cleanly).
  try {
    await deps.exec('docker', ['compose', '-p', project, 'down', '-v'])
  } catch (err) {
    const stderr = String((err as { stderr?: string }).stderr ?? '')
    throw { code: 'COMPOSE_FAILED', stderr: stderr.slice(-STDERR_TAIL) } as const
  }

  // 2. remove the built portal image (best-effort — it may not exist or be in use).
  try {
    await deps.exec('docker', ['rmi', '-f', `${project}-portal`])
  } catch {
    // ignore — a missing/used image must not fail the reset.
  }

  // 3. belt-and-braces daemon cleanup (best-effort; never throws — see killLingeringDaemons).
  if (folder) {
    const containerId = readContainerId(folder, deps)
    await killLingeringDaemons(folder, containerId, deps.processDeps ?? nodeProcessDeps)
  }

  // 4. on-disk artifacts (only when we know the folder).
  if (folder) {
    const { dirs, files } = orchaArtifacts(folder, deps)
    for (const d of dirs) deps.rmrf(d)
    for (const f of files) deps.rmFile(f)
  }
}
