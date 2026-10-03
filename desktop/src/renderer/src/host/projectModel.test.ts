import { describe, it, expect } from 'vitest'
import {
  bandOf,
  buildProjectRows,
  stackBand,
  firstDecision,
  sectionForPath,
  staleLabel,
  totalAttention,
  type ActiveContext
} from './projectModel'
import type { AttentionSnapshot, ProjectContainer, Stack } from '../../../shared/types'

const stack = (project: string, running = true): Stack => ({
  project,
  projectShort: project.replace(/^orcha-/, ''),
  apiPort: running ? 8000 : null,
  dbPort: null,
  portalStatus: running ? 'Up' : 'Exited',
  running,
  folder: null
})
const container = (id: string, name = id): ProjectContainer => ({
  id,
  name,
  description: null,
  status: 'active',
  github_repo: null,
  agents: 1,
  tasks: 1,
  needs_you: 0,
  member_count: 1
})
const noActive: ActiveContext = { project: null, cid: null, portalAttention: null }

const A = stack('orcha-a')
const B = stack('orcha-b')
const S = stack('orcha-stopped', false)
const cards = [
  { stack: A, container: container('a1', 'Alpha') },
  { stack: A, container: container('a2', 'Alpha Two') },
  { stack: B, container: container('b1', 'Beta') }
]
const attention: AttentionSnapshot = {
  items: [],
  projects: [
    {
      project: 'orcha-a',
      containers: [{ cid: 'a1', name: 'Alpha', count: 2, partial: false }],
      unavailable: ['a2'],
      fetchedAt: '2026-09-28T10:00:00Z',
      ok: true
    },
    { project: 'orcha-b', containers: [], unavailable: [], fetchedAt: null, ok: false }
  ]
}

describe('buildProjectRows', () => {
  it('one row per container, one row per stopped stack; unknown/unavailable is null, never 0', () => {
    const rows = buildProjectRows({ stacks: [A, B, S], cards, attention, pinned: new Set(), order: [], active: noActive })
    expect(rows.map((r) => [r.key, r.name, r.state, r.attention])).toEqual([
      ['orcha-a:a1', 'Alpha', 'running', 2],
      ['orcha-a:a2', 'Alpha Two', 'running', null],
      ['orcha-b:b1', 'Beta', 'running', null],
      ['orcha-stopped', 'stopped', 'stopped', null]
    ])
    expect(rows[1].unavailableReason).toMatch(/unavailable/)
    expect(rows[2].unavailableReason).toMatch(/unavailable/)
    expect(rows[3].unavailableReason).toBe('stopped')
  })

  it('a running stack with no container list yet is a single "starting" row', () => {
    const rows = buildProjectRows({ stacks: [A], cards: [], attention: null, pinned: new Set(), order: [], active: noActive })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ key: 'orcha-a', state: 'starting', attention: null, unavailableReason: 'not checked yet' })
  })

  it('pinned first, then local order, then discovery order', () => {
    const rows = buildProjectRows({
      stacks: [A, B],
      cards,
      attention,
      pinned: new Set(['b1']),
      order: ['orcha-a:a2', 'orcha-a:a1'],
      active: noActive
    })
    expect(rows.map((r) => r.key)).toEqual(['orcha-b:b1', 'orcha-a:a2', 'orcha-a:a1'])
  })

  it('uses the V2 portal live count for the open project only, matched by cid', () => {
    const active: ActiveContext = { project: 'orcha-a', cid: 'a1', portalAttention: { cid: 'a1', count: 5, partial: true } }
    const rows = buildProjectRows({ stacks: [A], cards, attention, pinned: new Set(), order: [], active })
    expect(rows[0]).toMatchObject({ attention: 5, partial: true, attentionSource: 'portal' })
    expect(rows[1]).toMatchObject({ attention: null, attentionSource: 'none' })
  })

  it('ignores a null (unknown) portal count and keeps the host number', () => {
    const active: ActiveContext = { project: 'orcha-a', cid: 'a1', portalAttention: { cid: 'a1', count: null, partial: false } }
    const rows = buildProjectRows({ stacks: [A], cards, attention, pinned: new Set(), order: [], active })
    expect(rows[0]).toMatchObject({ attention: 2, attentionSource: 'host' })
  })
})

describe('totalAttention', () => {
  it('sums known counts, reports unknown projects separately (not as partial), skips stopped', () => {
    const rows = buildProjectRows({ stacks: [A, B, S], cards, attention, pinned: new Set(), order: [], active: noActive })
    expect(totalAttention(rows)).toEqual({ count: 2, partial: false, unknown: 2 })
  })
  it('is null (not 0) when nothing is known yet', () => {
    const rows = buildProjectRows({ stacks: [A], cards: [], attention: null, pinned: new Set(), order: [], active: noActive })
    expect(totalAttention(rows).count).toBeNull()
  })
})

