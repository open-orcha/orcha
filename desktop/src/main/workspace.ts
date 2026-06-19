import path from 'node:path'
import { dockerExec, type Exec } from './dockerExec'
import type { WorkspaceResult } from '../shared/types'

const defaultExec: Exec = dockerExec

// Keep a generous tail: `orcha init` shells out to `docker compose`, and on failure the CLI
// appends a Python traceback AFTER docker's own error. 800 chars was all traceback — docker's
// actual message (the actionable part) scrolled off the top. Keep enough for both; the dialog
// strips the traceback noise for display (readableInitError).
const STDERR_TAIL = 4000

/** Mirror of the CLI's `_sanitize_name` so the desktop predicts the same compose project name
 *  the CLI will create. Keep in lockstep with orcha_cli/__main__.py:_sanitize_name. */
export function sanitizeName(s: string): string {
  const out = [...s.toLowerCase()].map((c) => (/[a-z0-9_-]/.test(c) ? c : '-')).join('')
  return out.replace(/^-+|-+$/g, '') || 'orcha'
}

/** `orcha init` shells out to `docker compose`; when that fails the CLI re-raises with a Python
 *  traceback printed AFTER docker's own error. To a non-engineer the traceback is pure noise and
 *  hides the one useful line (e.g. "Error response from daemon: …"). Drop the traceback frames so
 *  docker's message shows through; fall back to the raw tail if nothing's left. */
export function readableInitError(stderr: string): string {
  const noise =
    /^(Traceback \(|\s*File ")|^\s*[~^]+\s*$|^\s*(self|return|raise|cmd =|process|output=)\b|CalledProcessError/
  const lines = stderr.split('\n').filter((l) => l.trim().length > 0)
  const cleaned = lines.filter((l) => !noise.test(l))
  const body = (cleaned.length > 0 ? cleaned : lines).join('\n').trim()
  return body.slice(-1200)
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
