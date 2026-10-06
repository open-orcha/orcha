import { describe, it, expect } from 'vitest'
import {
  applyTabPrefs,
  cliMissing,
  closeTargets,
  EMPTY_TABS,
  exitLabel,
  layoutOf,
  newTab,
  parseTabPrefs,
  tabFromInfo,
  tabFromRestored,
  tabPrefsOf,
  tabsReducer,
  tabTitle,
  type TabsState
} from './termTabs'
import type { TermInfo } from '../../../shared/terminal'

const info = (id: number, over: Partial<TermInfo> = {}): TermInfo => ({
  id,
  kind: 'shell',
  project: 'orcha-a',
  cwd: '/Users/me/a',
  shell: 'zsh',
  note: null,
  ...over
})

function withTabs(...keys: string[]): TabsState {
  let s = EMPTY_TABS
  keys.forEach((k, i) => {
    s = tabsReducer(s, { type: 'open', tab: newTab(k, 'shell', 'orcha-a', 'a') })
    s = tabsReducer(s, { type: 'attached', key: k, info: info(i + 1) })
  })
  return s
}

describe('tabsReducer', () => {
  it('open activates the new tab; attached marks it running with main facts', () => {
    const s = withTabs('t1')
    expect(s.activeKey).toBe('t1')
    expect(s.tabs[0]).toMatchObject({ ptyId: 1, status: 'running', shell: 'zsh', cwd: '/Users/me/a' })
    expect(tabTitle(s.tabs[0])).toBe('zsh · a')
  })

  it('switch: activate by key and by ⌘-number (⌘9 = last)', () => {
    let s = withTabs('t1', 't2', 't3')
    expect(s.activeKey).toBe('t3')
    s = tabsReducer(s, { type: 'activateIndex', index: 0 })
    expect(s.activeKey).toBe('t1')
    s = tabsReducer(s, { type: 'activateIndex', index: 8 })
    expect(s.activeKey).toBe('t3')
    expect(tabsReducer(s, { type: 'activateIndex', index: 5 })).toBe(s) // no 6th tab: no-op
    s = tabsReducer(s, { type: 'activate', key: 't2' })
    expect(s.activeKey).toBe('t2')
    expect(tabsReducer(s, { type: 'activate', key: 'nope' })).toBe(s)
  })

  it('close: the right neighbour takes over, else the left; closing the last empties', () => {
    let s = withTabs('t1', 't2', 't3')
    s = tabsReducer(s, { type: 'activate', key: 't2' })
    s = tabsReducer(s, { type: 'close', key: 't2' })
    expect(s.tabs.map((t) => t.key)).toEqual(['t1', 't3'])
    expect(s.activeKey).toBe('t3')
    s = tabsReducer(s, { type: 'close', key: 't3' })
    expect(s.activeKey).toBe('t1')
    s = tabsReducer(s, { type: 'close', key: 't1' })
    expect(s).toEqual({ tabs: [], activeKey: null })
  })

  it('closing a background tab keeps the active one', () => {
    let s = withTabs('t1', 't2')
    s = tabsReducer(s, { type: 'close', key: 't1' })
    expect(s.activeKey).toBe('t2')
  })

  it('activity: flags a background tab once; activating clears it', () => {
    let s = withTabs('t1', 't2')
    s = tabsReducer(s, { type: 'activity', ptyId: 1 })
    expect(s.tabs[0].activity).toBe(true)
    const again = tabsReducer(s, { type: 'activity', ptyId: 1 })
    expect(again).toBe(s) // no churn per output chunk
    s = tabsReducer(s, { type: 'activate', key: 't1' })
    expect(s.tabs[0].activity).toBe(false)
  })

  it('exit: "exited 0" / "exited 1" / signal; restart resets to starting', () => {
    let s = withTabs('t1', 't2')
    s = tabsReducer(s, { type: 'exit', ptyId: 1, exit: { exitCode: 0, signal: null } })
    s = tabsReducer(s, { type: 'exit', ptyId: 2, exit: { exitCode: 1, signal: null } })
    expect(exitLabel(s.tabs[0])).toBe('exited 0')
    expect(exitLabel(s.tabs[1])).toBe('exited 1')
    const killed = tabsReducer(s, { type: 'exit', ptyId: 1, exit: { exitCode: 0, signal: 9 } })
    expect(exitLabel(killed.tabs[0])).toBe('killed (signal 9)')
    s = tabsReducer(s, { type: 'restarting', key: 't2' })
    expect(s.tabs[1]).toMatchObject({ status: 'starting', exit: null, ptyId: null })
    expect(exitLabel(s.tabs[1])).toBeNull()
    s = tabsReducer(s, { type: 'attached', key: 't2', info: info(7) })
    expect(s.tabs[1]).toMatchObject({ status: 'running', ptyId: 7 })
  })

  it('failed start shows the error', () => {
    let s = tabsReducer(EMPTY_TABS, { type: 'open', tab: newTab('t1', 'claude', null, null) })
    s = tabsReducer(s, { type: 'failed', key: 't1', error: 'boom' })
    expect(s.tabs[0]).toMatchObject({ status: 'failed', error: 'boom' })
    expect(exitLabel(s.tabs[0])).toBe('failed to start')
  })

  it('agent tabs: title is "Claude"/"Codex" + project; exit 127 = CLI missing', () => {
    let s = tabsReducer(EMPTY_TABS, { type: 'open', tab: newTab('c', 'claude', 'orcha-a', 'todo') })
    expect(tabTitle(s.tabs[0])).toBe('Claude · todo')
    s = tabsReducer(s, { type: 'attached', key: 'c', info: info(3, { kind: 'claude' }) })
    s = tabsReducer(s, { type: 'exit', ptyId: 3, exit: { exitCode: 127, signal: null } })
    expect(cliMissing(s.tabs[0])).toBe(true)
    expect(tabTitle(newTab('x', 'codex', null, null))).toBe('Codex')
    // a shell exiting 127 is just a failed command, not a missing agent CLI
    let sh = withTabs('t1')
    sh = tabsReducer(sh, { type: 'exit', ptyId: 1, exit: { exitCode: 127, signal: null } })
    expect(cliMissing(sh.tabs[0])).toBe(false)
  })

  it('rename: trims, caps, and clears back to automatic', () => {
    let s = withTabs('t1')
    s = tabsReducer(s, { type: 'rename', key: 't1', title: '  build  ' })
    expect(tabTitle(s.tabs[0])).toBe('build')
    s = tabsReducer(s, { type: 'rename', key: 't1', title: '   ' })
    expect(tabTitle(s.tabs[0])).toBe('zsh · a')
  })

  it('restore rebuilds tabs from main after a renderer reload', () => {
    const tab = tabFromInfo('r1', info(4, { exit: { exitCode: 1, signal: null } }), 'a')
    const s = tabsReducer(EMPTY_TABS, { type: 'restore', tabs: [tab] })
    expect(s.activeKey).toBe('r1')
    expect(exitLabel(s.tabs[0])).toBe('exited 1')
  })

  const order = (s: TabsState): string[] => s.tabs.map((t) => t.key)

  it('pin: pinned tabs move to the front in pin order; unpin goes to the first unpinned slot', () => {
    let s = withTabs('a', 'b', 'c', 'd')
    s = tabsReducer(s, { type: 'pin', key: 'c', pinned: true })
    expect(order(s)).toEqual(['c', 'a', 'b', 'd'])
    s = tabsReducer(s, { type: 'pin', key: 'a', pinned: true })
    expect(order(s)).toEqual(['c', 'a', 'b', 'd']) // a joins AFTER c (pin order)
    s = tabsReducer(s, { type: 'pin', key: 'd', pinned: true })
    expect(order(s)).toEqual(['c', 'a', 'd', 'b'])
    expect(s.tabs.map((t) => t.pinned)).toEqual([true, true, true, false])
    expect(tabsReducer(s, { type: 'pin', key: 'd', pinned: true })).toBe(s) // no-op
    s = tabsReducer(s, { type: 'pin', key: 'c', pinned: false })
    expect(order(s)).toEqual(['a', 'd', 'c', 'b'])
    expect(s.activeKey).toBe('d') // pinning never changes the active tab
    // new tabs open after everything (unpinned)
    s = tabsReducer(s, { type: 'open', tab: newTab('e', 'shell', null, null) })
    expect(order(s)).toEqual(['a', 'd', 'c', 'b', 'e'])
  })

  it('close others / to the right / to the left skip pinned tabs; none → []', () => {
    let s = withTabs('a', 'b', 'c', 'd', 'e')
    s = tabsReducer(s, { type: 'pin', key: 'd', pinned: true }) // d, a, b, c, e
    expect(order(s)).toEqual(['d', 'a', 'b', 'c', 'e'])
    expect(closeTargets(s.tabs, 'b', 'others')).toEqual(['a', 'c', 'e'])
    expect(closeTargets(s.tabs, 'b', 'right')).toEqual(['c', 'e'])
    expect(closeTargets(s.tabs, 'b', 'left')).toEqual(['a'])
    expect(closeTargets(s.tabs, 'a', 'left')).toEqual([]) // only a pinned tab to its left
    expect(closeTargets(s.tabs, 'e', 'right')).toEqual([])
    expect(closeTargets(s.tabs, 'd', 'others')).toEqual(['a', 'b', 'c', 'e']) // from a pinned tab
    expect(closeTargets(s.tabs, 'nope', 'others')).toEqual([])
    // closing the targets one by one leaves the pinned tab and the menu's tab
    for (const k of closeTargets(s.tabs, 'b', 'others')) s = tabsReducer(s, { type: 'close', key: k })
    expect(order(s)).toEqual(['d', 'b'])
  })

  it('colour: set, change, clear; unknown colours are refused', () => {
    let s = withTabs('a')
    s = tabsReducer(s, { type: 'color', key: 'a', color: 'teal' })
    expect(s.tabs[0].color).toBe('teal')
    expect(tabsReducer(s, { type: 'color', key: 'a', color: 'teal' })).toBe(s)
    s = tabsReducer(s, { type: 'color', key: 'a', color: 'hotpink' as never })
    expect(s.tabs[0].color).toBeNull()
  })

  it('title / pin / colour survive Restart (the tab key stays, only the pty changes)', () => {
    let s = withTabs('a', 'b')
    s = tabsReducer(s, { type: 'rename', key: 'b', title: 'server' })
    s = tabsReducer(s, { type: 'pin', key: 'b', pinned: true })
    s = tabsReducer(s, { type: 'color', key: 'b', color: 'blue' })
    s = tabsReducer(s, { type: 'restarting', key: 'b' })
    s = tabsReducer(s, { type: 'attached', key: 'b', info: info(9) })
    expect(s.tabs[0]).toMatchObject({ key: 'b', ptyId: 9, customTitle: 'server', pinned: true, color: 'blue' })
  })

  it('persistence round-trip: prefs by pty id → storage JSON → restore after a reload', () => {
    let s = withTabs('a', 'b', 'c', 'd') // ptys 1..4
    s = tabsReducer(s, { type: 'pin', key: 'c', pinned: true })
    s = tabsReducer(s, { type: 'pin', key: 'a', pinned: true })
    s = tabsReducer(s, { type: 'rename', key: 'b', title: 'api' })
    s = tabsReducer(s, { type: 'color', key: 'd', color: 'orange' })
    const stored = JSON.parse(JSON.stringify(tabPrefsOf(s.tabs)))
    expect(stored).toEqual({ '3': { pin: 0 }, '1': { pin: 1 }, '2': { title: 'api' }, '4': { color: 'orange' } })
    // main re-lists in creation order; fresh keys
    const rebuilt = [1, 2, 3, 4].map((id) => tabFromInfo(`r${id}`, info(id), 'a'))
    const r = tabsReducer(EMPTY_TABS, { type: 'restore', tabs: applyTabPrefs(rebuilt, parseTabPrefs(stored)) })
    expect(r.tabs.map((t) => t.ptyId)).toEqual([3, 1, 2, 4])
    expect(r.tabs.map((t) => [t.pinned, t.customTitle, t.color])).toEqual([
      [true, null, null],
      [true, null, null],
      [false, 'api', null],
      [false, null, 'orange']
    ])
  })

  it('stored prefs are validated: junk ids, types and colours are dropped', () => {
    expect(parseTabPrefs(null)).toEqual({})
    expect(parseTabPrefs([1])).toEqual({})
    expect(
      parseTabPrefs({ '0': { title: 'x' }, abc: { title: 'x' }, '5': { title: '  ', pin: -1, color: 'mauve' }, '6': { title: 'ok', pin: 2, color: 'green' } })
    ).toEqual({ '6': { title: 'ok', pin: 2, color: 'green' } })
  })

  it('rename to empty goes back to the program title', () => {
    let s = withTabs('a')
    s = tabsReducer(s, { type: 'rename', key: 'a', title: 'mine' })
    s = tabsReducer(s, { type: 'rename', key: 'a', title: '' })
    expect(s.tabs[0].customTitle).toBeNull()
  })
})

