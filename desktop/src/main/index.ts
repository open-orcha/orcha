import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, safeStorage, screen, session, shell, systemPreferences, WebContentsView } from 'electron'
import { installMediaPermissions, micAccessStatus, requestMicAccess } from './micPermission'
import { MIC_CHANNELS, MIC_SETTINGS_URL } from '../shared/mic'
import { classifyVerdiktLink, launchMacApp, openVerdiktLink } from './verdiktLinks'
import path from 'node:path'
import os from 'node:os'
import { accessSync, chmodSync, constants as fsConstants, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { parseDeepLink } from './deepLink'
import { configureNativeDiscovery, discoverStacks, listStacks } from './discovery'
import { startStack, stopStack } from './lifecycle'
import { fetchStackAttention } from './attention'
import { AttentionPoller } from './attentionPoller'
import { shouldShowAttention } from './notifyPrefs'
import { createTray, type TrayController } from './tray'
import { AppStatsLedger, parseStatsFile } from './usage/appStats'
import { UsageService } from './usage/service'
import { createPlanUsagePublisher } from './usage/planUsagePublisher'
import { createPlanUsageDisplaySync, DISPLAY_POLL_MS, type PlanUsageDisplaySync } from './usage/planUsageDisplay'
import { createScanClient, readClaudeCredentials, readUsagePrefsFile, writeUsagePrefsFile } from './usage/usageHost'
import { formatResetIn, peakWindow, trayUsageTitle, USAGE_CHANNELS, type UsageSnapshot } from '../shared/usage'
import { buildStatus, writeStatusFile } from './statusFile'
import { dockerExec, killPendingProbes } from './dockerExec'
import { dockerPublishedPorts, pickFreePort } from './portPicker'
import { preflight } from './preflight'
import { inspectFolder } from './folderModes'
import { provision, type EngineDeps } from './initEngine'
import { ensureOrchaLink, nodeOrchaLinkDeps } from './orchaLink'
import { fileVersionStore, restartNativeAfterUpdate } from './appUpdate'
import { readRegistry } from './nativeStacks'
import { startHostWorker, nodeHostWorkerDeps, hostToolPath, scrubWorkerEnv, streamOrcha, orchaBin, runOrcha } from './hostWorker'
import { analyzeProject, nodeAnalyzeProjectDeps, type AnalyzeProjectResult } from './analyzeProject'
import { resetStack } from './resetEngine'
import { planRemoval, removeProject, type RemoveDeps } from './removeEngine'
import { removeLeftover, scanStorage } from './storageScan'
import { cleanAgentWorktrees, isAgentWorktreePath, knownFolder, parseCleanRequest, scanAgentWorktrees } from './agentWorktrees'
import { dropKept, keptStatus, nodeDocker, nodeRemoveFs, nodeRun, recordKept } from './removeHost'
import { buildAppMenuTemplate } from './appMenu'
import { pinnedUserDataPath } from './userDataPath'
import { PRODUCT_NAME } from '../shared/brand'
import { adminOsascriptArgs, planInstall, runInstall } from './installers'
import { ghAuthToken, ghIsAuthenticated, ghListRepos, defaultClonesParent, resolveCloneDest } from './githubSource'
import { validateRepoUrl } from '../shared/repoUrl'
import {
  clampSidebarWidth,
  clampStripHeight,
  computeViewBounds,
  fitToWorkArea,
  insetForMode,
  portalViewVisible,
  radiusForMode,
  scaleInset,
  SIDEBAR_DEFAULT
} from './viewBounds'
import { readWorktrees } from './checkouts'
import { applyHostModal, resyncActiveView, showInManagerWindow } from './hostView'
import { readAppearance, isEmpty } from './appearanceStore'
import { buildApplyAppearanceScript } from './appearanceScripts'
import { createThemeController, readThemeMode, writeThemeMode, type ThemeController } from './themeMode'
import { canvasFor, THEME_CHANNELS, type ThemeState } from '../shared/theme'
import { normalizeProfileName, PROFILE_CHANNELS, profileState, type ProfileSaveResult, type ProfileState } from '../shared/profile'
import { readProfileName, renameSelfInProjects, writeProfileName } from './profileStore'
import { createProviderKeys } from './providerKeys'
import { parseProviderKeysInput, PROVIDER_KEYS_CHANNELS } from '../shared/providerKeys'
import { EmbedTracker } from './embedTracker'
import { PtyHost, type PtyProcess } from './ptyHost'
import { acceptTermSender as acceptTermSenderFacts, closeAction, createTermController, TermRequestError, type SenderFacts, type TermControllerHooks } from './terminalIpc'
import { parseRestoreRequest, TERM_CHANNELS, type TermCommand, type TermEvent } from '../shared/terminal'
import { createSessionKeeper, lsofArgs, parseLsofCwds, sessionsFilePath, type SavedSessions } from './sessionRestore'
import { AGENT_CHANNELS, agentShortLabel, type AgentsSnapshot } from '../shared/agents'
import { AgentDetector } from './agentDetect'
import { AgentsRequestError, createAgentsController, type AgentsController } from './agentsIpc'
import { readAgentPrefs, writeAgentPrefs } from './agentPrefs'
import { buildTermEnv, resolveShell, type KnownProject } from './terminalLaunch'
import { startHookReceiver, type HookReceiver } from './hookReceiver'
import { hookFilePaths, installAgentHooks, readCodexNotify, wireAgentHooks } from './agentHooks'
import { acceptPortalSender } from './embedIpc'
import {
  canSpaNavigate,
  EMBED_TO_HOST_CHANNEL,
  EMBED_TO_PORTAL_CHANNEL,
  isSafePath,
  parseHostMessage,
  parsePortalMessage,
  portalPreloadArgs,
  withEmbedHint,
  type EmbedEvent,
  type HostToPortal,
  type PortalToHost
} from '../shared/embed'
import { isDecisionItem } from '../shared/types'
import type {
  AttentionItem,
  BridgeError,
  CloneAndProvisionOptions,
  CloneDestSuggestion,
  FolderMode,
  GhRepo,
  GithubStatus,
  InstallResult,
  IpcResult,
  PortalActive,
  PrereqProbe,
  ProgressEvent,
  ProvisionOptions,
  ProvisionResult,
  Stack
} from '../shared/types'

/** Settings › Profile: the saved name (this Mac only) over the Mac account name. */
function currentProfile(): ProfileState {
  return profileState(readProfileName(app.getPath('userData')), os.userInfo().username)
}

/** Save the profile name and rename your human in every running project to match. */
async function saveProfile(raw: unknown): Promise<ProfileSaveResult> {
  let name: string | null
  try {
    name = normalizeProfileName(raw)
  } catch {
    throw { code: 'INVALID_PROFILE' } satisfies BridgeError
  }
  const before = currentProfile()
  writeProfileName(app.getPath('userData'), name)
  const state = currentProfile()
  const stacks = (await listStacks().catch(() => []))
    .filter((s) => s.running && s.apiPort !== null)
    .map((s) => ({ projectShort: s.projectShort, apiPort: s.apiPort as number }))
  const projects = await renameSelfInProjects(
    { stacks, request: (apiPort, p, method, body) => portalRequest(apiPort, p, method, body) },
    before.effective,
    state.effective
  )
  return { state, projects }
}

/** fetch→JSON with HTTP errors carrying `status` (so the engine maps 409→CONTAINER_EXISTS). */
async function fetchJson(url: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
  const res = await fetch(url, {
    method: init?.method ?? 'GET',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw Object.assign(new Error(`HTTP ${res.status} ${text.slice(0, 500)}`), { status: res.status })
  }
  const ct = res.headers.get('content-type') ?? ''
  return ct.includes('application/json') ? res.json() : undefined
}

/** `.claude/orcha.json` of a project folder, or null when missing/unreadable. */
function readProjectConfig(folder: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path.join(folder, '.claude', 'orcha.json'), 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/** Build the engine deps (GH #258 D2: the orcha CLI provisions; the app streams its progress). */
function engineDeps(): EngineDeps {
  return {
    orcha: streamOrcha,
    readConfig: readProjectConfig,
    // Settings › Profile name when set, else this Mac's account name.
    user: currentProfile().effective,
    // After the portal is up, make sure the host-side agent worker runs and surface any
    // missing prerequisite (Claude Code, API key) as a plain-language warning.
    startWorker: (folder) => startHostWorker(folder, nodeHostWorkerDeps)
  }
}

// ---- Prerequisites: probe + guided auto-install ----------------------------------------
// A fresh Mac has none of the host tools that actually run agents (Homebrew, the Docker
// engine, the orcha CLI, Claude Code). API keys are not a host prerequisite: Settings › API
// keys stores them on each project, and the notifier hands them to each run. These helpers detect what's missing and
// install it behind native dialogs — the pure plan/orchestration lives in ./installers.

/** `which <cmd>` against the host-tool PATH (the Finder-launched .app's PATH omits brew etc.). */
function whichHostTool(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('/usr/bin/which', [cmd], { env: { ...process.env, PATH: hostToolPath() } }, (err, stdout) =>
      resolve(err ? null : stdout.trim() || null)
    )
  })
}

/** GH #258: projects run natively, so setup no longer looks for Homebrew or Docker (both
 *  report false; the Setup step doesn't show them). Docker matters only to "Move this
 *  project off Docker", which checks it itself. */
async function probePrereqs(): Promise<PrereqProbe> {
  const bin = orchaBin()
  const [orcha, claude, codex] = await Promise.all([
    // bundled runtime or ~/.local/bin link (GH #258 D3) counts without a PATH lookup
    bin === 'orcha' ? whichHostTool('orcha') : Promise.resolve(bin),
    whichHostTool('claude'),
    whichHostTool('codex')
  ])
  return {
    homebrew: false,
    dockerEngine: false,
    orcha: !!orcha,
    claude: !!claude,
    codex: !!codex
  }
}

/** Run an install command as the logged-in user, streaming output lines. NONINTERACTIVE +
 *  no-auto-update keep Homebrew from prompting / blocking on a missing TTY. */
function runUserInstall(script: string, onLine: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', ['-c', script], {
      env: { ...process.env, PATH: hostToolPath(), NONINTERACTIVE: '1', HOMEBREW_NO_AUTO_UPDATE: '1' }
    })
    let tail = ''
    const onData = (buf: Buffer): void => {
      const text = buf.toString()
      tail = (tail + text).slice(-2000)
      for (const line of text.split('\n')) {
        const t = line.trim()
        if (t) onLine(t)
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(Object.assign(new Error(`exited ${code}`), { stderr: tail.trim() }))
    )
  })
}

/** Run a privileged command via the native macOS admin (Touch ID / password) popup. A
 *  user-cancelled popup rejects with osascript's "User canceled. (-128)". */
function runAdminInstall(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('osascript', adminOsascriptArgs(script), (err, _stdout, stderr) =>
      err ? reject(Object.assign(err, { stderr: stderr || (err as Error).message })) : resolve()
    )
  })
}

// ---- Add project / From GitHub -----------------------------------------------------------
// gh/git run on the host-tool PATH (same augmented PATH as the installers above); credentials
// for private repos flow through the host's own git credential helper / gh auth — Orcha never
// sees or stores a token, and never puts one in a URL.

/** `git clone <url> <dest>`, streaming stdout+stderr lines (git's own progress goes to
 *  stderr) to onLine — mirrors runUserInstall's spawn/stream shape. `dest`'s PARENT must
 *  already exist; dest itself must not (git clone creates it). */
