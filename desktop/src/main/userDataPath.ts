import path from 'node:path'
import { LEGACY_USER_DATA_DIRNAME } from '../shared/brand'

/** The pinned userData path: `<appData>/Orcha`, independent of the product name. Electron
 *  derives userData from the app name, so after the rename to "Embodent" (app.setName +
 *  electron-builder productName) it would move to `<appData>/Embodent` and every existing
 *  install would lose its saved state; index.ts pins it here before anything reads it. */
export function pinnedUserDataPath(appDataDir: string): string {
  return path.join(appDataDir, LEGACY_USER_DATA_DIRNAME)
}
