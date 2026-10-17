import type { ProjectContainer, Stack } from '../../../shared/types'
import { containerIcon } from '../../../shared/projectIcon'

/** One project card's worth of data: the container itself plus which stack (compose
 *  project) it lives in — Open/Pair need the stack's project name to route portalShow. */
export interface ProjectCardData {
  stack: Stack
  container: ProjectContainer
}

/** For every RUNNING stack, GET /api/containers and flatten into one row per container
 *  across all stacks (a stack can hold more than one project since mig 037). A stack whose
 *  fetch fails (portal still warming up, transient hiccup) is skipped for cards — it still
 *  shows as a normal running stack via listStacks, just contributes no cards this refresh
 *  rather than blocking the whole grid. Never throws. */
export async function loadProjectCards(
  stacks: Stack[],
  portalGet: (apiPort: number, path: string) => Promise<unknown>
): Promise<ProjectCardData[]> {
  const running = stacks.filter((s) => s.running && s.apiPort !== null)
  const results = await Promise.all(
    running.map(async (stack) => {
      try {
        const res = (await portalGet(stack.apiPort as number, '/api/containers')) as {
          containers?: ProjectContainer[]
        }
        const containers = Array.isArray(res.containers) ? res.containers : []
        return containers.map((raw) => {
          // D14: `icon` is validated here (never trusted as-is); an absent key stays absent so
          // the UI can tell an older portal (no shared store) from an unset icon (null).
          const { icon: _raw, ...rest } = raw
          const icon = containerIcon(raw)
          const container: ProjectContainer = icon === undefined ? rest : { ...rest, icon }
          return { stack, container }
        })
      } catch {
        return []
      }
    })
  )
  return results.flat()
}
