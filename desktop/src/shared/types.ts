/** Fixed height (CSS px) of the renderer's top bar, shown above the embedded portal view
 *  once a project is open ("← Projects" + name + status dot). Shared between main (embedded
 *  portal view bounds — see main/viewBounds.ts) and the renderer (the TopBar component's own
 *  height) so the view's top edge always lines up exactly with the bar's bottom edge — no
 *  gap, no overlap. Replaces the removed left icon rail (RAIL_WIDTH) — navigation is now a
 *  project-cards home screen + this bar, not a permanent side rail. */
export const TOPBAR_HEIGHT = 40

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

// ---- Home screen: per-container project cards (GET /api/containers) --------------------
// Mirrors the cloud hub's ProjectsPage contract (resources/orcha-templates/portal/frontend/
// src/cloud/projects/ProjectsPage.tsx + its portal_backend route) — the desktop home renders
// one card per container, not per stack, since a stack can (per mig 037) hold more than one
// project. `github_repo === 'local'` is the LOCAL-binding sentinel (see RepoBadge upstream).

export interface ProjectContainer {
  id: string
  name: string
  description: string | null
  status: string | null
  github_repo: string | null
  agents: number
  tasks: number
  needs_you: number
  member_count: number | null
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
  // ---- add project / from GitHub ----
  | { code: 'GIT_NOT_INSTALLED' }
  | { code: 'INVALID_REPO_URL'; reason: string }
  | { code: 'DEST_NOT_EMPTY' }
  | { code: 'CLONE_FAILED'; stderr: string }
  // ---- fleet suggestion ----
  | { code: 'PORTAL_REQUEST_FAILED'; status: number }
  | { code: 'INVALID_PORTAL_REQUEST' }

/** Discriminated IPC result — structured errors survive the IPC boundary
 *  (thrown Errors get flattened to message strings by ipcMain.handle). */
export type IpcResult<T> = { ok: true; data: T } | ({ ok: false } & BridgeError)

// ---- Onboarding / provisioning ----

/** Which framing the provisioning wizard shows: 'first-run' is the zero-stack onboarding
 *  path, 'add-project' is launched from an existing manager (button or File→Add Project).
 *  Same steps, same components — only copy (and step 0's "welcome" framing) differs. */
export type WizardVariant = 'first-run' | 'add-project'

export type ProvisionMode = 'init' | 'upgrade' | 'reset'

export type ProvisionStep =
  | 'preflight'
  | 'clone-repo'
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
  /** True when the folder already contains a .git dir. Drives the "git init" tip shown
   *  after a successful provision — Orcha never runs git itself. */
  isGitRepo: boolean
}

export interface FolderChoice {
  /** Absolute canonical path of the chosen (or to-be-created) folder. */
  folder: string
  mode: FolderMode
}

// ---- Add project / From GitHub ----

/** One repo from `gh repo list`, offered when the host's gh CLI is authenticated. */
export interface GhRepo {
  nameWithOwner: string
  description: string | null
}

/** Whether the host's `gh` CLI is installed AND logged in (checked fresh each time —
 *  never assumed). false means the GitHub source falls back to the URL-only field.
 *  `gitInstalled` gates the whole source — cloning needs `git` regardless of gh. */
export interface GithubStatus {
  authenticated: boolean
  gitInstalled: boolean
}

/** Suggested clone destination for a repo: the folder containing the user's existing
 *  stacks (or ~/orcha-projects) plus the repo's sanitized name. Purely a suggestion — the
 *  folder picker lets the user override the parent. */
export interface CloneDestSuggestion {
  parent: string
  repoName: string
}

export interface CloneAndProvisionOptions {
  /** https:// repo URL, already validated client-side (server re-validates). */
  repoUrl: string
  /** Absolute destination directory; must not exist or must be empty. */
  dest: string
}

/** The full surface the preload bridge exposes as window.orchaDesktop.
 *  Rejections are BridgeError objects (the preload re-throws ok:false results). */
