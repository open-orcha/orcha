/** Pure helpers for "Remove project" and Settings › Storage (removeEngine.ts / storageScan.ts).
 *
 *  Safety model: everything a project owns is selected by EXACT names and EXACT label values,
 *  never by prefix globbing — `orcha-acme` must never match `orcha-acme-web`'s containers,
 *  network, volume or image. Shared resources (the `postgres:16` base image, the
 *  `orcha-test/stub-runner` image, anything without this project's compose label) are never
 *  candidates. Electron-free and fs/exec-free — projectCleanup.test.ts. */
import path from 'node:path'

/** A compose project the desktop may act on (same guard as lifecycle/resetEngine). */
export const SAFE_PROJECT = /^orcha-[A-Za-z0-9][A-Za-z0-9_-]*$/

/** A per-run sandbox container name (orcha_cli/sandbox.py new_container_name). */
export const SANDBOX_NAME = /^orcha-run-[0-9a-f]{12}$/

// ---- docker listings ---------------------------------------------------------------------

export interface ContainerInfo {
  name: string
  /** `docker ps --format {{.State}}`: running / exited / created / paused … */
  state: string
  /** com.docker.compose.project label ('' when absent). */
  project: string
  /** orcha.managed label ('1' on sandbox containers). */
  managed: string
  /** orcha.cid label (the project container id a sandbox ran for). */
  cid: string
  networks: string[]
}

export const PS_FORMAT =
  '{{.Names}}\t{{.State}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "orcha.managed"}}\t{{.Label "orcha.cid"}}\t{{.Networks}}'

export function parseContainers(stdout: string): ContainerInfo[] {
  const out: ContainerInfo[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    const [name = '', state = '', project = '', managed = '', cid = '', networks = ''] = line.split('\t')
    if (!name) continue
    out.push({
      name: name.trim(),
      state: state.trim(),
      project: project.trim(),
      managed: managed.trim(),
      cid: cid.trim(),
      networks: networks
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean)
    })
  }
  return out
}

export interface LabeledName {
  name: string
  /** com.docker.compose.project label ('' when absent). */
  project: string
}

export const LABELED_FORMAT = '{{.Name}}\t{{.Label "com.docker.compose.project"}}'

export function parseLabeled(stdout: string): LabeledName[] {
  return stdout
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      const [name = '', project = ''] = l.split('\t')
      return { name: name.trim(), project: project.trim() }
    })
    .filter((x) => x.name)
}

export interface ImageInfo {
  repository: string
  tag: string
  id: string
}

export const IMAGES_FORMAT = '{{.Repository}}\t{{.Tag}}\t{{.ID}}'

export function parseImages(stdout: string): ImageInfo[] {
  return stdout
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      const [repository = '', tag = '', id = ''] = l.split('\t')
      return { repository: repository.trim(), tag: tag.trim(), id: id.trim() }
    })
    .filter((x) => x.repository && x.repository !== '<none>')
}

/** Sizes from `docker system df -v --format '{{json .}}'` (bytes; null when not reported). */
export interface DiskSizes {
  images: Map<string, number>
  volumes: Map<string, number>
}

/** "347MB" / "1.2GB" / "12.69kB" / "0B" → bytes (null for N/A / unparseable). */
export function parseSize(text: unknown): number | null {
  if (typeof text !== 'string') return null
  const m = text.trim().match(/^([\d.]+)\s*([kKMGT]?i?B)$/)
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n)) return null
  const unit = m[2].toUpperCase().replace('I', '')
  const mult: Record<string, number> = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }
  return mult[unit] !== undefined ? Math.round(n * mult[unit]) : null
}

export function parseDiskSizes(stdout: string): DiskSizes {
  const sizes: DiskSizes = { images: new Map(), volumes: new Map() }
  let raw: unknown
  try {
    raw = JSON.parse(stdout.trim().split('\n')[0] || 'null')
  } catch {
    return sizes
  }
  if (!raw || typeof raw !== 'object') return sizes
  const r = raw as { Images?: unknown; Volumes?: unknown }
  for (const img of Array.isArray(r.Images) ? r.Images : []) {
    const i = img as Record<string, unknown>
    if (typeof i.Repository !== 'string' || i.Repository === '<none>') continue
    // UniqueSize is what removing the image actually frees (shared layers stay).
    const size = parseSize(i.UniqueSize) ?? parseSize(i.Size)
    if (size !== null) sizes.images.set(`${i.Repository}:${String(i.Tag ?? 'latest')}`, size)
  }
  for (const vol of Array.isArray(r.Volumes) ? r.Volumes : []) {
    const v = vol as Record<string, unknown>
    const size = parseSize(v.Size)
    if (typeof v.Name === 'string' && size !== null) sizes.volumes.set(v.Name, size)
  }
  return sizes
}

