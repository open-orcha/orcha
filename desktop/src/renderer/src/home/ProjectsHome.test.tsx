// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ProjectsHome, { projectsInStack, type ProjectsHomeProps } from './ProjectsHome'
import { buildProjectRows, type ProjectRow } from '../host/projectModel'
import type { AttentionSnapshot, ProjectContainer, Stack } from '../../../shared/types'

function stack(over: Partial<Stack> = {}): Stack {
  return {
    project: 'orcha-a',
    projectShort: 'a',
    apiPort: 8001,
    dbPort: 5432,
    portalStatus: 'Up',
    running: true,
    folder: '/tmp/a',
    runtime: 'docker',
    health: 'ok',
    ...over
  }
}

function container(over: Partial<ProjectContainer> = {}): ProjectContainer {
  return {
    id: 'c1',
    name: 'Demo project',
    description: null,
    status: 'active',
    github_repo: null,
    agents: 2,
    tasks: 3,
    needs_you: 0,
    member_count: 1,
    icon: null,
    ...over
  }
}

function rowsFor(
  stacks: Stack[],
  cards: Array<{ stack: Stack; container: ProjectContainer }>,
  attention: AttentionSnapshot | null = null,
  pinned: string[] = []
): ProjectRow[] {
  return buildProjectRows({
    stacks,
    cards,
    attention,
    pinned: new Set(pinned),
    order: [],
    active: { project: null, cid: null, portalAttention: null }
  })
}

function props(over: Partial<ProjectsHomeProps> = {}): ProjectsHomeProps {
  return {
    rows: [],
    loaded: true,
    dockerDown: false,
    busy: {},
    errors: {},
    onCreate: vi.fn(),
    onOpen: vi.fn(),
    onNavigate: vi.fn(),
    onStart: vi.fn(),
    onStop: vi.fn(),
    onTogglePin: vi.fn(),
    onDismissError: vi.fn(),
    onRefresh: vi.fn().mockResolvedValue(undefined),
    ...over
  }
}

beforeEach(() => {
  window.orchaDesktop = {
    resetStack: vi.fn().mockResolvedValue(undefined),
    setHostModal: vi.fn().mockResolvedValue(undefined),
    probePrereqs: vi
      .fn()
      .mockResolvedValue({ homebrew: true, dockerEngine: true, orcha: true, claude: true, codex: true }),
    installPrereqs: vi.fn().mockResolvedValue({ ok: true, completed: [] }),
    onInstallProgress: vi.fn().mockReturnValue(() => {})
  } as never
})

const A = stack()
const attentionFor = (cid: string, count: number): AttentionSnapshot => ({
  items: [],
  projects: [
    { project: 'orcha-a', containers: [{ cid, name: 'x', count, partial: false }], unavailable: [], fetchedAt: null, ok: true }
  ]
})

