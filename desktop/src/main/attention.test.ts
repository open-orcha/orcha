import { describe, it, expect, vi } from 'vitest'
import { computeAttention, liveAgentsOf, liveTaskIds, fetchStackAttention, type StackAttention } from './attention'
import { isDecisionItem, type AttentionItem, type Stack } from '../shared/types'
import { assignPalette } from '../shared/palette'

const stack: Stack = {
  project: 'orcha-acme-ehr',
  projectShort: 'acme-ehr',
  apiPort: 8001,
  dbPort: 5435,
  portalStatus: 'Up 4 hours',
  running: true,
  folder: null,
  runtime: 'docker',
  health: 'ok'
}

// Shapes captured from the live portal API.
const AGENTS = [
  { id: 'human-1', alias: 'husseinmohamed', kind: 'human' },
  { id: 'ai-1', alias: 'Atlas', kind: 'ai' }
]

describe('computeAttention', () => {
  it('flags open requests targeting a human as request_answer, titled by the payload first line', () => {
    const items = computeAttention(stack, AGENTS, [
      {
        id: 'r1', status: 'open', target_id: 'human-1', requester_id: 'ai-1', type: 'info', detail: null,
        payload: '[Atlas → operator] Need a decision on PR #90.\n\nLong body here…'
      }
    ], [])
    expect(items).toEqual([
      {
        project: 'orcha-acme-ehr',
        projectShort: 'acme-ehr',
        kind: 'request_answer',
        id: 'r1',
        title: '[Atlas → operator] Need a decision on PR #90.',
        path: '/requests?req=r1'
      }
    ])
  })

  it('flags escalated requests (null target) as request_answer', () => {
    const items = computeAttention(stack, AGENTS, [
      { id: 'r2', status: 'open', target_id: null, requester_id: 'ai-1', type: 'approval', detail: null }
    ], [])
    expect(items.map((i) => i.kind)).toEqual(['request_answer'])
    expect(items[0].title).toBe('approval')   // falls back to type when detail is null
  })

  it('falls back to detail/type when the payload is not a string', () => {
    const items = computeAttention(stack, AGENTS, [
      { id: 'r8', status: 'open', target_id: 'human-1', requester_id: 'ai-1', type: 'info', detail: 'Need a decision', payload: { foo: 1 } }
    ], [])
    expect(items[0].title).toBe('Need a decision')
  })

  it('ignores open requests targeting an AI', () => {
    expect(computeAttention(stack, AGENTS, [
      { id: 'r3', status: 'open', target_id: 'ai-1', requester_id: 'human-1', type: 'info', detail: 'x' }
    ], [])).toEqual([])
  })

  it('flags answered requests raised by a human as request_close', () => {
    const items = computeAttention(stack, AGENTS, [
      { id: 'r4', status: 'answered', target_id: 'ai-1', requester_id: 'human-1', type: 'info', detail: 'My question' }
    ], [])
    expect(items.map((i) => i.kind)).toEqual(['request_close'])
  })

  it('ignores answered requests raised by an AI, and closed requests entirely', () => {
    expect(computeAttention(stack, AGENTS, [
      { id: 'r5', status: 'answered', target_id: 'human-1', requester_id: 'ai-1', type: 'info', detail: 'x' },
      { id: 'r6', status: 'closed', target_id: 'human-1', requester_id: 'human-1', type: 'info', detail: 'x' }
    ], [])).toEqual([])
  })

  it('flags needs_verification tasks and ignores other statuses', () => {
    const items = computeAttention(stack, AGENTS, [], [
      { id: 't1', title: 'Ship the feature', status: 'needs_verification' },
      { id: 't2', title: 'WIP', status: 'in_progress' },
      { id: 't3', title: 'Ready', status: 'ready' }
    ])
    expect(items).toEqual([
      {
        project: 'orcha-acme-ehr',
        projectShort: 'acme-ehr',
        kind: 'task_verify',
        id: 't1',
        title: 'Ship the feature',
        path: '/tasks?task=t1'
      }
    ])
  })

  it('truncates long titles to 80 chars', () => {
    const items = computeAttention(stack, AGENTS, [
      { id: 'r7', status: 'open', target_id: 'human-1', requester_id: 'ai-1', type: 'info', detail: 'x'.repeat(200) }
    ], [])
    expect(items[0].title.length).toBeLessThanOrEqual(80)
  })
})

const EMPTY: StackAttention = {
  items: [],
  agents: [],
  tasks: { ready: 0, inProgress: 0, needsVerification: 0 }
}

