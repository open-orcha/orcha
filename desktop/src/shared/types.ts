/** One orcha-* Docker compose stack (stack:db:container is 1:1:1 per orcha's model). */
export interface Stack {
  /** Full compose project name, e.g. "orcha-todo-app". */
  project: string
  /** Display name with the "orcha-" prefix stripped, e.g. "todo-app". */
  projectShort: string
  /** Host port mapped to the portal's container port 8000; null when unpublished (stopped). */
  apiPort: number | null
  /** Host port mapped to postgres 5432; null when unpublished (stopped). */
  dbPort: number | null
  /** Raw docker status of the portal container, e.g. "Up 3 hours" / "Exited (0) 2 days ago". */
  portalStatus: string
  /** True iff portalStatus starts with "Up". */
  running: boolean
}

export type BridgeError =
  | { code: 'DOCKER_UNAVAILABLE' }
  | { code: 'COMPOSE_FAILED'; stderr: string }
  | { code: 'UNKNOWN_STACK' }
  | { code: 'WORKSPACE_INIT_FAILED'; stderr: string }
  | { code: 'WORKSPACE_CANCELLED' }
  | { code: 'INTERNAL' }

/** A dependency the desktop app bootstraps before `orcha init` can run. */
export type DependencyName = 'homebrew' | 'docker' | 'cli'

export interface DependencyStatus {
  name: DependencyName
  /** True iff the tool's CLI is on PATH. */
  installed: boolean
  /** Docker only: whether the daemon is reachable (not just the CLI present). */
  running?: boolean
  /** First line of the tool's `--version` output, or null if absent. */
  version: string | null
}

/** Snapshot of the first-launch dependency check (Homebrew / Docker / Orcha CLI). */
export interface BootstrapStatus {
  homebrew: DependencyStatus
  docker: DependencyStatus
  cli: DependencyStatus
  /** True iff `orcha init` can run right now (CLI present + Docker daemon up). */
  ready: boolean
}

/** One human-runnable step to install/start a missing dependency. Surfaced, never auto-run. */
export interface InstallStep {
  name: DependencyName
  label: string
  command: string
  docsUrl: string
}

/** A workspace created by `orcha init` (the menu's File → New Workspace). */
export interface WorkspaceResult {
  /** Full compose project name, e.g. "orcha-todo-app". */
  project: string
  /** Display name with the "orcha-" prefix stripped. */
  projectShort: string
  /** Absolute path of the folder `orcha init` ran in. */
  dir: string
}

/** Discriminated IPC result — structured errors survive the IPC boundary
 *  (thrown Errors get flattened to message strings by ipcMain.handle). */
export type IpcResult<T> = { ok: true; data: T } | ({ ok: false } & BridgeError)

/** The full surface the preload bridge exposes as window.orchaDesktop.
 *  Rejections are BridgeError objects (the preload re-throws ok:false results). */
export interface OrchaDesktopApi {
  listStacks(): Promise<Stack[]>
  startStack(project: string): Promise<void>
  stopStack(project: string): Promise<void>
  openPortal(project: string, path?: string): Promise<void>
  listAttention(): Promise<AttentionItem[]>
  openManager(): Promise<void>
  quitApp(): Promise<void>
  /** First-launch dependency snapshot (Homebrew / Docker / Orcha CLI). Read-only. */
  checkDependencies(): Promise<BootstrapStatus>
  /** Pick a folder and run `orcha init` there. Rejects WORKSPACE_CANCELLED if the user
   *  dismisses the picker. */
  newWorkspace(): Promise<WorkspaceResult>
}

/** One thing waiting on the human, surfaced in tray/popover/notifications/cards. */
export interface AttentionItem {
  project: string
  projectShort: string
  kind: 'request_answer' | 'request_close' | 'task_verify' | 'health'
  /** Stable id for dedup (request/task uuid, or health:<project>:<up|down>). */
  id: string
  title: string
  /** Portal path for this item (e.g. /requests?req=<id>); '/' for health items. */
  path: string
}
