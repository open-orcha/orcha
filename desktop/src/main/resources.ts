import path from 'node:path'
import { app } from 'electron'

/** Resolve a file/dir shipped via electron-builder `extraResources` (templates, the tray
 *  template image): process.resourcesPath when packaged, desktop/resources in dev. */
export function resourceFile(name: string): string {
  // app.isPackaged is false under electron-vite dev and vitest.
  const packaged = (() => {
    try {
      return app?.isPackaged ?? false
    } catch {
      return false
    }
  })()
  if (packaged) return path.join(process.resourcesPath, name)
  return path.join(__dirname, '..', '..', 'resources', name)
}
