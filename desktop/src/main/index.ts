import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  shell
} from 'electron'
import path from 'node:path'
import { parseDeepLink } from './deepLink'
import { listStacks } from './discovery'
import { startStack, stopStack } from './lifecycle'
import { fetchStackAttention } from './attention'
import { AttentionPoller } from './attentionPoller'
import { createTray, type TrayController } from './tray'
import { buildStatus, writeStatusFile } from './statusFile'
import { checkDependencies } from './bootstrap'
import {
  BootstrapCancelled,
  dockerCommand,
  homebrewInstallCommand,
  homebrewPrepCommand,
  isOsascriptCancel,
  macArchFromSysctl,
  osascriptAdmin,
  planBootstrap,
  runGuidedBootstrap,
  userShellArgv,
  type InstallStepPlan
} from './installers'
import { dockerExec } from './dockerExec'
import { createWorkspace } from './workspace'
import type {
  AttentionItem,
  BootstrapStatus,
  BridgeError,
  IpcResult,
  Stack,
  WorkspaceResult
} from '../shared/types'

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

/** The Orcha mark, for dialogs, notifications, and windows. In dev the running bundle is plain
 *  Electron, so without passing this explicitly every prompt shows Electron's logo, not Orcha's.
 *  Resolved once from the same resources/icon.png the dock uses; undefined if it can't be read so
 *  callers fall back to the OS default rather than a blank icon. */
let appIconResolved = false
let cachedAppIcon: Electron.NativeImage | undefined
function appIcon(): Electron.NativeImage | undefined {
  if (!appIconResolved) {
    const img = nativeImage.createFromPath(path.join(app.getAppPath(), 'resources', 'icon.png'))
    cachedAppIcon = img.isEmpty() ? undefined : img
    appIconResolved = true
  }
  return cachedAppIcon
}

/** Show a small indeterminate progress window while a slow install step runs, then guarantee it
 *  closes. Homebrew/Docker downloads take minutes with no terminal in sight, so without this the
 *  app looks frozen after the user clicks Continue. Frameless + non-focusable so it never steals
 *  focus from macOS's own password prompt, which the privileged step shows on top of it. */
async function withInstallProgress<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const win = new BrowserWindow({
    width: 380,
    height: 130,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    title: 'Orcha',
    icon: appIcon(),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    :root { color-scheme: light dark; }
    body { margin: 0; height: 100vh; display: flex; align-items: center; gap: 16px;
      padding: 0 24px; box-sizing: border-box;
      font: 13px -apple-system, system-ui, sans-serif;
      background: Canvas; color: CanvasText; }
    .spinner { width: 22px; height: 22px; flex: none; border-radius: 50%;
      border: 3px solid color-mix(in srgb, CanvasText 20%, transparent);
      border-top-color: CanvasText; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .label { line-height: 1.35; }
    .sub { opacity: 0.6; font-size: 12px; }
  </style></head><body>
    <div class="spinner"></div>
    <div><div class="label">${label}</div><div class="sub">This can take a few minutes — you can leave this open.</div></div>
  </body></html>`
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  try {
    return await fn()
  } finally {
    if (!win.isDestroyed()) win.close()
  }
}

/** Plain-language caption for the in-progress window, per install step. */
function progressLabel(step: InstallStepPlan): string {
  if (step.name === 'homebrew') return 'Installing Homebrew…'
  if (step.name === 'docker') return 'Setting up Docker…'
  return 'Installing the Orcha CLI…'
}

function createManagerWindow(): void {
  managerWindow = new BrowserWindow({
    width: 760,
    height: 560,
    title: 'Orcha',
    icon: appIcon(),
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
    icon: appIcon(),
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
  const n = new Notification({ title: `Orcha — ${item.projectShort}`, body: item.title, icon: appIcon() })
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
    icon: appIcon(),
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

/** Pick a folder for a new workspace (the OS picker lets the user make one inline). */
async function pickWorkspaceDir(): Promise<string | null> {
  const res = await dialog.showOpenDialog({
    title: 'New Orcha Workspace',
    message: 'Choose an empty folder for your new Orcha project',
    buttonLabel: 'Create Workspace',
    properties: ['openDirectory', 'createDirectory']
  })
  if (res.canceled || res.filePaths.length === 0) return null
  return res.filePaths[0]
}

/** File → New Workspace: pick a folder, run `orcha init` there, nudge the user to the manager.
 *  Rejects {code:'WORKSPACE_CANCELLED'} when the picker is dismissed (callers treat it as a no-op). */
async function newWorkspaceFlow(): Promise<WorkspaceResult> {
  const dir = await pickWorkspaceDir()
  if (dir === null) throw { code: 'WORKSPACE_CANCELLED' } as const
  // Wake Docker (and install anything missing) for the user — no Terminal required.
  await ensureDockerReady()
  const ws = await createWorkspace(dir)
  // The poller picks the new stack up on its next tick; surface it now so the user isn't left
  // staring at an unchanged window.
  if (Notification.isSupported()) {
    new Notification({
      title: 'Orcha — workspace created',
      body: `${ws.projectShort} is starting up; it'll appear in the manager shortly.`,
      icon: appIcon()
    }).show()
  }
  showManagerWindow()
  return ws
}

