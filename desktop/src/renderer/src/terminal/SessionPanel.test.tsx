// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SessionPanel, { STRIP_HEIGHT, STRIP_OUTER, stripTitle } from './SessionPanel'
import { TermClient } from './termClient'
import { EMPTY_TABS, newTab, tabsReducer, type TabsState } from './termTabs'
import type { Terminals } from './useTerminals'
import type { TermApi, TermInfo } from '../../../shared/terminal'

// xterm needs a real canvas/layout; the panel's own behaviour is what's under test here.
vi.mock('./TerminalView', () => ({
  default: ({ ptyId, visible }: { ptyId: number; visible: boolean }) => (
    <div data-testid="terminal-view" data-pty={ptyId} data-visible={visible ? 'yes' : 'no'} />
  )
}))

const info = (id: number, kind: TermInfo['kind'] = 'shell'): TermInfo => ({ id, kind, project: 'orcha-a', cwd: '/a', shell: 'zsh', note: null })

function makeTerms(state: TabsState): Terminals & { calls: string[] } {
  const calls: string[] = []
  const api = { setFocus: vi.fn(), onEvent: () => () => {} } as unknown as TermApi
  return {
    calls,
    available: true,
    state,
    client: new TermClient(undefined, () => {}),
    api,
    open: () => null,
    close: (k) => void calls.push(`close:${k}`),
    activate: (k) => void calls.push(`activate:${k}`),
    activateIndex: () => {},
    restart: (k) => void calls.push(`restart:${k}`),
    rename: (k, t) => void calls.push(`rename:${k}:${t}`),
    pin: (k, p) => void calls.push(`pin:${k}:${p}`),
    setColor: (k, c) => void calls.push(`color:${k}:${c}`),
    active: state.tabs.find((t) => t.key === state.activeKey) ?? null,
    skipped: 0,
    deferred: 0,
    restoreNote: null,
    restoreLast: () => {},
    restoreProject: () => {},
    dismissRestored: (keys) => void calls.push(`dismiss:${keys.join(',')}`)
  }
}

function twoTabs(): TabsState {
  let s = EMPTY_TABS
  s = tabsReducer(s, { type: 'open', tab: newTab('t1', 'shell', 'orcha-a', 'todo') })
  s = tabsReducer(s, { type: 'attached', key: 't1', info: info(1) })
  s = tabsReducer(s, { type: 'open', tab: newTab('t2', 'claude', 'orcha-a', 'todo') })
  s = tabsReducer(s, { type: 'attached', key: 't2', info: info(2, 'claude') })
  return s
}

function renderPanel(state: TabsState, over: Partial<Parameters<typeof SessionPanel>[0]> = {}) {
  const terms = makeTerms(state)
  const handlers = { onShowPortal: vi.fn(), onShowTab: vi.fn(), onLaunch: vi.fn(), onOpenMenu: vi.fn() }
  render(
    <SessionPanel terms={terms} shown portalTab={{ label: 'fleet-mate', icon: <span /> }} focusToken={0} {...handlers} {...over}>
      <div data-testid="portal-area" />
    </SessionPanel>
  )
  return { terms, ...handlers }
}

