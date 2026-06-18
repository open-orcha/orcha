import { accessSync, constants, existsSync, mkdirSync, readdirSync } from 'node:fs'
import path from 'node:path'
import type { FolderState } from '../shared/types'
import { sanitizeName } from './templates'

/** Inspect a folder to decide init vs reconnect and surface a default name. */
export function inspectFolder(folder: string): FolderState {
  const initialized = existsSync(path.join(folder, '.orcha', 'docker-compose.yml'))
  let writable = false
  try {
    accessSync(folder, constants.W_OK)
    writable = true
  } catch {
    writable = false
  }
  return { initialized, writable, suggestedName: sanitizeName(path.basename(folder)) }
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
