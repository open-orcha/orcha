import { isDecisionItem, type AttentionItem, type HostCheckout, type HostLiveAgent, type HostLiveAgentState, type Stack } from '../shared/types'
import { attributeCheckouts, readWorktrees, type GitWorktree } from './checkouts'
import { rosterPaletteSlots, actorKey } from '../shared/palette'

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
  /** The agent's live worker run (lease-gated), `{ task_title, … }` or null. */
  active_run?: unknown
  /** The snapshot's copy of the agent's RUNNING run (not lease-gated) — the portal's roster
   *  and board read it as Working (presence.ts), so the host sidebar does too (VD-09). */
  running_run?: unknown
  last_active?: unknown
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
interface TaskRow {
  id: string
  title: string
  status: string
  /** Snapshot task rows (V2 attention): latest plan decision + opening agent plan post. */
  plan_decision?: unknown
  plan_message?: unknown
  /** Aliases of the agents assigned to the task (snapshot task rows). */
  assignees?: unknown
}

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

export interface ComputeAttentionOptions {
  /** Container id — appended to every item path as `cid=` (GAP-07). */
  cid?: string | null
  /** Container autonomy level from the snapshot. Unknown/absent is treated as `plan`,
   *  matching the portal's own default (SnapshotProvider.autLevel). */
  autonomy?: string | null
}

function withCid(path: string, cid: string | null | undefined): string {
  return cid ? `${path}&cid=${encodeURIComponent(cid)}` : path
}

/** A plan is pending when the task is in progress, an agent has posted its opening plan
 *  message and no plan decision exists yet — same rule as the portal's `pendingPlan`. */
function isPendingPlan(t: TaskRow): boolean {
  return (
    t.status === 'in_progress' &&
    (t.plan_decision === null || t.plan_decision === undefined) &&
    typeof t.plan_message === 'object' &&
    t.plan_message !== null
  )
}

/** Pure: which requests/tasks are waiting on a HUMAN right now — the canonical V2
 *  definition (docs/orcha-v2-architecture.md §3.1), evaluated per container:
 *  - task_plan:      pending plan, only when autonomy === 'plan';
 *  - task_verify:    needs_verification, unless autonomy === 'full';
 *  - request_answer: open request targeting a human (or untargeted), or any `escalated` request;
 *  - request_close:  FOLLOW-UP — answered request a human raised (listed, never counted).
 *  Order: plans, verifications, requests, then follow-ups. The desktop host has no acting-
 *  human identity, so reviewer-assigned-to-someone-else items are counted (documented). */