/** Detail rows as the portal returns them: alias/kind/status on each agent row,
 *  plus model + current_task on the richer snapshot rows. Atlas (idle) sorts
 *  before Plum alphabetically — Plum is working, so the roster must put Plum
 *  first. human-1 has no status/model/current_task -> idle, null, null. */
const DETAIL_AGENTS = [
  { id: 'ai-1', alias: 'Atlas', kind: 'ai', status: 'idle', model: 'claude-opus-4-8', current_task: null },
  {
    id: 'ai-2',
    alias: 'Plum',
    kind: 'ai',
    status: 'working',
    model: 'claude-sonnet-5',
    current_task: { id: 't9', title: 'Wire the widget bridge' }
  },
  { id: 'human-1', alias: 'husseinmohamed', kind: 'human' }
]

const SNAP_REQUESTS = [{ id: 'r1', status: 'open', target_id: 'human-1', requester_id: 'ai-1', type: 'info', detail: 'Hi' }]
const SNAP_TASKS = [
  { id: 't1', title: 'Verify me', status: 'needs_verification' },
  { id: 't2', title: 'WIP one', status: 'in_progress' },
  { id: 't3', title: 'WIP two', status: 'in_progress' },
  { id: 't4', title: 'Done', status: 'done' },
  { id: 't5', title: 'Queued', status: 'ready' }
]
const SNAP_QS = '?task_limit=200&request_limit=200'

/** Snapshot-walk fake: GET /api/containers → GET /api/containers/{cid}?limits (one call per
 *  container; agents + tasks + requests + autonomy ride the same snapshot response). */
const walkFetch = (agents: unknown[] = DETAIL_AGENTS) =>
  vi.fn(async (url: string) => {
    if (url.endsWith('/api/containers')) return { containers: [{ id: 'cid-1', name: 'EHR' }] }
    if (url.endsWith(`/api/containers/cid-1${SNAP_QS}`))
      return {
        container: { autonomy_level: 'plan' },
        agents,
        tasks: SNAP_TASKS,
        requests: SNAP_REQUESTS,
        task_total: SNAP_TASKS.length,
        request_total: 1
      }
    throw new Error(`unexpected url ${url}`)
  })

