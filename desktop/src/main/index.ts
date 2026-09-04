import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, shell, WebContentsView } from 'electron'
import path from 'node:path'
import os from 'node:os'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { parseDeepLink } from './deepLink'
import { listStacks } from './discovery'
import { startStack, stopStack } from './lifecycle'
import { fetchStackAttention } from './attention'
import { AttentionPoller } from './attentionPoller'
import { createTray, type TrayController } from './tray'
import { buildStatus, writeStatusFile } from './statusFile'
import { dockerExec } from './dockerExec'
import { dockerPublishedPorts, pickFreePort } from './portPicker'
import { preflight } from './preflight'
import { inspectFolder } from './folderModes'
import { templatesRoot } from './templates'
import { provision, type EngineDeps, type EngineFs } from './initEngine'
import { startHostWorker, nodeHostWorkerDeps, hostToolPath, scrubWorkerEnv } from './hostWorker'
import { analyzeProject, nodeAnalyzeProjectDeps, type AnalyzeProjectResult } from './analyzeProject'
import { resetStack } from './resetEngine'
import { buildAppMenuTemplate } from './appMenu'
import { adminOsascriptArgs, planInstall, runInstall } from './installers'
import { ghAuthToken, ghIsAuthenticated, ghListRepos, defaultClonesParent, resolveCloneDest } from './githubSource'
import { validateRepoUrl } from '../shared/repoUrl'
import { computeViewBounds } from './viewBounds'
import { readAppearance, writeAppearance, isEmpty, type Appearance } from './appearanceStore'
import { buildReadAppearanceScript, buildApplyAppearanceScript } from './appearanceScripts'
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
  PrereqProbe,
  ProgressEvent,
  ProvisionOptions,
  ProvisionResult,
  Stack
} from '../shared/types'

/** Real-fs adapter for the provision engine (the engine injects this for testability). */
const nodeEngineFs: EngineFs = {
  readFile: (p) => readFileSync(p, 'utf8'),
  writeFile: (p, c) => writeFileSync(p, c),
  copyTree: (src, dst) => cpSync(src, dst, { recursive: true }),
  mkdirp: (p) => void mkdirSync(p, { recursive: true }),
  chmod: (p, mode) => chmodSync(p, mode),
  exists: (p) => existsSync(p),
  readDir: (p) => {
    try {
      return readdirSync(p)
    } catch {
      return []
    }
  }
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

/** Build the engine deps. Ports are reserved per-run in the provision handler and
 *  injected via `findFreePort`; the default here is a harmless identity it overrides. */
function engineDeps(): EngineDeps {
  return {
    exec: dockerExec,
    fetchJson,
    fs: nodeEngineFs,
    templatesRoot,
    findFreePort: (start: number) => start,
    readComposeTemplate: () => {
      const composePath = path.join(templatesRoot(), 'docker-compose.yml.j2')
      if (!existsSync(composePath)) {
        // The template assets are gitignored and copied in by scripts/copy-orcha-templates.mjs
        // (run via predev/prebuild/predist). If they're missing the raw error is a bare
        // "ENOENT"; replace it with something a non-engineer can act on.
        throw new Error(
          'App assets are missing (bundled Orcha templates not found). ' +
            'In a dev checkout run `npm run build` (or `npm run copy:templates`) before launching; ' +
            'in a packaged build this means the .app was built incorrectly.'
        )
      }
      return readFileSync(composePath, 'utf8')
    },
    genSecret: () => randomBytes(32).toString('base64url'),
    user: os.userInfo().username || 'operator',
    // After the portal is up, start the host-side agent worker (orcha CLI notifier) so
    // assigned tasks actually run — without this the portal opens but nothing picks up work.
    startWorker: (folder) => startHostWorker(folder, nodeHostWorkerDeps),
    // gh token injection at provision (parity with `orcha up`) — see initEngine's compose-up step.
    ghAuthToken: () => ghAuthToken(dockerExec)
  }
}

// ---- Prerequisites: probe + guided auto-install ----------------------------------------
// A fresh Mac has none of the host tools that actually run agents (Homebrew, the Docker
// engine, the orcha CLI, Claude Code, an API key). These helpers detect what's missing and
// install it behind native dialogs — the pure plan/orchestration lives in ./installers.

/** Where the Anthropic API key is stored (this Mac only). Loaded into the process env on
 *  startup so the orcha worker we spawn inherits it; never written to the user's shell. */
function apiKeyFile(): string {
  return path.join(app.getPath('userData'), 'anthropic-api-key')
}

/** Load a previously-saved API key into the env so spawned `orcha up` → `claude` can see it. */
function loadApiKeyIntoEnv(): void {
  try {
    const f = apiKeyFile()
    if (!process.env.ANTHROPIC_API_KEY && existsSync(f)) {
      const key = readFileSync(f, 'utf8').trim()
      if (key) process.env.ANTHROPIC_API_KEY = key
    }
  } catch {
    // A missing/unreadable key file just means "no key yet" — the worker reports it plainly.
  }
}

/** `which <cmd>` against the host-tool PATH (the Finder-launched .app's PATH omits brew etc.). */
function whichHostTool(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('/usr/bin/which', [cmd], { env: { ...process.env, PATH: hostToolPath() } }, (err, stdout) =>
      resolve(err ? null : stdout.trim() || null)
    )
  })
}

