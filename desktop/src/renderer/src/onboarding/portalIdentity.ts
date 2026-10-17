/** Shared post-provision identity resolution: the container id and the human actor id for a
 *  just-provisioned stack's portal. Several post-provision steps need both — FleetStep (roster
 *  suggest/accept), the code-source auto-bind (PUT .../github), and the roster analysis
 *  persist call — so this is the one place that owns the GET /api/containers dance instead of
 *  each caller re-deriving it. */

interface ContainerRow {
  id: string
}
interface AgentRow {
  id: string
  kind: string
  alias?: string
}

/** Resolve the container id for a just-provisioned stack: GET /api/containers and take the
 *  newest/only one — there's exactly one container per stack in orcha's model. null on any
 *  failure or an empty roster (never throws; callers treat null as "nothing to bind to"). */
export async function resolveContainerId(apiPort: number): Promise<string | null> {
  try {
    const res = (await window.orchaDesktop.portalGet(apiPort, '/api/containers')) as {
      containers: ContainerRow[]
    }
    return res.containers[0]?.id ?? null
  } catch {
    return null
  }
}

/** Find the human actor id from the container snapshot's agent roster (kind: 'human') — used
 *  to attribute an action (fleet creation, code-source bind) to the person running
 *  onboarding. null on any failure or when no human is registered yet. */
export async function resolveHumanAgentId(apiPort: number, cid: string): Promise<string | null> {
  try {
    const detail = (await window.orchaDesktop.portalGet(apiPort, `/api/containers/${cid}`)) as {
      agents: AgentRow[]
    }
    return detail.agents.find((a) => a.kind === 'human')?.id ?? null
  } catch {
    return null
  }
}

/** The container's current agent aliases (lower-cased), or null when the roster can't be
 *  read. FleetStep uses it to tell which suggestions a failed batch already created. */
export async function fetchAgentAliases(apiPort: number, cid: string): Promise<Set<string> | null> {
  try {
    const detail = (await window.orchaDesktop.portalGet(apiPort, `/api/containers/${cid}`)) as {
      agents: AgentRow[]
    }
    return new Set(detail.agents.map((a) => (a.alias ?? '').toLowerCase()).filter(Boolean))
  } catch {
    return null
  }
}

/** One GET for both the human actor id and the aliases already on the roster. */
export async function resolveRosterIdentity(
  apiPort: number,
  cid: string
): Promise<{ humanAgentId: string | null; aliases: Set<string> }> {
  try {
    const detail = (await window.orchaDesktop.portalGet(apiPort, `/api/containers/${cid}`)) as {
      agents: AgentRow[]
    }
    return {
      humanAgentId: detail.agents.find((a) => a.kind === 'human')?.id ?? null,
      aliases: new Set(detail.agents.map((a) => (a.alias ?? '').toLowerCase()).filter(Boolean))
    }
  } catch {
    return { humanAgentId: null, aliases: new Set() }
  }
}
