import type { BridgeError } from '../../../shared/types'

/** Readable one-line summaries for bridge failures (design directive D4: never dump raw
 *  daemon stderr or `[object Object]` into the UI). The full text stays available as
 *  `detail` for an on-demand "Details" disclosure. */
export interface ReadableError {
  summary: string
  detail: string | null
}

const CODE_TEXT: Record<string, string> = {
  DOCKER_UNAVAILABLE: 'Docker isn’t running.',
  DOCKER_NOT_INSTALLED: 'Docker isn’t installed.',
  DOCKER_START_TIMEOUT: 'Docker didn’t start in time.',
  UNKNOWN_STACK: 'This stack no longer exists.',
  INVALID_STORAGE_ITEM: 'That item changed since the list was made — refresh and try again.',
  PORT_UNAVAILABLE: 'The port is already in use.',
  PORTAL_TIMEOUT: 'The portal didn’t come up in time.',
  INTERNAL: 'Something went wrong inside Embodent.'
}

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g
const SUMMARY_MAX = 160

function clip(s: string, n = SUMMARY_MAX): string {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s
}

/** Well-known, fixable daemon failures, rewritten as one plain next-step sentence. Checked
 *  before the generic "most telling line" pick so a busy port never reads as
 *  "Driver failed programming external connectivity on endpoint …". Exported so onboarding
 *  (provisionError.ts) and the manager word the same failure the same way. */
export function knownFailure(text: string): string | null {
  const clean = text.replace(ANSI, '')
  const bind =
    clean.match(/Bind for [^\s]*?:(\d+) failed: port is already allocated/i) ??
    clean.match(/listen tcp[^:]*:(\d+): bind: address already in use/i) ??
    clean.match(/ports? (\d+)[^\n]*already (?:allocated|in use)/i)
  if (bind) return `Port ${bind[1]} is already in use — stop whatever is using it, then try again.`
  if (/port is already allocated|address already in use/i.test(clean)) {
    return 'A port this stack needs is already in use — stop whatever is using it, then try again.'
  }
  if (/Cannot connect to the Docker daemon|Is the docker daemon running/i.test(clean)) {
    return 'Docker isn’t running — start Docker Desktop, then try again.'
  }
  if (/no space left on device/i.test(clean)) return 'Docker is out of disk space — free some space, then try again.'
  return null
}

/** Pick the most telling line of a docker/compose stderr dump. */
export function summarizeStderr(stderr: string): string {
  const known = knownFailure(stderr)
  if (known) return known
  const lines = stderr
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length === 0) return 'The command failed without saying why.'
  const pick =
    [...lines].reverse().find((l) => /error|failed|cannot|can't|denied|not found|no such/i.test(l)) ??
    lines[lines.length - 1]
  const cleaned = pick
    .replace(/^(time="[^"]*"\s+)?level=\w+\s+msg="?/i, '')
    .replace(/"$/, '')
    .replace(/^Error response from daemon:\s*/i, '')
    .replace(/^error:\s*/i, '')
    .trim()
  const text = cleaned || pick
  return clip(text.charAt(0).toUpperCase() + text.slice(1))
}

function norm(text: string): string {
  return text
    .replace(ANSI, '')
    .replace(/^(time="[^"]*"\s+)?level=\w+\s+msg="?/i, '')
    .replace(/^Error response from daemon:\s*/i, '')
    .replace(/^error:\s*/i, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s."'…]+$/, '')
    .trim()
    .toLowerCase()
}

/** True when the raw `detail` says nothing the friendly `summary` doesn't already say (the
 *  summary IS the raw line, modulo "Error:" prefixes / case / trailing punctuation) — then a
 *  "Details" toggle would only repeat the same sentence (desktop r3 review). */
export function detailIsRedundant(summary: string, detail: string | null): boolean {
  if (!detail) return true
  const d = norm(detail)
  return d === '' || norm(summary).includes(d)
}

/** Normalize anything a bridge call can reject with into a readable summary + detail. The
 *  detail is dropped when it only repeats the summary. */
export function readableError(err: unknown): ReadableError {
  const r = readableErrorRaw(err)
  return r.detail !== null && detailIsRedundant(r.summary, r.detail) ? { summary: r.summary, detail: null } : r
}

function readableErrorRaw(err: unknown): ReadableError {
  if (typeof err === 'string') {
    const detail = err.trim()
    return { summary: summarizeStderr(detail), detail: detail.includes('\n') || detail.length > SUMMARY_MAX ? detail : null }
  }
  if (err && typeof err === 'object') {
    const e = err as Partial<BridgeError> & { message?: unknown; stderr?: unknown; code?: unknown }
    if (typeof e.stderr === 'string' && e.stderr.trim()) {
      const detail = e.stderr.replace(ANSI, '').trim()
      return { summary: summarizeStderr(detail), detail }
    }
    if (e.code === 'DOCKER_UNAVAILABLE' && (e as { unresponsive?: unknown }).unresponsive === true) {
      return { summary: 'Docker isn’t responding — quit and reopen Docker Desktop.', detail: null }
    }
    if (typeof e.code === 'string' && CODE_TEXT[e.code]) return { summary: CODE_TEXT[e.code], detail: null }
    if (typeof e.message === 'string' && e.message.trim()) return { summary: clip(e.message.trim()), detail: null }
    if (typeof e.code === 'string') return { summary: `Failed (${e.code.toLowerCase().replace(/_/g, ' ')}).`, detail: null }
  }
  return { summary: 'Something went wrong.', detail: null }
}

/** A failed stack Start/Stop, kept per compose project until dismissed or retried. */
export interface StackActionError {
  action: 'start' | 'stop'
  error: unknown
}

export function stackErrorPrefix(e: StackActionError, stackName: string): string {
  return `Couldn’t ${e.action} ${stackName}`
}
