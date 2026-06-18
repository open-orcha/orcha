import { BrowserWindow } from 'electron'
import path from 'node:path'

let onboardingWindow: BrowserWindow | null = null

/** Open-or-focus the onboarding wizard window (modeled on the manager window). */
export function showOnboardingWindow(): void {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.show()
    onboardingWindow.focus()
    return
  }
  onboardingWindow = new BrowserWindow({
    width: 720,
    height: 620,
    title: 'New Orcha Project',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  const win = onboardingWindow
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#onboarding`)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: 'onboarding' })
  }
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.on('closed', () => {
    onboardingWindow = null
  })
}

/** The onboarding window's webContents, for streaming progress events. */
export function onboardingWebContents(): Electron.WebContents | null {
  return onboardingWindow && !onboardingWindow.isDestroyed() ? onboardingWindow.webContents : null
}
