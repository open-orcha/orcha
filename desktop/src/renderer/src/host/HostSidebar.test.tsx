// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { paletteColor } from '../../../shared/palette'
import HostSidebar, { agentFragment, agentTooltip, type HostSidebarProps } from './HostSidebar'
import { buildProjectRows } from './projectModel'
import type { AttentionSnapshot, HostLiveAgent, ProjectContainer, Stack } from '../../../shared/types'

const stack: Stack = {
  project: 'orcha-web',
  projectShort: 'web',
  apiPort: 8001,
  dbPort: 5432,
  portalStatus: 'Up',
  running: true,
  folder: null,
  runtime: 'docker',
  health: 'ok'
}
const container = (id: string, name: string): ProjectContainer => ({
  id,
  name,
  description: null,
  status: 'active',
  github_repo: null,
  agents: 3,
  tasks: 3,
  needs_you: 0,
  member_count: 1,
  icon: null
})
const agent = (alias: string, state: HostLiveAgent['state'], task: string | null = null): HostLiveAgent => ({
  alias,
  state,
  task,
  lastActive: null
})

const LIVE = [
  agent('lead', 'needs_review', 'Verify CSV export'),
  agent('qa-bot', 'blocked', 'Upgrade Playwright'),
  agent('frontend-dev', 'working', 'Add dark-mode tokens to the portal shell'),
  agent('backend-dev', 'working', 'Tune autovacuum')
]

function rows(live: HostLiveAgent[] | undefined = LIVE, liveTotal = 5, ok = true) {
  const attention: AttentionSnapshot = {
    items: [],
    projects: [
      {
        project: 'orcha-web',
        containers: [
          { cid: 'c1', name: 'orcha-web', count: 2, partial: false, ...(live ? { live, liveTotal } : {}) },
          { cid: 'c2', name: 'mobile', count: 0, partial: false, live: [agent('ios-dev', 'working', 'Fix login')], liveTotal: 1 }
        ],
        unavailable: [],
        fetchedAt: null,
        ok
      }
    ]
  }
  return buildProjectRows({
    stacks: [stack],
    cards: [
      { stack, container: container('c1', 'orcha-web') },
      { stack, container: container('c2', 'mobile') }
    ],
    attention,
    pinned: new Set(),
    order: [],
    active: { project: null, cid: null, portalAttention: null }
  })
}

function props(over: Partial<HostSidebarProps> = {}): HostSidebarProps {
  return {
    rows: rows(),
    total: { count: 2, partial: false, unknown: 0 },
    activeKey: 'orcha-web:c1',
    activeSection: null,
    width: 260,
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
    ...over
  }
}

beforeEach(() => {
  window.orchaDesktop = { setHostModal: vi.fn().mockResolvedValue(undefined) } as unknown as typeof window.orchaDesktop
})

