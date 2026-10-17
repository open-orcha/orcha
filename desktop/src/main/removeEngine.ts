/** "Remove project…" — take one project out of Embodent, cleaning up everything it owns.
 *
 *  Levels (shared/types RemoveOptions):
 *  - default ("Remove from Embodent"): stop the host daemons (notifier + terminal bridge, and
 *    their pid files), remove the stack's containers including its `orcha-run-*` sandboxes,
 *    its network and its project-specific portal image. KEEPS the data volume and every file,
 *    so adding the folder again (same compose name → same `<project>_pgdata`) brings it back.
 *  - `deleteData`: additionally removes the stack's volumes (`down -v`) — irreversible.
 *  - `removeFiles`: additionally removes Embodent's own files from the folder (never the
 *    user's code, their own .claude content or the git repo; worktrees with uncommitted
 *    changes and branches with unmerged work are kept, with a warning).
 *
 *  Every docker call is an argv array (never a shell string) naming exact resources selected
 *  by projectCleanup.ts. Electron-free, deps injected — removeEngine.test.ts. */
import path from 'node:path'
import type { RemoveOptions, RemovePhase, RemovePlan, RemoveResult } from '../shared/types'
import { killLingeringDaemons, nodeProcessDeps, type ProcessDeps } from './daemonCleanup'
import { classifyFolder, removeOne, saveOutput } from './agentWorktrees'
import {
  COMMAND_FILE,
  IMAGES_FORMAT,
  LABELED_FORMAT,
  MAYBE_EMPTY_DIRS,
  ORCHA_DIRS,
  ORCHA_FILES,
  PS_FORMAT,
  SAFE_PROJECT,
  SKILL_DIR,
  daemonPidFiles,
  folderBelongsTo,
  isQuorateBranch,
  isSafeFolder,
  parseContainers,
  parseDiskSizes,
  parseImages,
  parseLabeled,
  parseWorktrees,
  projectContainers,
  projectImages,
  projectNetworks,
  projectSandboxes,
  projectVolumes,
  quorateWorktrees,
  stripManagedHooks,
  type ContainerInfo,
  type WorktreeEntry
} from './projectCleanup'

const STDERR_TAIL = 500

export interface RemoveFs {
  readText(p: string): string | null
  exists(p: string): boolean
  listDir(p: string): string[] | null
  writeText(p: string, text: string): void
  /** Recursive remove (missing is fine). */
  rmrf(p: string): void
  /** Single-file remove (missing is fine). */
  rmFile(p: string): void
  /** Remove a directory only when it is empty (never throws). */
  rmdirIfEmpty(p: string): void
}

export interface RemoveDeps {
  /** `docker <args>` with a Finder-safe PATH and a neutral cwd (never a project's). */
  docker(args: string[]): Promise<{ stdout: string }>
  /** A host tool (`orcha`, `git`) run in `cwd`. Rejects on a nonzero exit / missing binary. */
  run(cmd: string, args: string[], cwd: string): Promise<{ stdout: string }>
  fs: RemoveFs
  home: string
  processDeps?: ProcessDeps
  log?(line: string): void
}

/** A docker failure in plain terms: daemon down → DOCKER_UNAVAILABLE, else the stderr tail. */
export function dockerFailure(err: unknown): { code: 'DOCKER_UNAVAILABLE' } | { code: 'COMPOSE_FAILED'; stderr: string } {
  const e = err as { code?: unknown; stderr?: unknown; message?: unknown } | null
  const stderr = String(e?.stderr ?? e?.message ?? '')
  if (e?.code === 'ENOENT' || /Cannot connect to the Docker daemon|Is the docker daemon running|docker daemon is not running|error during connect/i.test(stderr)) {
    return { code: 'DOCKER_UNAVAILABLE' }
  }
  return { code: 'COMPOSE_FAILED', stderr: stderr.slice(-STDERR_TAIL) }
}

interface Inventory {
  containers: ContainerInfo[]
  sandboxes: ContainerInfo[]
  networks: string[]
  volumes: string[]
  images: string[]
}