function cloneGitRepo(url: string, dest: string, onLine: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['clone', '--progress', url, dest], {
      env: { ...process.env, PATH: hostToolPath(), GIT_TERMINAL_PROMPT: '0' }
    })
    let tail = ''
    const onData = (buf: Buffer): void => {
      const text = buf.toString()
      tail = (tail + text).slice(-2000)
      // git's --progress writes carriage-return-updated lines; split on both so the log
      // shows each intermediate "Receiving objects: NN%" tick rather than one giant blob.
      for (const line of text.split(/\r|\n/)) {
        const t = line.trim()
        if (t) onLine(t)
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', (err) => reject(Object.assign(err, { stderr: tail.trim() })))
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(Object.assign(new Error(`git clone exited ${code}`), { stderr: tail.trim() }))
    )
  })
}

/** Reserve two DISTINCT free host ports (api, bridge) for `orcha init`. We must exclude
 *  ports Docker has already published: a host listen on 0.0.0.0:<p> can succeed while
 *  docker-proxy owns it, so the host probe alone misses the collision (#port-collision).
 *  Shared by orcha:provision and cloneAndProvision so both entry points pick ports alike. */
async function reservedEngineDeps(): Promise<EngineDeps> {
  const taken = await dockerPublishedPorts()
  const api = await pickFreePort(8000, { dockerPorts: taken })
  taken.add(api)
  const bridge = await pickFreePort(8765, { dockerPorts: taken })
  return { ...engineDeps(), ports: { api, bridge } }
}

/** Clone opts.repoUrl into opts.dest (streaming 'clone-repo' progress on the same channel
 *  as provisioning), then run the ordinary init provision pipeline on the clone. A cloned
 *  repo is always fresh (mode 'init' — a repo we just cloned can't already be .orcha-
 *  initialized) and is always a git repo (no git-init tip needed on this path). */
async function cloneAndProvision(
  opts: CloneAndProvisionOptions,
  onProgress: (e: ProgressEvent) => void
): Promise<ProvisionResult> {
  const runId = `clone:${opts.dest}:${Date.now()}`
  const emit = (status: ProgressEvent['status'], extra?: Partial<ProgressEvent>): void =>
    onProgress({ runId, step: 'clone-repo', status, ...(extra as object) } as ProgressEvent)

  const check = validateRepoUrl(opts.repoUrl)
  if (!check.ok) {
    emit('fail', { code: 'INVALID_REPO_URL', detail: check.reason })
    throw { code: 'INVALID_REPO_URL', reason: check.reason } as const
  }
  // resolveCloneDest already guarded emptiness when the destination was suggested; guard
  // again here in case the caller passed a path we didn't vet (defense in depth).
  try {
    resolveCloneDest(path.dirname(opts.dest), path.basename(opts.dest))
  } catch {
    emit('fail', { code: 'DEST_NOT_EMPTY', detail: `${opts.dest} is not empty` })
    throw { code: 'DEST_NOT_EMPTY' } as const
  }
  mkdirSync(path.dirname(opts.dest), { recursive: true })

  emit('start')
  try {
    await cloneGitRepo(check.url, opts.dest, (line) => emit('log', { line }))
    emit('ok')
  } catch (err) {
    const stderr = String((err as { stderr?: string }).stderr ?? (err as Error).message)
    emit('fail', { code: 'CLONE_FAILED', detail: stderr })
    throw { code: 'CLONE_FAILED', stderr } as const
  }

  const deps = await reservedEngineDeps()
  return provision({ folder: opts.dest, mode: 'init' }, onProgress, deps)
}

