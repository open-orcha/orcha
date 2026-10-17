import { execFile, execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dockerPath } from './dockerExec'
import { readNativeConfig, readState, type ServeState } from './nativeStacks'

/** What actually runs an agent is a host-side `claude -p` process spawned by the orcha
 *  CLI's notifier daemon. Native projects: `orcha serve` supervises it; Docker projects:
 *  `orcha up` starts it. Provisioning (`orcha init` / `up` / `migrate-runtime`) has already
 *  started it by the time the app's "Start the agent worker" step runs, so that step only
 *  CHECKS it is up — bounded, never another `orcha up` (#295) — and reports missing
 *  prerequisites in plain English. */

const STDERR_TAIL = 400

/** PATH for locating the host CLIs (`orcha`, `claude`) AND the tools they in turn need
 *  (`node` for Claude Code, `git`, `npm`). Extends the Finder-safe docker PATH with the
 *  user's real login-shell PATH (`loginPath`) plus the usual brew / npm-global / pipx /
 *  Claude-Code locations as a fallback. A Finder-launched .app inherits a minimal PATH
 *  that omits all of these — and crucially, the `orcha up` we spawn passes THIS PATH to
 *  the notifier daemon, which freezes it for every agent worker it later spawns. If a
 *  worker can't find `claude`/`node` it dies silently ("no reaction at all"), so the
 *  login-shell PATH (where the user actually installed those tools) is what makes
 *  app-launched runs behave like a Terminal `orcha up`. Pure + testable. */
export function hostToolPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
  loginPath: string | null = null
): string {
  const extra = [
    `${home}/.local/bin`, // pipx (orcha), uv tools
    `${home}/.claude/local`, // Claude Code native installer
    `${home}/.npm-global/bin`, // npm global prefix override
    '/opt/homebrew/bin', // already in dockerPath, but harmless to re-list
    '/usr/local/bin'
  ]
  const login = loginPath ? loginPath.split(':') : []
  const base = dockerPath(env, home).split(':')
  // login-shell dirs first: a user who runs nvm/volta/asdf has node (and the npm-global
  // claude) under a versioned home dir none of the hardcoded fallbacks above can guess.
  return [...login, ...base, ...extra].filter((p, i, a) => p && a.indexOf(p) === i).join(':')
}

/** Impure: ask the user's LOGIN shell for the PATH a Terminal would have, so app-launched
 *  `orcha up` inherits the same tool locations (nvm/volta/asdf/custom) the user installed
 *  into. Best-effort — returns null on any failure (no shell, timeout, weird output) and
 *  the caller degrades to the hardcoded fallback list. `-ilc` runs the interactive+login
 *  rc files where PATH is actually exported; `printf %s` keeps the output free of newlines. */
export function loginShellPath(): string | null {
  const cached = loginPathCache
  if (cached && Date.now() - cached.at < LOGIN_PATH_TTL_MS) return cached.value
  const value = readLoginShellPath()
  loginPathCache = { at: Date.now(), value }
  return value
}

/** A login shell can take a minute on a loaded Mac (#295: `zsh -ilc` measured 11–71 s) and
 *  this read is synchronous, so its answer is reused for a minute instead of re-spawning
 *  the shell on every `orcha` call the app makes. */
const LOGIN_PATH_TTL_MS = 60_000
let loginPathCache: { at: number; value: string | null } | null = null

