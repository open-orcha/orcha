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
  /** Absolute project root on disk (parent of .orcha), from the compose working_dir label;
   *  null when the label is absent. Used by Delete & reset to clean on-disk artifacts. */
  folder: string | null
}

export type BridgeError =
  | { code: 'DOCKER_UNAVAILABLE' }
  | { code: 'COMPOSE_FAILED'; stderr: string }
  | { code: 'UNKNOWN_STACK' }
  | { code: 'INTERNAL' }
  // ---- onboarding / provisioning ----
  | { code: 'DOCKER_NOT_INSTALLED' }
  | { code: 'DOCKER_START_TIMEOUT' }
  | { code: 'PORT_UNAVAILABLE' }
  | { code: 'TEMPLATES_MISSING' }
  | { code: 'ALREADY_INITIALIZED' }
  | { code: 'PORTAL_TIMEOUT' }
  | { code: 'CONTAINER_EXISTS' }
  | { code: 'PROVISION_FAILED'; step: ProvisionStep; stderr: string }

/** Discriminated IPC result — structured errors survive the IPC boundary
 *  (thrown Errors get flattened to message strings by ipcMain.handle). */
export type IpcResult<T> = { ok: true; data: T } | ({ ok: false } & BridgeError)

// ---- Onboarding / provisioning ----

export type ProvisionMode = 'init' | 'upgrade' | 'reset'

export type ProvisionStep =
  | 'preflight'
  | 'render-compose'
  | 'copy-templates'
  | 'compose-up'
  | 'wait-portal'
  | 'create-container'
  | 'register-human'
  | 'start-daemons'

export type ProgressEvent =
  | { runId: string; step: ProvisionStep; status: 'start' | 'ok' | 'skip' }
  | { runId: string; step: ProvisionStep; status: 'log'; line: string }
  | {
      runId: string
      step: ProvisionStep
      status: 'fail'
      code: BridgeError['code']
      detail: string
    }

export interface ProvisionOptions {
  /** Absolute, canonical path to the project folder (folder must already exist). */
  folder: string
  mode: ProvisionMode
  /** Project name; defaults to the sanitized folder basename when omitted. */
  name?: string
  /** Container objective; defaults to the folder basename when omitted. */
  objective?: string
  /** First human's alias; defaults to $USER or 'operator'. */
  alias?: string
}

export interface ProvisionResult {
  project: string
  apiPort: number
  /** Warnings from non-fatal steps (human/daemon), shown but not failing. */
  warnings: string[]
}

export type DockerState = 'ok' | 'not-installed' | 'daemon-down' | 'app-translocated'

export interface PreflightReport {
  docker: DockerState
  /** True after a successful auto-start of Docker Desktop. */
  autoStarted: boolean
  /** Human-readable next-step hint when docker !== 'ok'. */
  hint: string | null
}

// ---- Prerequisites / auto-install ----

/** The host-side tools Orcha needs that the Docker stack can't provide. Agents run as a
 *  host `claude -p` process launched by the orcha CLI, so a fresh Mac needs all of these
 *  before assigned tasks actually run. */
export type Prereq = 'homebrew' | 'dockerEngine' | 'orcha' | 'claude' | 'apiKey'

/** What's already present on this Mac. Each false → one install step. */
export interface PrereqProbe {
  /** `brew` resolves on PATH. */
  homebrew: boolean
  /** A `docker` CLI resolves on PATH (Colima, Docker Desktop, or OrbStack). */
  dockerEngine: boolean
  /** `orcha` CLI resolves on PATH. */
  orcha: boolean
  /** `claude` (Claude Code) resolves on PATH. */
  claude: boolean
  /** `codex` (OpenAI Codex CLI) resolves on PATH. Either claude or codex satisfies the
   *  "AI coding agent" requirement. */
  codex: boolean
  /** An Anthropic API key is available to the agent worker. */
  apiKey: boolean
}

/** A single shell command in an install step. `admin` actions run as root via the native
 *  macOS password / Touch ID popup; `user` actions run as the logged-in user. */
export interface InstallAction {
  kind: 'user' | 'admin'
  script: string
}

/** One installable prerequisite, in plain language, plus the commands that install it.
 *  `apiKey` carries no actions — it's handled by prompting for + storing the key. */
export interface InstallStep {
  id: Prereq
  /** Short plain-English name shown to a non-engineer. */
  title: string
  /** One line on what it is / why it's needed (shown before installing). */
  detail: string
  actions: InstallAction[]
}

/** Streamed install progress (main → renderer). */
export type InstallProgress =
  | { id: Prereq; status: 'start' | 'ok' | 'skip'; title: string }
  | { id: Prereq; status: 'log'; line: string }
  | { id: Prereq; status: 'fail'; title: string; detail: string }

export type InstallResult =
  | { ok: true; completed: Prereq[] }
  | { ok: false; completed: Prereq[]; failedAt: Prereq; detail: string }

export type FolderMode = 'existing' | 'new-blank' | 'reconnect'

export interface FolderState {
  /** True when the folder already contains .orcha/docker-compose.yml. */
  initialized: boolean
  writable: boolean
  /** Sanitized project name derived from the folder basename. */
  suggestedName: string
}

export interface FolderChoice {
  /** Absolute canonical path of the chosen (or to-be-created) folder. */
  folder: string
  mode: FolderMode
}

/** The full surface the preload bridge exposes as window.orchaDesktop.
 *  Rejections are BridgeError objects (the preload re-throws ok:false results). */
export interface OrchaDesktopApi {
  listStacks(): Promise<Stack[]>
  startStack(project: string): Promise<void>
  stopStack(project: string): Promise<void>
  openPortal(project: string, path?: string): Promise<void>
  /** Destructively delete a stack: down -v + remove its portal image + on-disk Orcha files.
   *  Irreversible; the renderer gates it behind a type-to-confirm prompt. */
  resetStack(project: string): Promise<void>
  listAttention(): Promise<AttentionItem[]>
  openManager(): Promise<void>
  quitApp(): Promise<void>
  // onboarding:
  preflight(): Promise<PreflightReport>
  /** Check which host prerequisites (Homebrew, Docker engine, orcha, Claude Code, API key)
   *  are already installed. */
  probePrereqs(): Promise<PrereqProbe>
  /** Install whatever prerequisites are missing, guided by native dialogs (one Mac-password
   *  prompt for Homebrew's folder, one prompt for the API key). Streams progress via
   *  onInstallProgress; resolves with what completed / where it stopped. */
  installPrereqs(): Promise<InstallResult>
  /** Subscribe to install progress; returns an unsubscribe fn. */
  onInstallProgress(cb: (e: InstallProgress) => void): () => void
  pickFolder(mode: FolderMode): Promise<FolderChoice | null>
  inspectFolder(folder: string): Promise<FolderState>
  provision(opts: ProvisionOptions): Promise<ProvisionResult>
  openOnboardingPortal(project: string): Promise<void>
  /** Open an https URL in the user's default browser (e.g. the Docker download page). */
  openExternal(url: string): Promise<void>
  /** Subscribe to provision progress; returns an unsubscribe fn. */
  onProvisionProgress(cb: (e: ProgressEvent) => void): () => void
  /** Subscribe to main→renderer navigation requests (e.g. File→New Project). */
  onNavigate(cb: (target: 'onboarding' | 'manager') => void): () => void
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
