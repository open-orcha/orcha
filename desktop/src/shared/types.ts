import type { TermApi } from './terminal'
import type { AgentsApi } from './agents'
import type { UsageApi } from './usage'
import type { ThemeApi } from './theme'
import type { ProfileApi } from './profile'
import type { ProviderKeysApi } from './providerKeys'
import type { MicApi } from './mic'
import type { EmbedEvent, EmbedMode, HostToPortal, PortalToHost } from './embed'
import type { ProjectIcon } from './projectIcon'

/** What main broadcasts on `orcha:portalActive`. `embed`/`route` are V2 additions; an
 *  older main omits them (treated as legacy by the renderer only if explicitly 'legacy'). */
export interface PortalActive {
  project: string | null
  embed?: EmbedMode | null
  route?: Extract<PortalToHost, { type: 'route' }> | null
}

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

// ---- Remove project / Storage -------------------------------------------------------------

/** "Remove project…" levels. Default (both false) = Remove from Embodent: containers, sandboxes,
 *  network, portal image and host daemons go; the data volume and every file stay. */
export interface RemoveOptions {
  /** Also delete the stack's volumes (tasks, agents, history) — irreversible, typed confirm. */
  deleteData: boolean
  /** Also remove Embodent's own files from the project folder (never the user's code). */
  removeFiles: boolean
  /** With removeFiles: first save agent worktrees' output (attached to its task while the
   *  portal still runs, else copied to .orcha/saved-output/<branch>/, which is kept). Default
   *  true; when false, worktrees with output are kept instead. */
  saveOutput?: boolean
}

export type RemovePhase = 'stopping' | 'removing' | 'deleting-data' | 'removing-files' | 'cleaning'

export interface SizedName {
  name: string
  /** Bytes, null when docker didn't report it. */
  size: number | null
}

/** Exactly what a removal would touch (exact names, by compose label). */
export interface RemovePlan {
  project: string
  projectShort: string
  folder: string | null
  /** The folder demonstrably belongs to this project (else it's never touched). */
  folderMatches: boolean
  containers: string[]
  sandboxes: string[]
  networks: string[]
  images: SizedName[]
  volumes: SizedName[]
  daemonPidFiles: string[]
  /** Embodent's files present in the folder (relative), removed only with removeFiles. */
  folderFiles: string[]
  worktrees: Array<{
    path: string
    branch: string | null
    /** The CLI's classification (absent when the CLI is too old to say). Embodent's own
     *  scaffolding never counts as a change. */
    state?: AgentWorktreeState
    /** has-output: the files that would be saved first. */
    files?: string[]
    size?: number | null
  }>
}

export interface RemoveResult {
  project: string
  projectShort: string
  dataDeleted: boolean
  filesRemoved: boolean
  /** Plain-words lines of what was removed / kept, and anything left with a reason. */
  removed: string[]
  kept: string[]
  warnings: string[]
}

// ---- Agent worktrees (orcha worktrees --json; orcha_cli/worktree_gc.py) -------------------

export type AgentWorktreeState = 'clean' | 'has-output' | 'unmerged' | 'in-use' | 'not-quorate'

export interface AgentWorktree {
  path: string
  name: string
  branch: string | null
  kind: string | null
  agent: string | null
  state: AgentWorktreeState
  reason?: string
  task_id?: string | null
  task_title?: string | null
  unmerged_commits?: number | null
  output?: string[]
  modified?: string[]
  output_count?: number
  modified_count?: number
  size_bytes?: number | null
  last_activity_at?: string | null
}

export interface ProjectWorktrees {
  project: string
  projectShort: string
  folder: string
  items: AgentWorktree[]
  reclaimable_bytes: number
  /** Plain words when this project's worktrees couldn't be read (e.g. an old CLI). */
  error?: string
}

export interface WorktreeCleanRequest {
  folder: string
  /** Preview only — nothing changes. */
  dryRun: boolean
  /** Leave worktrees with output alone. */
  onlyClean: boolean
  /** Unmerged worktrees to remove anyway (their branches are kept). */
  unmerged: string[]
}