// ---- what one project owns (exact matching) ----------------------------------------------

export const portalImage = (project: string): string => `${project}-portal`
export const defaultNetwork = (project: string): string => `${project}_default`

/** The compose project's own containers (portal, db) — exact label equality. */
export function projectContainers(all: ContainerInfo[], project: string): ContainerInfo[] {
  return all.filter((c) => c.project === project && !SANDBOX_NAME.test(c.name))
}

/** This project's per-run sandbox containers: an `orcha-run-<hex12>` name AND the
 *  orcha.managed label AND (attached to this stack's exact network OR stamped with this
 *  project's container id). Never a prefix match on the stack name. */
export function projectSandboxes(all: ContainerInfo[], project: string, cid: string | null): ContainerInfo[] {
  const net = defaultNetwork(project)
  return all.filter(
    (c) =>
      SANDBOX_NAME.test(c.name) &&
      c.managed === '1' &&
      (c.networks.includes(net) || (cid !== null && cid !== '' && c.cid === cid))
  )
}

/** Volumes labelled with exactly this compose project whose name is `<project>_<vol>`. */
export function projectVolumes(all: LabeledName[], project: string): string[] {
  return all.filter((v) => v.project === project && v.name.startsWith(`${project}_`)).map((v) => v.name)
}

/** The stack's default network, when it exists with this project's label. */
export function projectNetworks(all: LabeledName[], project: string): string[] {
  const net = defaultNetwork(project)
  return all.filter((n) => n.name === net && n.project === project).map((n) => n.name)
}

/** The project-specific portal image tags (`<project>-portal:<tag>`), exact repository. */
export function projectImages(all: ImageInfo[], project: string): string[] {
  const repo = portalImage(project)
  return all.filter((i) => i.repository === repo && i.tag && i.tag !== '<none>').map((i) => `${i.repository}:${i.tag}`)
}

// ---- the project folder -----------------------------------------------------------------

/** `name:` from a rendered .orcha/docker-compose.yml (the compose project it starts). */
export function composeNameOf(text: string | null): string | null {
  if (!text) return null
  for (const line of text.split('\n')) {
    const m = line.match(/^name:\s*["']?([A-Za-z0-9_-]+)["']?\s*$/)
    if (m) return m[1]
  }
  return null
}

/** True when `folder` demonstrably belongs to `project` (its compose file starts exactly
 *  that project, or its .claude/orcha.json names it). A folder that was re-initialised for
 *  another stack must never be cleaned or `orcha down`-ed on this project's behalf. */
export function folderBelongsTo(project: string, composeText: string | null, orchaJson: string | null): boolean {
  const name = composeNameOf(composeText)
  if (name !== null) return name === project
  try {
    const cfg = JSON.parse(orchaJson ?? 'null') as { project_name?: unknown } | null
    return typeof cfg?.project_name === 'string' && `orcha-${cfg.project_name}` === project
  } catch {
    return false
  }
}

/** A folder the cleanup may touch: absolute, normalised, not the filesystem root. */
export function isSafeFolder(folder: string | null): folder is string {
  return (
    typeof folder === 'string' &&
    path.isAbsolute(folder) &&
    path.normalize(folder) === folder &&
    !folder.endsWith('/') &&
    folder.split('/').filter(Boolean).length >= 2
  )
}

/** The `orcha …` hook commands Embodent/the CLI registers (orcha_cli/cli_hooks.py HOOKS and
 *  CODEX_HOOKS). Exact strings — a user's own hook is never matched, even one that calls
 *  `orcha` with other arguments. */
export const MANAGED_HOOK_COMMANDS: ReadonlySet<string> = new Set([
  'orcha poll-inbox',
  'orcha conv-guard',
  'orcha file-guard',
  'orcha watch --detach',
  'orcha rehydrate',
  'orcha unwatch',
  'orcha snapshot',
  'orcha task-claim-guard',
  'orcha notifier --ensure',
  'orcha terminal-bridge --ensure',
  'orcha reachability --quiet'
])

export type HookEditResult =
  | { kind: 'unchanged' }
  | { kind: 'write'; text: string; removed: number }
  /** Only managed hooks were in the file: it can be deleted. */
  | { kind: 'delete'; removed: number }
  /** Not JSON / not an object: leave the file exactly as it is. */
  | { kind: 'unparseable' }

/** Remove ONLY Embodent-managed hook entries from a Claude `settings.json` / Codex
 *  `hooks.json` (parsed JSON, never regex). User hooks, matchers, other keys and ordering are
 *  kept; an entry whose every hook was managed is dropped, then an emptied event, then an
 *  emptied `hooks` object. */
export function stripManagedHooks(text: string): HookEditResult {
  let settings: unknown
  try {
    settings = JSON.parse(text)
  } catch {
    return { kind: 'unparseable' }
  }
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return { kind: 'unparseable' }
  const obj = settings as Record<string, unknown>
  const hooks = obj.hooks
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return { kind: 'unchanged' }
  let removed = 0
  const nextHooks: Record<string, unknown> = {}
  for (const [event, entries] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(entries)) {
      nextHooks[event] = entries
      continue
    }
    const kept: unknown[] = []
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null || !Array.isArray((entry as { hooks?: unknown }).hooks)) {
        kept.push(entry)
        continue
      }
      const list = (entry as { hooks: unknown[] }).hooks
      const rest = list.filter((h) => {
        const managed =
          typeof h === 'object' && h !== null && MANAGED_HOOK_COMMANDS.has(String((h as { command?: unknown }).command ?? ''))
        if (managed) removed++
        return !managed
      })
      if (rest.length === list.length) kept.push(entry)
      else if (rest.length > 0) kept.push({ ...(entry as object), hooks: rest })
    }
    if (kept.length > 0) nextHooks[event] = kept
  }
  if (removed === 0) return { kind: 'unchanged' }
  const next: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (k !== 'hooks') next[k] = v
    else if (Object.keys(nextHooks).length > 0) next[k] = nextHooks
  }
  if (Object.keys(next).length === 0) return { kind: 'delete', removed }
  return { kind: 'write', text: `${JSON.stringify(next, null, 2)}\n`, removed }
}

