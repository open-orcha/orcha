/** Agent CLI detection (main process only). Electron-free — agentDetect.test.ts drives it
 *  with a mocked shell.
 *
 *  How: ONE bounded run of the user's own login shell prints its PATH
 *  (`$SHELL -l -i -c 'printf …"$PATH"'` — the same login+interactive environment agent tabs
 *  launch in, so nvm / ~/.local/bin / Homebrew entries from .zprofile/.zshrc count), then
 *  each registry binary is resolved against those directories here with an executable-file
 *  check. Nothing but the shell is executed, no candidate binary is ever run, and the
 *  renderer can only ask to (re)detect — it never supplies a name, path or command.
 *  Results are cached; `refresh()` re-runs on demand and coalesces concurrent calls. */
import path from 'node:path'
import { AGENT_REGISTRY, type AgentId, type DetectionStatus } from '../shared/agents'
import { shellBasename } from './terminalLaunch'

/** Marker so rc-file noise (banners, motd) printed by an interactive shell is ignored. */
export const PATH_MARKER = '__ORCHA_PATH__='
export const DETECT_TIMEOUT_MS = 10_000
/** PATH entries considered (a pathological PATH can't make detection unbounded). */
export const PATH_DIRS_MAX = 256

/** The shell argv that prints PATH (fish keeps PATH as a list). */
export function pathProbeArgs(shell: string): string[] {
  const name = shellBasename(shell)
  if (name === 'fish') return ['-l', '-i', '-c', `printf '%s%s\\n' '${PATH_MARKER}' (string join : $PATH)`]
  const flags = name === 'sh' || name === 'dash' ? ['-l', '-c'] : ['-l', '-i', '-c']
  return [...flags, `printf '%s%s\\n' '${PATH_MARKER}' "$PATH"`]
}

/** Pull the PATH directories out of the shell's stdout (last marker line wins). Only
 *  absolute, NUL/newline-free entries are kept, de-duplicated, capped. */
export function parsePathOutput(stdout: string): string[] | null {
  const line = stdout
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.includes(PATH_MARKER))
  if (line === undefined) return null
  const value = line.slice(line.indexOf(PATH_MARKER) + PATH_MARKER.length)
  const out: string[] = []
  for (const dir of value.split(':')) {
    if (!dir.startsWith('/') || dir.includes('\0') || out.includes(dir)) continue
    out.push(dir)
    if (out.length >= PATH_DIRS_MAX) break
  }
  return out
}

export interface DetectDeps {
  /** The user's login shell (already validated by resolveShell). */
  shell: string
  /** Run `file args` with a timeout; resolves stdout (rejects on error/timeout). */
  run(file: string, args: string[], timeoutMs: number): Promise<string>
  /** Is `p` an executable regular file (symlinks followed)? */
  isExecutable(p: string): boolean
  now(): number
}

export interface Detection {
  status: DetectionStatus
  at: number | null
  paths: Partial<Record<AgentId, string>>
}

/** Resolve every registry binary against PATH dirs (first hit wins, like `command -v`). */
export function resolveBins(dirs: string[], isExecutable: (p: string) => boolean): Partial<Record<AgentId, string>> {
  const found: Partial<Record<AgentId, string>> = {}
  for (const agent of AGENT_REGISTRY) {
    for (const dir of dirs) {
      const candidate = path.join(dir, agent.bin)
      if (isExecutable(candidate)) {
        found[agent.id] = candidate
        break
      }
    }
  }
  return found
}

export class AgentDetector {
  private state: Detection = { status: 'pending', at: null, paths: {} }
  private inflight: Promise<Detection> | null = null

  constructor(private readonly deps: DetectDeps) {}

  current(): Detection {
    return this.state
  }

  /** Cached result; runs the first detection if none has run yet. */
  async get(): Promise<Detection> {
    if (this.state.status === 'pending') return this.refresh()
    return this.state
  }

  /** Re-detect (coalesced: callers during a run share it). */
  refresh(): Promise<Detection> {
    if (this.inflight) return this.inflight
    this.inflight = (async () => {
      await null // always async, so `inflight` is set before `finally` clears it
      try {
        const stdout = await this.deps.run(this.deps.shell, pathProbeArgs(this.deps.shell), DETECT_TIMEOUT_MS)
        const dirs = parsePathOutput(stdout)
        if (!dirs) throw new Error('no PATH in shell output')
        this.state = { status: 'ready', at: this.deps.now(), paths: resolveBins(dirs, this.deps.isExecutable) }
      } catch {
        // Keep any earlier good result; a first failure reports 'error' (launchers fall back
        // to the legacy Claude/Codex entries, which resolve by name inside the shell).
        this.state = this.state.status === 'ready' ? this.state : { status: 'error', at: this.deps.now(), paths: {} }
      } finally {
        this.inflight = null
      }
      return this.state
    })()
    return this.inflight
  }

  /** Cached absolute path for an agent (null = unknown / not installed). */
  pathFor(id: AgentId): string | null {
    return this.state.paths[id] ?? null
  }
}
