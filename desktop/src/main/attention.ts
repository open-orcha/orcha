import type { AttentionItem, Stack } from '../shared/types'

export type FetchJson = (url: string) => Promise<unknown>

export const defaultFetchJson: FetchJson = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) })
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`)
  return res.json()
}

interface AgentRow {
  id: string
  alias: string
  kind: string
  status?: string | null
  /** Snapshot extras — typed loosely and read defensively (older portals omit them). */
  model?: unknown
  current_task?: unknown
}
interface RequestRow {
  id: string
  status: string
  target_id: string | null
  requester_id: string | null
  type?: string | null
  detail?: string | null
  payload?: unknown
}
interface TaskRow { id: string; title: string; status: string }

const TITLE_MAX = 80

function clip(text: string, max = TITLE_MAX): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Live escalation requests carry the human-readable message in `payload` as a
 *  string (multi-paragraph; the first line is the headline) while `detail` is
 *  null — title from the payload first line, else detail/type. */
function requestTitle(r: RequestRow): string {
  if (typeof r.payload === 'string' && r.payload.trim() !== '') {
    return clip(r.payload.trim().split('\n')[0].trim())
  }
  return clip(r.detail || r.type || 'request')
}

/** Pure: which requests/tasks are waiting on a HUMAN right now.
 *  Open request → the target owes an answer (null target = escalated to a human).
 *  Answered request → the requester owes a close.
 *  needs_verification task → a human owes verification (standing working agreement). */
export function computeAttention(
  stack: Stack,
  agents: AgentRow[],
  requests: RequestRow[],
  tasks: TaskRow[]
): AttentionItem[] {
  const humans = new Set(agents.filter((a) => a.kind === 'human').map((a) => a.id))
  const base = { project: stack.project, projectShort: stack.projectShort }
  const items: AttentionItem[] = []
  for (const r of requests) {
    const title = requestTitle(r)
    if (r.status === 'open' && (r.target_id === null || humans.has(r.target_id))) {
      items.push({ ...base, kind: 'request_answer', id: r.id, title, path: `/requests?req=${r.id}` })
    } else if (r.status === 'answered' && r.requester_id !== null && humans.has(r.requester_id)) {
      items.push({ ...base, kind: 'request_close', id: r.id, title, path: `/requests?req=${r.id}` })
    }
  }
  for (const t of tasks) {
    if (t.status === 'needs_verification') {
      items.push({ ...base, kind: 'task_verify', id: t.id, title: clip(t.title), path: `/tasks?task=${t.id}` })
    }
  }
  return items
}

/** One agent as the widgets show it (schema v3 roster entry). */
export interface AgentSummary {
  alias: string
  kind: string
  status: string
  /** Model id minus the noisy 'claude-' prefix ('claude-opus-4-8' → 'opus-4-8'). */
  model: string | null
  /** Current task title (clipped) when the agent is on one. */
  task: string | null
}

/** Everything one running stack contributes to schema v3: the attention items
 *  plus the agent roster and task counts the fetch walk already downloaded. */
export interface StackAttention {
  items: AttentionItem[]
  agents: AgentSummary[]
  tasks: { ready: number; inProgress: number; needsVerification: number }
}

const EMPTY_STACK_ATTENTION: StackAttention = {
  items: [],
  agents: [],
  tasks: { ready: 0, inProgress: 0, needsVerification: 0 }
}

const AGENTS_MAX = 8
const TASK_MAX = 60

/** Defensive reads — the snapshot's model/current_task vary across portal versions. */
function agentModel(row: AgentRow): string | null {
  if (typeof row.model !== 'string' || row.model === '') return null
  return row.model.startsWith('claude-') ? row.model.slice('claude-'.length) : row.model
}

function agentTask(row: AgentRow): string | null {
  const ct = row.current_task
  if (typeof ct !== 'object' || ct === null) return null
  const title = (ct as { title?: unknown }).title
  return typeof title === 'string' ? clip(title, TASK_MAX) : null
}

/** Roster for the widgets: working agents first (then alias), capped at 8 so
 *  one busy stack can't blow the status file up. Missing status = idle. */
function summarizeAgents(rows: AgentRow[]): AgentSummary[] {
  return rows
    .map((a) => ({
      alias: a.alias,
      kind: a.kind,
      status: a.status ?? 'idle',
      model: agentModel(a),
      task: agentTask(a)
    }))
    .sort(
      (a, b) =>
        Number(b.status === 'working') - Number(a.status === 'working') ||
        a.alias.localeCompare(b.alias)
    )
    .slice(0, AGENTS_MAX)
}

function countTasks(rows: TaskRow[]): StackAttention['tasks'] {
  return {
    ready: rows.filter((t) => t.status === 'ready').length,
    inProgress: rows.filter((t) => t.status === 'in_progress').length,
    needsVerification: rows.filter((t) => t.status === 'needs_verification').length
  }
}

/** Fetch + compute one running stack's attention items, agent roster and task
 *  counts (containers → detail → requests → tasks, all existing portal
 *  endpoints — consume-only). */
export async function fetchStackAttention(
  stack: Stack,
  fetchJson: FetchJson = defaultFetchJson
): Promise<StackAttention> {
  if (!stack.running || stack.apiPort === null) return EMPTY_STACK_ATTENTION
  const base = `http://localhost:${stack.apiPort}`
  const containers = (await fetchJson(`${base}/api/containers`)) as {
    containers: Array<{ id: string }>
  }
  const cid = containers.containers[0]?.id
  if (!cid) return EMPTY_STACK_ATTENTION
  const detail = (await fetchJson(`${base}/api/containers/${cid}`)) as { agents: AgentRow[] }
  const reqs = (await fetchJson(`${base}/api/containers/${cid}/requests?limit=100`)) as {
    requests: RequestRow[]
  }
  const tasks = (await fetchJson(`${base}/api/containers/${cid}/tasks?limit=100`)) as {
    tasks: TaskRow[]
  }
  return {
    items: computeAttention(stack, detail.agents, reqs.requests, tasks.tasks),
    agents: summarizeAgents(detail.agents),
    tasks: countTasks(tasks.tasks)
  }
}