function readLoginShellPath(): string | null {
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    const out = execFileSync(shell, ['-ilc', 'printf %s "$PATH"'], {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const trimmed = out.trim()
    return trimmed && trimmed.includes('/') ? trimmed : null
  } catch {
    return null
  }
}

/** Strip every env var that would override the user's Claude Code SUBSCRIPTION auth before
 *  spawning a host process that leads to a `claude` run (the notifier daemon, `orcha up`,
 *  anything downstream of it). ANTHROPIC_API_KEY (and ORCHA_LLM_API_KEY, and any
 *  CLAUDE_CODE_* var) takes precedence over a logged-in Claude Code session — if the
 *  LAUNCHING shell happened to have one set (e.g. exported in .zshrc for an unrelated
 *  script), every agent run silently fails "Invalid API key" even though the user is
 *  properly subscribed. Local runs are subscription-first: a deliberate key comes from the
 *  stack's own .env / Settings (read explicitly by whatever needs it), never from ambient
 *  env inheritance. Also drops ORCHA_PERSONAL_SESSION (a personal-tab marker). Pure — returns a new object, never mutates `env`. */
export function scrubWorkerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env }
  delete next.ANTHROPIC_API_KEY
  delete next.ORCHA_LLM_API_KEY
  // The desktop itself may have been started from one of its own (personal) terminal tabs;
  // the notifier and its agent workers are managed sessions and must not inherit that marker.
  delete next.ORCHA_PERSONAL_SESSION
  for (const key of Object.keys(next)) {
    if (key.startsWith('CLAUDE_CODE_')) delete next[key]
  }
  return next
}

export interface WorkerProbe {
  orchaFound: boolean
  claudeFound: boolean
  /** stderr from `orcha up` when it ran and failed; undefined if it wasn't run or succeeded. */
  upError?: string
  /** Why the worker is not running after the readiness check (timeout / crashlooping). */
  notReady?: string
}

/** Pure: turn a probe into the {started, reason} the engine consumes. Kept separate from
 *  the exec so the (plain-language) messaging is unit-testable without spawning processes. */
export function workerStartResult(probe: WorkerProbe): { started: boolean; reason?: string } {
  if (!probe.orchaFound) {
    return {
      started: false,
      reason:
        'Your project is set up and the portal is open, but agents won’t run yet: the Orcha ' +
        'helper that launches them isn’t installed on this Mac. Once it’s installed, assigning ' +
        'a task will start the agent automatically.'
    }
  }
  if (probe.notReady) return { started: false, reason: probe.notReady }
  if (probe.upError) {
    return {
      started: false,
      reason: `Couldn’t start the agent worker automatically: ${probe.upError.slice(-STDERR_TAIL).trim()}`
    }
  }
  if (!probe.claudeFound) {
    return {
      started: true,
      reason:
        'The agent worker is running, but Claude Code isn’t installed on this Mac yet — agents ' +
        'need it (plus an Anthropic API key) to actually do work. Install Claude Code and the ' +
        'next assigned task will run.'
    }
  }
  return { started: true }
}

/** Where the app looks for the `orcha` CLI (GH #258 plan D3), first hit wins:
 *  1. the runtime bundled in the app (`<resources>/orcha-runtime/bin/orcha`), so the app and
 *     the CLI it drives can never be different versions;
 *  2. `~/.local/bin/orcha` (the link the app creates for Terminal use, or a developer's own);
 *  3. plain `orcha`, found on the host-tool PATH at spawn time (Homebrew / pipx installs).
 *  Pure over `exists`; `resourcesPath` is null outside a packaged app (dev, tests). */
export function resolveOrcha(opts: {
  resourcesPath: string | null
  home: string
  exists: (p: string) => boolean
}): string {
  const candidates = [
    opts.resourcesPath ? path.join(opts.resourcesPath, 'orcha-runtime', 'bin', 'orcha') : null,
    path.join(opts.home, '.local', 'bin', 'orcha')
  ]
  for (const c of candidates) if (c && opts.exists(c)) return c
  return 'orcha'
}

/** Production resolveOrcha: the packaged app's resources dir and the real home folder. */
export function orchaBin(): string {
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath ?? null
  return resolveOrcha({
    resourcesPath,
    home: os.homedir(),
    exists: (p) => {
      try {
        fs.accessSync(p, fs.constants.X_OK)
        return true
      } catch {
        return false
      }
    }
  })
}