async function inventory(project: string, cid: string | null, deps: RemoveDeps): Promise<Inventory> {
  try {
    const [ps, vols, nets, imgs] = await Promise.all([
      deps.docker(['ps', '-a', '--no-trunc', '--format', PS_FORMAT]),
      deps.docker(['volume', 'ls', '--format', LABELED_FORMAT]),
      deps.docker(['network', 'ls', '--format', LABELED_FORMAT]),
      deps.docker(['images', '--format', IMAGES_FORMAT])
    ])
    const all = parseContainers(ps.stdout)
    return {
      containers: projectContainers(all, project),
      sandboxes: projectSandboxes(all, project, cid),
      networks: projectNetworks(parseLabeled(nets.stdout), project),
      volumes: projectVolumes(parseLabeled(vols.stdout), project),
      images: projectImages(parseImages(imgs.stdout), project)
    }
  } catch (err) {
    throw dockerFailure(err)
  }
}

interface FolderFacts {
  folder: string | null
  /** The folder demonstrably belongs to this project (safe to `orcha down` / clean). */
  matches: boolean
  cid: string | null
}

function folderFacts(project: string, folder: string | null, fs: RemoveFs): FolderFacts {
  if (!isSafeFolder(folder)) return { folder: null, matches: false, cid: null }
  const compose = fs.readText(path.join(folder, '.orcha', 'docker-compose.yml'))
  const cfgText = fs.readText(path.join(folder, '.claude', 'orcha.json'))
  let cid: string | null = null
  try {
    const cfg = JSON.parse(cfgText ?? 'null') as { current_container_id?: unknown } | null
    if (typeof cfg?.current_container_id === 'string' && cfg.current_container_id) cid = cfg.current_container_id
  } catch {
    cid = null
  }
  const matches = folderBelongsTo(project, compose, cfgText)
  return { folder, matches, cid: matches ? cid : null }
}

/** Embodent's files that exist in the folder (relative paths, for the dialog's summary). */
function existingFolderFiles(folder: string, fs: RemoveFs): string[] {
  const out: string[] = []
  for (const rel of [...ORCHA_DIRS, ...ORCHA_FILES]) if (fs.exists(path.join(folder, rel))) out.push(rel)
  const commands = (fs.listDir(path.join(folder, '.claude', 'commands')) ?? []).filter((n) => COMMAND_FILE.test(n))
  if (commands.length) out.push(`.claude/commands/orcha-*.md (${commands.length})`)
  const skills = (fs.listDir(path.join(folder, '.agents', 'skills')) ?? []).filter((n) => SKILL_DIR.test(n))
  if (skills.length) out.push(`.agents/skills/orcha-* (${skills.length})`)
  for (const rel of ['.claude/settings.json', '.codex/hooks.json']) {
    const text = fs.readText(path.join(folder, rel))
    if (text !== null && stripManagedHooks(text).kind !== 'unchanged' && stripManagedHooks(text).kind !== 'unparseable') {
      out.push(`${rel} (Embodent hooks only)`)
    }
  }
  return out
}

async function listWorktrees(folder: string, deps: RemoveDeps): Promise<WorktreeEntry[] | null> {
  try {
    const res = await deps.run('git', ['-C', folder, 'worktree', 'list', '--porcelain'], folder)
    return quorateWorktrees(parseWorktrees(res.stdout), folder)
  } catch {
    return null // not a git repo / git missing
  }
}

