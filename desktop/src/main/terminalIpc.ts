/** Terminal IPC controller: validates every renderer request and turns it into PtyHost calls.
 *  Electron-free (index.ts adapts ipcMain events to `SenderFacts`), so the whole security
 *  surface — who may call, which kinds, which folders — is covered by terminalIpc.test.ts. */
import {
  isTermKind,
  parseCreateRequest,
  parseResize,
  parseTermId,
  parseWrite,
  type TermInfo,
  type TermKind
} from '../shared/terminal'
import type { PtyHost } from './ptyHost'
import type { GitWorktree } from './checkouts'
import { buildLaunch, buildTermEnv, resolveCwd, resolveShell, type AgentLaunch, type KnownProject } from './terminalLaunch'
import type { AgentId } from '../shared/agents'
import type { HookMode } from './agentStatus'
import { withResume, type ResumePlan, type RestoreItem } from './sessionRestore'

/** A restored session's pty size before its view measures itself (it resizes on first fit). */
const RESTORE_COLS = 100
const RESTORE_ROWS = 24

/** Facts about an IPC sender, gathered by index.ts from the Electron event. */
export interface SenderFacts {
  /** event.sender is the manager window's webContents (not a portal view, not the tray). */
  isHostRenderer: boolean
  /** event.senderFrame is that webContents' main frame (no iframes). */
  isMainFrame: boolean
}

/** Only the host renderer's main frame may touch ptys. The embedded portal (a remote origin
 *  in its own WebContentsView with its own preload) and the tray popover never can. */
export function acceptTermSender(f: SenderFacts): boolean {
  return f.isHostRenderer === true && f.isMainFrame === true
}

export interface TermControllerDeps {
  host: PtyHost
  listProjects(): Promise<KnownProject[]>
  env: NodeJS.ProcessEnv
  /** The app's resolved appearance, for COLORFGBG in new terminals. */
  theme?: () => 'light' | 'dark'
  home: string
  exists(p: string): boolean
  isDir(p: string): boolean
  /** `git worktree list` of a project folder (null = not a repo / git missing). Optional so
   *  an older wiring still works — sessions then carry no branch. */
  readWorktrees?(folder: string): Promise<GitWorktree[] | null>
  /** Agents settings (main/agentsIpc.ts): the resolved binary + argv for an agent kind —
   *  permission-mode flag, the user's validated extra args, or `--version` for a probe.
   *  Optional: without it agents launch by name with no arguments (the pre-registry rule). */
  agentLaunch?(id: AgentId, probe: boolean): AgentLaunch
  /** Agent lifecycle hooks (main/agentHooks.ts): argv additions for a hooked launch (null =
   *  this launch runs without hooks) and the endpoint file the hook script reads. Optional:
   *  absent (or the receiver failed to start) = every session uses the output heuristics. */
  hooks?: TermControllerHooks
}

export type TermControllerHooks = {
  wire(id: AgentId, args: readonly string[], probe: boolean): { args: string[]; mode: HookMode } | null
  endpointFile: string
} | null

function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') : p)
  return norm(a) === norm(b)
}

/** Where a session for (project folder, requested branch) starts, and which branch that is.
 *  Pure — terminalIpc.test.ts. A requested branch must be a real checkout of the folder's
 *  repo (its worktree directory must exist); no branch = the project folder itself, whose
 *  branch is looked up for grouping only. */
export function resolveCheckout(
  folder: string,
  requested: string | null,
  worktrees: GitWorktree[] | null,
  isDir: (p: string) => boolean
): { cwd: string; branch: string | null } | null {
  if (requested === null) {
    const here = worktrees?.find((w) => samePath(w.path, folder)) ?? null
    return { cwd: folder, branch: here?.branch ?? null }
  }
  const tree = worktrees?.find((w) => !w.bare && w.branch === requested) ?? null
  if (!tree || !tree.path.startsWith('/') || tree.path.includes('\0') || !isDir(tree.path)) return null
  return { cwd: tree.path, branch: tree.branch }
}

export class TermRequestError extends Error {
  constructor(
    readonly code: 'FORBIDDEN' | 'INVALID' | 'UNKNOWN_STACK' | 'UNKNOWN_BRANCH' | 'SPAWN_FAILED',
    message: string = code
  ) {
    super(message)
  }
}