describe('HostSidebar — live agents nested under their project (D11)', () => {
  it('the open project is expanded by default: max 3 agents, then "+N more"', () => {
    render(<HostSidebar {...props()} />)
    const tree = screen.getByRole('list', { name: 'orcha-web branches, agents and terminals' })
    const agents = within(tree).getAllByTestId('live-agent')
    expect(agents).toHaveLength(3)
    // status glyph + round avatar + name + " - " + muted fragment
    expect(agents.map((a) => a.textContent)).toEqual([
      'Llead - needs review',
      'Qqa-bot - blocked',
      'Ffrontend-dev - Add dark-mode tokens to the portal shell'
    ])
    expect(agents.map((a) => a.querySelector('[data-state-glyph]')?.getAttribute('data-state-glyph'))).toEqual([
      'needs_review',
      'blocked',
      'working'
    ])
    // no branch data → agents sit directly under the project, no checkout rows
    expect(within(tree).queryAllByTestId('checkout')).toHaveLength(0)
    expect(within(tree).getByRole('list', { name: 'Live agents and terminals in orcha-web' })).toBeInTheDocument()
    // 5 live in total, 3 shown → +2 more
    expect(within(tree).getByTestId('live-agents-more').textContent).toBe('+2 more')
    // other (not open) projects stay collapsed until their caret is used
    expect(screen.queryByRole('list', { name: 'mobile branches, agents and terminals' })).toBeNull()
  })

  it('no standalone "Live agents" section exists', () => {
    render(<HostSidebar {...props()} />)
    expect(screen.queryByText(/^Live agents$/)).toBeNull()
    expect(screen.queryByText(/View all agents/)).toBeNull()
  })

  it('"+N more" navigates the embedded portal to that project\'s Agents tab', async () => {
    const p = props()
    render(<HostSidebar {...p} />)
    await userEvent.click(screen.getByTestId('live-agents-more'))
    expect(p.onNavigate).toHaveBeenCalledWith(expect.objectContaining({ key: 'orcha-web:c1' }), '/agents')
  })

  it('an agent row opens that agent in its project', async () => {
    const p = props()
    render(<HostSidebar {...p} />)
    await userEvent.click(screen.getAllByTestId('live-agent')[2])
    expect(p.onNavigate).toHaveBeenCalledWith(expect.objectContaining({ key: 'orcha-web:c1' }), '/agents?agent=frontend-dev')
  })

  it('the caret toggles a project and reports the explicit choice (persisted by the host)', async () => {
    const p = props()
    render(<HostSidebar {...p} />)
    const carets = screen.getAllByTestId('project-caret')
    expect(carets.map((c) => c.getAttribute('aria-expanded'))).toEqual(['true', 'false'])
    await userEvent.click(carets[1])
    expect(p.onToggleAgents).toHaveBeenCalledWith(expect.objectContaining({ key: 'orcha-web:c2' }), true)
    await userEvent.click(carets[0])
    expect(p.onToggleAgents).toHaveBeenCalledWith(expect.objectContaining({ key: 'orcha-web:c1' }), false)
  })

  it('stored choices override the default (open collapsed, other expanded)', () => {
    render(<HostSidebar {...props({ agentsExpanded: { 'orcha-web:c1': false, 'orcha-web:c2': true } })} />)
    expect(screen.queryByRole('list', { name: 'Live agents and terminals in orcha-web' })).toBeNull()
    const mobile = screen.getByRole('list', { name: 'mobile branches, agents and terminals' })
    expect(within(mobile).getAllByTestId('live-agent')).toHaveLength(1)
    expect(within(mobile).queryByTestId('live-agents-more')).toBeNull()
  })

  it('an unreachable project shows no agents and no caret (never stale/fake agents)', () => {
    render(<HostSidebar {...props({ rows: rows(LIVE, 5, false) })} />)
    expect(screen.queryAllByTestId('live-agent')).toHaveLength(0)
    expect(screen.queryAllByTestId('project-caret')).toHaveLength(0)
  })

  it('a project with no live agents has no caret; its attention count stays on the project row', () => {
    render(<HostSidebar {...props({ rows: rows([], 0) })} />)
    const carets = screen.getAllByTestId('project-caret')
    expect(carets).toHaveLength(1) // only "mobile"
    const webRow = screen.getByRole('button', { name: /^orcha-web, running/ })
    expect(webRow.textContent).toContain('2')
  })

  it('project and agent avatars are round with distinct palette colours', () => {
    render(<HostSidebar {...props()} />)
    const avatars = screen.getAllByTestId('agent-avatar')
    expect(avatars.every((a) => a.className.includes('rounded-full'))).toBe(true)
    expect(new Set(avatars.map((a) => a.style.background)).size).toBe(avatars.length)
  })
})

describe('agent fragments', () => {
  it('one short muted fragment: task title, "needs review" or "blocked"', () => {
    expect(agentFragment(agent('a', 'working', 'Ship it'))).toBe('Ship it')
    expect(agentFragment(agent('a', 'working'))).toBe('working')
    expect(agentFragment(agent('a', 'needs_review', 'X'))).toBe('needs review')
    expect(agentFragment(agent('a', 'blocked', 'X'))).toBe('blocked')
    // VD-09: an agent waiting on a request reads as neutral "waiting", never its task/"working".
    expect(agentFragment(agent('a', 'waiting', 'X'))).toBe('waiting')
  })

  it('tooltip carries the full sentence', () => {
    expect(agentTooltip(agent('lead', 'needs_review', 'Verify CSV'))).toBe('lead · needs review: “Verify CSV”')
    expect(agentTooltip(agent('qa', 'blocked', 'Upgrade'))).toBe('qa · blocked — waiting on a request (“Upgrade”)')
    expect(agentTooltip(agent('qa', 'waiting', 'Upgrade'))).toBe('qa · waiting on a reply (“Upgrade”)')
    expect(agentTooltip({ ...agent('fe', 'working', 'Tokens'), lastActive: new Date(Date.now() - 5 * 60_000).toISOString() })).toBe(
      'fe · working on “Tokens” · active 5m ago'
    )
  })
})

