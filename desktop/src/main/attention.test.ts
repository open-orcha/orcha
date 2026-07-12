import { describe, it, expect, vi } from 'vitest'
import { computeAttention, fetchStackAttention, type StackAttention } from './attention'
import type { Stack } from '../shared/types'

const stack: Stack = {
  project: 'orcha-quantal-ehr',
  projectShort: 'quantal-ehr',
  apiPort: 8001,
  dbPort: 5435,
  portalStatus: 'Up 4 hours',
  running: true,
  folder: null
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
        project: 'orcha-quantal-ehr',
        projectShort: 'quantal-ehr',
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
        project: 'orcha-quantal-ehr',
        projectShort: 'quantal-ehr',
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

const walkFetch = (agents: unknown[] = DETAIL_AGENTS) =>
  vi.fn(async (url: string) => {
    if (url.endsWith('/api/containers')) return { containers: [{ id: 'cid-1' }] }
    if (url.endsWith('/api/containers/cid-1')) return { agents }
    if (url.includes('/requests')) return {
      requests: [{ id: 'r1', status: 'open', target_id: 'human-1', requester_id: 'ai-1', type: 'info', detail: 'Hi' }]
    }
    if (url.includes('/tasks')) return {
      tasks: [
        { id: 't1', title: 'Verify me', status: 'needs_verification' },
        { id: 't2', title: 'WIP one', status: 'in_progress' },
        { id: 't3', title: 'WIP two', status: 'in_progress' },
        { id: 't4', title: 'Done', status: 'done' },
        { id: 't5', title: 'Queued', status: 'ready' }
      ]
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

  it('walks containers -> detail -> requests -> tasks and computes items', async () => {
    const fetchJson = walkFetch()
    const result = await fetchStackAttention(stack, fetchJson)
    expect(result.items.map((i) => i.id).sort()).toEqual(['r1', 't1'])
    expect(fetchJson).toHaveBeenCalledWith('http://localhost:8001/api/containers')
    expect(fetchJson).toHaveBeenCalledWith('http://localhost:8001/api/containers/cid-1/requests?limit=100')
    expect(fetchJson).toHaveBeenCalledWith('http://localhost:8001/api/containers/cid-1/tasks?limit=100')
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