/** Bound for a `which` lookup: it is a fast binary, so a minute means the machine is stuck. */
export const WHICH_TIMEOUT_MS = 5_000
/** How long the worker check waits for serve to report the notifier running. serve starts
 *  it once the portal answers (or after its own 30 s portal wait), so this is generous. */
export const WORKER_READY_DEADLINE_MS = 60_000
export const WORKER_READY_POLL_MS = 1_000

/** Injectable surface for testing checkWorkerReady without touching the real machine. */
export interface WorkerReadyDeps {
  /** Resolve a command to an absolute path, or null if not on PATH (like `which`); bounded. */
  which: (cmd: string, pathEnv: string) => Promise<string | null>
  /** True when `.claude/orcha.json` says the project runs natively (`orcha serve`). */
  isNative: (folder: string) => boolean
  /** Native: serve's `.orcha/state.json` (null when absent/unreadable). */
  readState: (folder: string) => ServeState | null
  /** Docker: the notifier daemon's pidfile (`.claude/.orcha-notifier.pid`), null when none. */
  dockerNotifierPid: (folder: string) => number | null
  isAlive: (pid: number) => boolean
  pathEnv?: string
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  deadlineMs?: number
  pollMs?: number
}

type WorkerState = { ready: true; pid: number } | { ready: false; why: string; final: boolean }

function workerState(folder: string, deps: WorkerReadyDeps): WorkerState {
  if (!deps.isNative(folder)) {
    const pid = deps.dockerNotifierPid(folder)
    return pid !== null && deps.isAlive(pid)
      ? { ready: true, pid }
      : { ready: false, why: 'the notifier daemon is not running (no live pid in .claude/.orcha-notifier.pid)', final: false }
  }
  const st = deps.readState(folder)
  if (!st || st.status !== 'running') {
    return { ready: false, why: `orcha serve is ${st?.status ?? 'not reporting yet (no .orcha/state.json)'}`, final: false }
  }
  const n = st.children?.notifier
  if (n?.status === 'crashlooping') {
    return { ready: false, why: 'the agent worker keeps crashing (serve marked it crashlooping)', final: true }
  }
  if (n?.status === 'running' && typeof n.pid === 'number' && deps.isAlive(n.pid)) return { ready: true, pid: n.pid }
  return { ready: false, why: `the agent worker is ${n?.status ?? 'not started yet'}`, final: false }
}

/** "Start the agent worker" (#295): the worker was started by provisioning itself (native:
 *  `orcha serve` supervises the notifier; Docker: `orcha up` started it), so this step
 *  VERIFIES it is running — polling serve's state.json / the notifier pidfile up to
 *  `deadlineMs` — and checks Claude Code is installed. Every wait is bounded; `log` gets
 *  one line per substep. Never throws; a worker that isn't up yet is a warning, not a
 *  failure (the project already exists). */
export async function checkWorkerReady(
  folder: string,
  deps: WorkerReadyDeps,
  log: (line: string) => void = () => {}
): Promise<{ started: boolean; reason?: string }> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const deadline = now() + (deps.deadlineMs ?? WORKER_READY_DEADLINE_MS)
  const t0 = now()
  const secs = (): string => `${Math.round((now() - t0) / 100) / 10} s`
  let state: WorkerState
  let lastWhy = ''
  for (;;) {
    try {
      state = workerState(folder, deps)
    } catch (err) {
      state = { ready: false, why: `could not read the worker state (${(err as Error)?.message ?? err})`, final: false }
    }
    if (state.ready || state.final || now() >= deadline) break
    if (state.why !== lastWhy) log(`waiting: ${state.why}`)
    lastWhy = state.why
    await sleep(deps.pollMs ?? WORKER_READY_POLL_MS)
  }
  let notReady: string | undefined
  if (state.ready) log(`agent worker running (pid ${state.pid}) after ${secs()}`)
  else {
    log(`agent worker not running after ${secs()}: ${state.why}`)
    notReady = state.final
      ? `Your project is running, but its agent worker keeps crashing, so agents won’t start. ` +
        `See .orcha/logs/notifier.log in the project folder, then restart the project.`
      : `Your project is running, but its agent worker wasn’t up after ${secs()} (${state.why}). ` +
        `It may still be starting; if agents don’t pick up tasks, run \`orcha status\` in the project folder.`
  }
  const pathEnv = deps.pathEnv ?? hostToolPath()
  const claude = await deps.which('claude', pathEnv).catch(() => null)
  log(claude ? `Claude Code found at ${claude}` : 'Claude Code not found on PATH')
  return workerStartResult({ orchaFound: true, claudeFound: !!claude, notReady })
}

