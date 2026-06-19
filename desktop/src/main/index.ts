import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, shell } from 'electron'
import path from 'node:path'
import os from 'node:os'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import { startHostWorker, nodeHostWorkerDeps, hostToolPath } from './hostWorker'
import { resetStack } from './resetEngine'
import { buildAppMenuTemplate } from './appMenu'
import { adminOsascriptArgs, planInstall, runInstall } from './installers'
import type {
  AttentionItem,
  BridgeError,
  FolderMode,
  InstallResult,
  IpcResult,
  PrereqProbe,
  ProgressEvent,
  ProvisionOptions,
  Stack
} from '../shared/types'

/** Real-fs adapter for the provision engine (the engine injects this for testability). */
const nodeEngineFs: EngineFs = {
  readFile: (p) => readFileSync(p, 'utf8'),
  writeFile: (p, c) => writeFileSync(p, c),
  copyTree: (src, dst) => cpSync(src, dst, { recursive: true }),
  mkdirp: (p) => void mkdirSync(p, { recursive: true }),
  chmod: (p, mode) => chmodSync(p, mode),
  exists: (p) => existsSync(p)
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
    startWorker: (folder) => startHostWorker(folder, nodeHostWorkerDeps)
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

// Runtime name for everything Electron derives it from (userData path, dialogs).
// The macOS app-menu TITLE still reads the bundle's Info.plist ("Electron" in dev);
// it becomes "Orcha" when packaging (electron-builder productName) lands post-#238.
app.setName('Orcha')

// Widgets deep-link back into the app: orcha://open?project=<compose project>&path=<portal path>
app.setAsDefaultProtocolClient('orcha')

let managerWindow: BrowserWindow | null = null
const portalWindows = new Map<string, BrowserWindow>()
let tray: TrayController | null = null
let poller: AttentionPoller | null = null

function createManagerWindow(): void {
  managerWindow = new BrowserWindow({
    width: 760,
    height: 560,
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
  managerWindow.on('closed', () => {
    managerWindow = null
  })
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
    if (stack && stack.running && stack.apiPort !== null) openPortalWindow(stack, path)
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

function openPortalWindow(stack: Stack, path = '/'): void {
  const url = `http://localhost:${stack.apiPort}${path}`
  const existing = portalWindows.get(stack.project)
  if (existing && !existing.isDestroyed()) {
    existing.loadURL(url)
    existing.focus()
    return
  }
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    title: `Orcha — ${stack.projectShort}`,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  win.loadURL(url)
  // Portal content may link out (docs, repos): keep same-origin navigation in-window,
  // push everything else to the system browser.
  const portalOrigin = `http://localhost:${stack.apiPort}`
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${portalOrigin}/`)) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(`${portalOrigin}/`)) {
      void shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })
  // The portal page's own <title> ("Orcha · Dashboard") would overwrite the window
  // title — keep the project name in front so multiple portals stay distinguishable.
  win.webContents.on('page-title-updated', (event, pageTitle) => {
    event.preventDefault()
    win.setTitle(`${stack.projectShort} · ${pageTitle.replace(/^Orcha\s*·\s*/, '')}`)
  })
  win.on('closed', () => {
    portalWindows.delete(stack.project)
  })
  portalWindows.set(stack.project, win)
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
        rmFile: (p) => rmSync(p, { force: true })
      })
    })
  )

  ipcMain.handle('orcha:openPortal', (_event, project: string, path?: unknown) =>
    asResult(async () => {
      const stack = await requireKnownStack(project)
      if (!stack.running || stack.apiPort === null) throw { code: 'UNKNOWN_STACK' } as const
      // Renderer-supplied path: require a single leading slash (no protocol-relative
      // // and no /\ — URL parsers treat backslash as a segment separator too).
      const safePath = typeof path === 'string' && /^\/(?![/\\])/.test(path) ? path : '/'
      openPortalWindow(stack, safePath)
    })
  )

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
      // Reserve three DISTINCT free host ports the engine reads via a sync lookup keyed by
      // the CLI's scan-start constants (5432/8000/8765). We must exclude ports Docker has
      // already published: a host listen on 0.0.0.0:<p> can succeed while docker-proxy owns
      // it, so the host probe alone misses the collision (#port-collision). We also feed each
      // chosen port back into the exclusion set so db/api/bridge never pick the same port.
      const taken = await dockerPublishedPorts()
      const db = await pickFreePort(5432, { dockerPorts: taken })
      taken.add(db)
      const api = await pickFreePort(8000, { dockerPorts: taken })
      taken.add(api)
      const bridge = await pickFreePort(8765, { dockerPorts: taken })
      const reserved: Record<number, number> = { 5432: db, 8000: api, 8765: bridge }
      const deps: EngineDeps = {
        ...engineDeps(),
        findFreePort: (start: number) => reserved[start] ?? start
      }
      return provision(
        opts,
        (e: ProgressEvent) => sendToManager('orcha:provision:progress', e),
        deps
      )
    })
  )

  ipcMain.handle('orcha:openOnboardingPortal', (_event, project: string) =>
    asResult(async () => {
      // Reuse the portal-open path: discover the just-created stack and open /onboarding.
      const stacks = await listStacks()
      const stack = stacks.find((s) => s.project === project)
      if (stack && stack.running && stack.apiPort !== null) openPortalWindow(stack, '/onboarding')
    })
  )

  ipcMain.handle('orcha:openExternal', (_event, url: unknown) =>
    asResult(async () => {
      // Allowlist https only — the renderer can't be tricked into opening file:// or app schemes.
      if (typeof url === 'string' && /^https:\/\//.test(url)) await shell.openExternal(url)
    })
  )

  // App menu with File → New Project. Onboarding lives inside the manager window now,
  // so New Project focuses it and asks the renderer to switch to onboarding mode.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildAppMenuTemplate({
        onNewProject: () => {
          showManagerWindow()
          sendToManager('orcha:navigate', 'onboarding')
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
  tray?.destroy()
})