/** What a removal would touch, with the sizes docker can report — the dialog's summary. */
export async function planRemoval(project: string, projectShort: string, folder: string | null, deps: RemoveDeps): Promise<RemovePlan> {
  if (!SAFE_PROJECT.test(project)) throw { code: 'UNKNOWN_STACK' } as const
  const facts = folderFacts(project, folder, deps.fs)
  const inv = await inventory(project, facts.cid, deps)
  let sizes = parseDiskSizes('')
  try {
    sizes = parseDiskSizes((await deps.docker(['system', 'df', '-v', '--format', '{{json .}}'])).stdout)
  } catch {
    // sizes are a nicety — the plan stands without them
  }
  const worktrees = facts.folder && facts.matches ? ((await listWorktrees(facts.folder, deps)) ?? []) : []
  // The CLI's classification (Embodent scaffolding is never a "change"); absent on an old CLI.
  const classified = facts.folder && facts.matches && worktrees.length ? await classifyFolder(facts.folder, deps.run) : null
  const byPath = new Map((classified ?? []).map((c) => [c.path, c]))
  const pidFiles = daemonPidFiles(facts.matches ? facts.folder : null, facts.cid, deps.home).filter((p) => deps.fs.exists(p))
  return {
    project,
    projectShort,
    folder: facts.folder,
    folderMatches: facts.matches,
    containers: inv.containers.map((c) => c.name),
    sandboxes: inv.sandboxes.map((c) => c.name),
    networks: inv.networks,
    images: inv.images.map((name) => ({ name, size: sizes.images.get(name) ?? null })),
    volumes: inv.volumes.map((name) => ({ name, size: sizes.volumes.get(name) ?? null })),
    daemonPidFiles: pidFiles,
    folderFiles: facts.folder && facts.matches ? existingFolderFiles(facts.folder, deps.fs) : [],
    worktrees: worktrees.map((w) => {
      const c = byPath.get(w.path)
      return c
        ? { path: w.path, branch: w.branch, state: c.state, size: c.size_bytes ?? null,
            files: c.state === 'has-output' ? [...(c.output ?? []), ...(c.modified ?? [])] : undefined }
        : { path: w.path, branch: w.branch }
    })
  }
}

/** Remove Embodent's own files from `folder` (only called when it belongs to the project). */
async function removeFolderFiles(folder: string, deps: RemoveDeps, result: RemoveResult, saveOutputFirst = true): Promise<void> {
  const { fs } = deps
  // 1. agent worktrees — through the CLI's classification when it can give one (Embodent's own
  //    scaffolding is not "uncommitted work"; output is saved before a worktree goes; unmerged
  //    commits, in-use and non-Embodent worktrees are always kept). An old CLI falls back to
  //    plain `git worktree remove` (never --force).
  const classified = await classifyFolder(folder, deps.run, true)
  const trees = classified === null ? await listWorktrees(folder, deps) : []
  if (classified !== null) {
    for (const wt of classified) {
      const name = path.basename(wt.path)
      if (wt.state === 'not-quorate') {
        result.warnings.push(`Kept ${name} in .orcha-worktrees — it isn't a Embodent worktree.`)
        continue
      }
      if (wt.state === 'in-use') {
        result.warnings.push(`Kept worktree ${name} — something is still running in it.`)
        continue
      }
      if (wt.state === 'unmerged') {
        result.warnings.push(`Kept worktree ${name} — branch ${wt.branch} has commits that aren't merged.`)
        continue
      }
      if (wt.state === 'has-output' && !saveOutputFirst) {
        result.warnings.push(`Kept worktree ${name} — it has output you chose not to save.`)
        continue
      }
      const res = await removeOne(folder, wt.path, deps.run)
      if (!res.ok) {
        result.warnings.push(`Kept worktree ${name} — ${res.reason || 'it could not be removed safely'}.`)
        continue
      }
      result.removed.push(`Worktree ${name}`)
      if (res.branchNote === 'deleted' && wt.branch) result.removed.push(`Branch ${wt.branch}`)
    }
  } else if (trees === null) {
    if ((fs.listDir(path.join(folder, '.orcha-worktrees')) ?? []).length > 0) {
      result.warnings.push('Kept .orcha-worktrees/ — git could not list its worktrees.')
    }
  } else {
    for (const wt of trees) {
      const name = path.basename(wt.path)
      try {
        await deps.run('git', ['-C', folder, 'worktree', 'remove', wt.path], folder)
        result.removed.push(`Worktree ${name}`)
      } catch {
        result.warnings.push(`Kept worktree ${name} — it has uncommitted changes.`)
        continue
      }
      if (!isQuorateBranch(wt.branch)) continue
      let merged = false
      try {
        await deps.run('git', ['-C', folder, 'merge-base', '--is-ancestor', wt.branch, 'HEAD'], folder)
        merged = true
      } catch {
        merged = false
      }
      if (!merged) {
        result.warnings.push(`Kept branch ${wt.branch} — it has work that isn't merged.`)
        continue
      }
      try {
        await deps.run('git', ['-C', folder, 'branch', '-d', wt.branch], folder)
        result.removed.push(`Branch ${wt.branch}`)
      } catch {
        result.warnings.push(`Kept branch ${wt.branch} — git refused to delete it.`)
      }
    }
    try {
      await deps.run('git', ['-C', folder, 'worktree', 'prune'], folder)
    } catch {
      // best effort
    }
  }
  // 2. Embodent's directories and files (fixed relative paths only). Saved agent output
  //    (.orcha/saved-output) is the one thing inside .orcha that is the user's — it stays.
  for (const rel of ORCHA_DIRS) {
    const p = path.join(folder, rel)
    if (!fs.exists(p)) continue
    if (rel === '.orcha' && fs.exists(path.join(p, 'saved-output'))) {
      for (const child of fs.listDir(p) ?? []) if (child !== 'saved-output') fs.rmrf(path.join(p, child))
      result.removed.push('.orcha (except saved-output)')
      result.kept.push('Saved agent output in .orcha/saved-output')
      continue
    }
    fs.rmrf(p)
    result.removed.push(rel)
  }
  for (const rel of ORCHA_FILES) {
    const p = path.join(folder, rel)
    if (fs.exists(p)) {
      fs.rmFile(p)
      result.removed.push(rel)
    }
  }
  const commandsDir = path.join(folder, '.claude', 'commands')
  for (const n of (fs.listDir(commandsDir) ?? []).filter((x) => COMMAND_FILE.test(x))) fs.rmFile(path.join(commandsDir, n))
  const skillsDir = path.join(folder, '.agents', 'skills')
  for (const n of (fs.listDir(skillsDir) ?? []).filter((x) => SKILL_DIR.test(x))) fs.rmrf(path.join(skillsDir, n))
  // 3. hooks — surgical JSON edit, the user's own hooks stay.
  for (const rel of ['.claude/settings.json', '.codex/hooks.json']) {
    const p = path.join(folder, rel)
    const text = fs.readText(p)
    if (text === null) continue
    const edit = stripManagedHooks(text)
    if (edit.kind === 'write') {
      fs.writeText(p, edit.text)
      result.removed.push(`${edit.removed} Embodent hook${edit.removed === 1 ? '' : 's'} from ${rel}`)
    } else if (edit.kind === 'delete') {
      fs.rmFile(p)
      result.removed.push(rel)
    } else if (edit.kind === 'unparseable') {
      result.warnings.push(`Left ${rel} unchanged — it isn't valid JSON.`)
    }
  }
  // 4. tidy directories the cleanup emptied (rmdir only — never a non-empty dir).
  for (const rel of MAYBE_EMPTY_DIRS) fs.rmdirIfEmpty(path.join(folder, rel))
}

