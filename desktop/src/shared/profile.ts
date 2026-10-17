/** Settings › Profile: the name you appear as in your projects.
 *
 *  PURE module (no Electron / Node imports) shared by main, the index preload (types +
 *  inlined channel names) and the renderer.
 *
 *  Without a saved name the desktop falls back to this Mac's account name — what every
 *  project was registered with before profiles existed. Saving a name stores it on this Mac
 *  (used when a new project registers you) and renames your human identity in every
 *  running project. */

/** Same cap as the portal's agent alias (AgentUpdate.alias max_length). */
export const MAX_PROFILE_NAME_LEN = 64

export interface ProfileState {
  /** The saved name, or null when none was chosen (the Mac name is used). */
  name: string | null
  /** This Mac's account name — the fallback. */
  deviceName: string
  /** What you appear as: `name` ?? `deviceName`. */
  effective: string
}

/** One running project's outcome when a saved name is applied to it. */
export interface ProfileRenameResult {
  project: string
  status: 'renamed' | 'unchanged' | 'skipped' | 'failed'
  /** Why it was skipped/failed, in plain words. */
  reason?: string
}

export interface ProfileSaveResult {
  state: ProfileState
  projects: ProfileRenameResult[]
}

export interface ProfileApi {
  get(): Promise<ProfileState>
  /** Save a name (null/blank clears it back to the Mac name) and apply it to running projects. */
  set(name: string | null): Promise<ProfileSaveResult>
}

export const PROFILE_CHANNELS = {
  get: 'orcha:profile:get',
  set: 'orcha:profile:set'
} as const

/** Trim + collapse inner whitespace; blank → null. Throws on a non-string or an over-long name. */
export function normalizeProfileName(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'string') throw new Error('name must be a string')
  const name = raw.trim().replace(/\s+/g, ' ')
  if (!name) return null
  if (name.length > MAX_PROFILE_NAME_LEN) throw new Error(`name is longer than ${MAX_PROFILE_NAME_LEN} characters`)
  return name
}

export function profileState(name: string | null, deviceName: string): ProfileState {
  const device = deviceName.trim() || 'operator'
  return { name, deviceName: device, effective: name ?? device }
}