describe('SessionPanel (full-panel terminals, Orca strip)', () => {
  it('the strip lists the project portal tab first, then every terminal; the active terminal fills the panel', () => {
    renderPanel(twoTabs())
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['fleet-mate', 'zsh · todo', 'Claude · todo'])
    expect(tabs[2]).toHaveAttribute('aria-selected', 'true')
    expect(screen.getAllByTestId('terminal-view').map((v) => v.dataset.visible)).toEqual(['no', 'yes'])
    expect(screen.getByTestId('terminal-area').className).not.toMatch(/hidden/)
    expect(tabs[2].querySelector('[data-mark="claude"]')).not.toBeNull()
  })

  it('portal showing: the portal tab is selected, the terminal area is hidden but terminals stay mounted', () => {
    renderPanel(twoTabs(), { shown: false })
    expect(screen.getByTestId('portal-tab')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('terminal-area').className).toMatch(/hidden/)
    expect(screen.getAllByTestId('terminal-view').every((v) => v.dataset.visible === 'no')).toBe(true)
    expect(screen.getByTestId('portal-area')).toBeInTheDocument()
  })

  it('one click back to the portal; arrows move across portal + terminals; F2 renames; × closes', async () => {
    const user = userEvent.setup()
    const { terms, onShowPortal, onShowTab } = renderPanel(twoTabs())
    await user.click(screen.getByTestId('portal-tab'))
    expect(onShowPortal).toHaveBeenCalled()
    await user.click(screen.getAllByRole('tab')[1])
    expect(onShowTab).toHaveBeenCalledWith('t1')
    screen.getAllByRole('tab')[2].focus()
    await user.keyboard('{ArrowRight}') // wraps to the portal tab
    expect(onShowPortal).toHaveBeenCalledTimes(2)
    screen.getAllByRole('tab')[1].focus()
    await user.keyboard('{F2}')
    const input = screen.getByRole('textbox', { name: 'Tab name' })
    await user.clear(input)
    await user.type(input, 'server{Enter}')
    expect(terms.calls).toContain('rename:t1:server')
    await user.click(screen.getByRole('button', { name: 'Close Claude · todo' }))
    expect(terms.calls).toContain('close:t2')
  })

  it('the program title (OSC) names the tab; an attention bell shows on a background tab', () => {
    let s = twoTabs()
    s = tabsReducer(s, { type: 'meta', ptyId: 1, title: 'npm run dev', snippet: null, attention: true, busy: false, lastActivity: 1, status: 'attention', statusAt: null })
    renderPanel(s)
    const tab = screen.getAllByRole('tab')[1]
    expect(tab.textContent).toBe('npm run dev')
    expect(tab.querySelector('[data-session-glyph="attention"]')).not.toBeNull()
    expect(stripTitle({ ...s.tabs[1], customTitle: 'mine' })).toBe('mine')
  })

  it('⋯ menu: New Terminal ⌘T / Claude ⌥⌘T / Codex, then tab actions', async () => {
    const user = userEvent.setup()
    const { onLaunch } = renderPanel(twoTabs())
    await user.click(screen.getByTestId('strip-menu'))
    const menu = screen.getByRole('menu', { name: 'Session actions' })
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual([
      'New Terminal⌘T',
      'Claude⌥⌘T',
      'Codex',
      'Back to fleet-mate',
      'Pin Tab',
      'Close⌘W',
      'Close Others',
      'Close Tabs To The Right',
      'Close Tabs To The Left',
      'Change TitleF2'
    ])
    // the active (last) tab has nothing to its right
    expect(within(menu).getByRole('menuitem', { name: 'Close Tabs To The Right' })).toBeDisabled()
    expect(within(menu).getByRole('menuitem', { name: 'Close Tabs To The Left' })).toBeEnabled()
    await user.click(within(menu).getByRole('menuitem', { name: /^Codex/ }))
    expect(onLaunch).toHaveBeenCalledWith('codex')
  })

  it('+ opens the launcher menu (never a tab by itself); picking Claude launches it', async () => {
    const user = userEvent.setup()
    const { onLaunch } = renderPanel(twoTabs())
    const plus = screen.getByTestId('strip-new')
    expect(plus).toHaveAttribute('aria-haspopup', 'menu')
    await user.click(plus)
    expect(onLaunch).not.toHaveBeenCalled()
    const menu = screen.getByRole('menu', { name: 'New tab' })
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['New Terminal⌘T', 'Claude⌥⌘T', 'Codex'])
    await user.click(within(menu).getByRole('menuitem', { name: /^Claude/ }))
    expect(onLaunch).toHaveBeenCalledWith('claude')
    expect(screen.queryByRole('menu', { name: 'New tab' })).toBeNull()
  })

  it('+ menu closes on Escape and returns focus to +', async () => {
    const user = userEvent.setup()
    renderPanel(twoTabs())
    await user.click(screen.getByTestId('strip-new'))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu', { name: 'New tab' })).toBeNull()
    expect(screen.getByTestId('strip-new')).toHaveFocus()
  })

  it('exit bar: "CLI not found" with the install command, Restart restarts', async () => {
    const user = userEvent.setup()
    let s = twoTabs()
    s = tabsReducer(s, { type: 'exit', ptyId: 2, exit: { exitCode: 127, signal: null } })
    const { terms } = renderPanel(s)
    expect(screen.getByTestId('terminal-exit')).toHaveTextContent('Claude Code CLI not found — install it, then Restart.')
    await user.click(screen.getByRole('button', { name: /Restart/ }))
    expect(terms.calls).toContain('restart:t2')
  })

  it('no tabs → no strip (main reserves nothing); strip geometry matches what main reserves', () => {
    renderPanel(EMPTY_TABS, { shown: false })
    expect(screen.queryByTestId('session-strip')).toBeNull()
    expect(STRIP_OUTER).toBe(STRIP_HEIGHT + 2)
  })

  it('reports keyboard focus entering/leaving the terminal (⌘W routing)', async () => {
    const user = userEvent.setup()
    const { terms } = renderPanel(twoTabs())
    const area = screen.getByTestId('terminal-area')
    area.tabIndex = -1
    area.focus()
    expect(terms.api!.setFocus).toHaveBeenLastCalledWith(true)
    await user.click(screen.getByTestId('portal-tab'))
    expect(terms.api!.setFocus).toHaveBeenLastCalledWith(false)
  })
})

describe('SessionPanel — an overflowing strip (DT-20)', () => {
  it('+ lives outside the scrolling tab list, so it can never scroll out of reach', () => {
    renderPanel(twoTabs())
    const tablist = screen.getByRole('tablist', { name: 'Sessions' })
    expect(tablist.contains(screen.getByTestId('strip-new'))).toBe(false)
    expect(tablist.className).not.toMatch(/\bflex-1\b/) // + follows the last tab
  })

  it('the active tab is scrolled into view when it changes', () => {
    const calls: string[] = []
    const orig = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      calls.push(this.dataset.tabKey ?? this.dataset.testid ?? '?')
    }
    try {
      const terms = makeTerms(twoTabs())
      const props = { terms, portalTab: { label: 'p', icon: <span /> }, focusToken: 0, onShowPortal: vi.fn(), onShowTab: vi.fn(), onLaunch: vi.fn(), onOpenMenu: vi.fn() }
      const { rerender } = render(<SessionPanel {...props} shown><div /></SessionPanel>)
      expect(calls.at(-1)).toBe('t2')
      const s = tabsReducer(twoTabs(), { type: 'activate', key: 't1' })
      rerender(<SessionPanel {...props} terms={makeTerms(s)} shown><div /></SessionPanel>)
      expect(calls.at(-1)).toBe('t1')
      rerender(<SessionPanel {...props} terms={makeTerms(s)} shown={false}><div /></SessionPanel>)
      expect(calls.at(-1)).toBe('portal-tab')
    } finally {
      HTMLElement.prototype.scrollIntoView = orig
    }
  })
})
