// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import HostSidebar, { type HostSidebarProps } from './HostSidebar'
import { SessionGlyph } from './SessionRow'
import { buildProjectRows } from './projectModel'
import { groupSessions } from '../terminal/sessions'
import { newTab, type TermTab } from '../terminal/termTabs'
import type { AttentionSnapshot, HostCheckout, ProjectContainer, Stack } from '../../../shared/types'

const stack: Stack = { project: 'orcha-fleet', projectShort: 'fleet', apiPort: 8001, dbPort: 5432, portalStatus: 'Up', running: true, folder: '/f' , runtime: 'docker', health: 'ok'}
const container = (id: string, name: string): ProjectContainer => ({
  id, name, description: null, status: 'active', github_repo: null, agents: 1, tasks: 0, needs_you: 0, member_count: 1, icon: null
})
const MAIN: HostCheckout = { branch: 'main', primary: true, detached: false, repo: 'fleet-mate' }

function rows() {
  const attention: AttentionSnapshot = {
    items: [],
    projects: [
      {
        project: 'orcha-fleet',
        containers: [
          { cid: 'c1', name: 'fleet-mate', count: 0, partial: false, live: [], liveTotal: 0, checkouts: [MAIN] },
          { cid: 'c2', name: 'other', count: 0, partial: false, live: [], liveTotal: 0, checkouts: null }
        ],
        unavailable: [],
        fetchedAt: null,
        ok: true
      }
    ]
  }
  return buildProjectRows({
    stacks: [stack],
    cards: [
      { stack, container: container('c1', 'fleet-mate') },
      { stack, container: container('c2', 'other') }
    ],
    attention,
    pinned: new Set(),
    order: [],
    active: { project: null, cid: null, portalAttention: null }
  })
}

const now = Date.now()
function tab(key: string, over: Partial<TermTab> = {}): TermTab {
  return { ...newTab(key, 'shell', 'orcha-fleet', 'fleet-mate', { rowKey: 'orcha-fleet:c1' }), status: 'running', ptyId: 1, shell: 'zsh', branch: 'main', ...over }
}
const TABS = [
  tab('s1', { meta: { title: null, snippet: 'hi', attention: false, busy: true, lastActivity: now - 2 * 60_000, status: 'working', statusAt: null } }),
  tab('s2', { status: 'exited', exit: { exitCode: 1, signal: null } }),
  tab('c1', { kind: 'claude', meta: { title: 'Project work commitment', snippet: null, attention: true, busy: false, lastActivity: now, status: 'attention', statusAt: null } })
]

function props(over: Partial<HostSidebarProps> = {}): HostSidebarProps {
  const r = rows()
  return {
    rows: r,
    total: { count: 0, partial: false, unknown: 0 },
    activeKey: 'orcha-fleet:c1',
    activeSection: null,
    width: 272,
    collapsed: false,
    busy: {},
    errors: {},
    managerActive: false,
    onOpen: vi.fn(),
    onNavigate: vi.fn(),
    onNeedsYou: vi.fn(),
    onStart: vi.fn(),
    onStop: vi.fn(),
    onTogglePin: vi.fn(),
    onMove: vi.fn(),
    onShowManager: vi.fn(),
    onAddProject: vi.fn(),
    onHelp: vi.fn(),
    onResize: vi.fn(),
    onToggleCollapsed: vi.fn(),
    onToggleAgents: vi.fn(),
    sessions: groupSessions(r, TABS),
    activeSessionKey: 's1',
    sessionActions: { onOpen: vi.fn(), onRename: vi.fn(), onRestart: vi.fn(), onClose: vi.fn() },
    onLaunch: vi.fn(),
    ...over
  }
}

beforeEach(() => {
  window.orchaDesktop = { setHostModal: vi.fn().mockResolvedValue(undefined) } as unknown as typeof window.orchaDesktop
})

describe('SessionGlyph', () => {
  it('done = green circle-check, distinct from the exited-0 ring and the running arc', () => {
    const { container, rerender } = render(<SessionGlyph status="done" />)
    const done = container.querySelector('[data-session-glyph="done"]')
    expect(done?.getAttribute('class')).toContain('text-ok')
    expect(done?.getAttribute('aria-hidden')).toBe('true')
    rerender(<SessionGlyph status="running" />)
    expect(container.querySelector('[data-session-glyph="running"]')?.getAttribute('class')).toContain('orcha-spin')
    rerender(<SessionGlyph status="idle" />)
    expect(container.querySelector('.orcha-spin')).toBeNull()
  })
})