describe('HostSidebar — Orca-style project tree + icons (D14)', () => {
  const MAIN = { branch: 'main', primary: true, detached: false, repo: 'acme/web' }
  const TASK = { branch: 'orcha/task-lead-3f2a9c1e-4b7', primary: false, detached: false, repo: 'acme/web' }
  function branchRows() {
    const attention: AttentionSnapshot = {
      items: [],
      projects: [
        {
          project: 'orcha-web',
          containers: [
            {
              cid: 'c1',
              name: 'orcha-web',
              count: 2,
              partial: false,
              live: [
                { ...agent('lead', 'working', 'Ship export'), branch: TASK.branch, lastActive: new Date(Date.now() - 5 * 60_000).toISOString() },
                { ...agent('qa-bot', 'blocked', 'Upgrade'), branch: null }
              ],
              liveTotal: 2,
              checkouts: [MAIN, TASK]
            },
            // branch data but nothing live: the primary checkout alone is a child
            { cid: 'c2', name: 'mobile', count: 0, partial: false, live: [], liveTotal: 0, checkouts: [MAIN] }
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
        { stack, container: container('c1', 'orcha-web') },
        { stack, container: container('c2', 'mobile') }
      ],
      attention,
      pinned: new Set(),
      order: [],
      active: { project: null, cid: null, portalAttention: null }
    })
  }

  it('branch data: project → checkout rows (primary badge, muted repo) → agents under their branch', () => {
    render(<HostSidebar {...props({ rows: branchRows() })} />)
    const tree = screen.getByRole('list', { name: 'orcha-web branches, agents and terminals' })
    const checkouts = within(tree).getAllByTestId('checkout')
    expect(checkouts.map((c) => c.getAttribute('aria-label'))).toEqual([
      'Branch main (primary checkout) · acme/web',
      'Branch orcha/task-lead-3f2a9c1e-4b7 · acme/web'
    ])
    expect(within(checkouts[0]).getByText('primary')).toBeInTheDocument()
    expect(within(checkouts[1]).queryByText('primary')).toBeNull()
    expect(within(checkouts[0]).getByText('acme/web')).toBeInTheDocument()
    expect(within(checkouts[1]).queryByText('acme/web')).toBeNull() // not repeated on worktree rows (D12)
    // lead sits under its task branch, with a right-aligned relative time
    const lead = within(checkouts[1]).getByTestId('live-agent')
    expect(lead.textContent).toBe('Llead - Ship export5m')
    // qa-bot's branch is unknown → directly under the project, never under a guessed branch
    const loose = within(tree).getByRole('list', { name: 'Live agents and terminals in orcha-web' })
    expect(within(loose).getAllByTestId('live-agent').map((a) => a.textContent)).toEqual(['Qqa-bot - blocked'])
  })

  it('every project with children shows its caret — also one whose only child is its checkout', () => {
    render(<HostSidebar {...props({ rows: branchRows() })} />)
    const carets = screen.getAllByTestId('project-caret')
    expect(carets.map((c) => c.getAttribute('aria-label'))).toEqual(['Collapse orcha-web', 'Expand mobile'])
  })

  it('carets live in a fixed left gutter so icons line up with or without a caret', () => {
    render(<HostSidebar {...props({ rows: rows([], 0) })} />)
    const webRow = screen.getByRole('button', { name: /^orcha-web, running/ }).parentElement!
    const mobileRow = screen.getByRole('button', { name: /^mobile, running/ }).parentElement!
    // same gutter element (w-5) first in both rows; only mobile's holds a caret
    expect(webRow.firstElementChild?.className).toContain('w-5')
    expect(mobileRow.firstElementChild?.className).toContain('w-5')
    expect(within(webRow.firstElementChild as HTMLElement).queryByTestId('project-caret')).toBeNull()
    expect(within(mobileRow.firstElementChild as HTMLElement).getByTestId('project-caret')).toBeInTheDocument()
  })

  it('⋯ is revealed on hover AND keyboard focus (not only for the open project)', () => {
    render(<HostSidebar {...props({ activeKey: null })} />)
    const more = screen.getByRole('button', { name: 'More actions for mobile' })
    expect(more.className).toContain('opacity-0')
    expect(more.className).toContain('group-hover:opacity-100')
    expect(more.className).toContain('group-focus-within:opacity-100')
    expect(more.className).toContain('focus-visible:opacity-100')
  })

  it('keyboard: → expands and ← collapses a project; Tab reaches its ⋯ menu', async () => {
    const p = props({ activeKey: null })
    render(<HostSidebar {...p} />)
    const user = userEvent.setup()
    const web = screen.getByRole('button', { name: /^orcha-web, running/ })
    web.focus()
    await user.keyboard('{ArrowRight}')
    expect(p.onToggleAgents).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'orcha-web:c1' }), true)
    await user.tab()
    expect(screen.getByRole('button', { name: 'More actions for orcha-web' })).toHaveFocus()
  })

  it('projects show the user icon, or the neutral default glyph — never initials', () => {
    render(<HostSidebar {...props({ icons: { c2: { kind: 'emoji', value: '📱' } } })} />)
    const web = screen.getByRole('button', { name: /^orcha-web, running/ })
    const mobile = screen.getByRole('button', { name: /^mobile, running/ })
    expect(within(web).getByTestId('project-icon')).toHaveAttribute('data-icon', 'default')
    expect(web.textContent).not.toContain('OW')
    expect(within(mobile).getByTestId('project-icon')).toHaveAttribute('data-icon', 'emoji:📱')
    // agents keep their round avatars (D7)
    expect(screen.getAllByTestId('agent-avatar').length).toBeGreaterThan(0)
  })

  it('Change icon… is fully keyboard operable: menu → picker (search focused) → ↓ → Enter; Esc returns focus', async () => {
    const onSetIcon = vi.fn()
    render(<HostSidebar {...props({ onSetIcon, emojiRecents: ['🐙'] })} />)
    const user = userEvent.setup()
    const trigger = screen.getByRole('button', { name: 'More actions for mobile' })
    trigger.focus()
    await user.keyboard('{Enter}')
    const item = screen.getByRole('menuitem', { name: 'Change icon…' })
    item.focus()
    await user.keyboard('{Enter}')
    const picker = await screen.findByRole('dialog', { name: 'Change icon for mobile' })
    const search = within(picker).getByRole('textbox', { name: 'Search emoji' })
    expect(search).toHaveFocus()
    // recents row first
    await within(picker).findByRole('region', { name: 'Recent' })
    await user.keyboard('{ArrowDown}')
    expect(within(picker).getByRole('button', { name: 'Recent: 🐙' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(onSetIcon).toHaveBeenCalledWith(expect.objectContaining({ key: 'orcha-web:c2' }), { kind: 'emoji', value: '🐙' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(trigger).toHaveFocus()
    // reopen, Escape closes and restores focus
    await user.keyboard('{Enter}')
    screen.getByRole('menuitem', { name: 'Change icon…' }).focus()
    await user.keyboard('{Enter}')
    await screen.findByRole('dialog', { name: 'Change icon for mobile' })
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(trigger).toHaveFocus()
  })

  it('a stopped stack: Change icon… is disabled with the reason (never a local-only icon)', async () => {
    const onSetIcon = vi.fn()
    const stopped: Stack = { ...stack, project: 'orcha-api', projectShort: 'api', running: false, apiPort: null }
    const r = buildProjectRows({
      stacks: [stopped],
      cards: [],
      attention: null,
      pinned: new Set(),
      order: [],
      active: { project: null, cid: null, portalAttention: null }
    })
    render(<HostSidebar {...props({ rows: r, activeKey: null, onSetIcon })} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'More actions for api' }))
    const item = screen.getByRole('menuitem', { name: /Change icon…/ })
    expect(item).toHaveAttribute('aria-disabled', 'true')
    expect(item).toHaveTextContent("Can't reach this project — start it to change its icon")
    await userEvent.setup().click(item)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onSetIcon).not.toHaveBeenCalled()
  })

  it('shows a failed icon write under that row, dismissible', async () => {
    const onDismissIconError = vi.fn()
    render(
      <HostSidebar
        {...props({ iconError: { key: 'orcha-web:c2', message: "You don't have permission to change this project's icon" }, onDismissIconError })}
      />
    )
    const alert = screen.getByTestId('icon-error')
    expect(alert).toHaveAttribute('role', 'alert')
    expect(alert).toHaveTextContent("You don't have permission")
    await userEvent.setup().click(within(alert).getByRole('button', { name: 'Dismiss' }))
    expect(onDismissIconError).toHaveBeenCalled()
  })

  it('offers the icon picked on this Mac (migration refused) in the picker', async () => {
    const onSetIcon = vi.fn()
    render(<HostSidebar {...props({ onSetIcon, iconOffer: (row) => (row.key === 'orcha-web:c2' ? { kind: 'emoji', value: '📱' } : null) })} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'More actions for mobile' }))
    await user.click(screen.getByRole('menuitem', { name: 'Change icon…' }))
    const picker = await screen.findByRole('dialog', { name: 'Change icon for mobile' })
    await user.click(within(within(picker).getByTestId('icon-suggestion')).getByRole('button', { name: 'Use it' }))
    expect(onSetIcon).toHaveBeenCalledWith(expect.objectContaining({ key: 'orcha-web:c2' }), { kind: 'emoji', value: '📱' })
  })

  it('D13: an agent uses the palette slot the host poller carried (the portal roster slot)', () => {
    const live = [{ ...agent('lead', 'working', 'x'), palette: 7 }]
    render(<HostSidebar {...props({ rows: rows(live, 1) })} />)
    const ref = document.createElement('span')
    ref.style.background = paletteColor(7).background
    const lead = screen.getAllByTestId('agent-avatar')[0]
    expect(lead.style.background).toBe(ref.style.background)
  })
})