/** Menu-triggered variant: same flow, but surface failures as a native dialog (there's no
 *  renderer round-trip to show them). Cancellation is a silent no-op. */
async function runNewWorkspaceFromMenu(): Promise<void> {
  try {
    await newWorkspaceFlow()
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'WORKSPACE_CANCELLED') return
    const detail =
      code === 'DOCKER_START_FAILED'
        ? 'Orcha couldn’t start the Docker engine. Open the app again in a minute — Docker can ' +
          'take a little while to wake up — or restart your Mac if it keeps happening.'
        : code === 'WORKSPACE_INIT_FAILED'
          ? `orcha init failed:\n\n${(err as { stderr?: string }).stderr ?? '(no output)'}`
          : 'Could not create the workspace. Is the Orcha CLI installed and Docker running?'
    dialog.showMessageBox({ type: 'error', icon: appIcon(), message: 'New Workspace failed', detail })
  }
}

/** Install the application menu, adding File → New Workspace (⌘N) to the standard macOS chrome. */
function buildAppMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Workspace…',
          accelerator: 'CmdOrCtrl+N',
          click: () => void runNewWorkspaceFromMenu()
        },
        { type: 'separator' as const },
        { label: 'Set Up Orcha…', click: () => void runGuidedSetup() },
        { type: 'separator' as const },
        isMac ? { role: 'close' as const } : { role: 'quit' as const }
      ]
    },
    { role: 'editMenu' as const },
    { role: 'windowMenu' as const }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** Run a command as the current user with the Finder-safe PATH (so brew/colima/orcha resolve
 *  after install). A login shell (`bash -lc`) also picks up Homebrew's shellenv. Pinned to the
 *  Mac's true arch (userShellArgv) so a Rosetta-translated app can't run brew as Intel. */
function runAsUser(cmd: string, arch: string): Promise<void> {
  const [file, args] = userShellArgv(cmd, arch)
  return dockerExec(file, args).then(() => undefined)
}

/** Homebrew's manual install (git clone) and its third-party taps need git, which on macOS comes
 *  from the Command Line Developer Tools. `xcode-select -p` exits non-zero when they're absent. */
async function commandLineToolsPresent(): Promise<boolean> {
  try {
    await dockerExec('xcode-select', ['-p'])
    return true
  } catch {
    return false
  }
}

/** Run a command with macOS's NATIVE admin authentication — the password / Touch ID popup the
 *  user expects ("that's Apple, not Orcha"). A dismissed popup surfaces as BootstrapCancelled so
 *  the caller reports a cancellation rather than a failure. */
async function runAsAdmin(stepName: InstallStepPlan['name'], cmd: string): Promise<void> {
  try {
    await dockerExec('osascript', ['-e', osascriptAdmin(cmd)])
  } catch (err) {
    if (isOsascriptCancel(err)) throw new BootstrapCancelled(stepName)
    throw err
  }
}

/** Ask the hardware which CPU this Mac has, so we install the matching Homebrew build. We read
 *  `sysctl -n hw.optional.arm64` rather than process.arch because a translated (Rosetta) launch
 *  reports x64 even on an Apple Silicon machine — which would install the Intel build and then fail
 *  with "Bad CPU type in executable". Falls back to process.arch if sysctl is unavailable. */
async function detectMacArch(): Promise<string> {
  try {
    const { stdout } = await dockerExec('sysctl', ['-n', 'hw.optional.arm64'])
    return macArchFromSysctl(stdout)
  } catch {
    return process.arch === 'arm64' ? 'arm64' : 'x64'
  }
}