describe('fetchStackAttention', () => {
  it('returns an empty summary without fetching when the stack is not running', async () => {
    const fetchJson = vi.fn()
    const stopped: Stack = { ...stack, running: false, apiPort: null }
    expect(await fetchStackAttention(stopped, fetchJson)).toEqual(EMPTY)
    expect(fetchJson).not.toHaveBeenCalled()
  })

  it('walks containers -> one capped snapshot per container and computes cid-scoped items', async () => {
    const fetchJson = walkFetch()
    const result = await fetchStackAttention(stack, fetchJson)
    expect(result.items.map((i) => i.id).sort()).toEqual(['r1', 't1'])
    expect(result.items.every((i) => i.cid === 'cid-1' && i.path.endsWith('&cid=cid-1'))).toBe(true)
    expect(fetchJson).toHaveBeenCalledWith('http://localhost:8001/api/containers')
    expect(fetchJson).toHaveBeenCalledWith(`http://localhost:8001/api/containers/cid-1${SNAP_QS}`)
    expect(fetchJson).toHaveBeenCalledTimes(2)
    expect(result.containers).toEqual([
      { cid: 'cid-1', name: 'EHR', count: 2, partial: false, live: [{ alias: 'Plum', state: 'working', task: 'Wire the widget bridge', lastActive: null, palette: expect.any(Number) }], liveTotal: 1, checkouts: null }
    ])
    expect(result.unavailable).toEqual([])
  })

  it('walks every container of a multi-project stack; roster/task counts stay on the founding one', async () => {
    const fetchJson = vi.fn(async (url: string) => {
      if (url.endsWith('/api/containers')) return { containers: [{ id: 'c1', name: 'One' }, { id: 'c2', name: 'Two' }] }
      if (url.includes('/api/containers/c1?'))
        return { container: { autonomy_level: 'plan' }, agents: DETAIL_AGENTS, tasks: SNAP_TASKS, requests: [] }
      if (url.includes('/api/containers/c2?'))
        return {
          container: { autonomy_level: 'plan' },
          agents: [],
          tasks: [{ id: 'x1', title: 'Other verify', status: 'needs_verification' }],
          requests: [],
          task_total: 500
        }
      throw new Error(url)
    })
    const result = await fetchStackAttention(stack, fetchJson)
    expect(result.items.map((i) => `${i.cid}:${i.id}`)).toEqual(['c1:t1', 'c2:x1'])
    expect(result.items[1].path).toBe('/tasks?task=x1&cid=c2')
    expect(result.containers).toEqual([
      { cid: 'c1', name: 'One', count: 1, partial: false, live: [{ alias: 'Plum', state: 'working', task: 'Wire the widget bridge', lastActive: null, palette: expect.any(Number) }], liveTotal: 1, checkouts: null },
      { cid: 'c2', name: 'Two', count: 1, partial: true, live: [], liveTotal: 0, checkouts: null }
    ])
    expect(result.tasks).toEqual({ ready: 1, inProgress: 2, needsVerification: 1 })
  })

  it('reports a failing secondary container as unavailable instead of zero', async () => {
    const fetchJson = vi.fn(async (url: string) => {
      if (url.endsWith('/api/containers')) return { containers: [{ id: 'c1' }, { id: 'c2' }] }
      if (url.includes('/api/containers/c1?')) return { agents: [], tasks: [], requests: [] }
      throw new Error('503')
    })
    const result = await fetchStackAttention(stack, fetchJson)
    expect(result.unavailable).toEqual(['c2'])
    expect(result.containers?.map((c) => c.cid)).toEqual(['c1'])
  })

  it('fails the whole stack when the founding container cannot be fetched (poller keeps it unavailable)', async () => {
    const fetchJson = vi.fn(async (url: string) => {
      if (url.endsWith('/api/containers')) return { containers: [{ id: 'c1' }] }
      throw new Error('boom')
    })
    await expect(fetchStackAttention(stack, fetchJson)).rejects.toThrow('boom')
  })

  it('summarizes agents working-first then alias, with model (claude- prefix stripped) and current task title', async () => {
    const result = await fetchStackAttention(stack, walkFetch())
    expect(result.agents).toEqual([
      { alias: 'Plum', kind: 'ai', status: 'working', model: 'sonnet-5', task: 'Wire the widget bridge' },
      { alias: 'Atlas', kind: 'ai', status: 'idle', model: 'opus-4-8', task: null },
      { alias: 'husseinmohamed', kind: 'human', status: 'idle', model: null, task: null }
    ])
  })

  it('keeps non-claude model names verbatim and clips long task titles to 60 chars', async () => {
    const result = await fetchStackAttention(
      stack,
      walkFetch([
        {
          id: 'ai-1',
          alias: 'Gem',
          kind: 'ai',
          status: 'working',
          model: 'gemini-3-pro',
          current_task: { id: 't1', title: 'x'.repeat(100) }
        }
      ])
    )
    expect(result.agents[0].model).toBe('gemini-3-pro')
    expect(result.agents[0].task).toBe(`${'x'.repeat(59)}…`)
    expect(result.agents[0].task).toHaveLength(60)
  })

  it('nulls model/task defensively for non-string models and malformed current_task shapes', async () => {
    const result = await fetchStackAttention(
      stack,
      walkFetch([
        { id: 'a', alias: 'a', kind: 'ai', status: 'idle', model: 42, current_task: { title: 17 } },
        { id: 'b', alias: 'b', kind: 'ai', status: 'idle', model: null, current_task: 'not-an-object' },
        { id: 'c', alias: 'c', kind: 'ai', status: 'awaiting_request' }
      ])
    )
    expect(result.agents).toEqual([
      { alias: 'a', kind: 'ai', status: 'idle', model: null, task: null },
      { alias: 'b', kind: 'ai', status: 'idle', model: null, task: null },
      { alias: 'c', kind: 'ai', status: 'awaiting_request', model: null, task: null }
    ])
  })

  it('caps the agent roster at 8, keeping working agents (sorted first) in the cut', async () => {
    const many = [
      // 9 idle agents that all sort before 'zoe' alphabetically…
      ...Array.from({ length: 9 }, (_, n) => ({ id: `ai-${n}`, alias: `agent-${n}`, kind: 'ai', status: 'idle' })),
      // …plus a working agent listed last: must survive the cap, in first place.
      { id: 'ai-z', alias: 'zoe', kind: 'ai', status: 'working' }
    ]
    const result = await fetchStackAttention(stack, walkFetch(many))
    expect(result.agents).toHaveLength(8)
    expect(result.agents[0]).toEqual({ alias: 'zoe', kind: 'ai', status: 'working', model: null, task: null })
    expect(result.agents.slice(1).map((a) => a.alias)).toEqual(
      Array.from({ length: 7 }, (_, n) => `agent-${n}`)
    )
  })

  it('counts ready, in_progress and needs_verification tasks', async () => {
    const result = await fetchStackAttention(stack, walkFetch())
    expect(result.tasks).toEqual({ ready: 1, inProgress: 2, needsVerification: 1 })
  })

  it('returns an empty summary when the stack has no container yet', async () => {
    const fetchJson = vi.fn(async () => ({ containers: [] }))
    expect(await fetchStackAttention(stack, fetchJson)).toEqual(EMPTY)
  })
})

