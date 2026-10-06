import type { Stack, StackDiscovery } from '../shared/types'
import { dockerExecWithTimeout, type Exec, type ExecResult } from './dockerExec'
import { listNativeStacks, readKnownFolders, rememberNativeFolder } from './nativeStacks'

/** `docker ps` is a quick probe: a hung CLI must settle as DOCKER_UNAVAILABLE, not block the
 *  manager's first paint forever (desktop audit BLOCKER). */
const defaultExec: Exec = dockerExecWithTimeout()

const PS_FORMAT =
  '{{.Names}}\t{{.Status}}\t{{.Ports}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.project.working_dir"}}'

/** The compose working_dir for an orcha stack is "<project>/.orcha"; the project root is its
 *  parent. Returns null when the label is absent/empty. */
export function projectFolderFromWorkingDir(workingDir: string): string | null {
  const wd = workingDir.trim()
  if (!wd) return null
  // strip a trailing "/.orcha" (or "\.orcha") to get the project root.
  const m = wd.match(/^(.*)[/\\]\.orcha[/\\]?$/)
  return m ? m[1] : wd
}

/** Mirror of the CLI's _parse_host_port, extended for IPv6 wildcard binds
 *  (':::8001->8000/tcp', '[::]:8001->8000/tcp') seen on OrbStack/Docker Desktop. */
export function parseHostPort(portsStr: string, containerPort: string): number | null {
  for (const raw of portsStr.split(',')) {
    const chunk = raw.trim()
    if (!chunk.includes(`->${containerPort}/`)) continue
    const match = chunk.match(/(?:0\.0\.0\.0|\[::\]|::):(\d+)->/)
    if (match) {
      const port = Number(match[1])
      if (Number.isInteger(port)) return port
    }
  }
  return null
}

/** Mirror of the CLI's _discover_stacks parsing, over `docker ps -a` output. */
export function parseDockerPs(stdout: string): Stack[] {
  const byProject = new Map<
    string,
    Array<{ name: string; status: string; ports: string; workingDir: string }>
  >()
  for (const line of stdout.split('\n')) {
    const parts = line.split('\t')
    if (parts.length < 4) continue
    const [name, status, ports, rawProject, workingDir = ''] = parts
    const project = rawProject.trim()
    if (!project.startsWith('orcha-')) continue
    const rows = byProject.get(project) ?? []
    rows.push({ name, status, ports, workingDir })
    byProject.set(project, rows)
  }

  return [...byProject.keys()].sort().map((project) => {
    let apiPort: number | null = null
    let dbPort: number | null = null
    let portalStatus = ''
    let folder: string | null = null
    for (const { name, status, ports, workingDir } of byProject.get(project)!) {
      if (name.includes('portal')) {
        portalStatus = status
        apiPort = parseHostPort(ports, '8000')
      } else if (name.includes('db')) {
        dbPort = parseHostPort(ports, '5432')
      }
      // Any container in the project carries the working_dir label; first non-null wins.
      folder = folder ?? projectFolderFromWorkingDir(workingDir)
    }
    return {
      project,
      projectShort: project.replace(/^orcha-/, ''),
      apiPort,
      dbPort,
      portalStatus,
      running: portalStatus.startsWith('Up'),
      folder,
      runtime: 'docker' as const,
      health: portalStatus.startsWith('Up') ? ('ok' as const) : ('stopped' as const)
    }
  })
}

/** One `docker ps -a` pass. Rejects with {code:'DOCKER_UNAVAILABLE'} when docker is missing
 *  or the daemon is down, adding `unresponsive: true` when the CLI hung past the probe timeout. */
export async function listDockerStacks(exec: Exec = defaultExec): Promise<Stack[]> {
  let result: ExecResult
  try {
    result = await exec('docker', ['ps', '-a', '--format', PS_FORMAT])
  } catch (err) {
    // A timed-out probe means the CLI is wedged, not that the daemon is stopped: say so, so
    // the manager/sidebar don't claim "isn't running" while preflight says "not responding".
    if ((err as { timedOut?: boolean } | null)?.timedOut === true) {
      throw { code: 'DOCKER_UNAVAILABLE', unresponsive: true } as const
    }
    // No `docker` binary at all: a Mac that never had Docker (GH #258 D4) — say nothing about it.
    if ((err as { code?: unknown } | null)?.code === 'ENOENT') {
      throw { code: 'DOCKER_UNAVAILABLE', missing: true } as const
    }
    throw { code: 'DOCKER_UNAVAILABLE' } as const
  }
  return parseDockerPs(result.stdout)
}