export interface WorktreeCleanEntry {
  path: string
  name: string
  branch: string | null
  state: AgentWorktreeState
  size_bytes?: number | null
  reason?: string
  /** dry run: files that would be saved first */
  saves?: string[]
  keep_branch?: boolean
}

export interface AgentWorktreeCleanResult {
  folder: string
  dryRun: boolean
  removed: WorktreeCleanEntry[]
  kept: WorktreeCleanEntry[]
  skipped: WorktreeCleanEntry[]
  freed_bytes: number
}

export type StorageItemKind = 'image' | 'volume' | 'network' | 'container'

export interface StorageItem {
  kind: StorageItemKind
  name: string
  /** The compose project it belonged to (orcha-*), null when unknown (a sandbox). */
  project: string | null
  size: number | null
  /** Plain words: why it's listed / what removing it means. */
  note: string
}

export interface StorageReport {
  items: StorageItem[]
  /** Compose projects that still have a stack (their resources are never listed). */
  inUse: string[]
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
  /** D14 (additive): the project's shared icon (portal `containers.icon`, mig 050), validated
   *  on read. `undefined` = the portal predates the store; `null` = unset (default glyph). */
  icon?: ProjectIcon | null
}

export type BridgeError =
  /** `unresponsive`: the docker CLI timed out (Docker Desktop wedged) rather than refusing
   *  the connection — "isn't responding, quit and reopen", not "isn't running". */
  | { code: 'DOCKER_UNAVAILABLE'; unresponsive?: boolean }
  | { code: 'COMPOSE_FAILED'; stderr: string }
  | { code: 'UNKNOWN_STACK' }
  /** Terminal: the requested branch is not a checkout of the project's repo (any more). */
  | { code: 'UNKNOWN_BRANCH' }
  | { code: 'INTERNAL' }
  /** Terminal tabs: the request was refused (FORBIDDEN sender / INVALID payload) or the pty
   *  could not start (SPAWN_FAILED, with node-pty's message for the tab to show). */
  | { code: 'TERMINAL_FAILED'; reason: 'FORBIDDEN' | 'INVALID' | 'SPAWN_FAILED'; message?: string }
  | { code: 'AGENTS_FAILED'; reason: 'FORBIDDEN' | 'INVALID' }
  | { code: 'USAGE_FAILED'; reason: 'FORBIDDEN' | 'INVALID' }
  /** Settings › Appearance: a mode other than system/light/dark, or a foreign sender. */
  | { code: 'INVALID_THEME' }
  /** Settings › Profile: a non-string / over-long name, or a foreign sender. */
  | { code: 'INVALID_PROFILE' }
  /** Settings › API keys: a malformed save (bad provider / key / switch), or a foreign sender. */
  | { code: 'INVALID_PROVIDER_KEYS' }
  /** Microphone (dictation): a sender that isn't our window or an embedded portal view. */
  | { code: 'INVALID_MIC' }
  /** Settings › Storage: the item isn't a leftover the current scan offers (or no confirm). */
  | { code: 'INVALID_STORAGE_ITEM' }
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
  /** True when the Docker CLI hung (probe timed out) rather than refused — Docker Desktop is
   *  wedged, so the UI should offer "restart Docker" instead of waiting longer. */
  unresponsive?: boolean
}

// ---- Prerequisites / auto-install ----

/** The host-side tools Orcha needs that the Docker stack can't provide. Agents run as a
 *  host `claude -p` process launched by the orcha CLI, so a fresh Mac needs all of these
 *  before assigned tasks actually run. */
export type Prereq = 'homebrew' | 'dockerEngine' | 'orcha' | 'claude'

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
}

/** A single shell command in an install step. `admin` actions run as root via the native
 *  macOS password / Touch ID popup; `user` actions run as the logged-in user. */
export interface InstallAction {
  kind: 'user' | 'admin'
  script: string
}

