// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useReducer } from 'react'
import { render, screen, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SessionPanel from './SessionPanel'
import { TermClient } from './termClient'
import { closePrompt, TabMenu, tabMenuSections, type TabMenuActions } from './TabMenu'
import { useTabCloser } from './CloseTabsDialog'
import { EMPTY_TABS, newTab, tabsReducer, type TabsState, type TermTab } from './termTabs'
import type { Terminals } from './useTerminals'
import type { TermApi, TermInfo } from '../../../shared/terminal'

vi.mock('./TerminalView', () => ({ default: () => <div data-testid="terminal-view" /> }))

const info = (id: number): TermInfo => ({ id, kind: 'shell', project: 'orcha-a', cwd: '/a', shell: 'zsh', note: null })

function tabs(n: number, pinned: string[] = []): TabsState {
  let s = EMPTY_TABS
  for (let i = 1; i <= n; i++) {
    s = tabsReducer(s, { type: 'open', tab: newTab(`t${i}`, 'shell', 'orcha-a', 'todo') })
    s = tabsReducer(s, { type: 'attached', key: `t${i}`, info: info(i) })
    s = tabsReducer(s, { type: 'rename', key: `t${i}`, title: `tab ${i}` })
  }
  for (const k of pinned) s = tabsReducer(s, { type: 'pin', key: k, pinned: true })
  return s
}

const labels = (menu: HTMLElement): string[] => within(menu).getAllByRole('menuitem').map((m) => m.textContent ?? '')
const disabled = (menu: HTMLElement): string[] =>
  within(menu)
    .getAllByRole('menuitem')
    .filter((m) => (m as HTMLButtonElement).disabled)
    .map((m) => m.textContent ?? '')

beforeEach(() => {
  window.orchaDesktop = { setHostModal: vi.fn().mockResolvedValue(undefined) } as unknown as typeof window.orchaDesktop
})

/** A live harness: real reducer + real useTabCloser, so menus, confirms and focus are real. */
function Harness({ initial, shown = true }: { initial: TabsState; shown?: boolean }) {
  const [state, dispatch] = useReducer(tabsReducer, initial)
  const terms: Terminals = {
    available: true,
    state,
    client: new TermClient(undefined, () => {}),
    api: { setFocus: vi.fn(), onEvent: () => () => {} } as unknown as TermApi,
    open: () => null,
    close: (key) => dispatch({ type: 'close', key }),
    activate: (key) => dispatch({ type: 'activate', key }),
    activateIndex: () => {},
    restart: () => {},
    rename: (key, title) => dispatch({ type: 'rename', key, title }),
    pin: (key, pinned) => dispatch({ type: 'pin', key, pinned }),
    setColor: (key, color) => dispatch({ type: 'color', key, color }),
    active: state.tabs.find((t) => t.key === state.activeKey) ?? null,
    skipped: 0,
    deferred: 0,
    restoreNote: null,
    restoreLast: () => {},
    restoreProject: () => {},
    dismissRestored: (keys) => dispatch({ type: 'dismissRestored', keys })
  }
  const closer = useTabCloser(terms)
  return (
    <>
      <SessionPanel
        terms={terms}
        shown={shown}
        portalTab={{ label: 'fleet', icon: <span /> }}
        onShowPortal={() => {}}
        onShowTab={terms.activate}
        onLaunch={() => {}}
        onOpenMenu={() => {}}
        onCloseTabs={closer.request}
        focusToken={0}
      >
        <div />
      </SessionPanel>
      {closer.dialog}
    </>
  )
}

const stripTab = (key: string): HTMLElement => document.querySelector<HTMLElement>(`[data-tab-key="${key}"]`)!
const stripOrder = (): string[] => screen.getAllByTestId('terminal-tab').map((t) => t.dataset.tabKey ?? '')

describe('tab menu items', () => {
  const actions = (t: readonly TermTab[]): TabMenuActions => ({ tabs: t, onPin: vi.fn(), onCloseTabs: vi.fn(), onColor: vi.fn(), onRestart: vi.fn() })

  it('Orca order, no split items; bulk closes disabled without targets', () => {
    const s = tabs(3)
    const ids = (tab: TermTab, all: readonly TermTab[] = s.tabs) => tabMenuSections(tab, actions(all), () => {}).map((sec) => sec.map((i) => `${i.id}${i.disabled ? '(off)' : ''}`))
    expect(ids(s.tabs[0])).toEqual([[], ['pin'], ['close', 'close-others', 'close-right', 'close-left(off)'], ['rename']])
    expect(ids(s.tabs[2])).toEqual([[], ['pin'], ['close', 'close-others', 'close-right(off)', 'close-left'], ['rename']])
    const one = tabs(1)
    expect(ids(one.tabs[0], one.tabs)[2]).toEqual(['close', 'close-others(off)', 'close-right(off)', 'close-left(off)'])
  })

  it('pinned tab → Unpin; pinned neighbours are not targets; exited → Restart first', () => {
    let s = tabs(3, ['t1', 't2'])
    const sec = tabMenuSections(s.tabs[2], actions(s.tabs), () => {})
    expect(sec[1][0].label).toBe('Pin Tab')
    expect(sec[2].find((i) => i.id === 'close-left')?.disabled).toBe(true) // only pinned tabs to the left
    expect(sec[2].find((i) => i.id === 'close-others')?.disabled).toBe(true)
    expect(tabMenuSections(s.tabs[0], actions(s.tabs), () => {})[1][0].label).toBe('Unpin Tab')
    s = tabsReducer(s, { type: 'exit', ptyId: 3, exit: { exitCode: 0, signal: null } })
    expect(tabMenuSections(s.tabs[2], actions(s.tabs), () => {})[0].map((i) => i.label)).toEqual(['Restart'])
  })

  it('shortcut hints: ⌘W on Close, F2 on Change Title (⌘R is never offered — Electron reload)', () => {
    const s = tabs(2)
    const flat = tabMenuSections(s.tabs[0], actions(s.tabs), () => {}).flat()
    expect(flat.find((i) => i.id === 'close')?.shortcut).toBe('⌘W')
    expect(flat.find((i) => i.id === 'rename')?.shortcut).toBe('F2')
    expect(flat.some((i) => i.shortcut === '⌘R')).toBe(false)
  })

  it('closePrompt: one unpinned → none; several live → "Close 3 tabs? Running processes will end."; all exited → none; pinned → asked', () => {
    let s = tabs(4, ['t4'])
    expect(closePrompt(s.tabs, ['t1'])).toBeNull()
    expect(closePrompt(s.tabs, ['t1', 't2', 't3'])).toEqual({ title: 'Close 3 tabs?', body: 'Running processes will end.', confirm: 'Close 3 tabs' })
    for (const id of [1, 2, 3]) s = tabsReducer(s, { type: 'exit', ptyId: id, exit: { exitCode: 0, signal: null } })
    expect(closePrompt(s.tabs, ['t1', 't2', 't3'])).toBeNull()
    expect(closePrompt(s.tabs, ['t4'])).toMatchObject({ title: 'Close pinned tab?', body: 'This tab is pinned. Its running process will end.' })
    expect(closePrompt(s.tabs, [])).toBeNull()
  })

  it('Tab Color is a labelled radio group: none + nine named swatches, current one checked', async () => {
    const user = userEvent.setup()
    let s = tabs(2)
    s = tabsReducer(s, { type: 'color', key: 't1', color: 'purple' })
    const a = actions(s.tabs)
    const onClose = vi.fn()
    render(<TabMenu tab={s.tabs[0]} actions={a} startRename={() => {}} onClose={onClose} />)
    const group = screen.getByRole('group', { name: 'Tab Color' })
    const radios = within(group).getAllByRole('menuitemradio')
    expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual([
      'No color',
      'Blue',
      'Purple',
      'Pink',
      'Red',
      'Orange',
      'Yellow',
      'Green',
      'Teal',
      'Grey'
    ])
    expect(radios.filter((r) => r.getAttribute('aria-checked') === 'true').map((r) => r.getAttribute('aria-label'))).toEqual(['Purple'])
    await user.click(within(group).getByRole('menuitemradio', { name: 'Teal' }))
    expect(a.onColor).toHaveBeenCalledWith('t1', 'teal')
    expect(onClose).toHaveBeenCalled()
  })

  it('keyboard: ↓/↑ walk items (disabled skipped), the swatch row is one stop landing on the checked colour, ←/→ inside it', async () => {
    const user = userEvent.setup()
    let s = tabs(2)
    s = tabsReducer(s, { type: 'color', key: 't2', color: 'red' })
    render(<TabMenu tab={s.tabs[1]} actions={actions(s.tabs)} startRename={() => {}} onClose={() => {}} />)
    const focused = (): string => document.activeElement?.getAttribute('data-menu-item') ?? document.activeElement?.getAttribute('data-swatch') ?? ''
    expect(focused()).toBe('pin')
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}')
    expect(focused()).toBe('close-left') // Close Others, (To The Right is disabled), To The Left
    await user.keyboard('{ArrowDown}{ArrowDown}')
    expect(focused()).toBe('red') // Change Title → the colour row, on the checked swatch
    await user.keyboard('{ArrowRight}')
    expect(focused()).toBe('orange')
    await user.keyboard('{ArrowUp}')
    expect(focused()).toBe('rename')
    await user.keyboard('{End}')
    expect(focused()).toBe('red')
    await user.keyboard('{ArrowDown}')
    expect(focused()).toBe('pin') // wraps
  })
})