describe('HostSidebar — Remove project… (⋯ menu)', () => {
  it('is the LAST item, after a separator, in the danger colour with a trash icon', async () => {
    render(<HostSidebar {...props({ onRemove: vi.fn() })} />)
    await userEvent.click(screen.getByRole('button', { name: 'More actions for mobile' }))
    const menu = screen.getByRole('menu', { name: 'Actions for mobile' })
    const items = within(menu).getAllByRole('menuitem')
    const last = items[items.length - 1]
    expect(last).toHaveTextContent('Remove project…')
    expect(last).toHaveAttribute('data-menu-item', 'remove-project')
    expect(last.className).toContain('text-danger')
    expect(last.querySelector('svg')).not.toBeNull()
    // the element right before it is a separator
    expect(last.previousElementSibling).toHaveAttribute('role', 'separator')
  })

  it('is keyboard reachable: ↑ from the first item wraps to it, Enter fires onRemove with the row', async () => {
    const onRemove = vi.fn()
    render(<HostSidebar {...props({ onRemove })} />)
    const user = userEvent.setup()
    const trigger = screen.getByRole('button', { name: 'More actions for mobile' })
    trigger.focus()
    await user.keyboard('{Enter}')
    await user.keyboard('{ArrowUp}')
    expect(screen.getByRole('menuitem', { name: 'Remove project…' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(onRemove).toHaveBeenCalledWith(expect.objectContaining({ key: 'orcha-web:c2', name: 'mobile' }))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(trigger).toHaveFocus()
  })

  it('is absent when the host does not offer removal', async () => {
    render(<HostSidebar {...props()} />)
    await userEvent.click(screen.getByRole('button', { name: 'More actions for mobile' }))
    expect(screen.queryByRole('menuitem', { name: 'Remove project…' })).toBeNull()
  })
})