/** One installable prerequisite, in plain language, plus the commands that install it. */
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
  /** What "Remove project…" would remove / keep (with sizes) — the dialog's summary. */
  removePlan?(project: string): Promise<RemovePlan>
  /** Remove a project from Embodent (see RemoveOptions). Progress arrives on onRemoveProgress. */
  removeProject?(project: string, opts: RemoveOptions): Promise<RemoveResult>
  onRemoveProgress?(cb: (e: { project: string; phase: RemovePhase }) => void): () => void
  /** Settings › Storage: Embodent leftovers whose project no longer has a stack. */
  storageScan?(): Promise<StorageReport>
  /** Remove one leftover (re-validated against a fresh scan; a volume needs `confirm` = its name). */
  storageRemove?(item: { kind: StorageItemKind; name: string; confirm?: string }): Promise<void>
  /** Settings › Storage › Agent worktrees: every known project's worktrees, classified. */
  storageWorktrees?(): Promise<ProjectWorktrees[]>
  /** Preview (dryRun) or run a clean-up of one project's worktrees. */
  storageCleanWorktrees?(req: WorktreeCleanRequest): Promise<AgentWorktreeCleanResult>
  /** Show one agent worktree in Finder (must be inside a known project's .orcha-worktrees). */
  revealWorktree?(folder: string, path: string): Promise<void>
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
   *  `project` is null when no view is showing (home/manager or the wizard is on screen).
   *  V2 (additive): `embed` is that view's embed mode and `route` its last reported route. */
  onPortalActive(cb: (active: PortalActive) => void): () => void
  /** Pull the current active-view state (a reloaded manager renderer asks on mount). */
  getPortalActive?(): Promise<PortalActive | null>
  // ---- V2 host (desktop embedded mode, docs/orcha-v2-architecture.md §7) ----
  /** Attention items plus per-stack availability (unavailable ≠ zero). */
  listAttentionStatus(): Promise<AttentionSnapshot>
  /** Report the host sidebar geometry; main re-lays out the active portal view.
   *  `stripHeight`: the session tab strip at the top of the panel (the view starts under it);
   *  `terminalShown`: a terminal session fills the panel — main hides the portal view. */
  setHostLayout(layout: { sidebarWidth: number; collapsed: boolean; stripHeight?: number; terminalShown?: boolean }): Promise<void>
  /** A host DOM dialog opened/closed — main hides/restores the native view under it. On
   *  close, `focus: 'host'` keeps keyboard focus in the host (default: back to the view). */
  setHostModal(open: boolean, opts?: { focus?: 'host' | 'view' }): Promise<void>
  /** JPEG still of the active portal view (painted under a host overlay while the view is
   *  hidden), or null when no view is showing. */
  portalSnapshot?(): Promise<Uint8Array | null>
  /** Terminal tabs (host renderer only; absent on an older preload). */
  term?: TermApi
  /** Settings › Agents (host renderer only; absent on an older preload). */
  agents?: AgentsApi
  /** Usage & spend (Stats & Usage, the status indicator, the tray popover). */
  usage?: UsageApi
  /** Settings › Appearance (System / Light / Dark; absent on an older preload). */
  theme?: ThemeApi
  /** Settings › Profile (absent on an older preload: the section is hidden). */
  profile?: ProfileApi
  /** Settings › API keys (absent on an older preload: the section is hidden). */
  providerKeys?: ProviderKeysApi
  /** Microphone access for dictation (Settings › Voice). */
  mic?: MicApi
  /** Forward a host → portal message (navigate / openSearch) to the ACTIVE portal view.
   *  Resolves false when there is nothing to deliver to. */
  embedSend(msg: HostToPortal): Promise<boolean>
  /** Validated portal → host messages, tagged with the sending stack (main-derived). */
  onEmbedEvent(cb: (event: EmbedEvent) => void): () => void
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

/** One thing waiting on the human, surfaced in tray/popover/notifications/cards.
 *
 *  Kinds follow the canonical V2 attention definition (docs/orcha-v2-architecture.md §3.1):
 *  - task_plan      — plan awaiting approval (in_progress, plan posted, no decision) — only
 *                     when the project's autonomy level is `plan`;
 *  - task_verify    — task at needs_verification — unless autonomy is `full`;
 *  - request_answer — request open to a human (or untargeted) OR status `escalated`;
 *  - request_close  — FOLLOW-UP (informational): an answered request a human raised. Listed
 *                     in the tray, but NOT counted in any "needs you" badge;
 *  - health         — stack up/down notification only (never in the polled list). */