export interface OrchaDesktopApi {
  listStacks(): Promise<Stack[]>
  startStack(project: string): Promise<void>
  stopStack(project: string): Promise<void>
  /** Switch the main window's embedded portal view to this stack (creating it on first
   *  use) and show it, covering the content area right of the rail. Replaces the old
   *  "open a new BrowserWindow" behavior — there is only ever one app window. */
  portalShow(project: string, path?: string): Promise<void>
  /** Hide whichever embedded portal view is currently showing, returning to the
   *  renderer's own content (home/manager or the wizard). The view is kept alive
   *  (not destroyed) so switching back to it is instant and its state is preserved. */
  portalHide(): Promise<void>
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
  // add project / from GitHub:
  /** Whether the host's gh CLI is installed and authenticated. */
  githubStatus(): Promise<GithubStatus>
  /** The user's repos via `gh repo list` (only meaningful when githubStatus().authenticated). */
  githubRepos(): Promise<GhRepo[]>
  /** Suggested <parent>/<repoName> destination for a repo, before the user picks/overrides
   *  the parent via pickFolder('new-blank'). */
  suggestCloneDest(repoUrl: string): Promise<CloneDestSuggestion>
  /** Pick the destination's parent directory (reuses the folder picker with "New Folder"
   *  enabled), returning the resolved <parent>/<repoName>, or null if the dest is non-empty
   *  or the user cancelled. */
  pickCloneDest(repoName: string): Promise<string | null>
  /** Clone the repo, then run the same provision pipeline on it (mode 'init' — a freshly
   *  cloned repo is never already .orcha-initialized). Streams BOTH clone and provision
   *  progress on onProvisionProgress, as 'clone-repo' then the usual provision steps. */
  cloneAndProvision(opts: CloneAndProvisionOptions): Promise<ProvisionResult>
  openOnboardingPortal(project: string): Promise<void>
  /** Open an https URL in the user's default browser (e.g. the Docker download page). */
  openExternal(url: string): Promise<void>
  /** Subscribe to provision progress; returns an unsubscribe fn. */
  onProvisionProgress(cb: (e: ProgressEvent) => void): () => void
  /** Subscribe to main→renderer navigation requests (e.g. File→Add Project). `variant`
   *  distinguishes the provisioning wizard's framing when target is 'onboarding'; absent
   *  for plain 'manager' navigation. */
  onNavigate(cb: (nav: { target: 'onboarding' | 'manager'; variant?: WizardVariant }) => void): () => void
  /** Subscribe to which stack's embedded portal view is active (main is the source of
   *  truth — a notification click or deep link can change it without any renderer click).
   *  `project` is null when no view is showing (home/manager or the wizard is on screen). */
  onPortalActive(cb: (active: { project: string | null }) => void): () => void
  // fleet (post-provision):
  /** GET a JSON path on a stack's own localhost portal (port + path validated in main —
   *  the renderer can't reach localhost directly under sandbox:true). Rejects with
   *  {code:'PORTAL_REQUEST_FAILED', status} on a non-2xx response (the Fleet step treats
   *  404 — and any other non-200 — as "this portal predates the endpoint" and auto-skips). */
  portalGet(apiPort: number, path: string): Promise<unknown>
  /** POST a JSON body to a path on a stack's own localhost portal. Same port/path
   *  validation and error shape as portalGet. */
  portalPost(apiPort: number, path: string, body: unknown): Promise<unknown>
  /** PUT a JSON body to a path on a stack's own localhost portal. Same port/path
   *  validation and error shape as portalGet — used by the code-source auto-bind (PUT
   *  .../github) and the roster analysis persist call. */
  portalPut(apiPort: number, path: string, body: unknown): Promise<unknown>
  /** Deep roster analysis of `folder` via the user's own local Claude Code subscription.
   *  Never rejects — {ok:false, reason} on any failure (claude absent, timeout, malformed
   *  output); the caller (FleetStep) treats that as "nothing to show", not an error. */
  analyzeProject(folder: string): Promise<AnalyzeProjectResult>
}

// ---- Fleet suggestion (post-provision "Meet your suggested fleet" step) -----------------
// GET .../roster/suggest is a newer portal endpoint — older/open CLI portals may 404 (or any
// other non-200), in which case the Fleet step auto-skips itself entirely and silently.

export interface RosterSuggestion {
  alias: string
  role: string
  focus: string
  is_main: boolean
  rationale: string
}

export interface RosterSuggestResponse {
  available: boolean
  project_kind: string
  signals: string[]
  suggestions: RosterSuggestion[]
}

export interface RosterAcceptResult {
  created: string[]
}

// ---- Deep roster analysis (local Claude Code subscription) ------------------------------
// Runs the host `claude` CLI once against a compact README+tree prompt. Never throws —
// {ok:false, reason} on any failure (claude absent, timeout, malformed output).

export interface AnalyzeAgentSuggestion {
  alias: string
  role: string
  focus: string
  rationale: string
}

export type AnalyzeProjectResult =
  | { ok: true; summary: string; agents: AnalyzeAgentSuggestion[] }
  | { ok: false; reason: string }

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
