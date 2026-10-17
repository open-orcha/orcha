/** Native (no-Docker) Orcha projects, read from files instead of `docker ps` (GH #258, plan
 *  D1 / D-D2).
 *
 *  - `~/.orcha/stacks.json` — the CLI's machine-wide registry. `orcha serve` adds its project
 *    on start; `orcha down` REMOVES it (cli_native_lifecycle.py), so a stopped project is not
 *    in the registry any more.
 *  - `<userData>/native-projects.json` — the app's own list of native folders it has seen, so a
 *    project the user stopped from the app still shows as a "Stopped" card it can start again.
 *  - `<folder>/.orcha/state.json` — written by `orcha serve` (cli_serve.py `state()`); its
 *    mtime is serve's liveness stamp (refreshed at least every 30 s; the CLI treats > 90 s as
 *    gone, cli_stacks_registry.STATE_FRESH_SECS).
 *  - `GET http://localhost:<api_port>/api/containers` — the same 1.5 s portal probe `orcha ls`
 *    uses; it decides HEALTH (ok / error / starting), not whether the project runs: a live
 *    serve with a failing API reads running + `health: 'error'`, never "stopped" (#281).
 *
 *  Nothing here spawns a process, so it is cheap enough for the 5–15 s pollers. */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Stack, StackHealth } from '../shared/types'

/** cli_stacks_registry.STATE_FRESH_SECS — a running state.json older than this means serve died. */
export const STATE_FRESH_MS = 90_000
export const PROBE_TIMEOUT_MS = 1_500

export interface RegistryEntry {
  path: string
  api_port: number | null
  bridge_port?: number | null
  runtime?: string
  cli_version?: string
  updated_at?: string
}

export interface ServeState {
  runtime?: string
  status?: string
  serve_pid?: number | null
  children?: Record<string, { pid?: number | null; status?: string; restarts?: number }>
  api_port?: number | null
  updated_at?: string
}

/** What GET /api/containers said: `ok` iff 2xx; `status` is the HTTP status when the portal
 *  answered at all (null = no answer: refused, timed out); `error` is a short reason to show
 *  when not ok ("HTTP 500: no such column: …", "connection refused"). */
export interface ProbeResult {
  ok: boolean
  status: number | null
  error: string | null
}

/** Portal probe. A bare boolean is accepted (true = ok, false = no answer) for simple fakes. */
export type Probe = (apiPort: number) => Promise<ProbeResult | boolean>

const NOT_PROBED: ProbeResult = { ok: false, status: null, error: null }

function normalizeProbe(r: ProbeResult | boolean): ProbeResult {
  if (typeof r === 'boolean') return r ? { ok: true, status: 200, error: null } : { ...NOT_PROBED, error: 'no answer' }
  return r
}

/** The portal's error text, shortened for a tooltip: FastAPI's `{"detail": …}` when present,
 *  else the first line of the body. */
export function summarizeErrorBody(body: string): string {
  let text = body.trim()
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && 'detail' in parsed) {
      const d = (parsed as { detail: unknown }).detail
      text = typeof d === 'string' ? d : JSON.stringify(d)
    }
  } catch {
    /* not JSON — plain text ("Internal Server Error") */
  }
  const line = text.split('\n')[0] ?? ''
  return line.length > 200 ? `${line.slice(0, 197)}…` : line
}

export function registryPath(home: string = os.homedir()): string {
  return path.join(home, '.orcha', 'stacks.json')
}

export function knownFoldersPath(userDataDir: string): string {
  return path.join(userDataDir, 'native-projects.json')
}

function readJsonObject(file: string): Record<string, unknown> | null {
  try {
    const data: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return typeof data === 'object' && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** `{project_name: entry}`; `{}` when absent, half-written or not an object (like `_read()`). */
export function readRegistry(file: string = registryPath()): Record<string, RegistryEntry> {
  const data = readJsonObject(file) ?? {}
  const out: Record<string, RegistryEntry> = {}
  for (const [name, entry] of Object.entries(data)) {
    if (typeof entry === 'object' && entry !== null && typeof (entry as RegistryEntry).path === 'string') {
      out[name] = entry as RegistryEntry
    }
  }
  return out
}

/** `.orcha/state.json` plus its mtime; `null` when absent or unreadable. */
export function readState(folder: string): { state: ServeState; mtimeMs: number } | null {
  const file = path.join(folder, '.orcha', 'state.json')
  const state = readJsonObject(file)
  if (!state) return null
  try {
    return { state: state as ServeState, mtimeMs: statSync(file).mtimeMs }
  } catch {
    return null
  }
}

/** `.claude/orcha.json` fields the app needs to show a stopped native project. */
export function readNativeConfig(folder: string): { name: string; apiPort: number | null } | null {
  const cfg = readJsonObject(path.join(folder, '.claude', 'orcha.json'))
  if (!cfg || cfg.runtime !== 'native') return null
  const name = typeof cfg.project_name === 'string' && cfg.project_name ? cfg.project_name : path.basename(folder)
  const apiPort = typeof cfg.api_port === 'number' ? cfg.api_port : null
  return { name, apiPort }
}

export function readKnownFolders(userDataDir: string): string[] {
  try {
    const data: unknown = JSON.parse(readFileSync(knownFoldersPath(userDataDir), 'utf8'))
    return Array.isArray(data) ? data.filter((f): f is string => typeof f === 'string') : []
  } catch {
    return []
  }
}

/** Add `folder` to the app's known native folders (atomic write; best-effort, never throws). */
export function rememberNativeFolder(userDataDir: string, folder: string): void {
  const known = readKnownFolders(userDataDir)
  if (known.includes(folder)) return
  try {
    mkdirSync(userDataDir, { recursive: true })
    const file = knownFoldersPath(userDataDir)
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify([...known, folder], null, 2) + '\n')
    renameSync(tmp, file)
  } catch {
    /* a lost entry only means a stopped project's card hides until it is started again */
  }
}

export const defaultProbe: Probe = async (apiPort) => {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(`http://localhost:${apiPort}/api/containers`, { signal: ctrl.signal })
    if (res.ok) return { ok: true, status: res.status, error: null }
    const body = await res.text().catch(() => '')
    const why = summarizeErrorBody(body)
    return { ok: false, status: res.status, error: `HTTP ${res.status}${why ? `: ${why}` : ''}` }
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError'
    return { ok: false, status: null, error: aborted ? `no answer in ${PROBE_TIMEOUT_MS / 1000} s` : 'no answer' }
  } finally {
    clearTimeout(timer)
  }
}