/** Docker is polled at most this often (plan D-D2: the old 15 s cadence); native rows are
 *  file reads and are fresh on every call. */
export const DOCKER_CACHE_MS = 15_000

/** `dockerAvailable: false` = `docker` is missing or its daemon is down — Docker projects (if
 *  any) are hidden, which the home screen shows as a small note instead of a blocking banner. */
export type Discovery = StackDiscovery

export interface DiscoveryDeps {
  exec?: Exec
  listNative?: () => Promise<Stack[]>
  now?: () => number
}

let nativeFoldersDir: string | null = null
/** main/index.ts points discovery at <userData> so stopped native projects stay listed. */
export function configureNativeDiscovery(userDataDir: string): void {
  nativeFoldersDir = userDataDir
}

/** Every native project seen in the CLI registry is remembered, because `orcha down` drops it
 *  from the registry — without this a project stopped from the app would vanish from Home. */
async function defaultListNative(): Promise<Stack[]> {
  const dir = nativeFoldersDir
  const known = dir ? readKnownFolders(dir) : []
  const stacks = await listNativeStacks({ knownFolders: known })
  if (dir) for (const s of stacks) if (s.folder && !known.includes(s.folder)) rememberNativeFolder(dir, s.folder)
  return stacks
}

let dockerCache: { at: number; value: Stack[] | { error: { code: 'DOCKER_UNAVAILABLE'; unresponsive?: boolean; missing?: boolean } } } | null =
  null

/** Test hook: forget the cached docker pass. */
export function resetDockerCache(): void {
  dockerCache = null
}

/** Native projects ∪ Docker stacks (a name in both keeps the native row, like `orcha ls`). */
export async function discoverStacks(deps: DiscoveryDeps = {}): Promise<Discovery> {
  const now = (deps.now ?? Date.now)()
  const nativeP = (deps.listNative ?? defaultListNative)().catch(() => [] as Stack[])
  // The cache is for the real docker CLI only; an injected exec (tests) always runs.
  let entry = deps.exec ? null : dockerCache
  if (!entry || now - entry.at >= DOCKER_CACHE_MS) {
    try {
      entry = { at: now, value: await listDockerStacks(deps.exec ?? defaultExec) }
    } catch (err) {
      entry = { at: now, value: { error: err as { code: 'DOCKER_UNAVAILABLE'; unresponsive?: boolean; missing?: boolean } } }
    }
    if (!deps.exec) dockerCache = entry
  }
  const native = await nativeP
  const docker = entry.value
  if (!Array.isArray(docker)) {
    return {
      stacks: native,
      dockerAvailable: false,
      dockerUnresponsive: docker.error.unresponsive === true,
      dockerMissing: docker.error.missing === true
    }
  }
  const seen = new Set(native.map((s) => s.projectShort))
  const stacks = [...native, ...docker.filter((s) => !seen.has(s.projectShort))].sort((a, b) =>
    a.project.localeCompare(b.project)
  )
  return { stacks, dockerAvailable: true }
}

/** All Orcha projects on this machine, running or stopped. Rejects with
 *  {code:'DOCKER_UNAVAILABLE'} only when Docker is unavailable AND there is no native project
 *  — a Docker-only machine keeps today's "Docker isn't running" banner; a machine with native
 *  projects just lists them (GH #258). */
export async function listStacks(deps: DiscoveryDeps | Exec = {}): Promise<Stack[]> {
  const d = await discoverStacks(typeof deps === 'function' ? { exec: deps, listNative: async () => [] } : deps)
  if (!d.dockerAvailable && d.stacks.length === 0) {
    throw d.dockerUnresponsive
      ? ({ code: 'DOCKER_UNAVAILABLE', unresponsive: true } as const)
      : ({ code: 'DOCKER_UNAVAILABLE' } as const)
  }
  return d.stacks
}
