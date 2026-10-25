/** Storage IPC operations, kept together so successful removals always invalidate scans
 *  captured before the change. CLI/Docker execution is injected for regression tests. */
import { singleFlight, singleFlightBy } from './singleFlight'
import { removeLeftover, scanStorage, type StorageDeps } from './storageScan'
import { cleanAgentWorktrees, knownFolder, parseCleanRequest, scanProjectWorktrees, worktreeProjects, type KnownFolder, type Run } from './agentWorktrees'

export function storageOperations(deps: () => StorageDeps) {
  const scan = singleFlight(() => scanStorage(deps()))
  return {
    scan,
    async remove(raw: unknown) {
      const result = await removeLeftover(raw, deps())
      scan.invalidate()
      return result
    }
  }
}

export function worktreeOperations(
  projects: () => Promise<KnownFolder[]>,
  run: () => Run,
  hasWorktreesDir: (folder: string) => boolean
) {
  const listed = async () => worktreeProjects(await projects(), hasWorktreesDir)
  const scanProject = singleFlightBy((p: KnownFolder & { folder: string }) => p.folder, (p) => scanProjectWorktrees(p, run()))
  const scan = singleFlight(async () => Promise.all((await listed()).map((p) => scanProject(p))))
  return {
    scan,
    async projects() {
      return (await listed()).map(({ project, projectShort, folder }) => ({ project, projectShort, folder }))
    },
    async project(raw: unknown) {
      const all = await projects()
      const folder = knownFolder(all, raw)
      const p = worktreeProjects(all, hasWorktreesDir).find((candidate) => candidate.folder === folder)
      if (!p) throw { code: 'INVALID_WORKTREE' } as const
      return scanProject(p)
    },
    async clean(raw: unknown) {
      const req = parseCleanRequest(raw, await projects())
      const result = await cleanAgentWorktrees(req, run())
      if (!req.dryRun) {
        scan.invalidate()
        scanProject.invalidate(req.folder)
      }
      return result
    }
  }
}