// Runtime name for everything Electron derives it from (dialogs, role menu labels —
// "About/Hide/Quit Embodent"). The macOS app-menu TITLE still reads the bundle's Info.plist
// ("Electron" in dev unless scripts/sign-dev-electron.sh patched it); packaged builds get
// it from electron-builder productName.
app.setName(PRODUCT_NAME)
// Pin userData to the pre-rebrand folder (<appData>/Orcha). Electron derives it from the
// app name, so without this the rename would silently start every install from scratch
// (prefs, session restore, agent settings, hook token, icon cache). Must run before
// anything reads userData — i.e. here, at module load, before app ready. An explicit
// --user-data-dir (throwaway QA/dev instances) still wins.
if (!app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', pinnedUserDataPath(app.getPath('appData')))
app.setAboutPanelOptions({ applicationName: PRODUCT_NAME })

// Widgets deep-link back into the app: orcha://open?project=<compose project>&path=<portal path>
app.setAsDefaultProtocolClient('orcha')

let managerWindow: BrowserWindow | null = null
/** One WebContentsView per stack, embedded into managerWindow's contentView and covering
 *  everything below the renderer's native TopBar. Views persist across hide/show (setVisible, not
 *  add/removeChildView) so switching stacks is instant and each portal's in-page state
 *  (scroll position, any client-side view state) survives the switch. Only ever destroyed
 *  when the stack itself disappears from discovery would be nice-to-have; v1 leaks at most
 *  one WebContents per stack the user has opened this session, which is bounded and cheap. */
const portalViews = new Map<string, WebContentsView>()
/** Which stack's view (if any) is currently the visible one — null means the renderer's
 *  own content (home/manager or the wizard) is showing. Used to restore the previous
 *  portal after a temporary hide (e.g. opening the add-project wizard). */
let activeProject: string | null = null
let tray: TrayController | null = null
let poller: AttentionPoller | null = null
/** Usage & spend (main/usage/*): created in whenReady (needs the final userData path). */
let usage: UsageService | null = null
/** "Show plan usage" setting, synced with every running portal (mig 070). */
let planDisplay: PlanUsageDisplaySync | null = null
let planDisplayTimer: ReturnType<typeof setInterval> | null = null
let appStats: AppStatsLedger | null = null
let scanClient: ReturnType<typeof createScanClient> | null = null
/** Tray popover windows (they get usage updates too). */
const popoverWindows = new Set<BrowserWindow>()

// ---- V2 embedded mode (docs/orcha-v2-architecture.md §7) --------------------------------
/** Host sidebar width reported by the manager renderer (already clamped; the rail width when
 *  collapsed). The active view is laid out right of it in V2 mode. */
let hostSidebarWidth = SIDEBAR_DEFAULT
/** A host (renderer DOM) dialog is open: the native view would cover it, so the active view
 *  is hidden until the dialog closes (arch §7.4). */
let hostModalOpen = false
/** Height (CSS px) of the host's session tab strip at the top of the content panel; the V2
 *  view starts below it. 0 = no terminal tabs (no strip). */
let hostStripHeight = 0
/** A terminal session fills the content panel: the active portal view is hidden (kept
 *  alive) until the host shows the portal again. */
let hostTerminalShown = false
/** Keyboard focus is inside the host's terminal dock (routes ⌘W to "close tab"). */
let termFocused = false
/** Which stack a portal view's webContents belongs to — the ONLY source of a portal
 *  message's project (never the message itself). */
const portalProjectByWebContentsId = new Map<number, string>()
/** Expected origin per stack (`http://localhost:<apiPort>`), for sender-frame checks. */
const portalOrigins = new Map<string, string>()
/** Last route each portal reported, so a re-mounted renderer can highlight the right item. */
const lastRoutes = new Map<string, Extract<PortalToHost, { type: 'route' }>>()
/** Last container cid each V2 portal reported as resolved (attention / liveAgents). */
const lastCids = new Map<string, string>()
const embedTracker = new EmbedTracker({
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  onChange: (project, mode) => {
    if (mode === 'legacy') applyLegacyAppearance(project)
    if (project === activeProject) {
      resizeActivePortalView()
      sendPortalActive()
    }
  }
})

// ---- Terminal tabs (host renderer only; see main/terminalIpc.ts for the security model) ----
/** node-pty is loaded on first use so a broken native module can never stop the app from
 *  starting — the tab reports the failure instead. It ships N-API prebuilds (no per-Electron
 *  rebuild); scripts/fix-node-pty.mjs restores the spawn-helper exec bit npm drops. */
type NodePty = { spawn(file: string, args: string[], opts: Record<string, unknown>): PtyProcess }
let nodePty: NodePty | null = null
function loadNodePty(): NodePty {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  if (!nodePty) nodePty = require('node-pty') as NodePty
  return nodePty
}
const ptyHost = new PtyHost({
  spawn: (file, args, opts) => loadNodePty().spawn(file, args, { ...opts }),
  emit: (event: TermEvent) => {
    // Embodent's own agent stats: working stretches + exits of agent terminals.
    if (event.type === 'meta') appStats?.status(event.id, event.status)
    else if (event.type === 'exit') appStats?.exited(event.id)
    sendToManager(event.type === 'data' ? TERM_CHANNELS.data : event.type === 'meta' ? TERM_CHANNELS.meta : TERM_CHANNELS.exit, event)
  },
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  killGroup: (pid, signal) => process.kill(-pid, signal as NodeJS.Signals),
  onAgentSession: () => sessionKeeper.agentSessionChanged()
})
// ---- Agents settings (main/agentsIpc.ts): detection on the login-shell PATH + prefs ----
/** Created in whenReady (needs the final userData path); the terminal controller asks it
 *  for an agent's resolved binary + argv at spawn time. */
let agentsCtl: AgentsController | null = null
const agentDetector = new AgentDetector({
  shell: resolveShell(process.env.SHELL, (p) => existsSync(p)),
  run: (file, args, timeoutMs) =>
    new Promise((resolve, reject) => {
      // The user's own shell only, bounded; stdin closed so an rc file can't wait on input.
      const child = execFile(
        file,
        args,
        { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, env: buildTermEnv(process.env), cwd: os.homedir() },
        (err, stdout) => (err && !stdout ? reject(err) : resolve(String(stdout)))
      )
      child.stdin?.end()
    }),
  isExecutable: (p) => {
    try {
      if (!statSync(p).isFile()) return false
      accessSync(p, fsConstants.X_OK)
      return true
    } catch {
      return false
    }
  },
  now: () => Date.now()
})

// ---- Agent lifecycle hooks (main/agentHooks.ts + hookReceiver.ts) ----
/** Set once the loopback receiver is listening and the hook files are written (whenReady);
 *  until then — or if either fails — sessions fall back to the output heuristics. */
let agentHookWiring: TermControllerHooks = null
let hookReceiver: HookReceiver | null = null
async function startAgentHooks(): Promise<void> {
  const token = randomBytes(32).toString('hex')
  const files = hookFilePaths(app.getPath('userData'))
  const receiver = await startHookReceiver({
    token,
    accepts: (id) => ptyHost.acceptsHooks(id),
    deliver: (id, e) => void ptyHost.hookEvent(id, e)
  })
  try {
    installAgentHooks(files, receiver.port, token, undefined, 'auto')
  } catch (err) {
    await receiver.close()
    throw err
  }
  hookReceiver = receiver
  agentHookWiring = {
    endpointFile: files.endpoint,
    wire: (id, args, probe) =>
      wireAgentHooks(id, args, probe, { files, codexNotify: () => readCodexNotify(buildTermEnv(process.env), os.homedir()) })
  }
}

const listKnownProjects = async (): Promise<KnownProject[]> =>
  (await listStacks()).map((s) => ({ project: s.project, projectShort: s.projectShort, folder: s.folder }))
const isDirectory = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
const termController = createTermController({
  host: ptyHost,
  get hooks() {
    return agentHookWiring
  },
  agentLaunch: (id, probe) => agentsCtl?.launchFor(id, probe) ?? { path: null, args: probe ? ['--version'] : [] },
  listProjects: listKnownProjects,
  env: process.env,
  theme: () => theme?.resolved() ?? 'dark',
  home: os.homedir(),
  exists: (p) => existsSync(p),
  readWorktrees: (folder) => readWorktrees(folder),
  isDir: isDirectory
})

// ---- Terminal session restore (main/sessionRestore.ts) ----
const LSOF = '/usr/sbin/lsof'
const sessionKeeper = createSessionKeeper({
  facts: () => ptyHost.facts(),
  liveCount: () => ptyHost.size,
  read: () => {
    try {
      return JSON.parse(readFileSync(sessionsFilePath(app.getPath('userData')), 'utf8')) as unknown
    } catch {
      return null
    }
  },
  write: (saved: SavedSessions) => {
    // Atomic (tmp + rename), owner-only: a crash mid-write leaves the previous set intact.
    const dir = app.getPath('userData')
    mkdirSync(dir, { recursive: true })
    const file = sessionsFilePath(dir)
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, file)
  },
  liveCwds: (pids) =>
    new Promise((resolve) => {
      execFile(LSOF, lsofArgs(pids), { timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024 }, (_err, stdout) =>
        resolve(parseLsofCwds(String(stdout ?? '')))
      )
    }),
  liveCwdsSync: (pids) => {
    try {
      return parseLsofCwds(execFileSync(LSOF, lsofArgs(pids), { timeout: 1500, killSignal: 'SIGKILL', encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
    } catch (err) {
      // lsof exits 1 when one pid is already gone; what it printed is still good.
      const out = (err as { stdout?: unknown }).stdout
      return parseLsofCwds(typeof out === 'string' ? out : '')
    }
  },
  prefs: () => {
    const p = agentsCtl?.prefs()
    return {
      restoreSessions: p?.restoreSessions ?? true,
      resumeAgents: p?.resumeAgents ?? true,
      extraArgs: (id) => p?.agents[id]?.extraArgs ?? []
    }
  },
  listProjects: listKnownProjects,
  home: os.homedir(),
  isDir: isDirectory,
  realpath: (p) => {
    try {
      return realpathSync(p)
    } catch {
      return null
    }
  },
  spawn: (item) => termController.restoreSpawn(item),
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
})
/** Sender facts for the terminal channels: the manager window's own main frame only. */
function termSender(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): SenderFacts {
  const isHostRenderer = !!managerWindow && !managerWindow.isDestroyed() && event.sender === managerWindow.webContents
  return { isHostRenderer, isMainFrame: event.senderFrame !== null && event.senderFrame === event.sender.mainFrame }
}
function sendTermCommand(command: TermCommand): void {
  if (!managerWindow || managerWindow.isDestroyed()) {
    showManagerWindow()
    return
  }
  showManagerWindow()
  sendToManager(TERM_CHANNELS.command, command)
}

/** Settings › Appearance. Created at the top of whenReady — BEFORE any window — so
 *  nativeTheme.themeSource (and with it prefers-color-scheme in every WebContents) and each
 *  native backgroundColor already match the stored mode on first paint. */
let theme: ThemeController | null = null

/** Canvas token (--color-bg / --v2-window for the resolved theme): every native surface
 *  paints this before first paint so nothing flashes the wrong tone (brief §6). */
function canvas(): string {
  return canvasFor(theme?.resolved() ?? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'))
}

/** A theme change (preference or OS flip under System): repaint native backgrounds and tell
 *  the manager + tray popovers. Portal views need nothing — they follow prefers-color-scheme. */
function publishTheme(s: ThemeState): void {
  const bg = canvasFor(s.resolved)
  if (managerWindow && !managerWindow.isDestroyed()) managerWindow.setBackgroundColor(bg)
  for (const w of popoverWindows) if (!w.isDestroyed()) w.setBackgroundColor(bg)
  for (const v of portalViews.values()) if (!v.webContents.isDestroyed()) v.setBackgroundColor(bg)
  sendToManager(THEME_CHANNELS.changed, s)

  for (const w of popoverWindows) if (!w.isDestroyed()) w.webContents.send(THEME_CHANNELS.changed, s)
}

function createManagerWindow(): void {
  managerWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    // Keep room for the host sidebar (≤ 360 px) plus a usable portal area.
    minWidth: 760,
    minHeight: 480,
    backgroundColor: canvas(),
    title: PRODUCT_NAME,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    managerWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    managerWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  // The manager renderer never navigates; deny everything (bridge must not ride a navigation).
  managerWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  managerWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // Keep every embedded portal view's bounds in sync with the window's content area as it
  // resizes (the TopBar's height is constant — only the view's width/height change).
  managerWindow.on('resize', () => resizeActivePortalView())
  keepManagerOnScreen()
  // The manager renderer can reload (View → Reload with host chrome focused) or crash. Its
  // host state starts empty and any open host dialog's cleanup never ran, so re-sync: clear
  // the stale host-modal flag, re-show/refocus the active view and re-send portalActive.
  const resyncHost = (): void => {
    hostModalOpen = false
    // A fresh renderer starts on the portal (its terminal view state is gone).
    hostTerminalShown = false
    const project = activeProject
    if (project !== null) {
      resyncActiveView(portalViews.get(project), (open) => sendToPortal(project, { type: 'hostModal', open }))
    }
    resizeActivePortalView()
    sendPortalActive()
  }
  managerWindow.webContents.on('did-finish-load', resyncHost)
  managerWindow.webContents.on('render-process-gone', () => {
    hostModalOpen = false
    hostTerminalShown = false
    const project = activeProject
    if (project !== null) {
      resyncActiveView(portalViews.get(project), (open) => sendToPortal(project, { type: 'hostModal', open }))
    }
  })
  // Zoom via Ctrl/Cmd+wheel on the host chrome: re-lay out with the new factor.
  managerWindow.webContents.on('zoom-changed', () => setTimeout(() => resizeActivePortalView(), 0))
  managerWindow.on('closed', () => {
    managerWindow = null
    // No terminal outlives the window that shows it (no orphaned shells / agents). The tab
    // set is saved first, so reopening the window restores it.
    sessionKeeper.freeze()
    ptyHost.killAll()
    termFocused = false
    hostStripHeight = 0
    hostTerminalShown = false
    for (const project of portalViews.keys()) embedTracker.forget(project)
    portalViews.clear()
    // the views (and what they last reported) are gone with the window
    lastRoutes.clear()
    lastCids.clear()
    portalProjectByWebContentsId.clear()
    activeProject = null
    hostModalOpen = false
  })
}

/** Bounds for a project's view given its embed mode and the host sidebar width. */
function boundsFor(project: string): Electron.Rectangle | null {
  if (!managerWindow || managerWindow.isDestroyed()) return null
  const [width, height] = managerWindow.getContentSize()
  // The sidebar width is CSS px in the manager renderer; scale by its zoom factor so a zoomed
  // host chrome is never covered by the native view (QA, brief item 12).
  let zoom = 1
  try { zoom = managerWindow.webContents.getZoomFactor() } catch { zoom = 1 }
  return computeViewBounds(
    { width, height },
    scaleInset(insetForMode(embedTracker.modeOf(project), hostSidebarWidth, hostStripHeight), zoom)
  )
}

/** Tell the manager renderer which view is showing and in which embed mode, plus its last
 *  reported route (so the host sidebar highlights the right section). */
function portalActivePayload(): PortalActive {
  const project = activeProject
  return {
    project,
    embed: project !== null ? embedTracker.modeOf(project) : null,
    route: project !== null ? (lastRoutes.get(project) ?? null) : null
  }
}
function sendPortalActive(): void {
  sendToManager('orcha:portalActive', portalActivePayload())
}

/** Deliver a validated host → portal message to one stack's view. */
function sendToPortal(project: string, msg: HostToPortal): boolean {
  const view = portalViews.get(project)
  if (!view || view.webContents.isDestroyed()) return false
  view.webContents.send(EMBED_TO_PORTAL_CHANNEL, msg)
  return true
}

/** Older (pre-V2) portals still honor the desktop's stored theme/skin. V2 is dark-only and
 *  ignores it, so this runs ONLY when a view falls back to legacy mode — once, read-only
 *  (the store file is never rewritten; kept for rollback, arch §7.4 Appearance). */
function applyLegacyAppearance(project: string): void {
  const view = portalViews.get(project)
  if (!view || view.webContents.isDestroyed()) return
  const stored = readAppearance(app.getPath('userData'))
  // Never set: follow the desktop's resolved Appearance (was hard-coded dark).
  const appearance = isEmpty(stored) ? { theme: theme?.resolved() ?? 'dark', skin: 'gold' } : stored
  view.webContents.executeJavaScript(buildApplyAppearanceScript(appearance)).catch(() => {
    // Best-effort — a view mid-navigation can reject this harmlessly.
  })
}

/** Recompute and apply bounds for whichever portal view is currently visible. Hidden views
 *  don't need their bounds kept current (they're not drawn), so this only ever touches the
 *  active one — cheap even with several stacks' views alive in the map. */
function resizeActivePortalView(): void {
  if (!managerWindow || managerWindow.isDestroyed() || activeProject === null) return
  const view = portalViews.get(activeProject)
  const bounds = boundsFor(activeProject)
  if (!view || !bounds) return
  view.setBounds(bounds)
  applyViewRadius(activeProject, view)
}

/** Round the view's corners to the inset panel radius (D5) — square in legacy mode. */
function applyViewRadius(project: string, view: WebContentsView): void {
  let zoom = 1
  try { zoom = managerWindow?.webContents.getZoomFactor() ?? 1 } catch { zoom = 1 }
  try {
    view.setBorderRadius(radiusForMode(embedTracker.modeOf(project), zoom))
  } catch {
    // Older Electron without setBorderRadius: a square panel is still correct, just less polished.
  }
}

/** Create (if needed) and return the embedded WebContentsView for a stack's portal. */
function getOrCreatePortalView(stack: Stack): WebContentsView {
  const existing = portalViews.get(stack.project)
  if (existing) return existing

  const portalOrigin = `http://localhost:${stack.apiPort}`
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Chromium's built-in PDF viewer, so PDFs preview inline in code views, diffs and
      // deliverables (the portal's file previews) instead of falling back to a download card.
      plugins: true,
      // Dedicated minimal preload (NOT the manager's): exposes window.orchaHost only when
      // the page origin equals this stack's origin (arch §7.2).
      preload: path.join(__dirname, '../preload/portal.js'),
      additionalArguments: portalPreloadArgs(portalOrigin, stack.project)
    }
  })
  view.setBackgroundColor(canvas())
  const webContentsId = view.webContents.id
  portalProjectByWebContentsId.set(webContentsId, stack.project)
  portalOrigins.set(stack.project, portalOrigin)
  view.webContents.on('destroyed', () => {
    portalProjectByWebContentsId.delete(webContentsId)
  })
  // Every full (main-frame, cross-document) navigation re-arms the 3 s `ready` window.
  view.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) embedTracker.loadStarted(stack.project)
  })
  // Portal content may link out (docs, repos): keep same-origin navigation in the
  // embedded view, push everything else to the system browser.
  // Verdikt hand-offs are same-origin redirects out of the portal: never load them in the
  // view — launch the Verdikt app (or the browser). See verdiktLinks.ts.
  const verdiktDeps = { openExternal: (u: string) => shell.openExternal(u), launchApp: launchMacApp, platform: process.platform }
  view.webContents.on('will-navigate', (event, url) => {
    const vk = classifyVerdiktLink(url, portalOrigin)
    if (vk) {
      event.preventDefault()
      void openVerdiktLink(vk, url, verdiktDeps)
      return
    }
    if (!url.startsWith(`${portalOrigin}/`)) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })
  view.webContents.setWindowOpenHandler(({ url }) => {
    const vk = classifyVerdiktLink(url, portalOrigin)
    if (vk) {
      void openVerdiktLink(vk, url, verdiktDeps)
      return { action: 'deny' }
    }
    if (!url.startsWith(`${portalOrigin}/`)) {
      void shell.openExternal(url)
      return { action: 'deny' }
    }
    // Same-origin "new window" requests (e.g. a task link's window.open()) should navigate
    // this project's existing embedded view in place, not spawn a second WebContentsView —
    // mirrors upstream's fix for the old one-window-per-portal model (GH #140).
    void view.webContents.loadURL(url)
    return { action: 'deny' }
  })
  portalViews.set(stack.project, view)
  return view
}