describe('computeAttention — canonical V2 kinds (arch §3.1)', () => {
  const planned = { id: 'p1', title: 'Plan me', status: 'in_progress', plan_decision: null, plan_message: { body: 'plan' } }

  it('flags a pending plan only at autonomy "plan" (the default when unknown)', () => {
    expect(computeAttention(stack, AGENTS, [], [planned]).map((i) => i.kind)).toEqual(['task_plan'])
    expect(computeAttention(stack, AGENTS, [], [planned], { autonomy: 'plan' }).map((i) => i.kind)).toEqual(['task_plan'])
    expect(computeAttention(stack, AGENTS, [], [planned], { autonomy: 'auto' })).toEqual([])
    expect(computeAttention(stack, AGENTS, [], [planned], { autonomy: 'full' })).toEqual([])
  })

  it('does not flag a plan that already has a decision, or an in-progress task with no plan post', () => {
    expect(
      computeAttention(stack, AGENTS, [], [
        { ...planned, plan_decision: { decision: 'approve' } },
        { id: 'p2', title: 'No plan yet', status: 'in_progress', plan_decision: null, plan_message: null }
      ])
    ).toEqual([])
  })

  it('suppresses verification at autonomy "full" only', () => {
    const t = [{ id: 't1', title: 'Verify', status: 'needs_verification' }]
    expect(computeAttention(stack, AGENTS, [], t, { autonomy: 'full' })).toEqual([])
    expect(computeAttention(stack, AGENTS, [], t, { autonomy: 'auto' }).map((i) => i.kind)).toEqual(['task_verify'])
  })

  it('includes escalated requests (GAP-04) regardless of target', () => {
    const items = computeAttention(stack, AGENTS, [
      { id: 'e1', status: 'escalated', target_id: 'ai-1', requester_id: 'ai-1', type: 'info', detail: 'Escalated' }
    ], [])
    expect(items.map((i) => i.kind)).toEqual(['request_answer'])
  })

  it('orders plans, verifications, requests, then follow-ups and adds cid to every path', () => {
    const items = computeAttention(
      stack,
      AGENTS,
      [
        { id: 'f1', status: 'answered', target_id: 'ai-1', requester_id: 'human-1', type: 'info', detail: 'mine' },
        { id: 'r1', status: 'open', target_id: 'human-1', requester_id: 'ai-1', type: 'info', detail: 'ask' }
      ],
      [{ id: 'v1', title: 'Verify', status: 'needs_verification' }, planned],
      { cid: 'c 1' }
    )
    expect(items.map((i) => i.kind)).toEqual(['task_plan', 'task_verify', 'request_answer', 'request_close'])
    expect(items.map((i) => i.path)).toEqual([
      '/tasks?task=p1&cid=c%201',
      '/tasks?task=v1&cid=c%201',
      '/requests?req=r1&cid=c%201',
      '/requests?req=f1&cid=c%201'
    ])
    expect(items.every((i) => i.cid === 'c 1')).toBe(true)
  })

  it('isDecisionItem counts plans/verifications/requests, never follow-ups or health', () => {
    expect(['task_plan', 'task_verify', 'request_answer', 'request_close', 'health'].map((kind) =>
      isDecisionItem({ kind: kind as AttentionItem['kind'] })
    )).toEqual([true, true, true, false, false])
  })
})