describe('ProjectsHome (Linear table in the inset panel)', () => {
  it('renders one row per project with real agent/task counts and ONE primary action', () => {
    render(<ProjectsHome {...props({ rows: rowsFor([A], [{ stack: A, container: container() }]) })} />)
    const row = screen.getByTestId('project-row')
    expect(within(row).getByRole('button', { name: 'Open Demo project' })).toBeInTheDocument()
    const cells = within(row).getAllByRole('cell')
    expect(cells.some((c) => c.textContent === '2')).toBe(true)
    expect(cells.some((c) => c.textContent === '3')).toBe(true)
    // D2: exactly one accent-filled (primary) button in the view — "New project".
    const primaries = screen.getAllByRole('button').filter((b) => b.className.includes('bg-accent '))
    expect(primaries.map((b) => b.textContent)).toEqual(['New project'])
  })

  it('clicking the row opens the project; New project starts the wizard', async () => {
    const p = props({ rows: rowsFor([A], [{ stack: A, container: container() }]) })
    render(<ProjectsHome {...p} />)
    await userEvent.click(screen.getByRole('button', { name: 'Open Demo project' }))
    expect(p.onOpen).toHaveBeenCalledWith(expect.objectContaining({ key: 'orcha-a:c1' }))
    await userEvent.click(screen.getByRole('button', { name: /new project/i }))
    expect(p.onCreate).toHaveBeenCalled()
  })

  it('health comes from the SAME attention the sidebar uses (never the stale card field)', () => {
    const rows = rowsFor([A], [{ stack: A, container: container({ needs_you: 12 }) }], attentionFor('c1', 3))
    render(<ProjectsHome {...props({ rows })} />)
    expect(screen.getByText('Needs you · 3')).toBeInTheDocument()
    expect(screen.queryByText(/12/)).toBeNull()
  })

  it('unknown attention reads "Checking…", zero reads "All clear"', () => {
    const { rerender } = render(<ProjectsHome {...props({ rows: rowsFor([A], [{ stack: A, container: container() }]) })} />)
    expect(screen.getByText('Checking…')).toBeInTheDocument()
    rerender(<ProjectsHome {...props({ rows: rowsFor([A], [{ stack: A, container: container() }], attentionFor('c1', 0)) })} />)
    expect(screen.getByText('All clear')).toBeInTheDocument()
  })

  it('a paused container reads Paused everywhere (not a green running state)', () => {
    render(<ProjectsHome {...props({ rows: rowsFor([A], [{ stack: A, container: container({ status: 'paused' }) }]) })} />)
    const band = screen.getByRole('rowgroup', { name: 'Paused' })
    expect(within(band).getAllByText('Paused')).toHaveLength(2) // band header + health chip
    expect(screen.queryByRole('rowgroup', { name: 'Running' })).toBeNull()
  })

  it('a stopped stack is a single honest row with a quiet Start', async () => {
    const S = stack({ project: 'orcha-legacy', projectShort: 'legacy', running: false, apiPort: null })
    const p = props({ rows: rowsFor([S], []) })
    render(<ProjectsHome {...p} />)
    expect(within(screen.getByTestId('project-row')).getByText('Stopped')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Start' }))
    expect(p.onStart).toHaveBeenCalledWith(expect.objectContaining({ key: 'orcha-legacy' }))
  })

  it('a start error sits on its own line under the row, readable and dismissible (not raw stderr in the row)', async () => {
    const S = stack({ project: 'orcha-legacy', projectShort: 'legacy', running: false, apiPort: null })
    const stderr = 'Container x Starting\nError response from daemon: Bind for 0.0.0.0:8001 failed: port is already allocated'
    const p = props({ rows: rowsFor([S], []), errors: { 'orcha-legacy': { action: 'start', error: { code: 'COMPOSE_FAILED', stderr } } } })
    render(<ProjectsHome {...p} />)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Couldn’t start legacy: Port 8001 is already in use — stop whatever is using it, then try again.')
    expect(alert).not.toHaveTextContent('Error response from daemon')
    await userEvent.click(within(alert).getByRole('button', { name: 'Details' }))
    expect(alert).toHaveTextContent('Container x Starting')
    await userEvent.click(within(alert).getByRole('button', { name: /dismiss/i }))
    expect(p.onDismissError).toHaveBeenCalledWith('orcha-legacy')
  })

  it('shows one error per stack even when the stack has several projects', () => {
    const rows = rowsFor([A], [
      { stack: A, container: container({ id: 'c1', name: 'acme-web' }) },
      { stack: A, container: container({ id: 'c2', name: 'acme-admin' }) }
    ])
    render(<ProjectsHome {...props({ rows, errors: { 'orcha-a': { action: 'stop', error: { code: 'COMPOSE_FAILED', stderr: 'boom' } } } })} />)
    expect(screen.getAllByRole('alert')).toHaveLength(1)
  })

  it('"Delete stack…" names the stack and lists every sibling project before deleting', async () => {
    const W = stack({ project: 'orcha-acme-web', projectShort: 'acme-web' })
    const rows = rowsFor([W], [
      { stack: W, container: container({ id: 'c1', name: 'acme-web' }) },
      { stack: W, container: container({ id: 'c2', name: 'acme-admin' }) }
    ])
    const p = props({ rows })
    render(<ProjectsHome {...p} />)
    await userEvent.click(screen.getByRole('button', { name: 'More actions for acme-admin' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete stack…' }))
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveTextContent('Delete the “acme-web” stack?')
    expect(within(dialog).getByRole('list')).toHaveTextContent('acme-webacme-admin')
    await userEvent.type(within(dialog).getByLabelText(/confirm stack name/i), 'orcha-acme-web')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete stack' }))
    await waitFor(() => expect(window.orchaDesktop.resetStack).toHaveBeenCalledWith('orcha-acme-web'))
    // The host state (and so the sidebar) is refreshed after the mutation.
    await waitFor(() => expect(p.onRefresh).toHaveBeenCalled())
  })

  it('filter pills narrow the list', async () => {
    const S = stack({ project: 'orcha-legacy', projectShort: 'legacy', running: false, apiPort: null })
    render(<ProjectsHome {...props({ rows: rowsFor([A, S], [{ stack: A, container: container() }]) })} />)
    expect(screen.getAllByTestId('project-row')).toHaveLength(2)
    await userEvent.click(screen.getByRole('tab', { name: /stopped/i }))
    expect(screen.getAllByTestId('project-row')).toHaveLength(1)
    expect(screen.getByText('legacy')).toBeInTheDocument()
  })

  it('favorites stay in their status band (star only) and the star toggles through the shared pin handler', async () => {
    const p = props({ rows: rowsFor([A], [{ stack: A, container: container() }], null, ['c1']) })
    render(<ProjectsHome {...p} />)
    expect(screen.queryByRole('rowgroup', { name: 'Favorites' })).toBeNull()
    expect(within(screen.getByRole('rowgroup', { name: 'Running' })).getByText('Demo project')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Unfavorite Demo project' }))
    expect(p.onTogglePin).toHaveBeenCalled()
  })

  it('band counts match the pills: paused and starting projects are not "Running"', async () => {
    const B = stack({ project: 'orcha-b', projectShort: 'b' })
    const C = stack({ project: 'orcha-c', projectShort: 'c' }) // running, container list not loaded → starting
    const rows = rowsFor(
      [A, B, C],
      [
        { stack: A, container: container({ id: 'a1', name: 'alpha' }) },
        { stack: A, container: container({ id: 'a2', name: 'fav' }) },
        { stack: B, container: container({ id: 'b1', name: 'payments', status: 'paused' }) }
      ],
      null,
      ['a2']
    )
    render(<ProjectsHome {...props({ rows })} />)
    const running = screen.getByRole('rowgroup', { name: 'Running' })
    expect(within(running).getAllByTestId('project-row')).toHaveLength(2)
    expect(screen.getByRole('tab', { name: /running/i })).toHaveTextContent('Running2')
    expect(within(screen.getByRole('rowgroup', { name: 'Paused' })).getByText('payments')).toBeInTheDocument()
    expect(screen.getByRole('rowgroup', { name: 'Starting' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: /running/i }))
    expect(screen.getAllByTestId('project-row')).toHaveLength(2)
  })

  it('Starting and Paused get filter pills when their count > 0 (and filter to their band)', async () => {
    const B = stack({ project: 'orcha-b', projectShort: 'b' })
    const C = stack({ project: 'orcha-c', projectShort: 'c' }) // running, no container list yet → starting
    const rows = rowsFor(
      [A, B, C],
      [
        { stack: A, container: container({ id: 'a1', name: 'alpha' }) },
        { stack: B, container: container({ id: 'b1', name: 'payments', status: 'paused' }) }
      ]
    )
    render(<ProjectsHome {...props({ rows })} />)
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent)
    expect(tabs).toEqual(['All3', 'Running1', 'Starting1', 'Paused1', 'Stopped0'])
    await userEvent.click(screen.getByRole('tab', { name: /paused/i }))
    expect(screen.getAllByTestId('project-row')).toHaveLength(1)
    expect(screen.getByText('payments')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: /starting/i }))
    expect(screen.getAllByTestId('project-row')).toHaveLength(1)
    expect(screen.getByRole('rowgroup', { name: 'Starting' })).toBeInTheDocument()
  })

  it('no Starting / Paused pills when nothing is starting or paused', () => {
    const rows = rowsFor([A], [{ stack: A, container: container({ id: 'a1', name: 'alpha' }) }])
    render(<ProjectsHome {...props({ rows })} />)
    expect(screen.queryByRole('tab', { name: /starting/i })).toBeNull()
    expect(screen.queryByRole('tab', { name: /paused/i })).toBeNull()
  })

  it('Docker down (older API): one quiet line, no Open Docker button — never "No projects yet"', () => {
    render(<ProjectsHome {...props({ dockerDown: true })} />)
    expect(screen.getByText('Docker isn’t running.')).toBeInTheDocument()
    expect(screen.queryByText(/no projects yet/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /open docker/i })).toBeNull()
  })

  it('Docker hung: the line says it isn’t responding — not "isn’t running"', () => {
    render(<ProjectsHome {...props({ dockerDown: true, dockerUnresponsive: true })} />)
    expect(screen.getByText('Docker isn’t responding.')).toBeInTheDocument()
    expect(screen.queryByText(/isn’t running/i)).toBeNull()
  })

  it('GH #258: Docker down with native projects listed = a small note, not the blocking notice', () => {
    render(<ProjectsHome {...props({ dockerHidden: true })} />)
    expect(screen.getByTestId('docker-hidden-note')).toHaveTextContent('any Docker projects are hidden')
    expect(screen.queryByText('Docker isn’t running.')).toBeNull()
    expect(screen.queryByRole('button', { name: /open docker/i })).toBeNull()
  })

  it('loading shows a skeleton, empty shows a calm empty state', () => {
    const { rerender } = render(<ProjectsHome {...props({ loaded: false })} />)
    expect(screen.getByLabelText('Loading projects')).toBeInTheDocument()
    rerender(<ProjectsHome {...props()} />)
    expect(screen.getByText('No projects yet')).toBeInTheDocument()
  })
})

describe('projectsInStack', () => {
  it('lists the named projects of one stack only', () => {
    const B = stack({ project: 'orcha-b', projectShort: 'b' })
    const rows = rowsFor([A, B], [
      { stack: A, container: container({ id: 'a1', name: 'one' }) },
      { stack: A, container: container({ id: 'a2', name: 'two' }) },
      { stack: B, container: container({ id: 'b1', name: 'three' }) }
    ])
    expect(projectsInStack(rows, 'orcha-a')).toEqual(['one', 'two'])
  })
})

describe('ProjectsHome — project icons (D14)', () => {
  it('rows show the user icon (or the default glyph); the row menu has "Change icon…" that sets it', async () => {
    const s = stack()
    const rows = rowsFor([s], [
      { stack: s, container: container() },
      { stack: s, container: container({ id: 'c2', name: 'Other' }) }
    ])
    const onSetIcon = vi.fn()
    render(<ProjectsHome {...props({ rows, icons: { c2: { kind: 'glyph', value: 'database', color: 2 } }, onSetIcon })} />)
    const [demo, other] = screen.getAllByTestId('project-row')
    expect(within(demo).getByTestId('project-icon')).toHaveAttribute('data-icon', 'default')
    expect(within(other).getByTestId('project-icon')).toHaveAttribute('data-icon', 'glyph:database')
    const user = userEvent.setup()
    await user.click(within(demo).getByRole('button', { name: 'More actions for Demo project' }))
    await user.click(screen.getByRole('menuitem', { name: 'Change icon…' }))
    const picker = await screen.findByRole('dialog', { name: 'Change icon for Demo project' })
    await user.click(within(picker).getByRole('tab', { name: 'Icons' }))
    await user.click(within(picker).getByRole('radio', { name: 'Colour 5' }))
    await user.click(within(picker).getByRole('button', { name: 'rocket' }))
    expect(onSetIcon).toHaveBeenCalledWith(expect.objectContaining({ key: 'orcha-a:c1' }), { kind: 'glyph', value: 'rocket', color: 4 })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
