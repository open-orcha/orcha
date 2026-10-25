/** Storage IPC operations, kept together so successful removals always invalidate scans
 *  captured before the change. CLI/Docker execution is injected for regression tests. */
import { singleFlight } from './singleFlight'
import { removeLeftover, scanStorage, type StorageDeps } from './storageScan'
import { cleanAgentWorktrees, parseCleanRequest, scanAgentWorktrees, type KnownFolder, type Run } from './agentWorktrees'

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
  const scan = singleFlight(async () => scanAgentWorktrees(await projects(), run(), hasWorktreesDir))
  return {
    scan,
    async clean(raw: unknown) {
      const req = parseCleanRequest(raw, await projects())
      const result = await cleanAgentWorktrees(req, run())
      if (!req.dryRun) scan.invalidate()
      return result
    }
  }
}
