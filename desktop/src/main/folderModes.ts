import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { FolderState } from '../shared/types'

/** Mirror of the CLI's _sanitize_name. */
export function sanitizeName(s: string): string {
  const lowered = s.toLowerCase()
  let out = ''
  for (const c of lowered) out += /[a-z0-9\-_]/.test(c) ? c : '-'
  out = out.replace(/^-+|-+$/g, '')
  return out || 'orcha'
}

export type Runtime = 'docker' | 'native'

function readConfig(folder: string): Record<string, unknown> {
  try {
    const v = JSON.parse(readFileSync(path.join(folder, '.claude', 'orcha.json'), 'utf8')) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const hasCompose = (folder: string): boolean => existsSync(path.join(folder, '.orcha', 'docker-compose.yml'))

/** The CLI's `cli_runtime_mode.detect_runtime`, in TS (GH #258 D2): the orcha.json `runtime`
 *  key wins, else the compose file means Docker, else native. Throws on an unknown runtime.
 *  Kept in lockstep by tests/fixtures/runtime_mode_cases.json (shared with the CLI tests). */
export function detectRuntime(folder: string): Runtime {
  const runtime = readConfig(folder).runtime
  if (runtime !== undefined && runtime !== null) {
    if (runtime === 'docker' || runtime === 'native') return runtime
    throw new Error(`unknown runtime ${JSON.stringify(runtime)} in ${path.join(folder, '.claude', 'orcha.json')}`)
  }
  return hasCompose(folder) ? 'docker' : 'native'
}

/** The CLI's `is_project`: the folder owns a stack — explicit native (not an `orcha connect`
 *  client), or a compose file with no / a docker runtime key. */
export function isProject(folder: string): boolean {
  const cfg = readConfig(folder)
  if (cfg.runtime === 'native' && !cfg.connected) return true
  return hasCompose(folder) && (cfg.runtime === undefined || cfg.runtime === null || cfg.runtime === 'docker')
}

/** Inspect a folder to decide init vs reconnect and surface a default name. */
export function inspectFolder(folder: string): FolderState {
  const initialized = isProject(folder)
  const isGitRepo = existsSync(path.join(folder, '.git'))
  let writable = false
  try {
    accessSync(folder, constants.W_OK)
    writable = true
  } catch {
    writable = false
  }
  return { initialized, writable, suggestedName: sanitizeName(path.basename(folder)), isGitRepo }
}

/** Create a new blank directory under parent. Throws if it already exists non-empty. */
export function createBlankFolder(parent: string, rawName: string): string {
  const name = sanitizeName(rawName)
  const target = path.join(parent, name)
  if (existsSync(target) && readdirSync(target).length > 0) {
    throw { code: 'ALREADY_INITIALIZED' } as const
  }
  mkdirSync(target, { recursive: true })
  return target
}