/** Embodent's own files inside a project folder (relative paths). Directories are removed
 *  recursively, files singly. The user's code, their own `.claude` content and `.git` are
 *  never listed. `.orcha-worktrees/` is handled separately (git worktree remove). */
export const ORCHA_DIRS = ['.orcha', '.claude/orcha-tabs', '.claude/.orcha-wakes', '.claude/.orcha-attachments', '.claude/.orcha-file-locks']
export const ORCHA_FILES = [
  '.claude/orcha.json',
  '.claude/.orcha-notifier.pid',
  '.claude/.orcha-notifier.log',
  '.claude/.orcha-notifier.hb',
  '.claude/.orcha-terminal-bridge.pid',
  '.claude/.orcha-terminal-bridge.log'
]
/** `.claude/commands/orcha-*.md` (the /orcha-* slash commands). */
export const COMMAND_FILE = /^orcha-[a-z0-9-]+\.md$/
/** `.agents/skills/orcha-*` (the Codex skill folders). */
export const SKILL_DIR = /^orcha-[a-z0-9-]+$/
/** Directories that may be left empty by the cleanup; removed only when empty (rmdir). */
export const MAYBE_EMPTY_DIRS = ['.claude/commands', '.agents/skills', '.agents', '.codex', '.orcha-worktrees', '.claude']

/** The daemon pid files of a project (stopped daemons leave these behind). */
export function daemonPidFiles(folder: string | null, cid: string | null, home: string): string[] {
  const out: string[] = []
  if (folder) out.push(path.join(folder, '.claude', '.orcha-notifier.pid'), path.join(folder, '.claude', '.orcha-terminal-bridge.pid'))
  if (cid && /^[A-Za-z0-9-]+$/.test(cid)) out.push(path.join(home, '.orcha', `notifier-${cid}.pid`))
  return out
}

// ---- git worktrees ------------------------------------------------------------------------

export interface WorktreeEntry {
  path: string
  branch: string | null
}

/** `git worktree list --porcelain` → entries (branch without refs/heads/). */
export function parseWorktrees(stdout: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = []
  let cur: WorktreeEntry | null = null
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) out.push(cur)
      cur = { path: line.slice('worktree '.length).trim(), branch: null }
    } else if (line.startsWith('branch ') && cur) {
      cur.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '')
    }
  }
  if (cur) out.push(cur)
  return out
}

/** Embodent's agent worktrees: those living directly under `<folder>/.orcha-worktrees/`. */
export function quorateWorktrees(entries: WorktreeEntry[], folder: string): WorktreeEntry[] {
  const root = `${folder.replace(/\/+$/, '')}/.orcha-worktrees/`
  return entries.filter((e) => e.path.startsWith(root) && !e.path.slice(root.length).includes('/'))
}

/** A branch Embodent created for agent work (`orcha/<kind>-<slug>`). */
export function isQuorateBranch(branch: string | null): branch is string {
  return typeof branch === 'string' && /^orcha\/[A-Za-z0-9._-]+$/.test(branch)
}