describe('session restore helpers', () => {
  const rinfo = (id: number): TermInfo => ({ id, kind: 'shell', project: 'orcha-a', cwd: '/a', shell: 'zsh', note: null })
  it('layoutOf reports pty ids + cosmetics only (no probes, no pty-less tabs) and the selection', () => {
    let s = tabsReducer(EMPTY_TABS, { type: 'open', tab: newTab('k1', 'shell', 'orcha-a', 'a', { rowKey: 'orcha-a:c1', branch: 'feat' }) })
    s = tabsReducer(s, { type: 'attached', key: 'k1', info: rinfo(1) })
    s = tabsReducer(s, { type: 'open', tab: newTab('k2', 'claude', null, null, { probe: true }) })
    s = tabsReducer(s, { type: 'attached', key: 'k2', info: { ...rinfo(2), kind: 'claude' } })
    s = tabsReducer(s, { type: 'open', tab: newTab('k3', 'shell', null, null) }) // still starting
    s = tabsReducer(s, { type: 'rename', key: 'k1', title: 'api' })
    s = tabsReducer(s, { type: 'color', key: 'k1', color: 'green' })
    s = tabsReducer(s, { type: 'activate', key: 'k1' })
    expect(layoutOf(s)).toEqual({
      tabs: [{ id: 1, title: 'api', pinned: false, color: 'green', rowKey: 'orcha-a:c1', launchBranch: 'feat' }],
      active: 1
    })
  })

  it('restore selects the saved tab; append keeps the current selection; notes dismiss', () => {
    const r = (id: number, over = {}) => ({ info: rinfo(id), title: null, pinned: false, color: null, rowKey: null, launchBranch: null, how: 'shell' as const, note: 'Restored · new shell', ...over })
    const a = tabFromRestored('a', r(1, { pinned: true, color: 'pink', title: 'x' }), 'a')
    const b = tabFromRestored('b', r(2), 'a')
    expect(a).toMatchObject({ ptyId: 1, pinned: true, color: 'pink', customTitle: 'x', status: 'running', restoredNote: 'Restored · new shell', meta: null })
    let s = tabsReducer(EMPTY_TABS, { type: 'restore', tabs: [b, a], activeKey: 'b' })
    expect(s.tabs.map((t) => t.key)).toEqual(['a', 'b']) // pinned first
    expect(s.activeKey).toBe('b')
    s = tabsReducer(s, { type: 'append', tabs: [tabFromRestored('c', r(3), null)] })
    expect(s.activeKey).toBe('b')
    s = tabsReducer(s, { type: 'dismissRestored', keys: ['a', 'c'] })
    expect(s.tabs.map((t) => t.restoredNote)).toEqual([null, 'Restored · new shell', null])
    s = tabsReducer(s, { type: 'restarting', key: 'b' })
    expect(s.tabs[1].restoredNote).toBeNull()
  })
})