describe('helpers', () => {
  it('firstDecision skips follow-ups', () => {
    const base = { project: 'orcha-a', projectShort: 'a', title: 't', path: '/' }
    expect(
      firstDecision([
        { ...base, kind: 'request_close', id: 'f' },
        { ...base, kind: 'task_verify', id: 'v' }
      ])?.id
    ).toBe('v')
    expect(firstDecision([{ ...base, kind: 'request_close', id: 'f' }])).toBeNull()
  })

  it('sectionForPath maps portal paths to sidebar sections', () => {
    expect(sectionForPath('/')).toBe('overview')
    expect(sectionForPath('/tasks')).toBe('tasks')
    expect(sectionForPath('/agents')).toBe('agents')
    expect(sectionForPath('/needs')).toBe('needs')
    expect(sectionForPath('/members')).toBe('settings')
    expect(sectionForPath('/onboarding')).toBeNull()
    expect(sectionForPath(null)).toBeNull()
  })

  it('staleLabel only speaks up after 2 minutes', () => {
    const now = Date.parse('2026-09-28T10:10:00Z')
    expect(staleLabel('2026-09-28T10:09:00Z', now)).toBeNull()
    expect(staleLabel('2026-09-28T10:05:00Z', now)).toBe('updated 5m ago')
    expect(staleLabel('2026-09-28T07:10:00Z', now)).toBe('updated 3h ago')
    expect(staleLabel(null, now)).toBeNull()
    expect(staleLabel('garbage', now)).toBeNull()
  })
})

describe('live agents per project row (D11)', () => {
  const lead = { alias: 'lead', state: 'working' as const, task: 'Fix race', lastActive: null }
  const snap = (over: Partial<AttentionSnapshot['projects'][number]> = {}): AttentionSnapshot => ({
    items: [],
    projects: [
      {
        project: 'orcha-a',
        containers: [
          { cid: 'a1', name: 'Alpha', count: 0, partial: false, live: [lead], liveTotal: 4 },
          { cid: 'a2', name: 'Alpha Two', count: 0, partial: false, live: [], liveTotal: 0 }
        ],
        unavailable: [],
        fetchedAt: '2026-09-28T10:00:00Z',
        ok: true,
        ...over
      }
    ]
  })
  const build = (attention: AttentionSnapshot | null, stacks = [A, B, S]) =>
    buildProjectRows({ stacks, cards, attention, pinned: new Set(), order: [], active: noActive })

  it('carries the host-polled live agents and their total onto the container row', () => {
    const rows = build(snap())
    const a1 = rows.find((r) => r.key === 'orcha-a:a1')
    expect(a1?.live).toEqual([lead])
    expect(a1?.liveTotal).toBe(4)
    expect(rows.find((r) => r.key === 'orcha-a:a2')?.live).toEqual([])
  })

  it('unknown / unreachable / stopped → null (render nothing, never stale or fake agents)', () => {
    expect(build(null).every((r) => r.live === null)).toBe(true)
    expect(build(snap({ ok: false })).find((r) => r.key === 'orcha-a:a1')?.live).toBeNull()
    expect(build(snap({ unavailable: ['a1'] })).find((r) => r.key === 'orcha-a:a1')?.live).toBeNull()
    expect(build(snap()).find((r) => r.key === 'orcha-stopped')?.live).toBeNull()
    // B has no poll entry at all
    expect(build(snap()).find((r) => r.key === 'orcha-b:b1')?.live).toBeNull()
  })

  it('an older host snapshot without `live` reads as unknown', () => {
    const old: AttentionSnapshot = {
      items: [],
      projects: [{ project: 'orcha-a', containers: [{ cid: 'a1', name: 'Alpha', count: 0, partial: false }], unavailable: [], fetchedAt: null, ok: true }]
    }
    expect(build(old).find((r) => r.key === 'orcha-a:a1')?.live).toBeNull()
  })
})

describe('bandOf / stackBand (shared by the manager and the tray)', () => {
  it('bands a row: stopped, starting, paused (container word), running', () => {
    expect(bandOf({ state: 'stopped', containerStatus: null })).toBe('stopped')
    expect(bandOf({ state: 'starting', containerStatus: null })).toBe('starting')
    expect(bandOf({ state: 'running', containerStatus: 'paused' })).toBe('paused')
    expect(bandOf({ state: 'running', containerStatus: null })).toBe('running')
  })

  it('a stack is running if any project runs, else starting, else paused (own word), else stopped', () => {
    expect(stackBand([{ state: 'running', containerStatus: 'paused' }, { state: 'running', containerStatus: null }])).toEqual({ band: 'running', word: 'running' })
    expect(stackBand([{ state: 'starting', containerStatus: null }])).toEqual({ band: 'starting', word: 'starting…' })
    expect(stackBand([{ state: 'running', containerStatus: 'archived' }])).toEqual({ band: 'paused', word: 'archived' })
    expect(stackBand([{ state: 'running', containerStatus: 'archived' }, { state: 'running', containerStatus: 'paused' }])).toEqual({ band: 'paused', word: 'inactive' })
    expect(stackBand([{ state: 'stopped', containerStatus: null }])).toEqual({ band: 'stopped', word: 'stopped' })
  })
})