async function probePrereqs(): Promise<PrereqProbe> {
  const [brew, docker, orcha, claude, codex] = await Promise.all([
    whichHostTool('brew'),
    whichHostTool('docker'),
    whichHostTool('orcha'),
    whichHostTool('claude'),
    whichHostTool('codex')
  ])
  return {
    homebrew: !!brew,
    dockerEngine: !!docker,
    orcha: !!orcha,
    claude: !!claude,
    codex: !!codex,
    apiKey: !!process.env.ANTHROPIC_API_KEY || existsSync(apiKeyFile())
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

/** Prompt for the Anthropic API key with a native, masked text field; null if cancelled. */
function promptApiKey(): Promise<string | null> {
  return new Promise((resolve) => {
    const args = [
      '-e',
      'try',
      '-e',
      'set k to text returned of (display dialog "Paste your Anthropic API key (starts with sk-ant-). It is stored only on this Mac." default answer "" with hidden answer with title "Orcha" buttons {"Cancel", "Save"} default button "Save")',
      '-e',
      'return k',
      '-e',
      'on error',
      '-e',
      'return "__CANCELLED__"',
      '-e',
      'end try'
    ]
    execFile('osascript', args, (err, stdout) => {
      if (err) return resolve(null)
      const v = stdout.trim()
      resolve(!v || v === '__CANCELLED__' ? null : v)
    })
  })
}

async function persistApiKey(key: string): Promise<void> {
  const f = apiKeyFile()
  mkdirSync(path.dirname(f), { recursive: true })
  writeFileSync(f, key, { mode: 0o600 })
  process.env.ANTHROPIC_API_KEY = key
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

/** Reserve three DISTINCT free host ports the engine reads via a sync lookup keyed by the
 *  CLI's scan-start constants (5432/8000/8765), and wire them into a fresh EngineDeps. We
 *  must exclude ports Docker has already published: a host listen on 0.0.0.0:<p> can
 *  succeed while docker-proxy owns it, so the host probe alone misses the collision
 *  (#port-collision). We also feed each chosen port back into the exclusion set so
 *  db/api/bridge never pick the same port. Shared by orcha:provision and cloneAndProvision
 *  so both provisioning entry points reserve ports identically. */
async function reservedEngineDeps(): Promise<EngineDeps> {
  const taken = await dockerPublishedPorts()
  const db = await pickFreePort(5432, { dockerPorts: taken })
  taken.add(db)
  const api = await pickFreePort(8000, { dockerPorts: taken })
  taken.add(api)
  const bridge = await pickFreePort(8765, { dockerPorts: taken })
  const reserved: Record<number, number> = { 5432: db, 8000: api, 8765: bridge }
  return { ...engineDeps(), findFreePort: (start: number) => reserved[start] ?? start }
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

// Runtime name for everything Electron derives it from (userData path, dialogs).
// The macOS app-menu TITLE still reads the bundle's Info.plist ("Electron" in dev);
// it becomes "Orcha" when packaging (electron-builder productName) lands post-#238.
app.setName('Orcha')

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

function createManagerWindow(): void {
  managerWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    title: 'Orcha',
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
  managerWindow.on('closed', () => {
    managerWindow = null
    portalViews.clear()
    activeProject = null
  })
}

/** Recompute and apply bounds for whichever portal view is currently visible. Hidden views
 *  don't need their bounds kept current (they're not drawn), so this only ever touches the
 *  active one — cheap even with several stacks' views alive in the map. */
function resizeActivePortalView(): void {
  if (!managerWindow || managerWindow.isDestroyed() || activeProject === null) return
  const view = portalViews.get(activeProject)
  if (!view) return
  const [width, height] = managerWindow.getContentSize()
  view.setBounds(computeViewBounds({ width, height }))
}

// ---- Appearance sync across embedded portal views -----------------------------------
// Each stack's portal is a SEPARATE origin (localhost:<its own port>), so localStorage
// theme/skin never carries across stacks or survives a rebuilt container — the desktop app
// owns one small appearance.json as the cross-stack source of truth and pushes it into
// every live view. See appearanceStore.ts / appearanceScripts.ts for the pure pieces.

const APPEARANCE_POLL_MS = 3000
let appearancePoller: ReturnType<typeof setInterval> | null = null
/** Last known bag read off the currently-active view's own localStorage, used to detect a
 *  user-initiated change (e.g. clicking the theme toggle inside the portal) between polls. */
let lastPolledAppearance: Appearance | null = null

/** Push `appearance` into every OTHER live view besides `exceptProject` (best-effort — a
 *  view that isn't finished loading yet just misses this round; the next dom-ready sync or
 *  poll tick catches it up). */
function pushAppearanceToOtherViews(appearance: Appearance, exceptProject: string | null): void {
  const script = buildApplyAppearanceScript(appearance)
  for (const [project, view] of portalViews) {
    if (project === exceptProject) continue
    if (view.webContents.isDestroyed()) continue
    view.webContents.executeJavaScript(script).catch(() => {
      // Best-effort — a view mid-navigation can reject this harmlessly.
    })
  }
}

/** On a view's dom-ready: read its current localStorage appearance. If the app's own store
 *  is EMPTY (first launch, nothing chosen yet anywhere), adopt whatever this view already
 *  has — seeding the store from wherever the user last set it, rather than overwriting a
 *  real preference with nothing. Otherwise, if the store differs from this view, push the
 *  store's values into it (localStorage write + live DOM apply). */
async function syncAppearanceOnDomReady(view: WebContentsView, project: string): Promise<void> {
  try {
    const current = (await view.webContents.executeJavaScript(buildReadAppearanceScript())) as Appearance
    const userDataDir = app.getPath('userData')
    let stored = readAppearance(userDataDir)
    if (isEmpty(stored)) {
      if (!isEmpty(current)) {
        // Adopt whatever the user last set in a portal, rather than overwriting a
        // real preference with the default.
        writeAppearance(userDataDir, current)
        return
      }
      // TRUE first launch — nothing chosen anywhere: the product default is the
      // gold-minimalist look (dark + the portal's "gold" skin). Seed the store and
      // fall through so it's pushed into this very first view too.
      stored = { theme: 'dark', skin: 'gold' }
      writeAppearance(userDataDir, stored)
    }
    const differs = stored.theme !== current.theme || stored.skin !== current.skin
    if (differs) {
      await view.webContents.executeJavaScript(buildApplyAppearanceScript(stored))
    }
    if (project === activeProject) lastPolledAppearance = stored
  } catch {
    // Best-effort — a view that errors here just doesn't get synced this round.
  }
}

/** Poll the ACTIVE view's own appearance every ~3s: if it changed since the last tick (the
 *  user picked a new theme/skin inside that portal), save it to the store and push it to
 *  every OTHER live view. Cheap (one executeJavaScript per tick, only against the visible
 *  view), and needs no changes on the portal side — it's still just reading/writing its own
 *  ordinary localStorage keys. */
function startAppearancePoller(): void {
  if (appearancePoller) return
  appearancePoller = setInterval(() => {
    if (activeProject === null) return
    const view = portalViews.get(activeProject)
    if (!view || view.webContents.isDestroyed()) return
    const project = activeProject
    view.webContents
      .executeJavaScript(buildReadAppearanceScript())
      .then((current: Appearance) => {
        if (isEmpty(current)) return
        const prev = lastPolledAppearance
        const changed = !prev || prev.theme !== current.theme || prev.skin !== current.skin
        if (!changed) return
        lastPolledAppearance = current
        writeAppearance(app.getPath('userData'), current)
        pushAppearanceToOtherViews(current, project)
      })
      .catch(() => {
        // Best-effort — a mid-navigation view just misses this tick.
      })
  }, APPEARANCE_POLL_MS)
}

/** Create (if needed) and return the embedded WebContentsView for a stack's portal. */
function getOrCreatePortalView(stack: Stack): WebContentsView {
  const existing = portalViews.get(stack.project)
  if (existing) return existing

  const view = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  const portalOrigin = `http://localhost:${stack.apiPort}`
  // Portal content may link out (docs, repos): keep same-origin navigation in the
  // embedded view, push everything else to the system browser.
  view.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${portalOrigin}/`)) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })
  view.webContents.setWindowOpenHandler(({ url }) => {
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
  view.webContents.on('dom-ready', () => void syncAppearanceOnDomReady(view, stack.project))
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
  const [width, height] = managerWindow.getContentSize()
  view.setBounds(computeViewBounds({ width, height }))
  view.setVisible(true)
  activeProject = stack.project

  // Navigate on first creation, or whenever the caller asked for a specific path — reusing
  // an existing view otherwise means "switch back to what was on screen", not "reload".
  if (isNewView || path !== '/') {
    void view.webContents.loadURL(`http://localhost:${stack.apiPort}${path}`)
  }
  sendToManager('orcha:portalActive', { project: stack.project })
}

/** Hide whichever portal view is showing, returning to the renderer's own content
 *  (home/manager or the wizard). The view itself is left alive (just setVisible(false))
 *  so re-showing it later is instant. */
function hidePortalView(): void {
  if (activeProject !== null) {
    portalViews.get(activeProject)?.setVisible(false)
    activeProject = null
  }
  sendToManager('orcha:portalActive', { project: null })
}

/** Open-or-focus: reuse the existing manager window when it's still alive. */
function showManagerWindow(): void {
  if (managerWindow && !managerWindow.isDestroyed()) {
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
  return win
}

async function openPortalByProject(project: string, path?: string): Promise<void> {
  try {
    const stacks = await listStacks()
    const stack = stacks.find((s) => s.project === project)
    if (stack && stack.running && stack.apiPort !== null) {
      showManagerWindow()
      showPortalView(stack, path)
    }
  } catch {
    // Docker down or discovery hiccup at click time — nothing sensible to open.
  }
}

function showAttentionNotification(item: AttentionItem): void {
  if (!Notification.isSupported()) return
  const n = new Notification({ title: `Orcha — ${item.projectShort}`, body: item.title })
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
  method: 'GET' | 'POST' | 'PUT',
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
  if (!res.ok) throw { code: 'PORTAL_REQUEST_FAILED', status: res.status } as const
  const ct = res.headers.get('content-type') ?? ''
  return ct.includes('application/json') ? res.json() : undefined
}

app.whenReady().then(() => {
  // Make a saved API key visible to any worker we spawn this session.
  loadApiKeyIntoEnv()

  ipcMain.handle('orcha:listStacks', () => asResult(() => listStacks()))

  ipcMain.handle('orcha:startStack', (_event, project: string) =>
    asResult(async () => {
      const stack = await requireKnownStack(project)
      await startStack(stack.project)
    })
  )

  ipcMain.handle('orcha:stopStack', (_event, project: string) =>
    asResult(async () => {
      const stack = await requireKnownStack(project)
      await stopStack(stack.project)
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
            execFile(cmd, args, { cwd: opts.cwd, env: opts.env, encoding: 'utf8' }, (err, stdout, stderr) =>
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
      })
    })
  )

  ipcMain.handle('orcha:portalShow', (_event, project: string, path?: unknown) =>
    asResult(async () => {
      const stack = await requireKnownStack(project)
      if (!stack.running || stack.apiPort === null) throw { code: 'UNKNOWN_STACK' } as const
      // Renderer-supplied path: require a single leading slash (no protocol-relative
      // // and no /\ — URL parsers treat backslash as a segment separator too).
      const safePath = typeof path === 'string' && /^\/(?![/\\])/.test(path) ? path : '/'
      showPortalView(stack, safePath)
    })
  )

  ipcMain.handle('orcha:portalHide', () => asResult(async () => hidePortalView()))

  ipcMain.handle('orcha:listAttention', () => asResult(async () => poller?.current() ?? []))

  ipcMain.handle('orcha:openManager', () => asResult(async () => showManagerWindow()))

  ipcMain.handle('orcha:quitApp', () => asResult(async () => app.quit()))

  // ---- onboarding ----

  ipcMain.handle('orcha:preflight', () => asResult(() => preflight()))

  ipcMain.handle('orcha:probePrereqs', () => asResult(() => probePrereqs()))

  ipcMain.handle('orcha:installPrereqs', () =>
    asResult(async (): Promise<InstallResult> => {
      const probe = await probePrereqs()
      // The desktop app installs ONE thing for the user: the Orcha CLI helper. Homebrew,
      // Docker, and an AI coding agent (Claude Code / Codex) are hard requirements the user
      // installs themselves — the onboarding step shows them and gates Continue on them.
      const steps = planInstall(probe, {
        arch: os.arch(),
        user: os.userInfo().username || 'operator'
      }).filter((s) => s.id === 'orcha')
      if (steps.length === 0) return { ok: true, completed: [] }
      return runInstall(steps, {
        runUser: runUserInstall,
        runAdmin: runAdminInstall,
        promptSecret: promptApiKey,
        persistApiKey,
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
      return provision(
        opts,
        (e: ProgressEvent) => sendToManager('orcha:provision:progress', e),
        deps
      )
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
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildAppMenuTemplate({
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

  // Dev dock icon (packaged builds carry it in the bundle). app.getAppPath() = desktop/.
  if (process.platform === 'darwin' && app.dock) {
    const icon = nativeImage.createFromPath(path.join(app.getAppPath(), 'resources', 'icon.png'))
    if (!icon.isEmpty()) app.dock.setIcon(icon)
  }

  tray = createTray({
    onOpenManager: showManagerWindow,
    createPopover: createPopoverWindow,
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
    onUpdate: (items, stacks, details) => {
      tray?.update(items.length)
      void writeStatusFile(buildStatus(stacks, items, details, new Date()))
    }
  })
  poller.start()
  startAppearancePoller()

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
  poller?.stop()
  if (appearancePoller) clearInterval(appearancePoller)
  tray?.destroy()
})