/** Health from state.json + the portal probe:
 *  stopped      — no state, `status: "stopped"`, or a running state gone stale (serve died);
 *  crashlooping — serve is up but a child is marked crashlooping;
 *  error        — serve is up and the portal ANSWERS, but GET /api/containers fails (an HTTP
 *                 error — e.g. #281's SQL error): running, not stopped, and not "starting";
 *  starting     — serve is up, the portal does not answer yet;
 *  ok           — serve is up and the portal answers 2xx.
 *  `portal` is the probe result, or a boolean (true = ok, false = no answer). */
export function healthOf(
  st: { state: ServeState; mtimeMs: number } | null,
  portal: ProbeResult | boolean,
  now: number
): StackHealth {
  if (!st || st.state.status !== 'running' || now - st.mtimeMs >= STATE_FRESH_MS) return 'stopped'
  const children = Object.values(st.state.children ?? {})
  if (children.some((c) => c?.status === 'crashlooping')) return 'crashlooping'
  const p = normalizeProbe(portal)
  if (p.ok) return 'ok'
  return p.status !== null ? 'error' : 'starting'
}

export interface ListNativeOptions {
  registryFile?: string
  /** Extra folders to consider (the app's known native folders). */
  knownFolders?: string[]
  probe?: Probe
  now?: number
}

/** A one-line, user-facing reason for a non-ok live project (shown as the row's tooltip). */
function healthDetail(health: StackHealth, p: ProbeResult): string {
  if (health === 'crashlooping') return 'A background process keeps crashing — see .orcha/logs in the project folder.'
  if (health === 'error') return `The project is running, but its project list failed (GET /api/containers → ${p.error ?? `HTTP ${p.status}`}).`
  return `The project is running; its portal is not answering yet (${p.error ?? 'no answer'}).`
}

/** Every native project the registry or the app knows about, running or stopped, in the
 *  shared `Stack` shape (`project = "orcha-<name>"`, `dbPort: null`). */
export async function listNativeStacks(opts: ListNativeOptions = {}): Promise<Stack[]> {
  const probe = opts.probe ?? defaultProbe
  const now = opts.now ?? Date.now()
  const byFolder = new Map<string, { name: string; apiPort: number | null }>()
  for (const [name, entry] of Object.entries(readRegistry(opts.registryFile))) {
    byFolder.set(entry.path, { name, apiPort: typeof entry.api_port === 'number' ? entry.api_port : null })
  }
  for (const folder of opts.knownFolders ?? []) {
    if (byFolder.has(folder)) continue
    const cfg = readNativeConfig(folder)
    if (cfg) byFolder.set(folder, cfg)
  }

  const rows = await Promise.all(
    [...byFolder.entries()].map(async ([folder, { name, apiPort: regPort }]): Promise<Stack> => {
      const st = readState(folder)
      const apiPort = (typeof st?.state.api_port === 'number' ? st.state.api_port : null) ?? regPort
      // `running` means the RUNTIME is up (serve alive, state.json fresh) — like a Docker stack
      // whose portal container is Up — not that one API call succeeded. A live project whose
      // project list errors (#281) must not read as "stopped" with only a Start button.
      const serveUp = healthOf(st, true, now) !== 'stopped'
      const probed = serveUp && apiPort !== null ? normalizeProbe(await probe(apiPort)) : NOT_PROBED
      const health = healthOf(st, probed, now)
      return {
        project: `orcha-${name}`,
        projectShort: name,
        apiPort,
        dbPort: null,
        portalStatus: !serveUp ? 'Down' : probed.ok ? 'Up (native)' : `Up (native) — portal ${probed.error ?? 'not answering'}`,
        running: serveUp,
        folder,
        runtime: 'native',
        health,
        ...(serveUp && !probed.ok ? { healthDetail: healthDetail(health, probed) } : {})
      }
    })
  )
  return rows.sort((a, b) => a.projectShort.localeCompare(b.projectShort))
}
