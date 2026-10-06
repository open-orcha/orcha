import { describe, it, expect } from 'vitest'
import { buildProjectTree, shortAgo } from './projectTree'
import type { HostCheckout, HostLiveAgent } from '../../../shared/types'

const a = (alias: string, branch: string | null = null): HostLiveAgent => ({ alias, state: 'working', task: 'T', lastActive: null, branch })
const main: HostCheckout = { branch: 'main', primary: true, detached: false, repo: 'acme/web' }
const wt = (branch: string): HostCheckout => ({ branch, primary: false, detached: false, repo: 'acme/web' })

describe('buildProjectTree (D14)', () => {
  it('no branch data: agents directly under the project, capped at 3 with +N more (D11)', () => {
    const t = buildProjectTree({ live: [a('a'), a('b'), a('c'), a('d')], liveTotal: 6, checkouts: null })
    expect(t.checkouts).toEqual([])
    expect(t.loose.map((x) => x.alias)).toEqual(['a', 'b', 'c'])
    expect(t.more).toBe(3)
    expect(t.hasChildren).toBe(true)
  })

  it('nothing live and no branch data → no children (no caret)', () => {
    expect(buildProjectTree({ live: [], liveTotal: 0, checkouts: null }).hasChildren).toBe(false)
    expect(buildProjectTree({ live: null, liveTotal: 0, checkouts: null }).hasChildren).toBe(false)
  })

  it('branch data: primary first, agents under the branch they work on, unknown-branch agents loose', () => {
    const t = buildProjectTree({
      live: [a('lead', 'orcha/task-lead-1'), a('qa', 'main'), a('docs', null)],
      liveTotal: 3,
      checkouts: [wt('orcha/task-lead-1'), main]
    })
    expect(t.checkouts.map((c) => [c.checkout.branch, c.agents.map((x) => x.alias)])).toEqual([
      ['main', ['qa']],
      ['orcha/task-lead-1', ['lead']]
    ])
    expect(t.loose.map((x) => x.alias)).toEqual(['docs'])
    expect(t.more).toBe(0)
  })

  it('the primary checkout alone is a child (caret shows even with no live agents)', () => {
    const t = buildProjectTree({ live: [], liveTotal: 0, checkouts: [main] })
    expect(t.checkouts).toEqual([{ checkout: main, agents: [], sessions: [] }])
    expect(t.hasChildren).toBe(true)
  })

  it('a worktree whose agent is beyond the cap is not shown as an empty row', () => {
    const t = buildProjectTree({
      live: [a('a'), a('b'), a('c'), a('d', 'orcha/task-d-1')],
      liveTotal: 4,
      checkouts: [main, wt('orcha/task-d-1')]
    })
    expect(t.checkouts.map((c) => c.checkout.branch)).toEqual(['main'])
    expect(t.more).toBe(1)
  })
})

describe('shortAgo', () => {
  const now = Date.parse('2026-09-28T12:00:00Z')
  it('compact right-column times', () => {
    expect(shortAgo(null, now)).toBeNull()
    expect(shortAgo('nope', now)).toBeNull()
    expect(shortAgo('2026-09-28T11:59:40Z', now)).toBe('now')
    expect(shortAgo('2026-09-28T11:55:00Z', now)).toBe('5m')
    expect(shortAgo('2026-09-28T07:00:00Z', now)).toBe('5h')
    expect(shortAgo('2026-09-26T12:00:00Z', now)).toBe('2d')
  })
})