/** Show the embedded portal view for `stack` at `path`, creating it on first use and
 *  reusing (not re-navigating) it on subsequent switches — the one exception is that we
 *  always navigate when the caller passes a specific path (e.g. an attention item or the
 *  onboarding finish screen), since that's a deliberate "go here" request. Hides whichever
 *  other view was showing; the renderer's native TopBar stays interactive because the
 *  view's bounds start below it (see computeViewBounds). */
function showPortalView(stack: Stack, path = '/'): void {
  if (!managerWindow || managerWindow.isDestroyed() || stack.apiPort === null) return
  managerWindow.show()
  managerWindow.focus()

  const isNewView = !portalViews.has(stack.project)
  const view = getOrCreatePortalView(stack)

  for (const [project, other] of portalViews) {
    if (project !== stack.project) other.setVisible(false)
  }
  if (!managerWindow.contentView.children.includes(view)) {
    managerWindow.contentView.addChildView(view)
  }
  activeProject = stack.project
  const bounds = boundsFor(stack.project)
  if (bounds) view.setBounds(bounds)
  applyViewRadius(stack.project, view)
  // Main (tray / notification / deep link / a sidebar click) asked for this portal: leave a
  // full-panel terminal and tell the host so its tab strip switches back to the portal.
  if (hostTerminalShown) {
    hostTerminalShown = false
    sendToManager(TERM_CHANNELS.command, 'show-portal' satisfies TermCommand)
  }
  // A host dialog that is still open keeps covering priority: the view stays hidden until
  // the renderer reports the dialog closed (setHostModal(false)).
  view.setVisible(portalViewVisible({ hostModalOpen, terminalShown: hostTerminalShown }))

  // Navigate on first creation, or whenever the caller asked for a specific path — reusing
  // an existing view otherwise means "switch back to what was on screen", not "reload".
  // The FIRST load carries the `?embed=desktop` pre-paint hint (arch §7.2).
  if (isNewView) {
    void view.webContents.loadURL(`http://localhost:${stack.apiPort}${withEmbedHint(path)}`)
  } else if (path !== '/') {
    // Same project, V2 portal, same container: SPA navigate so unsent drafts and scroll
    // survive a tray/notification/deep-link click (QA). Container switches stay full loads.
    const reported = lastRoutes.get(stack.project)?.search ?? null
    const spa =
      embedTracker.modeOf(stack.project) === 'v2' &&
      canSpaNavigate(path, reported, lastCids.get(stack.project) ?? null) &&
      sendToPortal(stack.project, { type: 'navigate', path })
    if (!spa) void view.webContents.loadURL(`http://localhost:${stack.apiPort}${path}`)
  }
  if (!hostModalOpen) view.webContents.focus()
  sendPortalActive()
}

/** Hide whichever portal view is showing, returning to the renderer's own content
 *  (home/manager or the wizard). The view itself is left alive (just setVisible(false))
 *  so re-showing it later is instant. */
function hidePortalView(): void {
  if (activeProject !== null) {
    portalViews.get(activeProject)?.setVisible(false)
    activeProject = null
  }
  sendPortalActive()
}

/** Keep the manager window fully on a display's work area. A window hanging past the
 *  screen's left edge showed the host sidebar clipped ("rojects", icons cut at x≈0) — the
 *  title bar and traffic lights were cut too, so it was the WINDOW that was off-screen, not
 *  the DOM. Applied on create, on re-show and when displays change (unplug / resolution). */
function keepManagerOnScreen(): void {
  if (!managerWindow || managerWindow.isDestroyed() || managerWindow.isFullScreen()) return
  try {
    const bounds = managerWindow.getBounds()
    const area = screen.getDisplayMatching(bounds).workArea
    const next = fitToWorkArea(bounds, area)
    if (next.x !== bounds.x || next.y !== bounds.y || next.width !== bounds.width || next.height !== bounds.height) {
      managerWindow.setBounds(next)
    }
  } catch {
    // screen not ready (very early startup): the OS placement stands
  }
}

/** Open-or-focus: reuse the existing manager window when it's still alive. */
function showManagerWindow(): void {
  if (managerWindow && !managerWindow.isDestroyed()) {
    keepManagerOnScreen()
    managerWindow.show()
    managerWindow.focus()
    return
  }
  createManagerWindow()
}

/** Send a one-way message to the (single) manager window if it's alive. */
function sendToManager(channel: string, payload: unknown): void {
  if (managerWindow && !managerWindow.isDestroyed()) managerWindow.webContents.send(channel, payload)
}

/** Frameless tray popover; hidden until the tray click positions it. */
function createPopoverWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 360,
    height: 480,
    show: false,
    backgroundColor: canvas(),
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#tray`)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: 'tray' })
  }
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  popoverWindows.add(win)
  win.on('closed', () => popoverWindows.delete(win))
  return win
}

/** Push a usage snapshot to the manager, the tray popovers and the menu-bar title. */
/** Mirrors the Usage panel's plan limits to each running portal for the mobile apps
 *  (portal mig 069). Throttled per portal, fire-and-forget, never blocks the UI. */
const planUsagePublisher = createPlanUsagePublisher({
  listStacks: () => listStacks(),
  fetch: (input, init) => fetch(input, init),
  host: () => os.hostname(),
  now: () => Date.now()
})

function publishUsage(snap: UsageSnapshot): void {
  void planUsagePublisher.publish(snap)
  sendToManager(USAGE_CHANNELS.changed, snap)
  for (const w of popoverWindows) if (!w.isDestroyed()) w.webContents.send(USAGE_CHANNELS.changed, snap)
  const now = Date.now()
  const rows = snap.providers
    .filter((p) => p.enabled && p.billing !== 'api-key' && p.limits?.status === 'ok' && p.limits.windows.length > 0)
    .map((p) => {
      const bars = (p.limits?.windows ?? []).map((w) => `${w.label} ${Math.round(w.usedPercent)}%`).join(' · ')
      const peak = peakWindow(p)
      const reset = peak ? formatResetIn(peak.resetsAt, now) : null
      return `${p.label} — ${bars}${reset ? `  (${reset.toLowerCase()})` : ''}`
    })
  tray?.setUsage(trayUsageTitle(snap), rows)
}

/** Bring the manager forward on Stats & Usage (or Settings › Agents for "Manage accounts…"). */
function openUsageInManager(target: 'stats' | 'accounts'): void {
  showManagerWindow()
  for (const w of popoverWindows) if (!w.isDestroyed()) w.hide()
  const send = (): void => sendToManager(USAGE_CHANNELS.openStats, target)
  if (managerWindow && managerWindow.webContents.isLoading()) managerWindow.webContents.once('did-finish-load', send)
  else send()
}

async function openPortalByProject(project: string, path?: string): Promise<void> {
  try {
    const stacks = await listStacks()
    const stack = stacks.find((s) => s.project === project)
    if (stack && stack.running && stack.apiPort !== null) {
      showInManagerWindow({ ensureManagerWindow: showManagerWindow, showPortalView }, stack, path)
    }
  } catch {
    // Docker down or discovery hiccup at click time — nothing sensible to open.
  }
}

function showAttentionNotification(item: AttentionItem): void {
  if (!Notification.isSupported()) return
  const n = new Notification({ title: `${PRODUCT_NAME} — ${item.projectShort}`, body: item.title })
  // macOS refuses Notification Center registration for ad-hoc-signed binaries
  // (UNErrorDomain error 1) — keep delivery failures visible. Dev fix:
  // desktop/scripts/sign-dev-electron.sh (packaged builds are properly signed).
  n.on('failed', (_e, error) =>
    console.error('[orcha-desktop] notification delivery failed:', item.id, error)
  )
  n.on('click', () => void openPortalByProject(item.project, item.path))
  n.show()
}

/** Wrap a handler so structured BridgeErrors survive IPC (thrown Errors get
 *  flattened to strings by ipcMain.handle — so we return IpcResult instead).
 *  Unknown rejections are normalized to INTERNAL so the renderer always gets
 *  a `code` (and internals never leak across the boundary). */
function asResult<T>(fn: () => Promise<T>): Promise<IpcResult<T>> {
  return fn().then(
    (data) => ({ ok: true as const, data }),
    (err: unknown) => {
      if (err && typeof err === 'object' && 'code' in err) {
        return { ok: false as const, ...(err as BridgeError) }
      }
      console.error('[orcha-desktop] unexpected handler rejection:', err)
      return { ok: false as const, code: 'INTERNAL' as const }
    }
  )
}

/** Validate a renderer-supplied project name against the live discovery snapshot. */
async function requireKnownStack(project: string): Promise<Stack> {
  const stacks = await listStacks()
  const stack = stacks.find((s) => s.project === project)
  if (!stack) throw { code: 'UNKNOWN_STACK' } as const
  return stack
}

/** GET/POST JSON to a specific stack's own localhost portal, on behalf of the sandboxed
 *  renderer (the Fleet step's roster/suggest + roster/suggest/accept calls). The port must
 *  match a currently-running stack from discovery, and the path must be a plain `/api/...`
 *  route (single leading slash, no protocol-relative `//`, no backslash) — this is a narrow,
 *  validated pass-through, not an open proxy. A non-2xx response rejects with
 *  PORTAL_REQUEST_FAILED{status}, which the Fleet step reads to auto-skip on 404. */
