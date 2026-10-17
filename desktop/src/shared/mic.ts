/** Microphone access for dictation (portal Settings › Voice, every text field).
 *  Shared by main, both preloads (types only) and the renderer. */
export type MicAccess = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'

export const MIC_CHANNELS = {
  /** status without prompting (manager window) */
  status: 'orcha:mic:status',
  /** ask macOS once (TCC prompt) — manager window or an embedded portal view */
  request: 'orcha:mic:request',
  /** open System Settings › Privacy & Security › Microphone */
  openSettings: 'orcha:mic:openSettings'
} as const

export const MIC_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'

export function isMicAccess(v: unknown): v is MicAccess {
  return v === 'granted' || v === 'denied' || v === 'restricted' || v === 'not-determined' || v === 'unknown'
}

/** window.orchaDesktop.mic (manager window). */
export interface MicApi {
  status(): Promise<MicAccess>
  request(): Promise<MicAccess>
  openSettings(): Promise<boolean>
}
