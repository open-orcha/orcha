/** Boots the Electron host and composes its focused IPC, window, tray, and polling modules. */
import { app, Menu, nativeImage } from 'electron'
import path from 'node:path'
import { fetchStackAttention } from './attention'
import { AttentionPoller } from './attentionPoller'
import { buildAppMenuTemplate } from './appMenu'
import { parseDeepLink } from './deepLink'
import { listStacks } from './discovery'
import { registerIpcHandlers } from './ipcHandlers'
import { loadApiKeyIntoEnv } from './prerequisites'
import { buildStatus, writeStatusFile } from './statusFile'
import { createTray, type TrayController } from './tray'
import {
  createManagerWindow,
  createPopoverWindow,
  openPortalByProject,
  sendToManager,
  showAttentionNotification,
  showManagerWindow
} from './windows'

app.setName('Orcha')
app.setAsDefaultProtocolClient('orcha')

let tray: TrayController | null = null
let poller: AttentionPoller | null = null

function installApplicationMenu(): void {
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
}

function installDevelopmentDockIcon(): void {
  if (process.platform !== 'darwin' || !app.dock) return
  const icon = nativeImage.createFromPath(
    path.join(app.getAppPath(), 'resources', 'icon.png')
  )
  if (!icon.isEmpty()) app.dock.setIcon(icon)
}

function startTrayAndAttentionPolling(): void {
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
}

app.whenReady().then(() => {
  loadApiKeyIntoEnv()
  registerIpcHandlers(() => poller)
  installApplicationMenu()
  installDevelopmentDockIcon()
  startTrayAndAttentionPolling()
  createManagerWindow()

  app.on('activate', showManagerWindow)
  app.on('open-url', (event, url) => {
    event.preventDefault()
    const target = parseDeepLink(url)
    if (target) void openPortalByProject(target.project, target.path)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  poller?.stop()
  tray?.destroy()
})