/** Remove a project. Throws a BridgeError ({code}) when the load-bearing step fails, so the
 *  dialog can offer Retry; a retry is safe (every step is idempotent). */
export async function removeProject(
  project: string,
  projectShort: string,
  folder: string | null,
  opts: RemoveOptions,
  deps: RemoveDeps,
  onPhase: (phase: RemovePhase) => void = () => {}
): Promise<RemoveResult> {
  if (!SAFE_PROJECT.test(project)) throw { code: 'UNKNOWN_STACK' } as const
  const log = deps.log ?? (() => {})
  const result: RemoveResult = {
    project,
    projectShort,
    dataDeleted: opts.deleteData,
    filesRemoved: false,
    removed: [],
    kept: [],
    warnings: []
  }
  const facts = folderFacts(project, folder, deps.fs)
  const inv = await inventory(project, facts.cid, deps)

  // 0. save agent output while the portal still runs (it is attached to its task; with no
  //    task it is copied to .orcha/saved-output, which the file removal keeps).
  if (opts.removeFiles && opts.saveOutput !== false && facts.folder && facts.matches) {
    const rows = await classifyFolder(facts.folder, deps.run)
    for (const wt of (rows ?? []).filter((r) => r.state === 'has-output')) {
      if (await saveOutput(facts.folder, wt.path, deps.run)) {
        result.removed.push(`Saved the output of ${path.basename(wt.path)}`)
      } else {
        result.warnings.push(`Couldn't save the output of ${path.basename(wt.path)} — its worktree is kept.`)
      }
    }
  }

  // 1. stop: the CLI's own `orcha down` from the folder stops the notifier + terminal bridge
  //    via their pid files (exactly like a Terminal `orcha down`), then the belt-and-braces
  //    process match. Only for a folder that demonstrably belongs to this project.
  onPhase('stopping')
  if (facts.folder && facts.matches) {
    try {
      await deps.run('orcha', opts.deleteData ? ['down', '-v'] : ['down'], facts.folder)
      log(`orcha down${opts.deleteData ? ' -v' : ''} in ${facts.folder}`)
    } catch {
      // missing CLI / nonzero exit — the docker steps below still do the teardown
    }
  }
  await killLingeringDaemons(facts.matches ? facts.folder : null, facts.cid, deps.processDeps ?? nodeProcessDeps)
  for (const p of daemonPidFiles(facts.matches ? facts.folder : null, facts.cid, deps.home)) {
    if (deps.fs.exists(p)) {
      deps.fs.rmFile(p)
      log(`removed pid file ${p}`)
    }
  }

  // 2. containers (sandboxes first: they hold the network), the stack, its network, its image.
  onPhase('removing')
  if (inv.sandboxes.length > 0) {
    try {
      // -v: the sandbox's own anonymous volumes only (named volumes are never removed by rm).
      await deps.docker(['rm', '-f', '-v', ...inv.sandboxes.map((c) => c.name)])
      result.removed.push(`${inv.sandboxes.length} agent sandbox container${inv.sandboxes.length === 1 ? '' : 's'}`)
    } catch (err) {
      const f = dockerFailure(err)
      if (f.code === 'DOCKER_UNAVAILABLE') throw f
      result.warnings.push('Some agent sandbox containers could not be removed.')
    }
  }
  try {
    await deps.docker(['compose', '-p', project, 'down', ...(opts.deleteData ? ['-v'] : [])])
  } catch (err) {
    const f = dockerFailure(err)
    if (f.code === 'DOCKER_UNAVAILABLE') throw f
    log(`compose down for ${project} failed; removing its containers directly`)
  }
  // Anything still carrying this project's exact label: stop gracefully (the db flushes),
  // then remove — so a compose hiccup never leaves the stack half there.
  const after = await inventory(project, facts.cid, deps)
  if (after.containers.length > 0) {
    const names = after.containers.map((c) => c.name)
    try {
      await deps.docker(['stop', ...names])
      await deps.docker(['rm', ...names])
    } catch (err) {
      throw dockerFailure(err)
    }
  }
  if (inv.containers.length > 0) result.removed.push(`Containers ${inv.containers.map((c) => c.name).join(', ')}`)
  for (const net of after.networks) {
    try {
      await deps.docker(['network', 'rm', net])
    } catch {
      result.warnings.push(`Network ${net} is still in use and was left.`)
      continue
    }
  }
  if (inv.networks.length > 0) result.removed.push(`Network ${inv.networks.join(', ')}`)
  for (const image of inv.images) {
    try {
      // No -f: only untags/removes when nothing uses it; a shared image ID stays for its other tags.
      await deps.docker(['image', 'rm', image])
      result.removed.push(`Image ${image}`)
    } catch {
      result.warnings.push(`Image ${image} is in use and was left.`)
    }
  }

  // 3. data — only on the explicit, typed confirmation.
  if (opts.deleteData) {
    onPhase('deleting-data')
    const left = (await inventory(project, facts.cid, deps)).volumes
    if (left.length > 0) {
      try {
        await deps.docker(['volume', 'rm', ...left])
      } catch (err) {
        throw dockerFailure(err)
      }
    }
    if (inv.volumes.length > 0) result.removed.push(`Data ${inv.volumes.join(', ')}`)
  } else {
    for (const v of inv.volumes) result.kept.push(`Data ${v}`)
  }

  // 4. Embodent's files in the folder (opt-in).
  if (opts.removeFiles && facts.folder) {
    onPhase('removing-files')
    if (facts.matches) {
      await removeFolderFiles(facts.folder, deps, result, opts.saveOutput !== false)
      result.filesRemoved = true
    } else {
      result.warnings.push('Left the folder untouched — it no longer belongs to this project.')
    }
  }
  if (facts.folder) result.kept.push(`Your code in ${facts.folder}`)

  onPhase('cleaning')
  log(
    `removed ${project}: ${result.removed.join('; ') || 'nothing'} | kept: ${result.kept.join('; ') || 'nothing'}` +
      (result.warnings.length ? ` | warnings: ${result.warnings.join(' ')}` : '')
  )
  return result
}
