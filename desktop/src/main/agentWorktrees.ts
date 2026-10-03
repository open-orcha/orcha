/** Settings › Storage › Agent worktrees, and the worktree step of Remove project.
 *
 *  The classification (clean / has-output / unmerged / in-use / not-quorate), saving output and
 *  every git operation live in ONE place — the Orcha CLI (`orcha worktrees … --json`,
 *  orcha_cli/worktree_gc.py, the same code the notifier runs). This module only calls it for
 *  the project folders discovery knows, validates what the renderer asks for against that list,
 *  and shapes the answers. Electron-free — agentWorktrees.test.ts. */
import path from 'node:path'
import type {
  AgentWorktree,
  AgentWorktreeCleanResult,
  ProjectWorktrees,
  WorktreeCleanRequest
} from '../shared/types'

export type Run = (cmd: string, args: string[], cwd: string) => Promise<{ stdout: string }>

export interface KnownFolder {
  project: string
  projectShort: string
  folder: string | null
}

export const CLI_OUTDATED =
  'This needs a newer Orcha CLI — run `orcha upgrade` (or reinstall the CLI) and try again.'

/** `orcha … --json` → the parsed object, or null when the CLI is missing / too old. */
async function cliJson(run: Run, args: string[], cwd: string): Promise<Record<string, unknown> | null> {
  try {
    const { stdout } = await run('orcha', args, cwd)
    const line = stdout.trim().split('\n').filter(Boolean).pop() ?? ''
    const parsed = JSON.parse(line) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const sumReclaimable = (items: AgentWorktree[]): number =>
  items.reduce((n, i) => n + (i.state === 'clean' || i.state === 'has-output' ? i.size_bytes ?? 0 : 0), 0)

/** Every known project's worktrees (folders without .orcha-worktrees are skipped quietly). */
export async function scanAgentWorktrees(
  projects: KnownFolder[],
  run: Run,
  hasWorktreesDir: (folder: string) => boolean
): Promise<ProjectWorktrees[]> {
  const out: ProjectWorktrees[] = []
  for (const p of projects) {
    if (!p.folder || !hasWorktreesDir(p.folder)) continue
    const res = await cliJson(run, ['worktrees', 'list', '--json', '--project', p.folder], p.folder)
    if (!res || res.ok !== true || !Array.isArray(res.items)) {
      out.push({ project: p.project, projectShort: p.projectShort, folder: p.folder, items: [], reclaimable_bytes: 0,
        error: res && typeof res.error === 'string' ? res.error : CLI_OUTDATED })
      continue
    }
    const items = res.items as AgentWorktree[]
    out.push({ project: p.project, projectShort: p.projectShort, folder: p.folder, items, reclaimable_bytes: sumReclaimable(items) })
  }
  return out
}

/** The folder of a known project, or a thrown INVALID_WORKTREE. */
export function knownFolder(projects: KnownFolder[], folder: unknown): string {
  if (typeof folder !== 'string') throw { code: 'INVALID_WORKTREE' } as const
  const hit = projects.find((p) => p.folder && path.resolve(p.folder) === path.resolve(folder))
  if (!hit || !hit.folder) throw { code: 'INVALID_WORKTREE' } as const
  return hit.folder
}

/** A path directly inside `<folder>/.orcha-worktrees/` (no `..`, no deeper). */
export function isAgentWorktreePath(folder: string, p: unknown): p is string {
  if (typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0')) return false
  const root = path.join(path.resolve(folder), '.orcha-worktrees')
  const resolved = path.resolve(p)
  return path.dirname(resolved) === root && path.basename(resolved) !== '' && !p.split('/').includes('..')
}

/** Validate a clean-up request from the renderer. */
export function parseCleanRequest(raw: unknown, projects: KnownFolder[]): WorktreeCleanRequest {
  const o = (raw ?? {}) as Record<string, unknown>
  const folder = knownFolder(projects, o.folder)
  const unmerged = Array.isArray(o.unmerged) ? o.unmerged : []
  if (unmerged.length > 500 || !unmerged.every((u) => isAgentWorktreePath(folder, u))) {
    throw { code: 'INVALID_WORKTREE' } as const
  }
  return { folder, dryRun: o.dryRun === true, onlyClean: o.onlyClean === true, unmerged: unmerged as string[] }
}

/** `orcha worktrees clean` (with --dry-run for the preview). */
export async function cleanAgentWorktrees(req: WorktreeCleanRequest, run: Run): Promise<AgentWorktreeCleanResult> {
  const args = ['worktrees', 'clean', '--json', '--project', req.folder]
  if (req.dryRun) args.push('--dry-run')
  if (req.onlyClean) args.push('--only-clean')
  for (const u of req.unmerged) args.push('--unmerged', u)
  const res = await cliJson(run, args, req.folder)
  if (!res || res.ok !== true) throw { code: 'WORKTREE_CLI', message: res && typeof res.error === 'string' ? res.error : CLI_OUTDATED }
  return {
    folder: req.folder,
    dryRun: req.dryRun,
    removed: (res.removed as AgentWorktreeCleanResult['removed']) ?? [],
    kept: (res.kept as AgentWorktreeCleanResult['kept']) ?? [],
    skipped: (res.skipped as AgentWorktreeCleanResult['skipped']) ?? [],
    freed_bytes: typeof res.freed_bytes === 'number' ? res.freed_bytes : 0
  }
}

// ---- Remove project --------------------------------------------------------------------

/** The CLI's classification of one folder's worktrees (null = CLI missing/too old → callers
 *  fall back to plain `git worktree remove`). `offline`: the stack may already be down. */
export async function classifyFolder(folder: string, run: Run, offline = false): Promise<AgentWorktree[] | null> {
  const args = ['worktrees', 'list', '--json', '--project', folder]
  if (offline) args.push('--offline')
  const res = await cliJson(run, args, folder)
  return res && res.ok === true && Array.isArray(res.items) ? (res.items as AgentWorktree[]) : null
}

/** Save one worktree's output (to its task when the portal answers, else .orcha/saved-output). */
export async function saveOutput(folder: string, wtPath: string, run: Run): Promise<boolean> {
  const res = await cliJson(run, ['worktrees', 'save-output', wtPath, '--json', '--project', folder], folder)
  return !!res && res.ok === true
}

/** Remove one worktree through the CLI's safe path. → {ok, reason}. */
export async function removeOne(folder: string, wtPath: string, run: Run): Promise<{ ok: boolean; reason: string; branchNote: string | null }> {
  const res = await cliJson(run, ['worktrees', 'remove', wtPath, '--json', '--offline', '--project', folder], folder)
  if (!res) return { ok: false, reason: CLI_OUTDATED, branchNote: null }
  return {
    ok: res.ok === true,
    reason: typeof res.reason === 'string' ? res.reason : typeof res.error === 'string' ? res.error : '',
    branchNote: typeof res.branch_note === 'string' ? res.branch_note : null
  }
}
