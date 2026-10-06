import { describe, it, expect } from 'vitest'
import { groupSessions, liveCount, sessionAgo, sessionLabel, sessionSnippet, sessionStatus, sessionTitle, type RowRef } from './sessions'
import { newTab, tabsReducer, EMPTY_TABS, type TermTab } from './termTabs'
import type { HostCheckout } from '../../../shared/types'

const MAIN: HostCheckout = { branch: 'main', primary: true, detached: false, repo: 'acme/fleet' }
const WT: HostCheckout = { branch: 'feat/x', primary: false, detached: false, repo: 'acme/fleet' }

function tab(key: string, over: Partial<TermTab> = {}): TermTab {
  return { ...newTab(key, 'shell', 'orcha-fleet', 'fleet-mate'), status: 'running', ptyId: 1, shell: 'zsh', ...over }
}
type Meta = NonNullable<TermTab['meta']>
const meta = (m: Partial<Meta>): Meta => {
  const base = { title: null, snippet: null, attention: false, busy: false, lastActivity: 0, statusAt: null, ...m }
  return { ...base, status: m.status ?? (base.attention ? 'attention' : base.busy ? 'working' : 'idle') }
}

describe('session row text + status', () => {
  it('status glyph: running / waiting (bell) / exited 0 ok / non-zero or signal error / failed', () => {
    // alive but quiet is idle — the spinner only runs while the program is actually busy
    expect(sessionStatus(tab('a'))).toBe('idle')
    expect(sessionStatus(tab('a', { meta: meta({ busy: true }) }))).toBe('running')
    expect(sessionStatus(tab('a', { meta: meta({ busy: true, attention: true }) }))).toBe('attention')
    expect(sessionStatus(tab('a', { meta: meta({ attention: true }) }))).toBe('attention')
    expect(sessionStatus(tab('a', { status: 'exited', exit: { exitCode: 0, signal: null } }))).toBe('ok')
    expect(sessionStatus(tab('a', { status: 'exited', exit: { exitCode: 1, signal: null } }))).toBe('error')
    expect(sessionStatus(tab('a', { status: 'exited', exit: { exitCode: 0, signal: 9 } }))).toBe('error')
    expect(sessionStatus(tab('a', { status: 'failed' }))).toBe('error')
    expect(sessionStatus(tab('a', { status: 'starting' }))).toBe('starting')
  })

  it('title prefers the rename, then the program OSC title (Claude task summary), then the launcher name', () => {
    expect(sessionTitle(tab('a'))).toBe('zsh')
    expect(sessionTitle(tab('a', { kind: 'claude', meta: meta({ title: 'Project work commitment' }) }))).toBe('Project work commitment')
    expect(sessionTitle(tab('a', { customTitle: 'server', meta: meta({ title: 'x' }) }))).toBe('server')
  })

  it('snippet: the latest output line; exit state prefixed; never a copy of the title', () => {
    expect(sessionSnippet(tab('a', { meta: meta({ snippet: 'hi' }) }))).toBe('hi')
    expect(sessionSnippet(tab('a', { status: 'exited', exit: { exitCode: 1, signal: null }, meta: meta({ snippet: 'hi' }) }))).toBe('exited 1 · hi')
    expect(sessionSnippet(tab('a', { meta: meta({ title: 'same', snippet: 'same' }) }))).toBeNull()
    expect(sessionSnippet(tab('a', { status: 'starting' }))).toBe('starting…')
  })

  it('relative time of last output + a full sentence for the tooltip', () => {
    const now = 10 * 60_000
    const t = tab('a', { meta: meta({ snippet: 'hi', lastActivity: now - 5 * 60_000 }) })
    expect(sessionAgo(t, now)).toBe('5m')
    expect(sessionAgo(tab('a'), now)).toBeNull()
    expect(sessionLabel(t, now)).toBe('zsh - hi · idle · active 5m ago')
  })

  it('hook-reported status: working spins, done is ✓ with "done · 2m ago" from the last hook event', () => {
    const now = 10 * 60_000
    const claude = (m: Partial<Meta>) => tab('a', { kind: 'claude', meta: meta({ title: 'Say hi', lastActivity: now - 60_000, ...m }) })
    expect(sessionStatus(claude({ status: 'working', statusAt: now - 1000, busy: true }))).toBe('running')
    const done = claude({ status: 'done', statusAt: now - 2 * 60_000 })
    expect(sessionStatus(done)).toBe('done')
    expect(sessionAgo(done, now)).toBe('2m') // the Stop, not the last redraw
    expect(sessionLabel(done, now)).toBe('Say hi · done · 2m ago')
    expect(sessionLabel(claude({ status: 'done', statusAt: now - 5_000 }), now)).toBe('Say hi · done · just now')
    expect(sessionStatus(claude({ status: 'attention', statusAt: now, attention: true }))).toBe('attention')
    expect(sessionStatus(claude({ status: 'error', statusAt: now }))).toBe('error')
    // an exited process shows its exit, whatever the last hook said
    expect(sessionStatus({ ...done, status: 'exited', exit: { exitCode: 0, signal: null } })).toBe('ok')
    // heuristic sessions keep "active 5m ago"
    expect(sessionLabel(tab('b', { meta: meta({ lastActivity: now - 5 * 60_000 }) }), now)).toBe('zsh · idle · active 5m ago')
  })

  it('the reducer stores meta by pty id and Restart clears it', () => {
    let s = tabsReducer(EMPTY_TABS, { type: 'open', tab: newTab('k', 'claude', 'orcha-fleet', 'fleet-mate') })
    s = tabsReducer(s, { type: 'attached', key: 'k', info: { id: 7, kind: 'claude', project: 'orcha-fleet', cwd: '/f', shell: 'zsh', note: null, branch: 'main' } })
    s = tabsReducer(s, { type: 'meta', ptyId: 7, title: 'T', snippet: 'S', attention: true, busy: false, lastActivity: 5, status: 'attention', statusAt: null })
    expect(s.tabs[0].meta).toEqual({ title: 'T', snippet: 'S', attention: true, busy: false, lastActivity: 5, status: 'attention', statusAt: null })
    expect(s.tabs[0].branch).toBe('main')
    s = tabsReducer(s, { type: 'restarting', key: 'k' })
    expect(s.tabs[0].meta).toBeNull()
  })
})