describe('liveAgentsOf (D11: live agents nested under their project)', () => {
  const ai = (alias: string, extra: Record<string, unknown> = {}) => ({ id: alias, alias, kind: 'ai', status: 'idle', ...extra })

  it('lists working, waiting and needs-review agents — never idle, human or terminated ones', () => {
    const { live, total } = liveAgentsOf(
      [
        ai('idle-one'),
        ai('worker', { status: 'working', current_task: { title: 'Fix the scheduler' }, last_active: '2026-09-28T10:00:00Z' }),
        ai('waiter', { status: 'awaiting_request', current_task: { title: 'Migrate billing' } }),
        ai('reviewer-bot'),
        ai('gone', { status: 'terminated' }),
        { id: 'h', alias: 'hussein', kind: 'human', status: 'working' }
      ],
      [
        { id: 't1', title: 'Add dark-mode tokens', status: 'needs_verification', assignees: ['reviewer-bot'] },
        { id: 't2', title: 'Something else', status: 'in_progress', assignees: ['idle-one'] }
      ]
    )
    expect(total).toBe(3)
    expect(live).toEqual([
      { alias: 'reviewer-bot', state: 'needs_review', task: 'Add dark-mode tokens', lastActive: null },
      { alias: 'worker', state: 'working', task: 'Fix the scheduler', lastActive: '2026-09-28T10:00:00Z' },
      { alias: 'waiter', state: 'waiting', task: 'Migrate billing', lastActive: null }
    ])
  })

  it('VD-09: one vocabulary with the portal — awaiting_request is neutral "waiting", a running run (even lease-lapsed) is working', () => {
    const { live } = liveAgentsOf(
      [
        ai('Atlas', { status: 'awaiting_request' }),
        ai('Pixel', { status: 'idle', running_run: { task_id: 't9', task_title: 'Polish icons', lease_live: false } }),
        ai('Scout', { status: 'awaiting_request', active_run: { task_title: 'Crawl docs' } })
      ],
      []
    )
    expect(live.map((l) => [l.alias, l.state, l.task])).toEqual([
      ['Pixel', 'working', 'Polish icons'],
      ['Scout', 'working', 'Crawl docs'],
      ['Atlas', 'waiting', null]
    ])
    expect(live.some((l) => l.state === 'blocked')).toBe(false)
    const ids = liveTaskIds(live, [ai('Pixel', { running_run: { task_id: 't9' } })], [])
    expect(ids.get('Pixel')).toBe('t9')
  })

  it('prefers the live run task title and treats a live run as working even when status reads idle', () => {
    const { live } = liveAgentsOf([ai('runner', { active_run: { task_title: 'Live run task' }, current_task: { title: 'Stale claim' } })], [])
    expect(live).toEqual([{ alias: 'runner', state: 'working', task: 'Live run task', lastActive: null }])
  })

  it('a working agent with a task in review shows as working (its current activity wins)', () => {
    const { live } = liveAgentsOf(
      [ai('busy', { status: 'working', current_task: { title: 'Now' } })],
      [{ id: 't', title: 'Earlier', status: 'needs_verification', assignees: ['busy'] }]
    )
    expect(live[0]).toMatchObject({ state: 'working', task: 'Now' })
  })

  it('caps the list but reports the true total; most recently active first within a state', () => {
    const agents = Array.from({ length: 7 }, (_, i) =>
      ai(`a${i}`, { status: 'working', last_active: `2026-09-28T10:0${i}:00Z` })
    )
    const { live, total } = liveAgentsOf(agents, [], 3)
    expect(total).toBe(7)
    expect(live.map((a) => a.alias)).toEqual(['a6', 'a5', 'a4'])
  })

  it('tolerates older snapshots (no assignees / active_run / last_active)', () => {
    const { live } = liveAgentsOf([ai('x', { status: 'working' })], [{ id: 't', title: 'T', status: 'needs_verification' }])
    expect(live).toEqual([{ alias: 'x', state: 'working', task: null, lastActive: null }])
  })
})

describe('D13 palette parity: live agents carry the portal\'s roster slot', () => {
  it('slots come from ONE assignment over the full snapshot roster (humans + idle included, snapshot order)', async () => {
    // The portal colours an agent by rosterPaletteSlots(snap.agents): the whole roster, in
    // snapshot order — not just the agents the sidebar shows.
    const roster = [
      { id: 'h', alias: 'hussein', kind: 'human', status: 'idle' },
      { id: 'a', alias: 'lead', kind: 'ai', status: 'idle' },
      { id: 'b', alias: 'backend-dev', kind: 'ai', status: 'working' },
      { id: 'c', alias: 'docs-writer', kind: 'ai', status: 'working' },
      { id: 'd', alias: 'reviewer', kind: 'ai', status: 'idle' }
    ]
    const fetchJson = vi.fn(async (url: string) => {
      if (url.endsWith('/api/containers')) return { containers: [{ id: 'c1', name: 'One' }] }
      return { container: { autonomy_level: 'plan' }, agents: roster, tasks: [], requests: [] }
    })
    const result = await fetchStackAttention(stack, fetchJson, async () => null)
    const want = assignPalette(roster.map((a) => a.alias))
    const live = result.containers![0].live
    expect(live.map((a) => a.alias).sort()).toEqual(['backend-dev', 'docs-writer'])
    for (const a of live) expect(a.palette).toBe(want.get(a.alias))
    // a subset-only assignment would differ for at least one agent in general; the roster one
    // is what the portal renders (AVATAR_HUES / FNV-1a / assignPalette are identical).
    expect(new Set(live.map((a) => a.palette)).size).toBe(live.length)
  })
})