/** Production deps: state.json / pidfile reads, a bounded `which` with the host-tool PATH
 *  that includes the user's login-shell PATH (resolved lazily, cached for a minute). */
export const nodeWorkerReadyDeps: WorkerReadyDeps = {
  get pathEnv() {
    return nodeHostWorkerDeps.pathEnv
  },
  which: (cmd, pathEnv) => nodeHostWorkerDeps.which(cmd, pathEnv),
  isNative: (folder) => readNativeConfig(folder) !== null,
  readState: (folder) => readState(folder)?.state ?? null,
  dockerNotifierPid: (folder) => {
    try {
      const pid = Number(fs.readFileSync(path.join(folder, '.claude', '.orcha-notifier.pid'), 'utf8').trim())
      return Number.isInteger(pid) && pid > 0 ? pid : null
    } catch {
      return null
    }
  },
  isAlive: (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (err) {
      return (err as NodeJS.ErrnoException)?.code === 'EPERM'
    }
  }
}

/** The host-tool PATH (with the login shell's PATH) and a bounded `which`. */
export const nodeHostWorkerDeps: { readonly pathEnv: string; which: (cmd: string, pathEnv: string) => Promise<string | null> } = {
  get pathEnv() {
    return hostToolPath(process.env, os.homedir(), loginShellPath())
  },
  which: (cmd, pathEnv) =>
    new Promise((resolve) => {
      execFile(
        '/usr/bin/which',
        [cmd],
        { env: { ...process.env, PATH: pathEnv }, timeout: WHICH_TIMEOUT_MS, killSignal: 'SIGKILL' },
        (err, stdout) => resolve(err ? null : stdout.trim() || null)
      )
    })
}

// ---- bounded `orcha` subprocesses (#295) -------------------------------------------------

/** `orcha up` / `down` / `upgrade` from an app click: a hung CLI (a stuck launchctl, a
 *  login shell that never returns) must end in a clear error, not a forever-"Starting…". */
export const ORCHA_RUN_TIMEOUT_MS = 5 * 60_000
/** After SIGTERM on a timeout, SIGKILL whatever is left this much later. */
export const KILL_GRACE_MS = 5_000

type SpawnLike = (cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }) => ReturnType<typeof spawn>

export interface BoundedRun {
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Overall bound; omitted/0 = unbounded. */
  timeoutMs?: number
  onLine?: (line: string) => void
  /** Short name for messages ("orcha up"). */
  label: string
  spawnImpl?: SpawnLike
}

/** Run a command, streaming stdout lines to `onLine`; resolves on exit 0, rejects with
 *  {stderr} (last 4 KB) otherwise. With `timeoutMs`, it rejects at the deadline — SIGTERM,
 *  then SIGKILL after KILL_GRACE_MS — without waiting for the pipes to close, so a
 *  grandchild still holding stdout can't keep the caller waiting. */
