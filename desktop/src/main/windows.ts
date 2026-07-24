/** Owns Electron manager, tray-popover, portal windows, and user notifications. */
import { BrowserWindow, Notification, shell } from 'electron'
import path from 'node:path'
import { listStacks } from './discovery'
import type { AttentionItem, Stack } from '../shared/types'

let managerWindow: BrowserWindow | null = null
const portalWindows = new Map<string, BrowserWindow>()

export function createManagerWindow(): void {
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
  if (process.env.ELECTRON_RENDERER_URL) {
    void managerWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void managerWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  managerWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  managerWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  managerWindow.on('closed', () => {
    managerWindow = null
  })
}

export function showManagerWindow(): void {
  if (managerWindow && !managerWindow.isDestroyed()) {
    managerWindow.show()
    managerWindow.focus()
    return
  }
  createManagerWindow()
}

export function sendToManager(channel: string, payload: unknown): void {
  if (managerWindow && !managerWindow.isDestroyed()) {
    managerWindow.webContents.send(channel, payload)
  }
}

export function createPopoverWindow(): BrowserWindow {
  const window = new BrowserWindow({
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
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}#tray`)
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: 'tray' })
  }
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  return window
}

export async function openPortalByProject(project: string, path?: string): Promise<void> {
  try {
    const stacks = await listStacks()
    const stack = stacks.find((candidate) => candidate.project === project)
    if (stack?.running && stack.apiPort !== null) openPortalWindow(stack, path)
  } catch {
    // Docker may be unavailable at click time; discovery will retry on the next action.
  }
}

export function showAttentionNotification(item: AttentionItem): void {
  if (!Notification.isSupported()) return
  const notification = new Notification({
    title: `Orcha — ${item.projectShort}`,
    body: item.title
  })
  notification.on('failed', (_event, error) => {
    console.error('[orcha-desktop] notification delivery failed:', item.id, error)
  })
  notification.on('click', () => void openPortalByProject(item.project, item.path))
  notification.show()
}

export function openPortalWindow(stack: Stack, pagePath = '/'): void {
  const url = `http://localhost:${stack.apiPort}${pagePath}`
  const existing = portalWindows.get(stack.project)
  if (existing && !existing.isDestroyed()) {
    void existing.loadURL(url)
    existing.focus()
    return
  }
  const window = new BrowserWindow({
    width: 1100,
    height: 800,
    title: `Orcha — ${stack.projectShort}`,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  void window.loadURL(url)
  const portalOrigin = `http://localhost:${stack.apiPort}`
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (!targetUrl.startsWith(`${portalOrigin}/`)) {
      event.preventDefault()
      void shell.openExternal(targetUrl)
    }
  })
  window.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (!targetUrl.startsWith(`${portalOrigin}/`)) {
      void shell.openExternal(targetUrl)
      return { action: 'deny' }
    }
    void window.loadURL(targetUrl)
    return { action: 'deny' }
  })
  window.webContents.on('page-title-updated', (event, pageTitle) => {
    event.preventDefault()
    window.setTitle(`${stack.projectShort} · ${pageTitle.replace(/^Orcha\s*·\s*/, '')}`)
  })
  window.on('closed', () => portalWindows.delete(stack.project))
  portalWindows.set(stack.project, window)
}
