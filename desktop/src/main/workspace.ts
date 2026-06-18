import path from 'node:path'
import { dockerExec, type Exec } from './dockerExec'
import type { WorkspaceResult } from '../shared/types'

const defaultExec: Exec = dockerExec

const STDERR_TAIL = 800

/** Mirror of the CLI's `_sanitize_name` so the desktop predicts the same compose project name
 *  the CLI will create. Keep in lockstep with orcha_cli/__main__.py:_sanitize_name. */
export function sanitizeName(s: string): string {
  const out = [...s.toLowerCase()].map((c) => (/[a-z0-9_-]/.test(c) ? c : '-')).join('')
  return out.replace(/^-+|-+$/g, '') || 'orcha'
}

/** Run `orcha init` in `dir`, creating a new Orcha workspace there. Rejects with
 *  {code:'WORKSPACE_INIT_FAILED', stderr} when the CLI exits non-zero (e.g. .orcha/ already
 *  exists, Docker down). The compose project name is derived the same way the CLI derives it. */
export async function createWorkspace(dir: string, exec: Exec = defaultExec): Promise<WorkspaceResult> {
  try {
    await exec('orcha', ['init'], { cwd: dir })
  } catch (err) {
    const stderr = String((err as { stderr?: string }).stderr ?? '')
    throw { code: 'WORKSPACE_INIT_FAILED', stderr: stderr.slice(-STDERR_TAIL) } as const
  }
  const project = `orcha-${sanitizeName(path.basename(dir))}`
  return { project, projectShort: sanitizeName(path.basename(dir)), dir }
}
