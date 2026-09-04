import { resolveContainerId, resolveHumanAgentId } from './portalIdentity'

/** Auto-bind the just-provisioned project's code source right after a successful provision.
 *  Fixes a real user-reported bug: cloning a repo (or picking an existing git folder) left
 *  container.github_repo null, so the Code Space opened blank — nothing told the portal
 *  "this container's code lives in the local git repo it was just set up in".
 *
 *  Feature-detects the endpoint: PUT .../github is a newer portal route. Older/open-CLI
 *  portals reject it (any non-200, most commonly 404) — that's not an error, it's just a
 *  portal that predates this feature, so we swallow it silently. Same treatment for a
 *  missing/unresolvable container or human id: this is a nice-to-have, never something worth
 *  surfacing as a wizard-blocking failure.
 *
 *  Returns true iff the bind actually took (so the Finish step can show a summary line). */
export async function bindCodeSource(apiPort: number, isGitRepo: boolean): Promise<boolean> {
  if (!isGitRepo) return false
  try {
    const cid = await resolveContainerId(apiPort)
    if (!cid) return false
    const humanAgentId = await resolveHumanAgentId(apiPort, cid)
    await window.orchaDesktop.portalPut(apiPort, `/api/containers/${cid}/github`, {
      repo: 'local',
      actor_agent_id: humanAgentId
    })
    return true
  } catch {
    // Non-200 (open-portal stacks rejecting "local"), network hiccup, or a portal that
    // predates the endpoint entirely — all silently skipped, never surfaced to the user.
    return false
  }
}