export interface AttentionItem {
  project: string
  projectShort: string
  kind: 'task_plan' | 'request_answer' | 'request_close' | 'task_verify' | 'health'
  /** Stable id for dedup (request/task uuid, or health:<project>:<up|down>). */
  id: string
  title: string
  /** Portal path for this item (e.g. /requests?req=<id>&cid=<cid>); '/' for health items.
   *  Carries `cid` whenever the container is known so a multi-project stack opens the
   *  right project (GAP-07). */
  path: string
  /** Container (project) id inside the stack, when known. Additive (V2). */
  cid?: string
}

/** True for items that count toward a "needs you" badge (decisions), false for follow-ups
 *  and health notices. The single rule shared by tray title, tray panel, status file and the
 *  host sidebar (arch §3.3, desktop). */
export function isDecisionItem(item: Pick<AttentionItem, 'kind'>): boolean {
  return item.kind === 'task_plan' || item.kind === 'task_verify' || item.kind === 'request_answer'
}

/** Per-project availability of the host's attention poll, so the UI can tell
 *  "unavailable/unknown" apart from "zero" (brief §3). */
export interface AttentionProjectStatus {
  project: string
  /** Containers successfully fetched this tick, with their decision counts and (additive,
   *  D11) the agents live in them right now. */
  containers: Array<{
    cid: string
    name: string
    count: number
    partial: boolean
    /** Live agents (working / needs review / blocked — never idle), capped; absent from
     *  older hosts' snapshots. */
    live?: HostLiveAgent[]
    /** How many live agents the container has in total (≥ live.length). */
    liveTotal?: number
    /** D14 (additive): the project's real git checkouts (primary first), read on the host
     *  from the stack folder; absent/null = no branch data (agents nest under the project). */
    checkouts?: HostCheckout[] | null
  }>
  /** Container ids listed by the stack whose snapshot fetch failed this tick. */
  unavailable: string[]
  /** ISO time of the last successful fetch of this stack, or null if never. */
  fetchedAt: string | null
  /** False when the last attempt for this (running) stack failed entirely. */
  ok: boolean
}

export interface AttentionSnapshot {
  items: AttentionItem[]
  projects: AttentionProjectStatus[]
}

/** Why an agent is shown under its project in the host sidebar (D11). Idle agents never are.
 *  `waiting` = the agent has an open outgoing request (portal status `awaiting_request`); it is
 *  NEUTRAL, the portal's "Waiting" everywhere (VD-09) — never red, never "needs review".
 *  `blocked` is no longer produced by main (kept so older renderer code still type-checks). */
export type HostLiveAgentState = 'working' | 'needs_review' | 'waiting' | 'blocked'

/** One live agent of a project, as the host attention poller derives it from the project's
 *  snapshot (`GET /api/containers/{cid}`) — real data only, nothing inferred beyond it. */
export interface HostLiveAgent {
  alias: string
  state: HostLiveAgentState
  /** The task the agent is on (working/blocked), or the task awaiting review. Clipped. */
  task: string | null
  /** ISO time of the agent's last heartbeat / run start, when reported. */
  lastActive: string | null
  /** D14 (additive): the checkout branch this agent verifiably works on (matches a
   *  HostCheckout.branch of its container), null/absent when not known. */
  branch?: string | null
  /** D13 (additive): the agent's palette slot from the portal's canonical assignment (the
   *  project's full snapshot roster, snapshot order); absent/null = hash it locally. */
  palette?: number | null
}

/** D14: one real git checkout of a project (host `git worktree list` of the stack folder). */
export interface HostCheckout {
  /** Short branch name ("main", "orcha/task-lead-3f2a…"), or "detached @ <sha7>". */
  branch: string
  /** The main working tree (the project root the agents' daemon runs from). */
  primary: boolean
  detached: boolean
  /** Muted second line: "owner/name" for a GitHub-bound project, else the folder name. */
  repo: string | null
}