describe('strip tab menu (SessionPanel)', () => {
  it('right-click opens the menu for that tab; Escape closes it and focus returns to the tab', async () => {
    const user = userEvent.setup()
    render(<Harness initial={tabs(3)} />)
    fireEvent.contextMenu(stripTab('t2'), { clientX: 120 })
    const menu = screen.getByRole('menu', { name: 'Tab actions' })
    expect(stripTab('t2')).toHaveAttribute('aria-expanded', 'true')
    expect(labels(menu)).toEqual(['Pin Tab', 'Close⌘W', 'Close Others', 'Close Tabs To The Right', 'Close Tabs To The Left', 'Change TitleF2'])
    expect(disabled(menu)).toEqual([])
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(stripTab('t2')).toHaveFocus()
  })

  it('Shift+F10 and the context-menu key open it on the focused tab; Enter runs the focused item', async () => {
    const user = userEvent.setup()
    render(<Harness initial={tabs(3)} />)
    stripTab('t3').focus()
    await user.keyboard('{Shift>}{F10}{/Shift}')
    expect(screen.getByRole('menu', { name: 'Tab actions' })).toBeInTheDocument()
    expect(document.activeElement).toHaveAttribute('data-menu-item', 'pin')
    await user.keyboard('{Enter}') // Pin Tab
    expect(stripOrder()).toEqual(['t3', 't1', 't2'])
    stripTab('t3').focus()
    await user.keyboard('{ContextMenu}')
    expect(labels(screen.getByRole('menu'))[0]).toBe('Unpin Tab')
  })

  it('pinned tabs: first in pin order, compact (icon + colour dot, title in tooltip/name), no ×', async () => {
    let s = tabs(3)
    s = tabsReducer(s, { type: 'pin', key: 't3', pinned: true })
    s = tabsReducer(s, { type: 'pin', key: 't1', pinned: true })
    s = tabsReducer(s, { type: 'color', key: 't3', color: 'green' })
    s = tabsReducer(s, { type: 'color', key: 't2', color: 'blue' })
    render(<Harness initial={s} />)
    expect(stripOrder()).toEqual(['t3', 't1', 't2'])
    const pinned = stripTab('t3')
    expect(pinned).toHaveAttribute('data-pinned', 'true')
    expect(pinned.textContent).toBe('')
    expect(pinned).toHaveAccessibleName('tab 3 · pinned · Green')
    expect(pinned.title).toMatch(/^tab 3 \(pinned\)/)
    expect(pinned.querySelector('[data-testid="tab-color-dot"]')).not.toBeNull()
    expect(within(pinned).queryByRole('button')).toBeNull()
    // an unpinned coloured tab gets the same dot before its title, never a coloured line
    const coloured = stripTab('t2')
    expect(coloured.querySelector('[data-testid="tab-color-dot"]')).not.toBeNull()
    expect(coloured.querySelector('[data-testid="tab-color-marker"]')).toBeNull()
    expect(coloured.textContent).toBe('tab 2')
  })

  it('tab colour is a dot (none when unset); the only underline is the neutral one on the active tab', async () => {
    const user = userEvent.setup()
    let s = tabs(3)
    s = tabsReducer(s, { type: 'color', key: 't1', color: 'blue' })
    render(<Harness initial={s} />)
    const dot = stripTab('t1').querySelector<HTMLElement>('[data-testid="tab-color-dot"]')!
    expect(dot).not.toBeNull()
    expect(dot.className).toMatch(/h-1\.5 w-1\.5/)
    expect(dot.style.background).not.toBe('')
    expect(stripTab('t2').querySelector('[data-testid="tab-color-dot"]')).toBeNull()
    const underlines = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-testid="tab-active-underline"]')]
    const selected = (): HTMLElement => screen.getAllByRole('tab').find((t) => t.getAttribute('aria-selected') === 'true')!
    expect(underlines()).toHaveLength(1)
    expect(selected().contains(underlines()[0])).toBe(true)
    expect(underlines()[0].className).toMatch(/bg-text-3/)
    expect(underlines()[0].style.background).toBe('')
    await user.click(stripTab('t1'))
    expect(stripTab('t1')).toHaveAttribute('aria-selected', 'true')
    expect(underlines()).toHaveLength(1)
    expect(stripTab('t1').contains(underlines()[0])).toBe(true)
  })

  it('Close Others keeps pinned tabs and asks once when processes are running', async () => {
    const user = userEvent.setup()
    render(<Harness initial={tabs(4, ['t1'])} />)
    fireEvent.contextMenu(stripTab('t3'), { clientX: 200 })
    await user.click(screen.getByRole('menuitem', { name: 'Close Others' }))
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveTextContent('Close 2 tabs?')
    expect(dialog).toHaveTextContent('Running processes will end.')
    await user.click(within(dialog).getByRole('button', { name: 'Close 2 tabs' }))
    expect(stripOrder()).toEqual(['t1', 't3'])
  })

  it('Cancel keeps the tabs; all-exited bulk closes go straight through', async () => {
    const user = userEvent.setup()
    let s = tabs(3)
    render(<Harness initial={s} />)
    fireEvent.contextMenu(stripTab('t1'), { clientX: 60 })
    await user.click(screen.getByRole('menuitem', { name: 'Close Tabs To The Right' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(stripOrder()).toEqual(['t1', 't2', 't3'])
    document.body.innerHTML = ''
    for (const id of [1, 2, 3]) s = tabsReducer(s, { type: 'exit', ptyId: id, exit: { exitCode: 0, signal: null } })
    render(<Harness initial={s} />)
    fireEvent.contextMenu(stripTab('t3'), { clientX: 300 })
    await user.click(screen.getByRole('menuitem', { name: 'Close Tabs To The Left' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(stripOrder()).toEqual(['t3'])
  })

  it('closing a pinned tab asks first (× is hidden; ⌘W / Delete / Close go through the confirm)', async () => {
    const user = userEvent.setup()
    render(<Harness initial={tabs(2, ['t2'])} />)
    stripTab('t2').focus()
    await user.keyboard('{Delete}')
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Close pinned tab?')
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(stripOrder()).toEqual(['t1'])
  })

  it('Change Title: inline rename in the tab; Escape cancels, Enter saves, empty → the program title', async () => {
    const user = userEvent.setup()
    let s = tabs(2)
    s = tabsReducer(s, { type: 'meta', ptyId: 1, title: 'npm run dev', snippet: null, attention: false, busy: false, lastActivity: 1, status: 'idle', statusAt: null })
    render(<Harness initial={s} />)
    fireEvent.contextMenu(stripTab('t1'), { clientX: 60 })
    await user.click(screen.getByRole('menuitem', { name: /Change Title/ }))
    let input = screen.getByRole('textbox', { name: 'Tab name' })
    await user.type(input, 'nope{Escape}')
    expect(stripTab('t1').textContent).toBe('tab 1')
    stripTab('t1').focus()
    await user.keyboard('{F2}')
    input = screen.getByRole('textbox', { name: 'Tab name' })
    await user.clear(input)
    await user.type(input, 'api{Enter}')
    expect(stripTab('t1').textContent).toBe('api')
    await user.keyboard('{F2}')
    input = screen.getByRole('textbox', { name: 'Tab name' })
    await user.clear(input)
    await user.keyboard('{Enter}')
    expect(stripTab('t1').textContent).toBe('npm run dev')
  })

  it('picking a colour from the menu marks the tab', async () => {
    const user = userEvent.setup()
    render(<Harness initial={tabs(2)} />)
    fireEvent.contextMenu(stripTab('t1'), { clientX: 60 })
    await user.click(screen.getByRole('menuitemradio', { name: 'Orange' }))
    expect(stripTab('t1')).toHaveAttribute('data-tab-color', 'orange')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('with the portal showing, an open tab menu hides the native view (it would cover the menu)', () => {
    render(<Harness initial={tabs(2)} shown={false} />)
    const api = window.orchaDesktop as unknown as { setHostModal: ReturnType<typeof vi.fn> }
    expect(api.setHostModal).not.toHaveBeenCalled()
    fireEvent.contextMenu(stripTab('t1'), { clientX: 60 })
    expect(api.setHostModal).toHaveBeenCalledWith(true)
  })
})
