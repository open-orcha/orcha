/** Microphone permission for dictation (portal voice feature).
 *
 *  Two layers must both say yes before a page can hear the microphone:
 *   1. macOS TCC — the app asks once (`systemPreferences.askForMediaAccess`), backed by
 *      NSMicrophoneUsageDescription in Info.plist and the `device.audio-input` entitlement
 *      (hardened runtime).
 *   2. Chromium's permission request for `media` — granted ONLY to our own pages (the stack
 *      portals on localhost and the manager window), and only for AUDIO. Camera requests
 *      and every other origin are refused.
 *  Every other permission keeps Electron's default (granted), so nothing else changes.
 *
 *  Pure apart from the injected Electron objects, so it is unit-testable. */
import type { MicAccess } from '../shared/mic'

export interface SystemPrefsLike {
  getMediaAccessStatus(mediaType: 'microphone'): string
  askForMediaAccess(mediaType: 'microphone'): Promise<boolean>
}

export interface PermissionDetailsLike {
  mediaTypes?: string[]
  requestingUrl?: string
  securityOrigin?: string
  mediaType?: string
}

export interface SessionLike {
  setPermissionRequestHandler(
    handler: ((webContents: unknown, permission: string, callback: (granted: boolean) => void, details: PermissionDetailsLike) => void) | null
  ): void
  setPermissionCheckHandler(
    handler: ((webContents: unknown, permission: string, requestingOrigin: string, details: PermissionDetailsLike) => boolean) | null
  ): void
}

export function micAccessStatus(sp: SystemPrefsLike, platform: string = process.platform): MicAccess {
  if (platform !== 'darwin') return 'granted' // Windows/Linux: Chromium's own prompt is the gate
  try {
    const s = sp.getMediaAccessStatus('microphone')
    return s === 'granted' || s === 'denied' || s === 'restricted' || s === 'not-determined' ? s : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Ask macOS once; afterwards the answer is cached by the OS (Settings is the only way back). */
export async function requestMicAccess(sp: SystemPrefsLike, platform: string = process.platform): Promise<MicAccess> {
  const now = micAccessStatus(sp, platform)
  if (now !== 'not-determined') return now
  try {
    return (await sp.askForMediaAccess('microphone')) ? 'granted' : 'denied'
  } catch {
    return 'unknown'
  }
}

/** Our own pages: a stack portal (http://localhost|127.0.0.1:<port>) or the manager renderer. */
export function isTrustedMediaOrigin(url: string | undefined, extra: readonly string[] = []): boolean {
  if (!url) return false
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol === 'file:') return true
  if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return true
  return extra.some((o) => {
    try {
      return new URL(o).origin === u.origin
    } catch {
      return false
    }
  })
}

export function wantsVideo(details: PermissionDetailsLike): boolean {
  if (details.mediaType === 'video') return true
  return (details.mediaTypes || []).includes('video')
}

export function installMediaPermissions(
  session: SessionLike,
  deps: { ask: () => Promise<MicAccess>; trustedExtra?: () => readonly string[] }
): void {
  const extra = () => (deps.trustedExtra ? deps.trustedExtra() : [])
  session.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (permission !== 'media') {
      callback(true) // Electron's default for everything else — unchanged
      return
    }
    const origin = details.requestingUrl || details.securityOrigin || (wc as { getURL?: () => string } | null)?.getURL?.()
    if (wantsVideo(details) || !isTrustedMediaOrigin(origin, extra())) {
      callback(false)
      return
    }
    deps.ask().then(
      (s) => callback(s === 'granted'),
      () => callback(false)
    )
  })
  session.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    if (permission !== 'media') return true
    return !wantsVideo(details) && isTrustedMediaOrigin(requestingOrigin, extra())
  })
}