export function computeAttention(
  stack: Stack,
  agents: AgentRow[],
  requests: RequestRow[],
  tasks: TaskRow[],
  opts: ComputeAttentionOptions = {}
): AttentionItem[] {
  const humans = new Set(agents.filter((a) => a.kind === 'human').map((a) => a.id))
  const autonomy = opts.autonomy || 'plan'
  const cid = opts.cid ?? null
  const base = { project: stack.project, projectShort: stack.projectShort, ...(cid ? { cid } : {}) }
  const plans: AttentionItem[] = []
  const verifs: AttentionItem[] = []
  const answers: AttentionItem[] = []
  const followUps: AttentionItem[] = []
  for (const t of tasks) {
    const path = withCid(`/tasks?task=${t.id}`, cid)
    if (autonomy === 'plan' && isPendingPlan(t)) {
      plans.push({ ...base, kind: 'task_plan', id: t.id, title: clip(t.title), path })
    } else if (t.status === 'needs_verification' && autonomy !== 'full') {
      verifs.push({ ...base, kind: 'task_verify', id: t.id, title: clip(t.title), path })
    }
  }
  for (const r of requests) {
    const title = requestTitle(r)
    const path = withCid(`/requests?req=${r.id}`, cid)
    const toHuman = r.target_id === null || humans.has(r.target_id)
    if ((r.status === 'open' && toHuman) || r.status === 'escalated') {
      answers.push({ ...base, kind: 'request_answer', id: r.id, title, path })
    } else if (r.status === 'answered' && r.requester_id !== null && humans.has(r.requester_id)) {
      followUps.push({ ...base, kind: 'request_close', id: r.id, title, path })
    }
  }
  return [...plans, ...verifs, ...answers, ...followUps]
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

/** One container's result inside a stack fetch (V2 host sidebar: per-project counts,
 *  with failures kept distinct from zero). */
export interface ContainerAttention {
  cid: string
  name: string
  /** Decision count (plans + verifications + requests; follow-ups excluded). */
  count: number
  /** True when the snapshot was capped below the server total, so the count may be low. */
  partial: boolean
  /** D11: the container's live agents (capped at LIVE_MAX) and their total. */
  live: HostLiveAgent[]
  liveTotal: number
  /** D14: the project's real git checkouts (primary first); null = no branch data. */
  checkouts: HostCheckout[] | null
}

/** Everything one running stack contributes to schema v3: the attention items
 *  plus the agent roster and task counts the fetch walk already downloaded. */
export interface StackAttention {
  items: AttentionItem[]
  agents: AgentSummary[]
  tasks: { ready: number; inProgress: number; needsVerification: number }
  /** V2 (additive): per-container decision counts; absent containers failed to load. */
  containers?: ContainerAttention[]
  /** V2 (additive): container ids listed by the stack whose snapshot failed this tick. */
  unavailable?: string[]
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

/** Live agents per container carried to the host sidebar (it shows ≤ 3 + "N more"). */
export const LIVE_MAX = 5

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function runTaskTitle(row: AgentRow): string | null {
  for (const run of [row.active_run, row.running_run]) {
    const t = isObj(run) ? str(run.task_title) : null
    if (t) return t
  }
  return null
}

const STATE_RANK: Record<HostLiveAgentState, number> = { needs_review: 0, blocked: 1, working: 2, waiting: 3 }

/** Pure (D11): which AI agents of one container are LIVE right now, from its snapshot rows.
 *  - working:      status `working` or a running worker run (`active_run`, or `running_run`
 *                  even with a lapsed lease — same rule as the portal's presence.ts); a run
 *                  wins over an `awaiting_request` status;
 *  - waiting:      status `awaiting_request` (an open outgoing request) — neutral, the
 *                  portal's "Waiting" (VD-09: one vocabulary; not red "blocked");
 *  - needs_review: otherwise, the agent is assigned a task at `needs_verification`.
 *  Idle agents, humans and terminated agents are never listed. Order: needs review, working,
 *  waiting, then most recently active, then alias. Returns the capped list and the total. */
export function liveAgentsOf(
  agents: AgentRow[],
  tasks: TaskRow[],
  max = LIVE_MAX
): { live: HostLiveAgent[]; total: number } {
  const review = new Map<string, string>()
  for (const t of tasks) {
    if (t.status !== 'needs_verification' || !Array.isArray(t.assignees)) continue
    for (const a of t.assignees) if (typeof a === 'string' && !review.has(a)) review.set(a, t.title)
  }
  const out: HostLiveAgent[] = []
  for (const a of agents) {
    if (a.kind === 'human' || a.status === 'terminated' || typeof a.alias !== 'string') continue
    const task = runTaskTitle(a) ?? agentTask(a)
    let state: HostLiveAgentState | null = null
    let shown: string | null = task
    if (a.status === 'working' || isObj(a.active_run) || isObj(a.running_run)) state = 'working'
    else if (a.status === 'awaiting_request') state = 'waiting'
    else if (review.has(a.alias)) {
      state = 'needs_review'
      shown = review.get(a.alias) ?? null
    }
    if (state === null) continue
    out.push({ alias: a.alias, state, task: shown === null ? null : clip(shown, TASK_MAX), lastActive: str(a.last_active) })
  }
  const time = (x: HostLiveAgent): number => {
    const n = x.lastActive ? Date.parse(x.lastActive) : NaN
    return Number.isFinite(n) ? n : 0
  }
  out.sort((x, y) => STATE_RANK[x.state] - STATE_RANK[y.state] || time(y) - time(x) || x.alias.localeCompare(y.alias))
  return { live: out.slice(0, max), total: out.length }
}

function taskIdOf(v: unknown): string | null {
  if (typeof v !== 'object' || v === null) return null
  return str((v as { task_id?: unknown }).task_id)
}

/** Pure (D14): the task id each live agent is on, as the snapshot reports it — the task under
 *  review for a needs-review agent, else the live run's task, else the claimed current task.
 *  Agents with no task id are absent (their branch can't be known). */
export function liveTaskIds(live: HostLiveAgent[], agents: AgentRow[], tasks: TaskRow[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const l of live) {
    let id: string | null = null
    if (l.state === 'needs_review') {
      const t = tasks.find(
        (x) => x.status === 'needs_verification' && Array.isArray(x.assignees) && x.assignees.includes(l.alias)
      )
      id = t ? t.id : null
    } else {
      const row = agents.find((a) => a.alias === l.alias)
      id = row ? (taskIdOf(row.active_run) ?? taskIdOf(row.running_run) ?? taskIdOf(row.current_task)) : null
    }
    if (id) out.set(l.alias, id)
  }
  return out
}

function countTasks(rows: TaskRow[]): StackAttention['tasks'] {
  return {
    ready: rows.filter((t) => t.status === 'ready').length,
    inProgress: rows.filter((t) => t.status === 'in_progress').length,
    needsVerification: rows.filter((t) => t.status === 'needs_verification').length
  }
}

/** Snapshot rows per container. Tasks come back needs_verification → in_progress → rest
 *  and requests open → answered → rest, so the capped window keeps every attention
 *  candidate unless a project has hundreds of them (then `partial` is set). */
const SNAPSHOT_LIMIT = 200
/** Upper bound on containers polled per stack per tick (a stack normally has 1–3). */
const CONTAINERS_MAX = 25

interface ContainerListRow {
  id: string
  name?: unknown
}
interface SnapshotResponse {
  container?: { autonomy_level?: unknown; github_repo?: unknown; worktrees_disabled?: unknown } | null
  agents?: AgentRow[]
  tasks?: TaskRow[]
  requests?: RequestRow[]
  task_total?: unknown
  request_total?: unknown
}

/** Fetch + compute one running stack's attention items, agent roster and task counts.
 *  Walks EVERY container in the stack (a stack can hold several projects since mig 037) via
 *  the existing, member-read snapshot endpoint — consume-only, no new backend surface:
 *    GET /api/containers → GET /api/containers/{cid}?task_limit=200&request_limit=200
 *  Items carry `cid` in their path (GAP-07). The widget roster + task counts stay scoped to
 *  the founding container (index 0), exactly as before, so status.json v3 keeps its meaning.
 *  A failing founding container fails the stack (as before); a failing secondary container
 *  is reported in `unavailable` instead of silently counting as zero. */
export async function fetchStackAttention(
  stack: Stack,
  fetchJson: FetchJson = defaultFetchJson,
  readTrees: (folder: string | null) => Promise<GitWorktree[] | null> = readWorktrees
): Promise<StackAttention> {
  if (!stack.running || stack.apiPort === null) return EMPTY_STACK_ATTENTION
  const base = `http://localhost:${stack.apiPort}`
  const list = (await fetchJson(`${base}/api/containers`)) as { containers?: ContainerListRow[] }
  const containers = (Array.isArray(list.containers) ? list.containers : []).slice(0, CONTAINERS_MAX)
  if (containers.length === 0) return EMPTY_STACK_ATTENTION

  const items: AttentionItem[] = []
  const perContainer: ContainerAttention[] = []
  const unavailable: string[] = []
  let founding: { agents: AgentRow[]; tasks: TaskRow[] } | null = null
  // D14: the stack folder's checkouts, read once per tick (host git, read-only, never throws).
  const worktrees = await readTrees(stack.folder)

  for (const [index, c] of containers.entries()) {
    const cid = c.id
    let snap: SnapshotResponse
    try {
      snap = (await fetchJson(
        `${base}/api/containers/${encodeURIComponent(cid)}?task_limit=${SNAPSHOT_LIMIT}&request_limit=${SNAPSHOT_LIMIT}`
      )) as SnapshotResponse
    } catch (err) {
      if (index === 0) throw err
      unavailable.push(cid)
      continue
    }
    const agents = Array.isArray(snap.agents) ? snap.agents : []
    const tasks = Array.isArray(snap.tasks) ? snap.tasks : []
    const requests = Array.isArray(snap.requests) ? snap.requests : []
    const autonomy = typeof snap.container?.autonomy_level === 'string' ? snap.container.autonomy_level : null
    const found = computeAttention(stack, agents, requests, tasks, { cid, autonomy })
    items.push(...found)
    const partial =
      (typeof snap.task_total === 'number' && snap.task_total > tasks.length) ||
      (typeof snap.request_total === 'number' && snap.request_total > requests.length)
    const liveFound = liveAgentsOf(agents, tasks)
    const { checkouts, live } = attributeCheckouts({
      worktrees,
      folder: stack.folder,
      githubRepo: typeof snap.container?.github_repo === 'string' ? snap.container.github_repo : null,
      worktreesDisabled: snap.container?.worktrees_disabled === true,
      live: liveFound.live,
      taskIds: liveTaskIds(liveFound.live, agents, tasks)
    })
    const liveTotal = liveFound.total
    // D13 parity: the portal colours an agent by ONE assignment over the project's full
    // roster (snapshot order) — carry that slot so the sidebar shows the same colour.
    const slots = rosterPaletteSlots(agents)
    perContainer.push({
      cid,
      name: typeof c.name === 'string' ? c.name : stack.projectShort,
      count: found.filter(isDecisionItem).length,
      partial,
      live: live.map((a) => ({ ...a, palette: slots.get(actorKey(a.alias)) ?? null })),
      liveTotal,
      checkouts
    })
    if (index === 0) founding = { agents, tasks }
  }

  return {
    items,
    agents: summarizeAgents(founding?.agents ?? []),
    tasks: countTasks(founding?.tasks ?? []),
    containers: perContainer,
    unavailable
  }
}