describe('groupSessions (project → branch/checkout)', () => {
  const rows: RowRef[] = [
    { key: 'orcha-fleet:c1', stack: { project: 'orcha-fleet' }, checkouts: [MAIN] },
    { key: 'orcha-fleet:c2', stack: { project: 'orcha-fleet' }, checkouts: null },
    { key: 'orcha-web:c9', stack: { project: 'orcha-web' }, checkouts: null }
  ]

  it('a session in the project folder sits under the PRIMARY checkout of the row it was opened from', () => {
    const g = groupSessions(rows, [tab('a', { rowKey: 'orcha-fleet:c1', branch: 'main' })])
    expect(g.byRow.get('orcha-fleet:c1')?.byBranch.get('main')?.map((t) => t.key)).toEqual(['a'])
  })

  it('no branch reported by main but the row has a primary → primary; no branch data at all → loose', () => {
    const g = groupSessions(rows, [tab('a', { rowKey: 'orcha-fleet:c1' }), tab('b', { rowKey: 'orcha-fleet:c2' })])
    expect(g.byRow.get('orcha-fleet:c1')?.byBranch.get('main')?.length).toBe(1)
    expect(g.byRow.get('orcha-fleet:c2')?.loose.map((t) => t.key)).toEqual(['b'])
  })

  it('a real worktree branch the row does not list becomes its own (non-primary) checkout', () => {
    const g = groupSessions(rows, [tab('a', { rowKey: 'orcha-fleet:c1', branch: 'feat/x', launchBranch: 'feat/x' })])
    const r = g.byRow.get('orcha-fleet:c1')!
    expect(r.extraCheckouts).toEqual([{ ...WT }])
    expect(r.byBranch.get('feat/x')?.map((t) => t.key)).toEqual(['a'])
  })

  it('unknown row (restored after reload) → the stack’s first row; home-folder / vanished stack → unplaced', () => {
    const g = groupSessions(rows, [
      tab('a', { rowKey: null }),
      tab('b', { project: null, rowKey: null }),
      tab('c', { project: 'orcha-gone', rowKey: 'orcha-gone:x' }),
      tab('d', { project: 'orcha-web', rowKey: 'orcha-fleet:c1' }) // stale row of another stack
    ])
    expect(g.byRow.get('orcha-fleet:c1')?.all.map((t) => t.key)).toEqual(['a'])
    expect(g.byRow.get('orcha-web:c9')?.all.map((t) => t.key)).toEqual(['d'])
    expect(g.unplaced.map((t) => t.key)).toEqual(['b', 'c'])
  })

  it('liveCount counts running + starting sessions only (collapsed-project badge)', () => {
    expect(
      liveCount([tab('a'), tab('b', { status: 'starting' }), tab('c', { status: 'exited', exit: { exitCode: 0, signal: null } })])
    ).toBe(2)
  })
})