async function portalRequest(
  apiPortRaw: unknown,
  pathRaw: unknown,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  body?: unknown
): Promise<unknown> {
  const apiPort = typeof apiPortRaw === 'number' ? apiPortRaw : NaN
  const path = typeof pathRaw === 'string' ? pathRaw : ''
  if (!Number.isInteger(apiPort) || !/^\/api\/(?![/\\])[\w/-]*$/.test(path)) {
    throw { code: 'INVALID_PORTAL_REQUEST' } as const
  }
  const stacks = await listStacks()
  const known = stacks.some((s) => s.running && s.apiPort === apiPort)
  if (!known) throw { code: 'INVALID_PORTAL_REQUEST' } as const

  const res = await fetch(`http://localhost:${apiPort}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000)
  })
  if (!res.ok) {
    // Carry the portal's own reason (FastAPI `detail`: a string, or a list of
    // validation errors) so the renderer can say WHY instead of a bare failure.
    let detail: string | undefined
    try {
      const d = ((await res.json()) as { detail?: unknown })?.detail
      if (typeof d === 'string') detail = d
      else if (Array.isArray(d))
        detail = d
          .map((e) => (e && typeof e === 'object' && 'msg' in e ? String((e as { msg: unknown }).msg) : ''))
          .filter(Boolean)
          .join('; ')
    } catch {
      /* non-JSON error body */
    }
    throw { code: 'PORTAL_REQUEST_FAILED', status: res.status, ...(detail ? { detail: detail.slice(0, 300) } : {}) } as const
  }
  const ct = res.headers.get('content-type') ?? ''
  return ct.includes('application/json') ? res.json() : undefined
}

app.whenReady().then(() => {
  // GH #258: native projects stopped from the app stay listed (main/nativeStacks.ts).
  configureNativeDiscovery(app.getPath('userData'))
  // GH #258 D3: `orcha` in Terminal → the runtime bundled in this app (best effort; packaged only).
  try {
    const res = ensureOrchaLink(
      nodeOrchaLinkDeps(app.isPackaged ? process.resourcesPath : null, () => {
        try {
          return execFileSync('/usr/bin/which', ['orcha'], { env: { ...process.env, PATH: hostToolPath() }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
        } catch {
          return null
        }
      })
    )
    if (res === 'created' || res === 'refreshed') console.log(`[orcha-desktop] ~/.local/bin/orcha ${res}`)
  } catch (err) {
    console.warn('[orcha-desktop] could not link ~/.local/bin/orcha:', err)
  }
  // GH #258 D3: first launch of a new app version → running native projects restart on the
  // new bundled runtime (`orcha upgrade`). Packaged only; in the background, never blocking.
  if (app.isPackaged) {
    void restartNativeAfterUpdate(app.getVersion(), {
      ...fileVersionStore(app.getPath('userData')),
      registry: () => readRegistry(),
      upgrade: (folder) => runOrcha(folder, ['upgrade']),
      warn: (msg) => console.warn(`[orcha-desktop] ${msg}`)
    }).then((done) => {
      if (done.length) console.log(`[orcha-desktop] restarted ${done.length} project(s) on the new runtime`)
    })
  }
  // Appearance first: every window below is created with the right canvas.
  const userDataDir = app.getPath('userData')
  theme = createThemeController({
    nativeTheme,
    read: () => readThemeMode(userDataDir),
    write: (mode) => writeThemeMode(userDataDir, mode),
    onChange: publishTheme
  })
  const themeCtl = theme
  /** Appearance IPC: only our own index-preload windows (manager, tray popovers). */
  const themeSender = (event: Electron.IpcMainInvokeEvent): boolean =>
    (!!managerWindow && !managerWindow.isDestroyed() && event.sender === managerWindow.webContents) ||
    [...popoverWindows].some((w) => !w.isDestroyed() && w.webContents === event.sender)
  ipcMain.handle(THEME_CHANNELS.get, (event) =>
    asResult(async () => {
      if (!themeSender(event)) throw { code: 'INVALID_THEME' } satisfies BridgeError
      return themeCtl.state()
    })
  )
  ipcMain.handle(THEME_CHANNELS.set, (event, raw: unknown) =>
    asResult(async () => {
      if (!themeSender(event)) throw { code: 'INVALID_THEME' } satisfies BridgeError
      return themeCtl.set(raw)
    })
  )

  // Settings › Profile: same sender rule as Appearance (our own index-preload windows).
  ipcMain.handle(PROFILE_CHANNELS.get, (event) =>
    asResult(async () => {
      if (!themeSender(event)) throw { code: 'INVALID_PROFILE' } satisfies BridgeError
      return currentProfile()
    })
  )
  ipcMain.handle(PROFILE_CHANNELS.set, (event, raw: unknown) =>
    asResult(async () => {
      if (!themeSender(event)) throw { code: 'INVALID_PROFILE' } satisfies BridgeError
      return saveProfile(raw)
    })
  )

  // Dictation (portal Settings › Voice): the microphone. Chromium's `media` permission is
  // granted only to our own pages and only for audio, after macOS says yes (micPermission.ts).
  installMediaPermissions(session.defaultSession, {
    ask: () => requestMicAccess(systemPreferences),
    trustedExtra: () => (process.env['ELECTRON_RENDERER_URL'] ? [process.env['ELECTRON_RENDERER_URL']] : [])
  })
  /** Manager window, tray popovers, or an embedded portal view (dictation asks before recording). */
  const micSender = (event: Electron.IpcMainInvokeEvent): boolean =>
    themeSender(event) || portalProjectByWebContentsId.has(event.sender.id)
  ipcMain.handle(MIC_CHANNELS.status, (event) =>
    asResult(async () => {
      if (!micSender(event)) throw { code: 'INVALID_MIC' } satisfies BridgeError
      return micAccessStatus(systemPreferences)
    })
  )
  ipcMain.handle(MIC_CHANNELS.request, (event) =>
    asResult(async () => {
      if (!micSender(event)) throw { code: 'INVALID_MIC' } satisfies BridgeError
      return requestMicAccess(systemPreferences)
    })
  )
  ipcMain.handle(MIC_CHANNELS.openSettings, (event) =>
    asResult(async () => {
      if (!micSender(event)) throw { code: 'INVALID_MIC' } satisfies BridgeError
      if (process.platform === 'darwin') await shell.openExternal(MIC_SETTINGS_URL)
      return true
    })
  )

  // A display went away / changed resolution: never leave the window (and its sidebar)
  // hanging off-screen.
  screen.on('display-removed', () => keepManagerOnScreen())
  screen.on('display-metrics-changed', () => keepManagerOnScreen())

  ipcMain.handle('orcha:listStacks', () => asResult(() => listStacks()))
  ipcMain.handle('orcha:listStacksDetailed', () => asResult(() => discoverStacks()))

  ipcMain.handle('orcha:startStack', (_event, project: string) =>
    asResult(async () => {
      const stack = await requireKnownStack(project)
      await startStack(stack)
    })
  )

  ipcMain.handle('orcha:stopStack', (_event, project: string) =>
    asResult(async () => {
      const stack = await requireKnownStack(project)
      await stopStack(stack)
    })
  )

  ipcMain.handle('orcha:resetStack', (_event, project: string) =>
    asResult(async () => {
      // Validate against the live snapshot to get the on-disk folder; the engine re-guards the name.
      const stack = await requireKnownStack(project)
      await resetStack(stack.project, stack.folder, {
        exec: dockerExec,
        rmrf: (p) => rmSync(p, { recursive: true, force: true }),
        rmFile: (p) => rmSync(p, { force: true }),
        execHost: (cmd, args, opts) =>
          new Promise((resolve, reject) => {
            execFile(cmd === 'orcha' ? orchaBin() : cmd, args, { cwd: opts.cwd, env: opts.env, encoding: 'utf8' }, (err, stdout, stderr) =>
              err ? reject(Object.assign(err, { stderr })) : resolve({ stdout })
            )
          }),
        pathEnv: nodeHostWorkerDeps.pathEnv ?? hostToolPath(),
        hostEnv: scrubWorkerEnv(process.env),
        readFile: (p) => {
          try {
            return readFileSync(p, 'utf8')
          } catch {
            return null
          }
        },
        listDir: (p) => {
          try {
            return readdirSync(p)
          } catch {
            return null
          }
        }
      }, stack.runtime)
    })
  )

  // ---- Remove project (removeEngine.ts) + Settings › Storage (storageScan.ts) ----
  /** Only the manager window's own renderer may run these (never a portal view). */
  const fromManager = (event: Electron.IpcMainInvokeEvent): boolean =>
    !!managerWindow && !managerWindow.isDestroyed() && event.sender === managerWindow.webContents
  const removeDeps = (): RemoveDeps => ({
    docker: (args) => nodeDocker(args),
    run: nodeRun({ ...scrubWorkerEnv(process.env), PATH: nodeHostWorkerDeps.pathEnv ?? hostToolPath() }),
    fs: nodeRemoveFs,
    home: os.homedir(),
    log: (line) => console.log(`[orcha-desktop] remove: ${line}`)
  })
  /** Projects validated against discovery for a removal this session — a Retry after a
   *  partial failure (the stack may already be gone from `docker ps`) stays allowed. */
  const removalTargets = new Map<string, { projectShort: string; folder: string | null }>()
  const removalTarget = async (project: unknown): Promise<{ project: string; projectShort: string; folder: string | null }> => {
    if (typeof project !== 'string') throw { code: 'UNKNOWN_STACK' } as const
    try {
      const stack = await requireKnownStack(project)
      const t = { projectShort: stack.projectShort, folder: stack.folder }
      removalTargets.set(stack.project, t)
      return { project: stack.project, ...t }
    } catch (err) {
      const prior = removalTargets.get(project)
      if (prior && (err as { code?: unknown })?.code === 'UNKNOWN_STACK') return { project, ...prior }
      throw err
    }
  }
  /** Main's own per-project state: the portal view (and what it reported), attention and
   *  saved terminal tabs. */
  const forgetProjectInMain = (project: string): void => {
    if (activeProject === project) hidePortalView()
    const view = portalViews.get(project)
    if (view) {
      try {
        if (managerWindow && !managerWindow.isDestroyed()) managerWindow.contentView.removeChildView(view)
        view.webContents.close()
      } catch {
        // already gone
      }
      portalViews.delete(project)
    }
    portalOrigins.delete(project)
    lastRoutes.delete(project)
    lastCids.delete(project)
    embedTracker.forget(project)
    poller?.forget(project)
    const tabs = sessionKeeper.forgetProject(project)
    console.log(`[orcha-desktop] remove: forgot app state for ${project} (portal view, attention, ${tabs} saved tab${tabs === 1 ? '' : 's'})`)
  }

  ipcMain.handle('orcha:removePlan', (event, project: unknown) =>
    asResult(async () => {
      if (!fromManager(event)) throw { code: 'UNKNOWN_STACK' } as const
      const t = await removalTarget(project)
      return planRemoval(t.project, t.projectShort, t.folder, removeDeps())
    })
  )

  ipcMain.handle('orcha:removeProject', (event, project: unknown, rawOpts: unknown) =>
    asResult(async () => {
      if (!fromManager(event)) throw { code: 'UNKNOWN_STACK' } as const
      const o = (rawOpts ?? {}) as { deleteData?: unknown; removeFiles?: unknown; saveOutput?: unknown }
      const opts = { deleteData: o.deleteData === true, removeFiles: o.removeFiles === true, saveOutput: o.saveOutput !== false }
      const t = await removalTarget(project)
      console.log(`[orcha-desktop] remove: ${t.project} (folder ${t.folder ?? 'unknown'}) deleteData=${opts.deleteData} removeFiles=${opts.removeFiles}`)
      const result = await removeProject(t.project, t.projectShort, t.folder, opts, removeDeps(), (phase) => {
        if (!event.sender.isDestroyed()) event.sender.send('orcha:removeProject:progress', { project: t.project, phase })
      })
      removalTargets.delete(t.project)
      forgetProjectInMain(t.project)
      try {
        const dir = app.getPath('userData')
        if (!opts.deleteData && t.folder && !result.filesRemoved) recordKept(dir, t.project, t.folder)
        else dropKept(dir, t.project)
      } catch {
        // ledger is best effort
      }
      return result
    })
  )

  const storageDeps = () => ({ docker: (args: string[]) => nodeDocker(args, 60_000), kept: () => keptStatus(app.getPath('userData')) })
  ipcMain.handle('orcha:storage:scan', (event) =>
    asResult(async () => {
      if (!fromManager(event)) throw { code: 'INVALID_STORAGE_ITEM' } as const
      return scanStorage(storageDeps())
    })
  )
  ipcMain.handle('orcha:storage:remove', (event, raw: unknown) =>
    asResult(async () => {
      if (!fromManager(event)) throw { code: 'INVALID_STORAGE_ITEM' } as const
      const done = await removeLeftover(raw, storageDeps())
      console.log(`[orcha-desktop] storage: removed ${done.kind} ${done.name}`)
      if (done.kind === 'volume' && done.project) {
        try {
          dropKept(app.getPath('userData'), done.project)
        } catch {
          // ledger is best effort
        }
      }
    })
  )

  // ---- Settings › Storage › Agent worktrees (agentWorktrees.ts → `orcha worktrees --json`) ----
  const worktreeRun = () => nodeRun({ ...scrubWorkerEnv(process.env), PATH: nodeHostWorkerDeps.pathEnv ?? hostToolPath() })
  ipcMain.handle('orcha:storage:worktrees', (event) =>
    asResult(async () => {
      if (!fromManager(event)) throw { code: 'INVALID_WORKTREE' } as const
      return scanAgentWorktrees(await listKnownProjects(), worktreeRun(), (f) => isDirectory(path.join(f, '.orcha-worktrees')))
    })
  )
  ipcMain.handle('orcha:storage:worktreesClean', (event, raw: unknown) =>
    asResult(async () => {
      if (!fromManager(event)) throw { code: 'INVALID_WORKTREE' } as const
      const req = parseCleanRequest(raw, await listKnownProjects())
      const res = await cleanAgentWorktrees(req, worktreeRun())
      if (!req.dryRun) {
        console.log(`[orcha-desktop] storage: cleaned ${res.removed.length} agent worktree(s) in ${req.folder} (${res.freed_bytes} bytes)`)
      }
      return res
    })
  )
  ipcMain.handle('orcha:storage:revealWorktree', (event, folder: unknown, p: unknown) =>
    asResult(async () => {
      if (!fromManager(event)) throw { code: 'INVALID_WORKTREE' } as const
      const f = knownFolder(await listKnownProjects(), folder)
      if (!isAgentWorktreePath(f, p) || !isDirectory(p)) throw { code: 'INVALID_WORKTREE' } as const
      shell.showItemInFolder(p)
    })
  )

  ipcMain.handle('orcha:portalShow', (_event, project: string, path?: unknown) =>
    asResult(async () => {
      const stack = await requireKnownStack(project)
      if (!stack.running || stack.apiPort === null) throw { code: 'UNKNOWN_STACK' } as const
      // Renderer-supplied path: require a single leading slash (no protocol-relative
      // // and no /\ — URL parsers treat backslash as a segment separator too).
      const safePath = typeof path === 'string' && /^\/(?![/\\])/.test(path) ? path : '/'
      // The tray popover calls this too: after Cmd+W the manager window is gone (the app
      // lives on in the tray), so re-create it first — exactly like openPortalByProject.
      showInManagerWindow({ ensureManagerWindow: showManagerWindow, showPortalView }, stack, safePath)
    })
  )

  ipcMain.handle('orcha:portalHide', () => asResult(async () => hidePortalView()))

  // Read-only pull of the active-view state (the renderer asks on mount, so a reloaded or
  // re-created manager window never misses the first push).
  ipcMain.handle('orcha:getPortalActive', (event) =>
    asResult(async (): Promise<PortalActive | null> => {
      if (!managerWindow || event.sender !== managerWindow.webContents) return null
      return portalActivePayload()
    })
  )

  ipcMain.handle('orcha:listAttention', () => asResult(async () => poller?.current() ?? []))

  // Items + per-stack availability (V2 host sidebar: unavailable ≠ zero).
  ipcMain.handle('orcha:listAttentionStatus', () =>
    asResult(async () => poller?.snapshot() ?? { items: [], projects: [] })
  )

  // ---- V2 embedded mode (arch §7) ----

  // Host sidebar geometry → recompute the active view's bounds immediately. Only the
  // manager window may set it; values are clamped (never trust renderer numbers).
  ipcMain.handle('orcha:setHostLayout', (event, layout: unknown) =>
    asResult(async () => {
      if (!managerWindow || event.sender !== managerWindow.webContents) return
      const l = (typeof layout === 'object' && layout !== null ? layout : {}) as Record<string, unknown>
      hostSidebarWidth = clampSidebarWidth(l.sidebarWidth, l.collapsed === true)
      if ('stripHeight' in l) hostStripHeight = clampStripHeight(l.stripHeight)
      if ('terminalShown' in l && typeof l.terminalShown === 'boolean' && l.terminalShown !== hostTerminalShown) {
        hostTerminalShown = l.terminalShown
        const view = activeProject !== null ? portalViews.get(activeProject) : undefined
        if (view && !view.webContents.isDestroyed()) {
          view.setVisible(portalViewVisible({ hostModalOpen, terminalShown: hostTerminalShown }))
          // Keyboard focus follows what is on screen: the terminal lives in the host renderer.
          if (hostTerminalShown) managerWindow.webContents.focus()
          else if (!hostModalOpen) view.webContents.focus()
        } else if (hostTerminalShown) {
          managerWindow.webContents.focus()
        }
      }
      resizeActivePortalView()
    })
  )

  // A host dialog opened/closed: hide/restore the active native view (a DOM dialog cannot
  // draw above it) and tell the portal so it doesn't trap focus meanwhile.
  ipcMain.handle('orcha:setHostModal', (event, open: unknown, opts?: unknown) =>
    asResult(async () => {
      if (!managerWindow || event.sender !== managerWindow.webContents || typeof open !== 'boolean') return
      // Closing a host overlay (e.g. the command menu that just opened a terminal tab) may
      // keep keyboard focus in the host instead of handing it back to the portal view.
      const keepHostFocus =
        !open && typeof opts === 'object' && opts !== null && (opts as { focus?: unknown }).focus === 'host'
      hostModalOpen = open
      if (activeProject === null) return
      const project = activeProject
      // Keyboard focus follows the dialog (see applyHostModal): a hidden view that still
      // holds focus would swallow Escape/Enter/Tab meant for e.g. a portal-requested stop.
      applyHostModal(
        open,
        portalViews.get(project),
        managerWindow.webContents,
        (o) => sendToPortal(project, { type: 'hostModal', open: o }),
        !keepHostFocus,
        hostTerminalShown
      )
    })
  )

  // Manager renderer → active portal: SPA navigate / open search. Validated here; only the
  // manager window may send. A view not (yet) in V2 mode can't receive SPA messages, so a
  // navigate falls back to a full load of the same safe path (never a different origin).
  ipcMain.handle('orcha:embedSend', (event, raw: unknown) =>
    asResult(async (): Promise<boolean> => {
      if (!managerWindow || event.sender !== managerWindow.webContents) return false
      const msg = parseHostMessage(raw)
      if (!msg || msg.type === 'hostModal' || activeProject === null) return false
      const project = activeProject
      const view = portalViews.get(project)
      if (!view || view.webContents.isDestroyed()) return false
      if (embedTracker.modeOf(project) !== 'v2') {
        if (msg.type === 'navigate' && isSafePath(msg.path)) {
          const origin = portalOrigins.get(project)
          if (origin) void view.webContents.loadURL(`${origin}${msg.path}`)
          return true
        }
        return false
      }
      sendToPortal(project, msg)
      if (msg.type === 'openSearch' && !hostModalOpen) view.webContents.focus()
      return true
    })
  )

  // Portal → host (fire-and-forget). The sender must be a known portal view's MAIN frame on
  // that stack's own origin; the project is derived from the sender, never from the
  // message. Unknown/malformed messages are dropped. Nothing here can run commands: the
  // only side effects are layout (ready), bookkeeping (route) and forwarding to the
  // manager renderer, which maps requestHostAction to its existing, confirmed stack actions.
  ipcMain.on(EMBED_TO_HOST_CHANNEL, (event, raw: unknown) => {
    const project = portalProjectByWebContentsId.get(event.sender.id)
    const frame = event.senderFrame
    const facts = {
      project,
      isRegisteredView: project !== undefined && portalViews.get(project)?.webContents === event.sender,
      isMainFrame: frame !== null && frame === event.sender.mainFrame,
      frameUrl: frame?.url ?? null,
      expectedOrigin: project !== undefined ? portalOrigins.get(project) : undefined
    }
    if (!acceptPortalSender(facts)) return
    const msg = parsePortalMessage(raw)
    if (!msg) return
    const from = facts.project
    if (msg.type === 'ready') {
      embedTracker.ready(from)
      // a new full load: the previous load's resolved container may no longer apply
      lastCids.delete(from)
    }
    if (msg.type === 'revealPath') {
      // Settings › Agent worktrees "Open folder": only a folder directly inside THIS stack's
      // own .orcha-worktrees (the project is the sender's, never the message's).
      void listStacks()
        .then((stacks) => {
          const folder = stacks.find((s) => s.project === from)?.folder
          if (folder && isAgentWorktreePath(folder, msg.path) && isDirectory(msg.path)) shell.showItemInFolder(msg.path)
        })
        .catch(() => {})
      return
    }
    if (msg.type === 'route') lastRoutes.set(from, msg)
    // The portal's RESOLVED container (its route may drop ?cid=, QA 2/6).
    if ((msg.type === 'attention' || msg.type === 'liveAgents') && msg.cid !== null) lastCids.set(from, msg.cid)
    sendToManager('orcha:embed:event', { project: from, msg } satisfies EmbedEvent)
  })

  // ---- Terminal tabs: typed, validated, host-renderer-only (main/terminalIpc.ts) ----
  const termResult = <T>(fn: () => T | Promise<T>): Promise<IpcResult<T>> =>
    asResult(async () => {
      try {
        return await fn()
      } catch (err) {
        if (err instanceof TermRequestError) {
          if (err.code === 'SPAWN_FAILED') console.error('[orcha-desktop] terminal spawn failed:', err.message)
          throw (err.code === 'UNKNOWN_STACK' || err.code === 'UNKNOWN_BRANCH'
            ? { code: err.code }
            : {
                code: 'TERMINAL_FAILED',
                reason: err.code,
                ...(err.code === 'SPAWN_FAILED' ? { message: err.message } : {})
              }) satisfies BridgeError
        }
        throw err
      }
    })
  ipcMain.handle(TERM_CHANNELS.create, (event, raw: unknown) =>
    termResult(async () => {
      const info = await termController.create(termSender(event), raw)
      if (info.kind !== 'shell' && !info.probe) appStats?.spawned(info.id)
      return info
    })
  )
  ipcMain.handle(TERM_CHANNELS.kill, (event, raw: unknown) => termResult(() => termController.kill(termSender(event), raw)))
  ipcMain.handle(TERM_CHANNELS.list, (event) => termResult(() => termController.list(termSender(event))))
  // Keystrokes and resizes are fire-and-forget (no round trip per key); invalid ones drop.
  ipcMain.on(TERM_CHANNELS.write, (event, raw: unknown) => void termController.write(termSender(event), raw))
  ipcMain.on(TERM_CHANNELS.resize, (event, raw: unknown) => void termController.resize(termSender(event), raw))
  // Session restore: cosmetic layout in (pty ids only), saved tabs reopened by main.
  ipcMain.on(TERM_CHANNELS.layout, (event, raw: unknown) => {
    if (acceptTermSenderFacts(termSender(event))) sessionKeeper.layout(raw)
  })
  ipcMain.handle(TERM_CHANNELS.restore, (event, raw: unknown) =>
    termResult(async () => {
      if (!acceptTermSenderFacts(termSender(event))) throw new TermRequestError('FORBIDDEN')
      const req = parseRestoreRequest(raw)
      if (!req) throw new TermRequestError('INVALID')
      return sessionKeeper.restore(req)
    })
  )
  ipcMain.on(TERM_CHANNELS.focus, (event, focused: unknown) => {
    if (termSender(event).isHostRenderer && typeof focused === 'boolean') termFocused = focused
  })

  // The command menu is DOM in the host renderer; the native view would cover it, so the
  // host hides the view while the menu is open and paints this still of it underneath (the
  // panel looks unchanged instead of flashing to the projects list). Manager-only, and it
  // returns pixels of the ACTIVE view only.
  ipcMain.handle('orcha:portalSnapshot', (event) =>
    asResult(async (): Promise<Uint8Array | null> => {
      if (!managerWindow || event.sender !== managerWindow.webContents || activeProject === null) return null
      const view = portalViews.get(activeProject)
      if (!view || view.webContents.isDestroyed() || hostModalOpen || hostTerminalShown) return null
      const image = await view.webContents.capturePage()
      if (image.isEmpty()) return null
      return new Uint8Array(image.toJPEG(82))
    })
  )

  ipcMain.handle('orcha:openManager', () => asResult(async () => showManagerWindow()))

  ipcMain.handle('orcha:quitApp', () => asResult(async () => app.quit()))

  // ---- onboarding ----

  ipcMain.handle('orcha:preflight', () => asResult(() => preflight()))

  ipcMain.handle('orcha:probePrereqs', () => asResult(() => probePrereqs()))

  ipcMain.handle('orcha:installPrereqs', () =>
    asResult(async (): Promise<InstallResult> => {
      const probe = await probePrereqs()
      // A packaged app brings the Orcha helper with it (bundled runtime, GH #258 D3), so the
      // probe finds it and this is a no-op. Only a dev build without `orcha` installs it here.
      // An AI coding agent (Claude Code / Codex) stays a requirement the user installs.
      const steps = planInstall(probe).filter((s) => s.id === 'orcha')
      if (steps.length === 0) return { ok: true, completed: [] }
      return runInstall(steps, {
        runUser: runUserInstall,
        runAdmin: runAdminInstall,
        onProgress: (e) => sendToManager('orcha:install:progress', e)
      })
    })
  )

  ipcMain.handle('orcha:pickFolder', (_event, mode: FolderMode) =>
    asResult(async () => {
      const result = await dialog.showOpenDialog({
        properties: mode === 'new-blank' ? ['openDirectory', 'createDirectory'] : ['openDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) return null
      return { folder: result.filePaths[0], mode }
    })
  )

  ipcMain.handle('orcha:inspectFolder', (_event, folder: string) =>
    asResult(async () => inspectFolder(folder))
  )

  ipcMain.handle('orcha:provision', (_event, opts: ProvisionOptions) =>
    asResult(async () => {
      const deps = await reservedEngineDeps()
      const res = await provision(
        opts,
        (e: ProgressEvent) => sendToManager('orcha:provision:progress', e),
        deps
      )
      // Re-added: its kept data is in use again (Settings › Storage stops listing it).
      try {
        dropKept(app.getPath('userData'), res.project)
      } catch {
        // ledger is best effort
      }
      return res
    })
  )

  // ---- add project / from GitHub ----

  ipcMain.handle('orcha:githubStatus', () =>
    asResult(async (): Promise<GithubStatus> => {
      // git presence is this path's own preflight — a fresh Mac may have Homebrew/Docker/an
      // AI agent (the global hard prereqs) but no git yet (Xcode CLT installs it lazily).
      const [gitPath, authenticated] = await Promise.all([whichHostTool('git'), ghIsAuthenticated(dockerExec)])
      return { authenticated, gitInstalled: !!gitPath }
    })
  )

  ipcMain.handle('orcha:githubRepos', () => asResult(async (): Promise<GhRepo[]> => ghListRepos(dockerExec)))

  ipcMain.handle('orcha:suggestCloneDest', (_event, repoUrl: unknown) =>
    asResult(async (): Promise<CloneDestSuggestion> => {
      const check = typeof repoUrl === 'string' ? validateRepoUrl(repoUrl) : { ok: false as const, reason: '' }
      const repoName = check.ok ? check.repoName : 'repo'
      const stacks = await listStacks().catch(() => [])
      const parent = defaultClonesParent(
        stacks.map((s) => s.folder),
        os.homedir()
      )
      return { parent, repoName }
    })
  )

  ipcMain.handle('orcha:pickCloneDest', (_event, repoName: unknown) =>
    asResult(async (): Promise<string | null> => {
      // Default the picker to the same suggested parent suggestCloneDest computed, so the
      // common case (accept the suggestion) is a single click. mkdirp it first — Finder's
      // panel silently ignores a defaultPath that doesn't exist yet (e.g. a fresh ~/orcha-
      // projects on a machine with no stacks yet).
      const stacks = await listStacks().catch(() => [])
      const defaultParent = defaultClonesParent(
        stacks.map((s) => s.folder),
        os.homedir()
      )
      mkdirSync(defaultParent, { recursive: true })
      const result = await dialog.showOpenDialog({
        defaultPath: defaultParent,
        properties: ['openDirectory', 'createDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) return null
      const name = typeof repoName === 'string' && repoName ? repoName : 'repo'
      return resolveCloneDest(result.filePaths[0], name)
    })
  )

  ipcMain.handle('orcha:cloneAndProvision', (_event, opts: CloneAndProvisionOptions) =>
    asResult(async () => cloneAndProvision(opts, (e: ProgressEvent) => sendToManager('orcha:provision:progress', e)))
  )

  ipcMain.handle('orcha:openOnboardingPortal', (_event, project: string) =>
    asResult(async () => {
      // Reuse the portal-show path: discover the just-created stack and land on the
      // DASHBOARD ('/'), not '/onboarding' — by the time the wizard's Finish fires,
      // provisioning has already registered the operator and (usually) created the
      // fleet, and the portal's own first-run page would greet that fully-set-up
      // workspace with "your workspace is empty".
      const stacks = await listStacks()
      const stack = stacks.find((s) => s.project === project)
      if (stack && stack.running && stack.apiPort !== null) showPortalView(stack, '/')
    })
  )

  ipcMain.handle('orcha:analyzeProject', (_event, folder: unknown) =>
    asResult(async (): Promise<AnalyzeProjectResult> => {
      // Deep roster analysis via the user's OWN local Claude Code subscription — never
      // throws (analyzeProject collapses every failure to {ok:false, reason}), so this
      // handler never rejects; the renderer treats a false `ok` as "nothing to show".
      if (typeof folder !== 'string' || !folder) return { ok: false, reason: 'no folder given' }
      const pathEnv = nodeHostWorkerDeps.pathEnv ?? hostToolPath()
      return analyzeProject(folder, nodeAnalyzeProjectDeps(pathEnv))
    })
  )

  ipcMain.handle('orcha:openExternal', (_event, url: unknown) =>
    asResult(async () => {
      // Allowlist https only — the renderer can't be tricked into opening file:// or app schemes.
      if (typeof url === 'string' && /^https:\/\//.test(url)) await shell.openExternal(url)
    })
  )

  // ---- fleet suggestion: localhost-only portal pass-through ----
  // The renderer runs sandboxed (no direct network to localhost portals), so the Fleet step's
  // GET/POST to a just-provisioned stack's own API goes through main. Both the port AND path
  // are validated against the live discovery snapshot — this is NOT a general proxy.

  ipcMain.handle('orcha:portalGet', (_event, apiPort: unknown, path: unknown) =>
    asResult(async () => portalRequest(apiPort, path, 'GET'))
  )

  ipcMain.handle('orcha:portalPost', (_event, apiPort: unknown, path: unknown, body: unknown) =>
    asResult(async () => portalRequest(apiPort, path, 'POST', body))
  )

  ipcMain.handle('orcha:portalPut', (_event, apiPort: unknown, path: unknown, body: unknown) =>
    asResult(async () => portalRequest(apiPort, path, 'PUT', body))
  )

  // App menu with File → Add Project. The provisioning wizard lives inside the manager
  // window (no second window) — Add Project focuses it and asks the renderer to switch
  // into the wizard, in "add-project" variant (same steps as first-run onboarding).
  // ---- Agents settings: typed, validated, host-renderer-only (main/agentsIpc.ts) ----
  // Loopback hook receiver + hook files; a failure only costs the ✓ (heuristics remain).
  startAgentHooks().catch((err) => console.warn('[agent-hooks] disabled:', err instanceof Error ? err.message : err))
  let menuAgentLabel = ''
  agentsCtl = createAgentsController({
    detector: agentDetector,
    load: () => readAgentPrefs(app.getPath('userData')),
    save: (prefs) => void writeAgentPrefs(app.getPath('userData'), prefs),
    openExternal: (url) => shell.openExternal(url),
    copyText: (text) => clipboard.writeText(text),
    onChange: (snap: AgentsSnapshot) => {
      sendToManager(AGENT_CHANNELS.changed, snap)
      const label = agentShortLabel(snap.defaultAgent)
      if (label !== menuAgentLabel) installAppMenu(label)
    }
  })
  const agentsResult = <T>(fn: () => T | Promise<T>): Promise<IpcResult<T>> =>
    asResult(async () => {
      try {
        return await fn()
      } catch (err) {
        if (err instanceof AgentsRequestError) throw { code: 'AGENTS_FAILED', reason: err.code } satisfies BridgeError
        throw err
      }
    })
  const ctl = agentsCtl
  ipcMain.handle(AGENT_CHANNELS.get, (event) => agentsResult(() => ctl.get(termSender(event))))
  ipcMain.handle(AGENT_CHANNELS.refresh, (event) => agentsResult(() => ctl.refresh(termSender(event))))
  ipcMain.handle(AGENT_CHANNELS.update, (event, raw: unknown) => agentsResult(() => ctl.update(termSender(event), raw)))
  ipcMain.handle(AGENT_CHANNELS.openDocs, (event, raw: unknown) => agentsResult(() => ctl.openDocs(termSender(event), raw)))
  ipcMain.handle(AGENT_CHANNELS.copyInstall, (event, raw: unknown) => agentsResult(() => ctl.copyInstall(termSender(event), raw)))
  // First detection in the background so menus/settings have results when first opened.
  ctl.warm()

  /** (Re)build the app menu — again whenever the Default agent changes (⌥⌘T's label). */
  function installAppMenu(defaultAgentLabel: string): void {
    menuAgentLabel = defaultAgentLabel
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        buildAppMenuTemplate({
          onTerminal: (command) => sendTermCommand(command),
          onSettings: () => sendTermCommand('open-settings'),
          defaultAgentLabel,
          onReloadPage: () => {
            // the project page on screen (bypassing cache so a freshly upgraded portal loads);
            // with no portal showing, reload the host window as the stock item did
            const view = activeProject ? portalViews.get(activeProject) : undefined
            if (view && !view.webContents.isDestroyed() && view.getVisible()) view.webContents.reloadIgnoringCache()
            else if (managerWindow && !managerWindow.isDestroyed()) managerWindow.webContents.reload()
          },
          onClose: () => {
            // ⌘W: with focus in the host's terminal dock it closes the active TAB; anywhere
            // else (portal view, other windows) it closes the window as before.
            const focused = BrowserWindow.getFocusedWindow()
            const action = closeAction({
              focusedIsManager: !!focused && !!managerWindow && focused === managerWindow,
              managerContentsFocused: !!managerWindow && !managerWindow.isDestroyed() && managerWindow.webContents.isFocused(),
              termFocused
            })
            if (action === 'tab') {
              sendToManager(TERM_CHANNELS.command, 'close-tab' satisfies TermCommand)
              return
            }
            focused?.close()
          },
          onAddProject: () => {
            showManagerWindow()
            // The wizard renders as DOM in the renderer; any embedded portal WebContentsView
            // would still draw ABOVE it, so hide the view before switching (rule: wizard/home
            // = no view visible — see showPortalView/hidePortalView).
            hidePortalView()
            sendToManager('orcha:navigate', { target: 'onboarding', variant: 'add-project' })
          }
        })
      )
    )
  }
  installAppMenu(agentShortLabel(ctl.prefs().defaultAgent))

  // ---- Usage & spend (main/usage/*): local log analytics + subscription windows ----
  const userData = app.getPath('userData')
  const statsFile = path.join(userData, 'usage-stats.json')
  let statsSaveTimer: ReturnType<typeof setTimeout> | null = null
  appStats = new AppStatsLedger({
    load: () => {
      try {
        return JSON.parse(readFileSync(statsFile, 'utf8')) as unknown
      } catch {
        return null
      }
    },
    // Debounced atomic write (status flips can be frequent).
    save: (data) => {
      if (statsSaveTimer) clearTimeout(statsSaveTimer)
      statsSaveTimer = setTimeout(() => {
        try {
          writeFileSync(`${statsFile}.tmp`, JSON.stringify(parseStatsFile(data)) + '\n', { mode: 0o600 })
          renameSync(`${statsFile}.tmp`, statsFile)
        } catch {
          /* best-effort */
        }
      }, 1000)
    },
    now: () => Date.now()
  })
  scanClient = createScanClient(path.join(userData, 'usage-cache.json'))
  const scan = scanClient
  usage = new UsageService({
    env: process.env,
    home: os.homedir(),
    loadPrefs: () => readUsagePrefsFile(userData),
    savePrefs: (p) => writeUsagePrefsFile(userData, p),
    scan: (roots) => scan.scan(roots),
    readClaudeCredentials: () => readClaudeCredentials(process.env, os.homedir()),
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    agents: () => agentsCtl?.snapshot() ?? null,
    appStats: () => appStats?.snapshot() ?? { agentsSpawned: 0, agentSeconds: 0, trackingSince: null },
    onChange: (snap) => publishUsage(snap),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
  })
  const usageSvc = usage
  /** Usage IPC: the manager and the tray popover (both our own index preload) may read and
   *  change usage prefs; embedded portal views never can (different preload, and refused). */
  const usageSender = (event: Electron.IpcMainInvokeEvent): boolean =>
    (!!managerWindow && !managerWindow.isDestroyed() && event.sender === managerWindow.webContents) ||
    [...popoverWindows].some((w) => !w.isDestroyed() && w.webContents === event.sender)
  const usageResult = <T>(event: Electron.IpcMainInvokeEvent, fn: () => T | Promise<T>): Promise<IpcResult<T>> =>
    asResult(async () => {
      if (!usageSender(event)) throw { code: 'USAGE_FAILED', reason: 'FORBIDDEN' } satisfies BridgeError
      return await fn()
    })
  ipcMain.handle(USAGE_CHANNELS.get, (event) => usageResult(event, () => usageSvc.snapshot()))
  ipcMain.handle(USAGE_CHANNELS.refresh, (event) => usageResult(event, () => usageSvc.refresh({ manual: true })))
  ipcMain.handle(USAGE_CHANNELS.update, (event, raw: unknown) =>
    usageResult(event, () => {
      const snap = usageSvc.update(raw)
      if (!snap) throw { code: 'USAGE_FAILED', reason: 'INVALID' } satisfies BridgeError
      return snap
    })
  )
  ipcMain.handle(USAGE_CHANNELS.openStats, (event, target: unknown) =>
    usageResult(event, () => openUsageInManager(target === 'accounts' ? 'accounts' : 'stats'))
  )

  // "Show plan usage" (sidebar Usage row): cached in <userData>, re-read from every running
  // portal at launch, on focus and every 2 minutes; a change is PUT to all of them.
  const displayFile = path.join(userData, 'plan-usage-display.json')
  const displaySync = createPlanUsageDisplaySync({
    listStacks: () => listStacks(),
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    load: () => {
      try {
        return JSON.parse(readFileSync(displayFile, 'utf8')) as unknown
      } catch {
        return null
      }
    },
    save: (d) => {
      try {
        writeFileSync(`${displayFile}.tmp`, JSON.stringify(d) + '\n', { mode: 0o600 })
        renameSync(`${displayFile}.tmp`, displayFile)
      } catch {
        /* best-effort: the in-memory value stays */
      }
    },
    onChange: (d) => {
      sendToManager(USAGE_CHANNELS.displayChanged, d)
      for (const w of popoverWindows) if (!w.isDestroyed()) w.webContents.send(USAGE_CHANNELS.displayChanged, d)
    }
  })
  planDisplay = displaySync
  ipcMain.handle(USAGE_CHANNELS.displayGet, (event) => usageResult(event, () => displaySync.get()))
  ipcMain.handle(USAGE_CHANNELS.displaySet, (event, raw: unknown) =>
    usageResult(event, () => {
      const d = displaySync.set(raw)
      if (!d) throw { code: 'USAGE_FAILED', reason: 'INVALID' } satisfies BridgeError
      return d
    })
  )
  void displaySync.refresh()

  // Settings › API keys: an Anthropic / OpenAI key stored on every running project (sealed by
  // its portal) and switched on/off for its agent runs; remembered on this Mac with the
  // Keychain-backed safeStorage so projects started later get it too. The key arrives here
  // once (save) and never goes back to any renderer, log or error.
  const keysFile = path.join(userData, 'provider-keys.json')
  const keys = createProviderKeys({
    listStacks: () => listStacks(),
    fetch: (input, init) => fetch(input, init),
    profileName: () => currentProfile().effective,
    load: () => {
      try {
        return JSON.parse(readFileSync(keysFile, 'utf8')) as unknown
      } catch {
        return null
      }
    },
    save: (data) => {
      writeFileSync(`${keysFile}.tmp`, JSON.stringify(data) + '\n', { mode: 0o600 })
      renameSync(`${keysFile}.tmp`, keysFile)
    },
    canSeal: () => {
      // On macOS the Keychain is always there, and asking safeStorage reads the
      // "Embodent Safe Storage" item — a password prompt at launch (and every refresh)
      // for someone who never saved a key. Only seal/unseal touch the Keychain.
      if (process.platform === 'darwin') return true
      try {
        return safeStorage.isEncryptionAvailable()
      } catch {
        return false
      }
    },
    seal: (plain) => {
      try {
        return safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(plain).toString('base64') : null
      } catch {
        return null
      }
    },
    unseal: (sealed) => {
      try {
        return safeStorage.decryptString(Buffer.from(sealed, 'base64'))
      } catch {
        return null
      }
    },
    onBilling: (b) => usageSvc.setApiBilling(b),
    now: () => Date.now()
  })
  ipcMain.handle(PROVIDER_KEYS_CHANNELS.get, (event) =>
    asResult(async () => {
      if (!themeSender(event)) throw { code: 'INVALID_PROVIDER_KEYS' } satisfies BridgeError
      return keys.get()
    })
  )
  ipcMain.handle(PROVIDER_KEYS_CHANNELS.refresh, (event) =>
    asResult(async () => {
      if (!themeSender(event)) throw { code: 'INVALID_PROVIDER_KEYS' } satisfies BridgeError
      return keys.refresh()
    })
  )
  ipcMain.handle(PROVIDER_KEYS_CHANNELS.save, (event, raw: unknown) =>
    asResult(async () => {
      if (!themeSender(event)) throw { code: 'INVALID_PROVIDER_KEYS' } satisfies BridgeError
      const input = parseProviderKeysInput(raw)
      if (!input) throw { code: 'INVALID_PROVIDER_KEYS' } satisfies BridgeError
      return keys.save(input)
    })
  )
  void keys.refresh()

  planDisplayTimer = setInterval(() => {
    void displaySync.refresh()
    void keys.refresh()
  }, DISPLAY_POLL_MS)
  app.on('browser-window-focus', () => void displaySync.refresh({ force: false }))

  // Dev dock icon (packaged builds carry it in the bundle). app.getAppPath() = desktop/.
  if (process.platform === 'darwin' && app.dock) {
    const icon = nativeImage.createFromPath(path.join(app.getAppPath(), 'resources', 'icon.png'))
    if (!icon.isEmpty()) app.dock.setIcon(icon)
  }

  tray = createTray({
    onOpenManager: showManagerWindow,
    createPopover: createPopoverWindow,
    onUsageDetails: () => openUsageInManager('stats'),
    onTestNotification: () =>
      showAttentionNotification({
        project: 'orcha-test',
        projectShort: 'orcha',
        kind: 'health',
        id: `test:${Date.now()}`,
        title: 'Test notification — Notification Center delivery works',
        path: '/'
      })
  })
  poller = new AttentionPoller({
    listStacks,
    fetchStackAttention,
    notify: showAttentionNotification,
    // Honour the person's Embodent notification settings (portal mig 063): the stack
    // itself decides (should_notify on the desktop channel); fails open.
    gate: async (item) => shouldShowAttention(item, await listStacks()),
    onUpdate: (items, stacks, details) => {
      // Badge = decisions only (plans, verifications, requests); follow-ups are listed in
      // the popover but never counted (V2 arch §3.3, desktop decision).
      tray?.update(items.filter(isDecisionItem).length)
      void writeStatusFile(buildStatus(stacks, items, details, new Date()))
    }
  })
  poller.start()
  usage.start()

  // One window. The renderer decides whether to show onboarding (zero stacks) or
  // the manager from its own listStacks() — no second window, no force-open here.
  createManagerWindow()
  app.on('activate', () => {
    showManagerWindow()
  })

  // Widget tap-through: validate the orcha:// link, then reuse the notification
  // click path (discovery re-checks the project before any window opens).
  app.on('open-url', (event, url) => {
    event.preventDefault()
    const target = parseDeepLink(url)
    if (target) void openPortalByProject(target.project, target.path)
  })
})

app.on('window-all-closed', () => {
  // Tray app: stay alive on macOS; quit elsewhere (v1.1 is macOS-first).
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  // Save the tab set (live shell folders, agent conversation ids) before the ptys go.
  sessionKeeper.freeze()
  ptyHost.killAll()
  void hookReceiver?.close()
  poller?.stop()
  usage?.stop()
  if (planDisplayTimer) clearInterval(planDisplayTimer)
  void planDisplay?.flush()
  appStats?.flush()
  scanClient?.stop()
  tray?.destroy()
})

// A wedged Docker CLI must not outlive the app as an orphaned `docker ps`.
app.on('will-quit', () => killPendingProbes())