export function createTermController(deps: TermControllerDeps) {
  const guard = (f: SenderFacts): void => {
    if (!acceptTermSender(f)) throw new TermRequestError('FORBIDDEN')
  }
  /** Compose the argv (agent launch + hooks + optional resume) and spawn. */
  const spawnSession = (o: {
    kind: TermKind
    project: string | null
    cwd: string
    branch: string | null
    note: string | null
    probe: boolean
    cols: number
    rows: number
    resume?: ResumePlan
    agentSession?: string | null
  }): TermInfo => {
    const shell = resolveShell(deps.env.SHELL, deps.exists)
    const probe = o.probe
    let hooks: { mode: HookMode; endpointFile: string } | null = null
    let plan
    if (o.kind === 'shell') plan = buildLaunch('shell', shell)
    else {
      let launch: AgentLaunch = deps.agentLaunch?.(o.kind, probe) ?? { path: null, args: probe ? ['--version'] : [] }
      const wired = deps.hooks ? deps.hooks.wire(o.kind, launch.args, probe) : null
      if (wired && deps.hooks) {
        launch = { ...launch, args: wired.args }
        hooks = { mode: wired.mode, endpointFile: deps.hooks.endpointFile }
      }
      if (!probe && o.resume) launch = { ...launch, args: withResume(o.kind, launch.args, o.resume) }
      plan = buildLaunch(o.kind, shell, launch)
    }
    try {
      return deps.host.create({
        kind: o.kind,
        project: o.project,
        file: plan.file,
        args: plan.args,
        cwd: o.cwd,
        branch: o.branch,
        ...(probe ? { probe: true } : {}),
        note: o.note,
        shell,
        cols: o.cols,
        rows: o.rows,
        env: buildTermEnv(deps.env, deps.theme?.()),
        ...(hooks ? { hooks } : {}),
        ...(o.kind !== 'shell' && o.agentSession ? { agentSession: o.agentSession } : {})
      })
    } catch (err) {
      throw new TermRequestError('SPAWN_FAILED', err instanceof Error ? err.message : String(err))
    }
  }
  return {
    async create(f: SenderFacts, raw: unknown): Promise<TermInfo> {
      guard(f)
      const req = parseCreateRequest(raw)
      if (!req) throw new TermRequestError('INVALID')
      let known: KnownProject | null = null
      if (req.project !== null) {
        const projects = await deps.listProjects()
        known = projects.find((p) => p.project === req.project) ?? null
        if (!known) throw new TermRequestError('UNKNOWN_STACK')
      }
      const resolved = resolveCwd(known, deps.home, deps.isDir)
      let cwd = resolved.cwd
      const note = resolved.note
      let branch: string | null = null
      const requested = req.branch ?? null
      if (known && note === null && deps.readWorktrees) {
        const trees = await deps.readWorktrees(cwd).catch(() => null)
        const checkout = resolveCheckout(cwd, requested, trees, deps.isDir)
        if (!checkout) throw new TermRequestError('UNKNOWN_BRANCH')
        cwd = checkout.cwd
        branch = checkout.branch
      } else if (requested !== null) {
        throw new TermRequestError('UNKNOWN_BRANCH')
      }
      return spawnSession({ kind: req.kind, project: known ? known.project : null, cwd, branch, note, probe: req.probe === true, cols: req.cols, rows: req.rows })
    },
    /** Start a session the app restored from its own saved tab set (main/sessionRestore.ts —
     *  already validated there: a known kind, a known project, a cwd inside $HOME or a known
     *  project folder, a UUID conversation id). Never reachable from the renderer directly. */
    restoreSpawn(item: RestoreItem): TermInfo {
      if (!isTermKind(item.kind) || !item.cwd.startsWith('/') || !deps.isDir(item.cwd)) throw new TermRequestError('INVALID')
      return spawnSession({
        kind: item.kind,
        project: item.project ? item.project.project : null,
        cwd: item.cwd,
        branch: item.saved.branch,
        note: null,
        probe: false,
        cols: RESTORE_COLS,
        rows: RESTORE_ROWS,
        resume: item.resume,
        agentSession: item.agentSession
      })
    },
    write(f: SenderFacts, raw: unknown): boolean {
      if (!acceptTermSender(f)) return false
      const w = parseWrite(raw)
      return w ? deps.host.write(w.id, w.data) : false
    },
    resize(f: SenderFacts, raw: unknown): boolean {
      if (!acceptTermSender(f)) return false
      const r = parseResize(raw)
      return r ? deps.host.resize(r.id, r.cols, r.rows) : false
    },
    kill(f: SenderFacts, raw: unknown): boolean {
      guard(f)
      const id = parseTermId(raw)
      if (id === null) throw new TermRequestError('INVALID')
      return deps.host.kill(id)
    },
    list(f: SenderFacts): TermInfo[] {
      guard(f)
      return deps.host.list()
    }
  }
}

export type TermController = ReturnType<typeof createTermController>

/** ⌘W (File › Close): close the active terminal TAB only when the manager window is the
 *  focused window, its own webContents (not the portal view) holds focus, and the renderer
 *  reported focus inside the terminal dock; otherwise close the focused window as before. */
export function closeAction(f: { focusedIsManager: boolean; managerContentsFocused: boolean; termFocused: boolean }): 'tab' | 'window' {
  return f.focusedIsManager && f.managerContentsFocused && f.termFocused ? 'tab' : 'window'
}