describe('HostSidebar — terminal sessions (Orca)', () => {
  it('sessions sit under their project’s branch row with glyph, kind mark, title - snippet and time', () => {
    render(<HostSidebar {...props()} />)
    const [primary] = screen.getAllByTestId('checkout')
    const sessionRows = within(primary).getAllByTestId('session-row')
    expect(sessionRows.map((r) => r.textContent)).toEqual(['zsh - hi2m', 'zsh - exited 1', 'Project work commitmentnow'])
    // status glyphs: running arc, red x, amber bell
    expect(sessionRows.map((r) => r.querySelector('[data-session-glyph]')?.getAttribute('data-session-glyph'))).toEqual([
      'running',
      'error',
      'attention'
    ])
    // Claude uses the real brand mark
    expect(sessionRows[2].querySelector('[data-mark="claude"]')).not.toBeNull()
    expect(sessionRows[2]).toHaveAccessibleName(/^Project work commitment · waiting for you/)
  })

  it('the active session’s branch group gets the rounded highlight card; the row is current', () => {
    render(<HostSidebar {...props()} />)
    const [primary] = screen.getAllByTestId('checkout')
    expect(primary).toHaveAttribute('data-current', 'true')
    expect(primary.className).toMatch(/rounded-\[10px\]/)
    expect(within(primary).getAllByTestId('session-row')[0]).toHaveAttribute('aria-current', 'true')
    render(<HostSidebar {...props({ activeSessionKey: null })} />)
    expect(screen.getAllByTestId('checkout')[1]).not.toHaveAttribute('data-current')
  })

  it('click opens the session; ⋯ → Rename / Restart (exited only) / Close', async () => {
    const p = props()
    const user = userEvent.setup()
    render(<HostSidebar {...p} />)
    const rowsEls = screen.getAllByTestId('session-row')
    await user.click(rowsEls[0])
    expect(p.sessionActions!.onOpen).toHaveBeenCalledWith('s1')
    // running session: no Restart
    await user.click(screen.getAllByTestId('session-menu')[0])
    let menu = screen.getByRole('menu')
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Rename…', 'Close (ends the process)'])
    await user.keyboard('{Escape}')
    // exited session: Restart + Close
    await user.click(screen.getAllByTestId('session-menu')[1])
    menu = screen.getByRole('menu')
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Rename…', 'Restart', 'Close'])
    await user.click(within(menu).getByRole('menuitem', { name: 'Restart' }))
    expect(p.sessionActions!.onRestart).toHaveBeenCalledWith('s2')
    await user.click(screen.getAllByTestId('session-menu')[1])
    await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Close' }))
    expect(p.sessionActions!.onClose).toHaveBeenCalledWith('s2')
  })

  it('with the tab menu: ⋯ / Shift+F10 open the same Orca menu as the strip; pin glyph + colour dot on the row', async () => {
    const user = userEvent.setup()
    const tabs = [TABS[0], { ...TABS[1], pinned: true, color: 'teal' as const }, TABS[2]]
    const tabMenu = { tabs, onPin: vi.fn(), onCloseTabs: vi.fn(), onColor: vi.fn() }
    const p = props({
      sessions: groupSessions(rows(), tabs),
      sessionActions: { onOpen: vi.fn(), onRename: vi.fn(), onRestart: vi.fn(), onClose: vi.fn(), tabMenu }
    })
    render(<HostSidebar {...p} />)
    const rowsEls = screen.getAllByTestId('session-row')
    // the pinned, teal (exited) session
    expect(rowsEls[1].querySelector('[data-testid="session-pinned"]')).not.toBeNull()
    expect(rowsEls[1].querySelector<HTMLElement>('[data-testid="session-color"]')!.style.background).not.toBe('')
    expect(rowsEls[1]).toHaveAccessibleName(/· pinned · Teal$/)
    expect(rowsEls[0].querySelector('[data-testid="session-pinned"]')).toBeNull()
    await user.click(screen.getAllByTestId('session-menu')[1])
    let menu = screen.getByRole('menu', { name: 'Tab actions' })
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual([
      'Restart',
      'Unpin Tab',
      'Close⌘W',
      'Close Others',
      'Close Tabs To The Right',
      'Close Tabs To The Left',
      'Change TitleF2'
    ])
    expect(within(menu).getByRole('group', { name: 'Tab Color' })).toBeInTheDocument()
    await user.click(within(menu).getByRole('menuitem', { name: 'Close Others' }))
    expect(tabMenu.onCloseTabs).toHaveBeenCalledWith(['s1', 'c1'])
    await user.click(screen.getAllByTestId('session-menu')[1])
    await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Restart' }))
    expect(p.sessionActions!.onRestart).toHaveBeenCalledWith('s2')
    // keyboard: Shift+F10 on the row, Escape returns focus to the ⋯ trigger
    rowsEls[0].focus()
    await user.keyboard('{Shift>}{F10}{/Shift}')
    menu = screen.getByRole('menu', { name: 'Tab actions' })
    await user.click(within(menu).getByRole('menuitem', { name: 'Pin Tab' }))
    expect(tabMenu.onPin).toHaveBeenCalledWith('s1', true)
    await user.click(screen.getAllByTestId('session-menu')[0])
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getAllByTestId('session-menu')[0]).toHaveFocus()
  })

  it('rename from the ⋯ menu or F2 on the row', async () => {
    const p = props()
    const user = userEvent.setup()
    render(<HostSidebar {...p} />)
    screen.getAllByTestId('session-row')[0].focus()
    await user.keyboard('{F2}')
    const input = screen.getByRole('textbox', { name: 'Session name' })
    await user.clear(input)
    await user.type(input, 'server{Enter}')
    expect(p.sessionActions!.onRename).toHaveBeenCalledWith('s1', 'server')
  })

  it('session rows are in the tree’s roving focus (↑/↓ reach them)', () => {
    render(<HostSidebar {...props()} />)
    const project = screen.getByRole('button', { name: /^fleet-mate,/ })
    project.focus()
    fireEvent.keyDown(project, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getAllByTestId('session-row')[0])
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getAllByTestId('session-row')[1])
  })

  it('a collapsed project hides its sessions but shows a count of running ones', () => {
    render(<HostSidebar {...props({ agentsExpanded: { 'orcha-fleet:c1': false } })} />)
    expect(screen.queryAllByTestId('session-row')).toHaveLength(0)
    expect(screen.getByTestId('session-count')).toHaveTextContent('2')
    expect(screen.getByTestId('session-count')).toHaveAccessibleName('2 terminal sessions running')
  })

  it('project ⋯ menu: an Orca "Open" section (New Terminal ⌘T, Claude ⌥⌘T, Codex) above the existing items', async () => {
    const p = props()
    const user = userEvent.setup()
    render(<HostSidebar {...p} />)
    await user.click(screen.getAllByTestId('project-menu')[0])
    const menu = screen.getByRole('menu')
    const items = within(menu).getAllByRole('menuitem')
    expect(items.slice(0, 4).map((m) => m.textContent)).toEqual(['New Terminal⌘T', 'Claude⌥⌘T', 'Codex', 'Open project'])
    expect(items[1].querySelector('[data-mark="claude"]')).not.toBeNull()
    expect(items[2].querySelector('[data-mark="openai"]')).not.toBeNull()
    expect(items[0]).toHaveAttribute('aria-keyshortcuts', 'Meta+T')
    expect(within(menu).getAllByRole('separator').length).toBeGreaterThanOrEqual(1)
    await user.click(items[1])
    expect(p.onLaunch).toHaveBeenCalledWith(p.rows[0], 'claude', null)
  })

  it('branch row ⋯: launches in that branch (primary = the project folder itself)', async () => {
    const p = props()
    const user = userEvent.setup()
    render(<HostSidebar {...p} />)
    await user.click(screen.getAllByTestId('checkout-menu')[0])
    const menu = screen.getByRole('menu', { name: 'Actions for branch main' })
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['New Terminal⌘T', 'Claude⌥⌘T', 'Codex'])
    await user.click(within(menu).getByRole('menuitem', { name: /^Codex/ }))
    expect(p.onLaunch).toHaveBeenCalledWith(p.rows[0], 'codex', null)
  })

  it('home-folder sessions show in a "This Mac" group', () => {
    const r = rows()
    render(<HostSidebar {...props({ sessions: groupSessions(r, [tab('h', { project: null, rowKey: null, branch: null })]) })} />)
    const local = screen.getByTestId('local-sessions')
    expect(within(local).getByText('This Mac')).toBeInTheDocument()
    expect(within(local).getAllByTestId('session-row')).toHaveLength(1)
  })

  it('layout (sidebar clip): the sidebar and its rows never use negative offsets / translate to the left', () => {
    const { container } = render(<HostSidebar {...props()} />)
    const nav = screen.getByTestId('host-sidebar')
    expect(nav.style.width).toBe('272px')
    expect(nav.className).toMatch(/shrink-0/)
    for (const el of Array.from(container.querySelectorAll<HTMLElement>('*'))) {
      const cls = typeof el.className === 'string' ? el.className : ''
      expect(cls).not.toMatch(/(^|\s)-(ml|mx|left|translate-x)-/)
    }
  })
})