/** Is the Docker daemon reachable right now? `docker info` exits non-zero when the engine is
 *  installed but asleep — the same signal bootstrap's detection uses. */
async function dockerDaemonUp(): Promise<boolean> {
  try {
    await dockerExec('docker', ['info', '--format', '{{.ServerVersion}}'])
    return true
  } catch {
    return false
  }
}

/** Poll until the Docker daemon answers or we give up. `colima start` blocks until its VM is up,
 *  but Docker Desktop/OrbStack return immediately and warm up in the background — so we poll either
 *  way rather than trusting the start command's exit. */
async function waitForDockerUp(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await dockerDaemonUp()) return true
    await new Promise((r) => setTimeout(r, 2000))
  }
  return dockerDaemonUp()
}

/** Make the machine ready for `orcha init` WITHOUT sending the user to Terminal — the whole point
 *  of "make it simpler". The app runs everything with a PATH that already resolves brew/colima/
 *  limactl (dockerPath), which is exactly what a bare user shell lacks, so it can do what the user
 *  couldn't. Three cases:
 *   - engine missing entirely → run the full guided install (consent + native password popup);
 *   - engine installed but asleep → just start it behind a spinner (no install, no password —
 *     starting a local engine the user already has needs neither), then wait for it to answer;
 *   - already up → nothing.
 *  Throws {code:'DOCKER_START_FAILED'} when the engine won't come up, so callers show a plain
 *  message instead of a raw CLI traceback. */
async function ensureDockerReady(): Promise<void> {
  let status = await checkDependencies().catch(() => null)
  if (status && !status.docker.installed) {
    await runGuidedSetup()
    status = await checkDependencies().catch(() => status)
  }
  if (!status || !status.docker.installed || status.docker.running === true) return
  const ready = status
  const arch = await detectMacArch()
  const up = await withInstallProgress('Starting Docker…', async () => {
    await runAsUser(dockerCommand(ready), arch).catch(() => {})
    return waitForDockerUp(90_000)
  })
  if (!up) throw { code: 'DOCKER_START_FAILED' } as const
}

/** Actually perform one confirmed install step. Homebrew is special: the one privileged action
 *  (creating + chowning its prefix) goes through the native admin popup, then the manual install
 *  (git clone) runs as the user — it owns the prefix, so it needs no further elevation and never
 *  trips the installer's unattended-sudo abort. Both prep and install are pinned to the same
 *  hardware arch so they agree on /opt/homebrew (Apple Silicon) vs /usr/local (Intel). Docker
 *  (Colima) and the CLI install through Homebrew as the user, no popup. */
async function performInstall(
  step: InstallStepPlan,
  status: BootstrapStatus,
  arch: string
): Promise<void> {
  switch (step.name) {
    case 'homebrew':
      if (!(await commandLineToolsPresent())) {
        // Kick off Apple's own installer dialog, then ask the user to finish it and retry — git
        // (needed by the clone and by Homebrew taps) ships with the Command Line Tools.
        await dockerExec('xcode-select', ['--install']).catch(() => {})
        throw new Error(
          'macOS needs to finish installing its Command Line Developer Tools first. A system ' +
            'dialog should have appeared — click Install, wait for it to complete, then choose ' +
            '“Set Up Orcha…” again.'
        )
      }
      await runAsAdmin('homebrew', homebrewPrepCommand(arch))
      await runAsUser(homebrewInstallCommand(arch), arch)
      return
    case 'docker':
      await runAsUser(dockerCommand(status), arch)
      return
    case 'cli':
      await runAsUser(step.command, arch)
      return
  }
}

/** Show the per-step consent dialog. Continue → proceed; Cancel → stop the whole run (kedar's
 *  explicit instruction: tell them about the popup and ask before installing, for every step). */
async function confirmStep(step: InstallStepPlan): Promise<boolean> {
  const res = await dialog.showMessageBox({
    type: 'question',
    icon: appIcon(),
    message: step.title,
    detail: step.consentMessage,
    buttons: ['Continue', 'Cancel'],
    defaultId: 0,
    cancelId: 1
  })
  return res.response === 0
}

