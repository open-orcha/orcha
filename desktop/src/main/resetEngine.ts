import path from 'node:path'
import { dockerExec, type Exec } from './dockerExec'

/** Same orcha-* guard the lifecycle/discovery code uses — argv must name a known orcha stack. */
const SAFE_PROJECT = /^orcha-[A-Za-z0-9_-]+$/
const STDERR_TAIL = 500

export interface ResetDeps {
  exec: Exec
  /** Recursively remove a directory (best-effort; missing is fine). */
  rmrf: (p: string) => void
  /** Remove a single file (best-effort; missing is fine). */
  rmFile: (p: string) => void
}

const defaultDeps = (): ResetDeps => ({
  exec: dockerExec,
  // Real fs adapters are injected by index.ts; these are overridden in tests.
  rmrf: () => {},
  rmFile: () => {}
})

/** The on-disk Orcha artifacts a reset removes from a project folder. Never the project root,
 *  never .claude wholesale — only Orcha's own files, so the user's code is untouched. */
function orchaArtifacts(folder: string): { dirs: string[]; files: string[] } {
  return {
    dirs: [
      path.join(folder, '.orcha'),
      path.join(folder, '.claude', 'orcha-tabs'),
      path.join(folder, '.claude', '.orcha-wakes'),
      path.join(folder, '.claude', '.orcha-attachments')
    ],
    files: [path.join(folder, '.claude', 'orcha.json')]
  }
}

/** Fully delete an orcha stack so the project can be re-created clean:
 *   1. docker compose down -v   (containers + network + the pgdata volume — the data wipe)
 *   2. docker rmi -f <project>-portal  (so the portal rebuilds fresh; best-effort)
 *   3. remove the on-disk Orcha artifacts in `folder` (when known) — never the user's code
 *  Destructive + irreversible; callers gate it behind a type-to-confirm prompt. */
export async function resetStack(
  project: string,
  folder: string | null,
  deps: ResetDeps = defaultDeps()
): Promise<void> {
  if (!SAFE_PROJECT.test(project)) {
    throw { code: 'UNKNOWN_STACK' } as const
  }

  // 1. down -v — the load-bearing teardown. A failure here is fatal (nothing was wiped cleanly).
  try {
    await deps.exec('docker', ['compose', '-p', project, 'down', '-v'])
  } catch (err) {
    const stderr = String((err as { stderr?: string }).stderr ?? '')
    throw { code: 'COMPOSE_FAILED', stderr: stderr.slice(-STDERR_TAIL) } as const
  }

  // 2. remove the built portal image (best-effort — it may not exist or be in use).
  try {
    await deps.exec('docker', ['rmi', '-f', `${project}-portal`])
  } catch {
    // ignore — a missing/used image must not fail the reset.
  }

  // 3. on-disk artifacts (only when we know the folder).
  if (folder) {
    const { dirs, files } = orchaArtifacts(folder)
    for (const d of dirs) deps.rmrf(d)
    for (const f of files) deps.rmFile(f)
  }
}