export function runBounded(cmd: string, args: string[], opts: BoundedRun): Promise<void> {
  const doSpawn: SpawnLike = opts.spawnImpl ?? ((c, a, o) => spawn(c, a, o))
  return new Promise((resolve, reject) => {
    let settled = false
    const timers: ReturnType<typeof setTimeout>[] = []
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      for (const t of timers) clearTimeout(t)
      fn()
    }
    const child = doSpawn(cmd, args, { cwd: opts.cwd, env: opts.env })
    let buf = ''
    let tail = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        opts.onLine?.(buf.slice(0, nl))
        buf = buf.slice(nl + 1)
      }
    })
    child.stderr?.on('data', (chunk: string) => {
      tail = (tail + chunk).slice(-4000)
    })
    child.on('error', (err) =>
      settle(() => reject(Object.assign(err, { stderr: `${opts.label} could not be started: ${err.message}` })))
    )
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (buf) opts.onLine?.(buf)
      buf = ''
      settle(() =>
        code === 0
          ? resolve()
          : reject(Object.assign(new Error(`${opts.label} exited ${code ?? signal}`), { stderr: tail.trim() }))
      )
    })
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timers.push(
        setTimeout(() => {
          if (settled) return
          child.kill('SIGTERM')
          const grace = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
          }, KILL_GRACE_MS)
          grace.unref?.()
          child.stdout?.destroy()
          child.stderr?.destroy()
          const mins = opts.timeoutMs! >= 60_000 ? `${Math.round(opts.timeoutMs! / 60_000)} min` : `${Math.round(opts.timeoutMs! / 1000)} s`
          settle(() =>
            reject(
              Object.assign(new Error(`${opts.label} timed out`), {
                timedOut: true,
                stderr:
                  `${opts.label} did not finish within ${mins} and was stopped. Your Mac may be very busy, or a ` +
                  `background step is stuck — check \`orcha status\` in the project folder, then try again.` +
                  (tail.trim() ? `\n${tail.trim()}` : '')
              })
            )
          )
        }, opts.timeoutMs)
      )
    }
  })
}

// scrubWorkerEnv: a notifier `orcha up` starts freezes its env for every agent worker it later
// spawns (see hostToolPath's doc comment) — an inherited ANTHROPIC_API_KEY here breaks every
// subsequent run for the lifetime of the daemon, not just this one `orcha up`.
function execOrcha(folder: string, args: string[], pathEnv: string): Promise<void> {
  return runBounded(orchaBin(), args, {
    cwd: folder,
    env: { ...scrubWorkerEnv(process.env), PATH: pathEnv },
    timeoutMs: ORCHA_RUN_TIMEOUT_MS,
    label: `orcha ${args[0]}`
  })
}

/** Run `orcha <args>` in a project folder; rejects with {stderr} on a non-zero exit. */
export type OrchaRun = (folder: string, args: string[]) => Promise<void>

/** Production OrchaRun (native start/stop, GH #258 D1), with the same PATH + scrubbed env as
 *  the worker check, bounded by ORCHA_RUN_TIMEOUT_MS. */
export const runOrcha: OrchaRun = (folder, args) => execOrcha(folder, args, nodeHostWorkerDeps.pathEnv ?? hostToolPath())

/** `orcha <args>` in a project folder with each stdout line streamed to `onLine` (GH #258 D2:
 *  `orcha init --progress-json`, `orcha migrate-runtime --json`). Same PATH + scrubbed env as
 *  runOrcha; rejects with {stderr} (the last 4 KB) on a non-zero exit, a missing CLI, or —
 *  with `timeoutMs` — a run that does not finish in time. */
export function streamOrcha(
  folder: string,
  args: string[],
  onLine: (line: string) => void,
  timeoutMs?: number
): Promise<void> {
  const pathEnv = nodeHostWorkerDeps.pathEnv ?? hostToolPath()
  return runBounded(orchaBin(), args, {
    cwd: folder,
    env: { ...scrubWorkerEnv(process.env), PATH: pathEnv },
    timeoutMs,
    onLine,
    label: `orcha ${args[0]}`
  })
}