/** Guided first-run setup: detect what's missing, get one "Set everything up" yes, then walk the
 *  user through installing each piece with an explicit confirm + the native macOS popup. Stops
 *  cleanly on any cancel/failure and offers Retry. Reachable from the menu and shown on first
 *  launch when a hard dependency (CLI or Docker) is missing. We never self-run installers without
 *  these explicit confirmations. */
/** On launch, only interrupt with the setup flow when a hard dependency (Orcha CLI or Docker
 *  itself) is missing. A merely-stopped daemon is transient and shouldn't pop a dialog at startup. */
async function maybeRunSetupOnLaunch(): Promise<void> {
  let status: BootstrapStatus
  try {
    status = await checkDependencies()
  } catch {
    return
  }
  if (status.cli.installed && status.docker.installed) return
  await runGuidedSetup()
}

async function runGuidedSetup(): Promise<void> {
  let status: BootstrapStatus
  try {
    status = await checkDependencies()
  } catch {
    return // detection itself shouldn't block startup
  }
  const arch = await detectMacArch()
  const steps = planBootstrap(status, arch)
  if (steps.length === 0) {
    void dialog.showMessageBox({
      type: 'info',
      icon: appIcon(),
      message: 'Orcha is ready',
      detail: 'Everything Orcha needs is already installed.'
    })
    return
  }

  const intro = await dialog.showMessageBox({
    type: 'info',
    icon: appIcon(),
    message: 'Set up Orcha',
    detail:
      'Orcha needs a few tools before it can create workspaces:\n\n' +
      steps.map((s) => `• ${s.title}`).join('\n') +
      '\n\nOrcha will install them one at a time and ask you before each. Some steps show macOS’s ' +
      'own password or fingerprint prompt — that’s Apple asking, not Orcha.',
    buttons: ['Set everything up', 'Not now'],
    defaultId: 0,
    cancelId: 1
  })
  if (intro.response !== 0) return

  const outcome = await runGuidedBootstrap(
    status,
    {
      confirm: confirmStep,
      perform: (step) => withInstallProgress(progressLabel(step), () => performInstall(step, status, arch))
    },
    arch
  )

  if (outcome.result === 'completed') {
    const after = await checkDependencies().catch(() => status)
    void dialog.showMessageBox(
      after.ready
        ? { type: 'info', icon: appIcon(), message: 'Orcha is set up', detail: 'You can now create a workspace with File → New Workspace.' }
        : {
            type: 'info',
            icon: appIcon(),
            message: 'Almost there',
            detail:
              'The installs finished. If Orcha still isn’t ready, open the app again — Docker can ' +
              'take a moment to start.'
          }
    )
    return
  }
  if (outcome.result === 'cancelled') {
    const res = await dialog.showMessageBox({
      type: 'info',
      icon: appIcon(),
      message: 'Setup paused',
      detail: `You cancelled before “${outcome.title}”. Nothing was left half-installed — you can pick up where you left off.`,
      buttons: ['Retry', 'Later'],
      defaultId: 0,
      cancelId: 1
    })
    if (res.response === 0) await runGuidedSetup()
    return
  }
  if (outcome.result === 'failed') {
    const res = await dialog.showMessageBox({
      type: 'error',
      icon: appIcon(),
      message: `“${outcome.title}” didn’t finish`,
      detail:
        `${outcome.error}\n\nYou can try again, or run this yourself in Terminal:\n\n${outcome.command}`,
      buttons: ['Retry', 'Later'],
      defaultId: 0,
      cancelId: 1
    })
    if (res.response === 0) await runGuidedSetup()
  }
}

/** Validate a renderer-supplied project name against the live discovery snapshot. */
async function requireKnownStack(project: string): Promise<Stack> {
  const stacks = await listStacks()
  const stack = stacks.find((s) => s.project === project)
  if (!stack) throw { code: 'UNKNOWN_STACK' } as const
  return stack
}

app.whenReady().then(() => {
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

  ipcMain.handle('orcha:checkDependencies', () => asResult(() => checkDependencies()))

  ipcMain.handle('orcha:newWorkspace', () => asResult(() => newWorkspaceFlow()))

  // Dev dock icon (packaged builds carry it in the bundle). app.getAppPath() = desktop/.
  if (process.platform === 'darwin' && app.dock) {
    const icon = appIcon()
    if (icon) app.dock.setIcon(icon)
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

  buildAppMenu()
  createManagerWindow()
  void maybeRunSetupOnLaunch()
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
