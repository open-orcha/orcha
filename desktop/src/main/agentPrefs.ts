/** Agents settings persistence: ONE small JSON file owned by the desktop app, next to
 *  appearance.json in <userData> (same pattern as appearanceStore.ts — pure path fn, injected
 *  dir, never throws).
 *
 *  Migration: before the registry there was no agents file — Claude and Codex were always
 *  offered, ⌥⌘T launched Claude, and both launched without flags. A missing / unreadable
 *  file therefore becomes `defaultAgentPrefs()`: Claude stays the Default (⌥⌘T unchanged),
 *  Claude + Codex stay enabled, and — the owner's decision — permission mode is Yolo for
 *  existing users too (changeable in Settings › Agents). The migrated prefs are written back
 *  once so later reads are stable. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { AGENT_PREFS_VERSION, parseAgentPrefs, type AgentPrefs } from '../shared/agents'

export function agentPrefsFilePath(userDataDir: string): string {
  return path.join(userDataDir, 'agents.json')
}

export interface PrefsRead {
  prefs: AgentPrefs
  /** The file was absent / unreadable / older — the caller should persist `prefs`. */
  migrated: boolean
}

export function readAgentPrefs(userDataDir: string): PrefsRead {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(agentPrefsFilePath(userDataDir), 'utf8'))
  } catch {
    return { prefs: parseAgentPrefs(null), migrated: true }
  }
  const version = typeof raw === 'object' && raw !== null ? (raw as { version?: unknown }).version : undefined
  return { prefs: parseAgentPrefs(raw), migrated: version !== AGENT_PREFS_VERSION }
}

/** Atomic write (tmp + rename). Best-effort: a failed write keeps the in-memory prefs. */
export function writeAgentPrefs(userDataDir: string, prefs: AgentPrefs): boolean {
  try {
    mkdirSync(userDataDir, { recursive: true })
    const file = agentPrefsFilePath(userDataDir)
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(prefs, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}
