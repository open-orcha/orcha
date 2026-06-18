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
  osascriptAdmin,
  planBootstrap,
  runGuidedBootstrap,
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
  const ws = await createWorkspace(dir)
  // The poller picks the new stack up on its next tick; surface it now so the user isn't left
  // staring at an unchanged window.
  if (Notification.isSupported()) {
    new Notification({
      title: 'Orcha — workspace created',
      body: `${ws.projectShort} is starting up; it'll appear in the manager shortly.`
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
      code === 'WORKSPACE_INIT_FAILED'
        ? `orcha init failed:\n\n${(err as { stderr?: string }).stderr ?? '(no output)'}`
        : 'Could not create the workspace. Is the Orcha CLI installed and Docker running?'
    dialog.showMessageBox({ type: 'error', message: 'New Workspace failed', detail })
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
 *  after install). A login shell (`bash -lc`) also picks up Homebrew's shellenv. */
function runAsUser(cmd: string): Promise<void> {
  return dockerExec('/bin/bash', ['-lc', cmd]).then(() => undefined)
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

/** Actually perform one confirmed install step. Homebrew is special: it refuses to run as root,
 *  so we do the one privileged action (creating + chowning its prefix) via the native admin popup,
 *  then run the official installer as the user — it finds the prefix ready and needs no more
 *  elevation. Docker (Colima) and the CLI install through Homebrew as the user, no popup. */
async function performInstall(step: InstallStepPlan, status: BootstrapStatus): Promise<void> {
  switch (step.name) {
    case 'homebrew':
      await runAsAdmin('homebrew', homebrewPrepCommand())
      await runAsUser(homebrewInstallCommand())
      return
    case 'docker':
      await runAsUser(dockerCommand(status))
      return
    case 'cli':
      await runAsUser(step.command)
      return
  }
}

/** Show the per-step consent dialog. Continue → proceed; Cancel → stop the whole run (kedar's
 *  explicit instruction: tell them about the popup and ask before installing, for every step). */
async function confirmStep(step: InstallStepPlan): Promise<boolean> {
  const res = await dialog.showMessageBox({
    type: 'question',
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
  const steps = planBootstrap(status)
  if (steps.length === 0) {
    void dialog.showMessageBox({
      type: 'info',
      message: 'Orcha is ready',
      detail: 'Everything Orcha needs is already installed.'
    })
    return
  }

  const intro = await dialog.showMessageBox({
    type: 'info',
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

  const outcome = await runGuidedBootstrap(status, {
    confirm: confirmStep,
    perform: (step) => performInstall(step, status)
  })

  if (outcome.result === 'completed') {
    const after = await checkDependencies().catch(() => status)
    void dialog.showMessageBox(
      after.ready
        ? { type: 'info', message: 'Orcha is set up', detail: 'You can now create a workspace with File → New Workspace.' }
        : {
            type: 'info',
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
