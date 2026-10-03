// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'

// xterm needs real layout/canvas; the terminal view itself is covered by the dock tests.
vi.mock('./terminal/TerminalView', () => ({
  default: ({ ptyId }: { ptyId: number }) => <div data-testid="terminal-view" data-pty={ptyId} />
}))

/** Captured onNavigate listener so tests can simulate main→renderer IPC (e.g. the
 *  File→Add Project menu item) without a real Electron process. */
let navigateListener: ((nav: { target: 'onboarding' | 'manager'; variant?: string }) => void) | null = null
/** Captured onPortalActive listener so tests can simulate main's "which portal view is
 *  showing" broadcast (tray/notification/deep-link can change it without a click here). */
let portalActiveListener: ((active: { project: string | null; embed?: string | null; route?: unknown }) => void) | null = null
/** Captured V2 embed-event listeners (App subscribes twice: host state + host actions). */
let embedListeners: Array<(e: { project: string; msg: unknown }) => void> = []
const emitEmbed = (e: { project: string; msg: unknown }): void => {
  act(() => embedListeners.forEach((l) => l(e)))
}

function stub(
  stacks: unknown[],
  portalGetImpl?: (apiPort: number, path: string) => unknown,
  attentionStatus: unknown = { items: [], projects: [] }
) {
  navigateListener = null
  portalActiveListener = null
  embedListeners = []
  window.orchaDesktop = {
    listStacks: vi.fn().mockResolvedValue(stacks),
    startStack: vi.fn(),
    stopStack: vi.fn(),
    resetStack: vi.fn(),
    portalShow: vi.fn(),
    portalHide: vi.fn(),
    listAttention: vi.fn().mockResolvedValue([]),
    openManager: vi.fn(),
    quitApp: vi.fn(),
    preflight: vi.fn().mockResolvedValue({ docker: 'ok', autoStarted: false, hint: null }),
    probePrereqs: vi
      .fn()
      .mockResolvedValue({ homebrew: true, dockerEngine: true, orcha: true, claude: true, codex: true, apiKey: true }),
    installPrereqs: vi.fn().mockResolvedValue({ ok: true, completed: [] }),
    onInstallProgress: vi.fn().mockReturnValue(() => {}),
    pickFolder: vi.fn().mockResolvedValue(null),
    inspectFolder: vi
      .fn()
      .mockResolvedValue({ initialized: false, writable: true, suggestedName: 'x', isGitRepo: true }),
    provision: vi.fn().mockResolvedValue({ project: 'orcha-x', apiPort: 8000, warnings: [] }),
    githubStatus: vi.fn().mockResolvedValue({ authenticated: false, gitInstalled: true }),
    githubRepos: vi.fn().mockResolvedValue([]),
    suggestCloneDest: vi.fn().mockResolvedValue({ parent: '/tmp/orcha-projects', repoName: 'repo' }),
    pickCloneDest: vi.fn().mockResolvedValue(null),
    cloneAndProvision: vi.fn().mockResolvedValue({ project: 'orcha-repo', apiPort: 8000, warnings: [] }),
    openOnboardingPortal: vi.fn(),
    openExternal: vi.fn(),
    onProvisionProgress: vi.fn().mockReturnValue(() => {}),
    onNavigate: vi.fn().mockImplementation((cb) => {
      navigateListener = cb
      return () => {}
    }),
    onPortalActive: vi.fn().mockImplementation((cb) => {
      portalActiveListener = cb
      return () => {}
    }),
    portalGet: vi.fn().mockImplementation(
      portalGetImpl ?? (async () => ({ containers: [] }))
    ),
    portalPost: vi.fn().mockRejectedValue({ code: 'PORTAL_REQUEST_FAILED', status: 404 }),
    portalPut: vi.fn().mockRejectedValue({ code: 'PORTAL_REQUEST_FAILED', status: 404 }),
    analyzeProject: vi.fn().mockResolvedValue({ ok: false, reason: 'claude is not installed on this Mac' }),
    listAttentionStatus: vi.fn().mockResolvedValue(attentionStatus),
    setHostLayout: vi.fn().mockResolvedValue(undefined),
    setHostModal: vi.fn().mockResolvedValue(undefined),
    embedSend: vi.fn().mockResolvedValue(true),
    onEmbedEvent: vi.fn().mockImplementation((cb) => {
      embedListeners.push(cb)
      return () => {
        embedListeners = embedListeners.filter((l) => l !== cb)
      }
    })
  } as never
}

const runningStack = {
  project: 'orcha-x',
  projectShort: 'x',
  apiPort: 8000,
  dbPort: 5432,
  portalStatus: 'Up',
  running: true,
  folder: null
}

describe('App single-window host', () => {
  beforeEach(() => {
    vi.useRealTimers()
    window.localStorage.clear() // sidebar width/collapsed/order/pins persist per test otherwise
  })

  it('starts in onboarding mode when there are no stacks', async () => {
    stub([])
    render(<App />)
    await waitFor(() => expect(screen.getByText(/set up embodent/i)).toBeInTheDocument())
  })

  it('starts on the Projects home screen when stacks exist', async () => {
    stub([runningStack])
    render(<App />)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Projects' })).toBeInTheDocument())
  })

  it('no left rail — the home screen is the only navigation surface', async () => {
    stub([runningStack])
    render(<App />)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Projects' })).toBeInTheDocument())
    expect(screen.queryByTestId('rail')).not.toBeInTheDocument()
  })

  it('New project opens the wizard in add-project framing, with Cancel back home', async () => {
    stub([runningStack])
    const user = userEvent.setup()
    render(<App />)
    const newProject = await screen.findByRole('button', { name: /new project/i })

    await user.click(newProject)
    await waitFor(() => expect(screen.getByText(/add a project/i)).toBeInTheDocument())

    // add-project variant offers a Cancel back to the home screen (first-run onboarding has
    // none — there's nowhere to cancel to before any stack exists).
    // The header Cancel opens a confirm dialog ("Skip setup?"); its own "Skip" button is
    // the actual confirm.
    await user.click(screen.getByRole('button', { name: /cancel/i }))
    // The confirm's wording belongs to the onboarding flow ("Skip" / "Cancel setup" / "Leave").
    await user.click(await screen.findByRole('button', { name: /^(skip|cancel setup|leave)$/i }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Projects' })).toBeInTheDocument())
  })

  it('opening a project card calls portalShow with a ?cid= path; a LEGACY portal gets the TopBar', async () => {
    stub([runningStack], async (_port, path) =>
      path === '/api/containers'
        ? { containers: [{ id: 'c1', name: 'Demo', description: null, status: 'active', github_repo: null, agents: 1, tasks: 2, needs_you: 0, member_count: 1 }] }
        : {}
    )
    const user = userEvent.setup()
    render(<App />)
    await user.click(await screen.findByRole('button', { name: 'Open Demo' }))
    expect(window.orchaDesktop.portalShow).toHaveBeenCalledWith('orcha-x', '/?cid=c1')

    // Simulate main confirming the switch, with an older portal that never answered `ready`.
    act(() => portalActiveListener?.({ project: 'orcha-x', embed: 'legacy' }))
    await waitFor(() => expect(screen.getByTestId('topbar')).toBeInTheDocument())
    expect(screen.queryByTestId('host-sidebar')).not.toBeInTheDocument() // never doubled
    expect(screen.getByText('x')).toBeInTheDocument() // the stack's short name in the TopBar
  })

  it('TopBar "← Projects" hides the portal and returns to the home grid', async () => {
    stub([runningStack])
    render(<App />)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Projects' })).toBeInTheDocument())

    act(() => portalActiveListener?.({ project: 'orcha-x', embed: 'legacy' }))
    await waitFor(() => expect(screen.getByTestId('topbar')).toBeInTheDocument())

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /projects/i }))
    expect(window.orchaDesktop.portalHide).toHaveBeenCalled()
  })

  it('File→Add Project (main-process menu IPC) switches straight into the wizard', async () => {
    stub([runningStack])
    render(<App />)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Projects' })).toBeInTheDocument())

    // Simulate main's sendToManager('orcha:navigate', { target: 'onboarding', variant: 'add-project' }).
    expect(navigateListener).not.toBeNull()
    navigateListener?.({ target: 'onboarding', variant: 'add-project' })

    await waitFor(() => expect(screen.getByText(/add a project/i)).toBeInTheDocument())
  })
})

const demoContainers = {
  containers: [
    { id: 'c1', name: 'Demo', description: null, status: 'active', github_repo: null, agents: 1, tasks: 2, needs_you: 0, member_count: 1, icon: null },
    { id: 'c2', name: 'Second', description: null, status: 'active', github_repo: null, agents: 1, tasks: 0, needs_you: 0, member_count: 1, icon: null }
  ]
}
const demoGet = async (_port: number, path: string) => (path === '/api/containers' ? demoContainers : {})
const demoAttention = {
  items: [
    { project: 'orcha-x', projectShort: 'x', kind: 'request_close', id: 'f1', title: 'Follow up', path: '/requests?req=f1&cid=c1', cid: 'c1' },
    { project: 'orcha-x', projectShort: 'x', kind: 'task_verify', id: 't1', title: 'Verify', path: '/tasks?task=t1&cid=c1', cid: 'c1' }
  ],
  projects: [
    {
      project: 'orcha-x',
      containers: [{ cid: 'c1', name: 'Demo', count: 1, partial: false }],
      unavailable: ['c2'],
      fetchedAt: '2026-09-28T10:00:00Z',
      ok: true
    }
  ]
}

async function renderHost() {
  stub([runningStack], demoGet, demoAttention)
  render(<App />)
  const sidebar = await screen.findByTestId('host-sidebar')
  await waitFor(() => expect(within(sidebar).getByText('Second')).toBeInTheDocument())
  return sidebar
}

/** Main confirms the V2 portal for orcha-x/c1 answered `ready` and reported its route. */
function openV2(path = '/tasks') {
  act(() => portalActiveListener?.({ project: 'orcha-x', embed: 'v2', route: null }))
  emitEmbed({ project: 'orcha-x', msg: { type: 'ready', version: 1 } })
  emitEmbed({ project: 'orcha-x', msg: { type: 'route', path, search: '?cid=c1', title: 'Tasks' } })
}

describe('App — V2 host sidebar (arch §7)', () => {
  beforeEach(() => {
    vi.useRealTimers()
    window.localStorage.clear() // sidebar width/collapsed/order/pins persist per test otherwise
  })

  it('renders one row per project with its needs-you count; unavailable is not shown as 0', async () => {
    const sidebar = await renderHost()
    const demo = within(sidebar).getByRole('button', { name: /^Demo/ })
    await waitFor(() => expect(within(demo).getByText('1')).toBeInTheDocument())
    const second = within(sidebar).getByRole('button', { name: /^Second/ })
    expect(within(second).queryByText('0')).not.toBeInTheDocument()
    // Top total counts decisions only (the follow-up is excluded) and discloses the gap.
    const needs = within(sidebar).getByRole('button', { name: /^Needs you/ })
    expect(needs).toHaveAttribute('title', '1 decision waiting across local projects · 1 project couldn’t be checked')
    // No unexplained "+": the unknown project is flagged on its own row instead.
    expect(needs).not.toHaveTextContent('+')
    expect(within(second).getByTestId('attention-unknown')).toHaveAttribute('title', expect.stringMatching(/unavailable/))
  })

  it('reports the sidebar width to main and re-reports on collapse', async () => {
    const sidebar = await renderHost()
    expect(window.orchaDesktop.setHostLayout).toHaveBeenCalledWith({ sidebarWidth: 272, collapsed: false, stripHeight: 0, terminalShown: false })
    await userEvent.setup().click(within(sidebar).getByRole('button', { name: 'Collapse sidebar' }))
    await waitFor(() =>
      expect(window.orchaDesktop.setHostLayout).toHaveBeenLastCalledWith({ sidebarWidth: 56, collapsed: true, stripHeight: 0, terminalShown: false })
    )
    expect(screen.getByTestId('host-sidebar')).toHaveAttribute('data-collapsed', 'true')
  })

  it('re-reports the layout on window resize so main re-applies the zoom factor (QA 3)', async () => {
    await renderHost()
    const calls = vi.mocked(window.orchaDesktop.setHostLayout!).mock.calls.length
    act(() => window.dispatchEvent(new Event('resize')))
    expect(vi.mocked(window.orchaDesktop.setHostLayout!).mock.calls.length).toBe(calls + 1)
    expect(window.orchaDesktop.setHostLayout).toHaveBeenLastCalledWith({ sidebarWidth: 272, collapsed: false, stripHeight: 0, terminalShown: false })
  })

  it('keyboard-resizes the sidebar within bounds', async () => {
    const sidebar = await renderHost()
    const handle = within(sidebar).getByRole('separator', { name: 'Resize sidebar' })
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    await waitFor(() =>
      expect(window.orchaDesktop.setHostLayout).toHaveBeenLastCalledWith({ sidebarWidth: 288, collapsed: false, stripHeight: 0, terminalShown: false })
    )
  })

  it('keeps the resize handle fully inside the sidebar (the native view draws over anything past its edge, QA 5)', async () => {
    const sidebar = await renderHost()
    const handle = within(sidebar).getByRole('separator', { name: 'Resize sidebar' })
    expect(handle.className).toMatch(/(^|\s)right-0(\s|$)/)
    expect(handle.className).not.toMatch(/(^|\s)-right-/)
    expect(handle.className).not.toMatch(/translate-x/)
  })

  it('clicking a project row switches projects with a full ?cid= load', async () => {
    const sidebar = await renderHost()
    await userEvent.setup().click(within(sidebar).getByRole('button', { name: /^Second/ }))
    expect(window.orchaDesktop.portalShow).toHaveBeenCalledWith('orcha-x', '/?cid=c2')
  })

  it('D1: projects are single rows — no per-project section nav or live-agents list in the sidebar', async () => {
    const sidebar = await renderHost()
    openV2('/tasks')
    emitEmbed({
      project: 'orcha-x',
      msg: { type: 'liveAgents', cid: 'c1', agents: [{ alias: 'Atlas', status: 'working', task: 'Ship it', updatedAt: null }] }
    })
    await waitFor(() => expect(within(sidebar).getByRole('button', { name: /^Demo/ })).toHaveAttribute('aria-current', 'true'))
    for (const name of ['Overview', 'Tasks', 'Agents', 'Requests', 'Code', 'GitHub', 'Activity', 'Metrics']) {
      expect(within(sidebar).queryByRole('button', { name })).not.toBeInTheDocument()
    }
    expect(within(sidebar).queryByText('Atlas')).not.toBeInTheDocument()
    expect(within(sidebar).queryByRole('button', { name: /expand demo|collapse demo/i })).not.toBeInTheDocument()
  })

  it('D3: selection is a subtle fill — no colored left stripe anywhere in the sidebar', async () => {
    const sidebar = await renderHost()
    openV2('/settings')
    await waitFor(() => expect(within(sidebar).getByRole('button', { name: /^Demo/ })).toHaveAttribute('aria-current', 'true'))
    expect(sidebar.innerHTML).not.toMatch(/inset_2px_0_0|border-l-2|border-l-accent/)
  })

  it('in V2 mode, Project settings SPA-navigates the open project (with cid) and highlights the route', async () => {
    const sidebar = await renderHost()
    openV2('/settings')
    const settings = await within(sidebar).findByRole('button', { name: 'Project settings' })
    await waitFor(() => expect(settings).toHaveAttribute('aria-current', 'page'))
    await userEvent.setup().click(settings)
    expect(window.orchaDesktop.embedSend).toHaveBeenCalledWith({ type: 'navigate', path: '/settings?cid=c1' })
    expect(window.orchaDesktop.portalShow).not.toHaveBeenCalledWith('orcha-x', '/settings?cid=c1')
  })

  it('the portal-reported cid decides the open container even when the route drops ?cid= (QA)', async () => {
    const sidebar = await renderHost()
    act(() => portalActiveListener?.({ project: 'orcha-x', embed: 'v2', route: null }))
    emitEmbed({ project: 'orcha-x', msg: { type: 'ready', version: 1 } })
    // container B (c2) is open, but an in-portal link reported a route WITHOUT ?cid=
    emitEmbed({ project: 'orcha-x', msg: { type: 'route', path: '/tasks', search: '', title: 'Tasks' } })
    emitEmbed({ project: 'orcha-x', msg: { type: 'attention', cid: 'c2', count: 0, partial: false } })
    const second = within(sidebar).getByRole('button', { name: /^Second/ })
    await waitFor(() => expect(second).toHaveAttribute('aria-current', 'true'))
    // a host navigation targets c2 via SPA (never container A's cid)
    await userEvent.setup().click(within(sidebar).getByRole('button', { name: 'Project settings' }))
    expect(window.orchaDesktop.embedSend).toHaveBeenCalledWith({ type: 'navigate', path: '/settings?cid=c2' })
    expect(window.orchaDesktop.embedSend).not.toHaveBeenCalledWith({ type: 'navigate', path: '/settings?cid=c1' })
  })

  it('with the open container unknown on a multi-container stack, a host navigation is a full load, never an SPA guess (QA 2)', async () => {
    const sidebar = await renderHost()
    act(() => portalActiveListener?.({ project: 'orcha-x', embed: 'v2', route: null }))
    emitEmbed({ project: 'orcha-x', msg: { type: 'ready', version: 1 } })
    // route without ?cid= and no attention/liveAgents yet: the portal's container is unknown
    emitEmbed({ project: 'orcha-x', msg: { type: 'route', path: '/tasks', search: '', title: 'Tasks' } })
    const settings = await within(sidebar).findByRole('button', { name: 'Project settings' })
    await userEvent.setup().click(settings)
    expect(window.orchaDesktop.portalShow).toHaveBeenCalledWith('orcha-x', '/settings?cid=c1')
    expect(window.orchaDesktop.embedSend).not.toHaveBeenCalledWith({ type: 'navigate', path: '/settings?cid=c1' })
  })

  it('pulls the active-view state on mount (a reloaded manager never misses the first push)', async () => {
    stub([runningStack], demoGet, demoAttention)
    ;(window.orchaDesktop as unknown as { getPortalActive: unknown }).getPortalActive = vi
      .fn()
      .mockResolvedValue({ project: 'orcha-x', embed: 'v2', route: { type: 'route', path: '/needs', search: '?cid=c1', title: 'Needs you' } })
    render(<App />)
    const sidebar = await screen.findByTestId('host-sidebar')
    const needs = await within(sidebar).findByRole('button', { name: /^Needs you/ })
    await waitFor(() => expect(needs).toHaveAttribute('aria-current', 'page'))
  })

  it('uses the portal live attention for the open project', async () => {
    const sidebar = await renderHost()
    openV2('/')
    emitEmbed({ project: 'orcha-x', msg: { type: 'attention', cid: 'c1', count: 3, partial: false } })
    const demo = within(sidebar).getByRole('button', { name: /^Demo/ })
    await waitFor(() => expect(within(demo).getByText('3')).toBeInTheDocument())
    // …and the manager table shows the SAME number (one data source).
    expect(screen.getAllByText('Needs you · 3').length).toBeGreaterThan(0)
  })

  it('the sidebar refreshes after a delete from the manager (no stale rows)', async () => {
    const sidebar = await renderHost()
    const user = userEvent.setup()
    // After the delete, docker reports no stacks.
    vi.mocked(window.orchaDesktop.resetStack).mockImplementation(async () => {
      vi.mocked(window.orchaDesktop.listStacks).mockResolvedValue([])
    })
    const table = screen.getByRole('table', { name: 'Projects on this Mac' })
    await user.click(within(table).getByRole('button', { name: 'More actions for Second' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete stack…' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByRole('list')).toHaveTextContent('DemoSecond')
    await user.type(within(dialog).getByLabelText(/confirm stack name/i), 'orcha-x')
    await user.click(within(dialog).getByRole('button', { name: 'Delete stack' }))
    await waitFor(() => expect(within(sidebar).queryByRole('button', { name: /^Demo/ })).not.toBeInTheDocument())
    expect(within(sidebar).getByText('No projects on this Mac yet.')).toBeInTheDocument()
    expect(screen.getByText('No projects yet')).toBeInTheDocument()
  })

  it('a start error is shown ONCE — in the visible manager table, not also in the sidebar', async () => {
    const stopped = { ...runningStack, project: 'orcha-y', projectShort: 'y', running: false, apiPort: null, portalStatus: 'Exited' }
    stub([runningStack, stopped], demoGet, demoAttention)
    vi.mocked(window.orchaDesktop.startStack).mockRejectedValue({
      code: 'COMPOSE_FAILED',
      stderr: 'Container y Starting\nError response from daemon: Bind for 0.0.0.0:8001 failed: port is already allocated'
    })
    render(<App />)
    const sidebar = await screen.findByTestId('host-sidebar')
    const user = userEvent.setup()
    const table = await screen.findByRole('table', { name: 'Projects on this Mac' })
    await user.click(within(table).getByRole('button', { name: 'Start' }))
    const alerts = await screen.findAllByRole('alert')
    expect(alerts).toHaveLength(1)
    expect(within(table).getByRole('alert')).toHaveTextContent('Couldn’t start y: Port 8001 is already in use')
    expect(within(sidebar).queryByTestId('sidebar-error')).toBeNull()
    expect(document.body.textContent).not.toContain('Error response from daemon')
    await user.click(within(within(table).getByRole('alert')).getByRole('button', { name: /dismiss/i }))
    await waitFor(() => expect(screen.queryAllByRole('alert')).toHaveLength(0))
  })

  it('with a portal open, a failed start shows only a sidebar glyph (tooltip = message) that opens the manager', async () => {
    const sidebar = await renderHost()
    vi.mocked(window.orchaDesktop.startStack).mockRejectedValue({ code: 'PORT_UNAVAILABLE' })
    openV2('/')
    emitEmbed({ project: 'orcha-x', msg: { type: 'requestHostAction', action: 'startStack' } })
    const glyph = await within(sidebar).findByTestId('sidebar-error')
    expect(glyph).toHaveAttribute('title', 'Couldn’t start x: The port is already in use.')
    expect(screen.queryAllByRole('alert')).toHaveLength(0)
    await userEvent.setup().click(glyph)
    expect(window.orchaDesktop.portalHide).toHaveBeenCalled()
  })

  it('a failed stop shows inside the open Stop dialog only; after Cancel it moves to the manager', async () => {
    const sidebar = await renderHost()
    vi.mocked(window.orchaDesktop.stopStack).mockRejectedValue({ code: 'COMPOSE_FAILED', stderr: 'boom: failed to stop' })
    const user = userEvent.setup()
    await user.click(within(sidebar).getByRole('button', { name: 'More actions for Demo' }))
    await user.click(within(sidebar).getByRole('menuitem', { name: 'Stop stack…' }))
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: 'Stop stack' }))
    await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent('Couldn’t stop: Boom: failed to stop'))
    // the next action is explicit: the primary now retries
    expect(within(dialog).getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Stop stack' })).toBeNull()
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(within(sidebar).queryByTestId('sidebar-error')).toBeNull()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(1))
    expect(within(screen.getByRole('table', { name: 'Projects on this Mac' })).getByRole('alert')).toHaveTextContent('Couldn’t stop x')
  })

  it('Docker down: the sidebar says so instead of "no projects"', async () => {
    stub([])
    vi.mocked(window.orchaDesktop.listStacks).mockRejectedValue({ code: 'DOCKER_UNAVAILABLE' })
    render(<App />)
    const sidebar = await screen.findByTestId('host-sidebar')
    await waitFor(() => expect(within(sidebar).getByText(/docker isn’t running/i)).toBeInTheDocument())
    expect(within(sidebar).queryByText(/no projects on this mac/i)).not.toBeInTheDocument()
  })

  it('Docker hung (CLI timed out): sidebar and manager say "isn’t responding", never "isn’t running"', async () => {
    stub([])
    vi.mocked(window.orchaDesktop.listStacks).mockRejectedValue({ code: 'DOCKER_UNAVAILABLE', unresponsive: true })
    render(<App />)
    const sidebar = await screen.findByTestId('host-sidebar')
    await waitFor(() => expect(within(sidebar).getByText(/docker isn’t responding — quit and reopen/i)).toBeInTheDocument())
    expect(screen.getByText('Docker isn’t responding.')).toBeInTheDocument()
    expect(screen.queryByText(/isn’t running/i)).toBeNull()
  })

  it('never a blank window: a loading frame, then the manager if docker ps never answers', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false })
    stub([])
    vi.mocked(window.orchaDesktop.listStacks).mockReturnValue(new Promise(() => {}))
    render(<App />)
    expect(screen.getByTestId('app-loading')).toHaveTextContent('Loading projects…')
    await act(async () => {
      vi.advanceTimersByTime(12_500)
    })
    expect(screen.getByRole('heading', { name: 'Projects' })).toBeInTheDocument()
    vi.useRealTimers()
  })

  it('collapsed rail: project icons (default cube glyph, never initials) and a labelled Needs-you entry (D14)', async () => {
    await renderHost()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    const rail = screen.getByTestId('host-sidebar')
    expect(within(rail).getByRole('button', { name: /^Needs you/ })).toBeInTheDocument()
    expect(within(rail).getByRole('button', { name: 'Add project' })).toBeInTheDocument()
    expect(within(rail).getByRole('button', { name: 'Help' })).toBeInTheDocument()
    const demo = within(rail).getByRole('button', { name: /^Demo/ })
    expect(within(demo).getByTestId('project-icon')).toHaveAttribute('data-icon', 'default')
    expect(demo).not.toHaveTextContent('DE')
    const second = within(rail).getByRole('button', { name: /^Second/ })
    expect(within(second).getByTestId('project-icon')).toHaveAttribute('data-icon', 'default')
  })

  it('Change icon… writes the shared store (PUT /api/containers/{cid}/icon) and shows it in sidebar + manager (D14)', async () => {
    const sidebar = await renderHost()
    vi.mocked(window.orchaDesktop.portalPut).mockImplementation(async (_port, _path, body) => ({
      container_id: 'c1',
      icon: (body as { icon: unknown }).icon
    }))
    const user = userEvent.setup()
    await user.click(within(sidebar).getByRole('button', { name: 'More actions for Demo' }))
    await user.click(within(sidebar).getByRole('menuitem', { name: 'Change icon…' }))
    const picker = await within(sidebar).findByRole('dialog', { name: 'Change icon for Demo' })
    await user.type(within(picker).getByRole('textbox', { name: 'Search emoji' }), 'rocket')
    await user.click(await within(picker).findByRole('button', { name: 'rocket' }))
    expect(within(sidebar).queryByRole('dialog')).toBeNull()
    expect(window.orchaDesktop.portalPut).toHaveBeenCalledWith(8000, '/api/containers/c1/icon', { icon: { kind: 'emoji', value: '🚀' } })
    const demo = within(sidebar).getByRole('button', { name: /^Demo, / })
    expect(within(demo).getByTestId('project-icon')).toHaveAttribute('data-icon', 'emoji:🚀')
    // localStorage is a read cache of the SERVER value only — no local-only icon store
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem('orcha:host:projectIconCache') ?? '{}')).toMatchObject({ c1: { kind: 'emoji', value: '🚀' } })
    )
    expect(localStorage.getItem('orcha:host:projectIcons')).toBeNull()
    expect(JSON.parse(localStorage.getItem('orcha:host:emojiRecents') ?? '[]')).toEqual(['🚀'])
    // focus returns to the ⋯ trigger
    expect(within(sidebar).getByRole('button', { name: 'More actions for Demo' })).toHaveFocus()
  })

  it('a refused icon write (403) rolls back and says why, under that row (D14)', async () => {
    const sidebar = await renderHost()
    vi.mocked(window.orchaDesktop.portalPut).mockRejectedValue({ code: 'PORTAL_REQUEST_FAILED', status: 403 })
    const user = userEvent.setup()
    await user.click(within(sidebar).getByRole('button', { name: 'More actions for Demo' }))
    await user.click(within(sidebar).getByRole('menuitem', { name: 'Change icon…' }))
    const picker = await within(sidebar).findByRole('dialog', { name: 'Change icon for Demo' })
    await user.type(within(picker).getByRole('textbox', { name: 'Search emoji' }), 'rocket')
    await user.click(await within(picker).findByRole('button', { name: 'rocket' }))
    // shown on ONE surface: the manager table while it is visible (never also the sidebar)
    const text = await screen.findByText("You don't have permission to change this project's icon")
    const alert = text.closest('[role="alert"]') as HTMLElement
    expect(within(sidebar).queryByTestId('icon-error')).toBeNull()
    const demo = within(sidebar).getByRole('button', { name: /^Demo, / })
    expect(within(demo).getByTestId('project-icon')).toHaveAttribute('data-icon', 'default')
    await user.click(within(alert).getByRole('button', { name: 'Dismiss error' }))
    expect(screen.queryByText("You don't have permission to change this project's icon")).toBeNull()
  })

  it('the server icon from the container poll is what every surface shows (D14)', async () => {
    stub([runningStack], async (_port, path) =>
      path === '/api/containers'
        ? { containers: [{ ...demoContainers.containers[0], icon: { kind: 'glyph', value: 'database', color: 3 } }] }
        : {}
    )
    render(<App />)
    const sidebar = await screen.findByTestId('host-sidebar')
    await waitFor(() =>
      expect(within(within(sidebar).getByRole('button', { name: /^Demo, / })).getByTestId('project-icon')).toHaveAttribute(
        'data-icon',
        'glyph:database'
      )
    )
  })

  it('an older portal (no `icon` on the container list) disables Change icon… with the reason', async () => {
    stub([runningStack], async (_port, path) =>
      path === '/api/containers' ? { containers: [{ ...demoContainers.containers[0], icon: undefined }] } : {}
    )
    render(<App />)
    const sidebar = await screen.findByTestId('host-sidebar')
    await waitFor(() => expect(within(sidebar).getByText('Demo')).toBeInTheDocument())
    await userEvent.setup().click(within(sidebar).getByRole('button', { name: 'More actions for Demo' }))
    const item = within(sidebar).getByRole('menuitem', { name: /Change icon…/ })
    expect(item).toHaveAttribute('aria-disabled', 'true')
    expect(item).toHaveTextContent(/too old for shared icons/)
    expect(window.orchaDesktop.portalPut).not.toHaveBeenCalled()
  })

  it('collapsed rail: a failed start turns that avatar’s own status dot red (no detached dot)', async () => {
    const sidebar = await renderHost()
    vi.mocked(window.orchaDesktop.startStack).mockRejectedValue({ code: 'PORT_UNAVAILABLE' })
    openV2('/')
    emitEmbed({ project: 'orcha-x', msg: { type: 'requestHostAction', action: 'startStack' } })
    await within(sidebar).findByTestId('sidebar-error')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    const rail = screen.getByTestId('host-sidebar')
    const demo = within(rail).getByRole('button', { name: /^Demo/ })
    const dot = within(demo).getByTestId('avatar-error-dot')
    expect(dot).toHaveClass('bg-danger')
    // anchored inside the project icon, and it is the only status dot on that icon
    expect(dot.parentElement).toHaveAttribute('data-testid', 'project-icon')
    expect(demo.querySelectorAll('[data-status-dot]')).toHaveLength(1)
    expect(demo).toHaveAccessibleName(/Couldn’t start x/)
  })

  it('Needs you opens /needs in a V2 portal, else the first waiting decision (skipping follow-ups)', async () => {
    const sidebar = await renderHost()
    const user = userEvent.setup()
    await user.click(within(sidebar).getByRole('button', { name: /^Needs you/ }))
    expect(window.orchaDesktop.portalShow).toHaveBeenCalledWith('orcha-x', '/tasks?task=t1&cid=c1')
    openV2('/')
    await user.click(within(sidebar).getByRole('button', { name: /^Needs you/ }))
    expect(window.orchaDesktop.embedSend).toHaveBeenCalledWith({ type: 'navigate', path: '/needs?cid=c1' })
  })

  it('row menu: Pair phone opens the pairing settings tab of that project (GAP-06)', async () => {
    const sidebar = await renderHost()
    const user = userEvent.setup()
    await user.click(within(sidebar).getByRole('button', { name: 'More actions for Second' }))
    const menu = within(sidebar).getByRole('menu', { name: 'Actions for Second' })
    await user.click(within(menu).getByRole('menuitem', { name: 'Pair phone' }))
    expect(window.orchaDesktop.portalShow).toHaveBeenCalledWith('orcha-x', '/settings?cid=c2#tab=pairing')
  })

  it('row menu closes on Escape and returns focus to its trigger', async () => {
    const sidebar = await renderHost()
    const user = userEvent.setup()
    const trigger = within(sidebar).getByRole('button', { name: 'More actions for Demo' })
    await user.click(trigger)
    expect(within(sidebar).getByRole('menu')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(within(sidebar).queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('Stop stack asks for confirmation, hides the native view meanwhile, then stops', async () => {
    const sidebar = await renderHost()
    const user = userEvent.setup()
    await user.click(within(sidebar).getByRole('button', { name: 'More actions for Demo' }))
    await user.click(within(sidebar).getByRole('menuitem', { name: 'Stop stack…' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(window.orchaDesktop.setHostModal).toHaveBeenCalledWith(true)
    expect(window.orchaDesktop.stopStack).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Stop stack' }))
    await waitFor(() => expect(window.orchaDesktop.stopStack).toHaveBeenCalledWith('orcha-x'))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(window.orchaDesktop.setHostModal).toHaveBeenLastCalledWith(false)
  })

  it('a portal requestHostAction stopStack goes through the same confirm (sender stack only)', async () => {
    await renderHost()
    emitEmbed({ project: 'orcha-x', msg: { type: 'requestHostAction', action: 'stopStack' } })
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Stop the “x” stack?')
    await userEvent.setup().keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(window.orchaDesktop.stopStack).not.toHaveBeenCalled()
  })

  it('Cmd/Ctrl+K in host chrome opens the command menu (native view hidden under it); its "Search <project>…" opens the V2 portal search', async () => {
    await renderHost()
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const menu = await screen.findByRole('dialog', { name: 'Command menu' })
    expect(window.orchaDesktop.setHostModal).toHaveBeenCalledWith(true)
    // no V2 project open: no portal search entry
    expect(within(menu).queryByRole('option', { name: /^Search / })).not.toBeInTheDocument()
    fireEvent.keyDown(within(menu).getByRole('combobox'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Command menu' })).not.toBeInTheDocument())
    expect(window.orchaDesktop.setHostModal).toHaveBeenLastCalledWith(false, { focus: 'view' })
    expect(window.orchaDesktop.embedSend).not.toHaveBeenCalled()

    openV2('/')
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const menu2 = await screen.findByRole('dialog', { name: 'Command menu' })
    const input = within(menu2).getByRole('combobox')
    await userEvent.setup().type(input, 'search{Enter}')
    expect(window.orchaDesktop.embedSend).toHaveBeenCalledWith({ type: 'openSearch' })
  })

  it('the sidebar "Search or run…" entry opens the command menu with the terminal launchers', async () => {
    const sidebar = await renderHost()
    await userEvent.setup().click(within(sidebar).getByTestId('open-command-menu'))
    const menu = await screen.findByRole('dialog', { name: 'Command menu' })
    for (const name of [/New Terminal/, /^Claude/, /^Codex/, /Agent settings/]) {
      expect(within(menu).getByRole('option', { name })).toBeInTheDocument()
    }
  })

  it('Agent settings… opens the execution settings of the open project', async () => {
    await renderHost()
    openV2('/tasks')
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const menu = await screen.findByRole('dialog', { name: 'Command menu' })
    await userEvent.setup().click(within(menu).getByRole('option', { name: /Agent settings/ }))
    await waitFor(() => {
      const calls = [
        ...vi.mocked(window.orchaDesktop.embedSend).mock.calls.map((c) => JSON.stringify(c)),
        ...vi.mocked(window.orchaDesktop.portalShow).mock.calls.map((c) => JSON.stringify(c))
      ]
      expect(calls.some((c) => c.includes('/settings') && c.includes('tab=execution'))).toBe(true)
    })
  })

  it('first-run onboarding hides the host sidebar', async () => {
    stub([])
    render(<App />)
    await waitFor(() => expect(screen.getByText(/set up embodent/i)).toBeInTheDocument())
    expect(screen.queryByTestId('host-sidebar')).not.toBeInTheDocument()
  })
})

describe('App — full-panel terminal sessions', () => {
  beforeEach(() => {
    vi.useRealTimers()
    window.localStorage.clear()
  })

  function withTerm() {
    let command: ((c: string) => void) | null = null
    const term = {
      create: vi.fn().mockImplementation(async (req: { kind: string; project: string | null }) => ({
        id: 1,
        kind: req.kind,
        project: req.project,
        cwd: '/Users/me/x',
        shell: 'zsh',
        note: null
      })),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      setFocus: vi.fn(),
      onEvent: vi.fn().mockReturnValue(() => {}),
      onCommand: vi.fn().mockImplementation((cb) => {
        command = cb
        return () => {}
      })
    }
    return { term, send: (c: string) => act(() => command?.(c)) }
  }

  it('⌘T (menu command) opens a FULL-PANEL shell in the open project: main hides the portal view; the strip switches back; ⌘W closes it', async () => {
    stub([runningStack], demoGet, demoAttention)
    const { term, send } = withTerm()
    ;(window.orchaDesktop as unknown as { term: unknown }).term = term
    render(<App />)
    await screen.findByTestId('host-sidebar')
    openV2('/tasks')
    expect(window.orchaDesktop.setHostLayout).toHaveBeenLastCalledWith({ sidebarWidth: 272, collapsed: false, stripHeight: 0, terminalShown: false })
    send('new-shell')
    await waitFor(() => expect(term.create).toHaveBeenCalledWith({ kind: 'shell', project: 'orcha-x', cols: 100, rows: 24 }))
    await screen.findByTestId('terminal-view')
    expect(screen.getByRole('tab', { name: /zsh/ })).toHaveAttribute('aria-selected', 'true')
    // the terminal fills the panel: main hides the portal view; the strip (38 px) sits on top
    await waitFor(() =>
      expect(window.orchaDesktop.setHostLayout).toHaveBeenLastCalledWith({ sidebarWidth: 272, collapsed: false, stripHeight: 38, terminalShown: true })
    )
    expect(screen.getByTestId('session-panel')).toHaveAttribute('data-terminal-shown', 'true')
    // the portal tab (project name) switches back in one click
    await userEvent.setup().click(screen.getByTestId('portal-tab'))
    await waitFor(() =>
      expect(window.orchaDesktop.setHostLayout).toHaveBeenLastCalledWith({ sidebarWidth: 272, collapsed: false, stripHeight: 38, terminalShown: false })
    )
    // ⌃` flips back to the terminal
    send('toggle-panel')
    await waitFor(() => expect(screen.getByTestId('session-panel')).toHaveAttribute('data-terminal-shown', 'true'))
    // main showed a portal (tray / notification): back to the portal
    send('show-portal')
    await waitFor(() => expect(screen.getByTestId('session-panel')).toHaveAttribute('data-terminal-shown', 'false'))
    send('close-tab')
    await waitFor(() => expect(screen.queryByTestId('session-strip')).not.toBeInTheDocument())
    expect(term.kill).toHaveBeenCalledWith(1)
    expect(window.orchaDesktop.setHostLayout).toHaveBeenLastCalledWith({ sidebarWidth: 272, collapsed: false, stripHeight: 0, terminalShown: false })
  })

  it('sessions show in the sidebar under their project; a row click shows the terminal; a project click returns to the portal', async () => {
    stub([runningStack], demoGet, demoAttention)
    const { term, send } = withTerm()
    ;(window.orchaDesktop as unknown as { term: unknown }).term = term
    render(<App />)
    const sidebar = await screen.findByTestId('host-sidebar')
    openV2('/tasks')
    send('new-shell')
    const row = await within(sidebar).findByTestId('session-row')
    expect(row).toHaveAccessibleName(/^zsh · idle/)
    expect(row).toHaveAttribute('aria-current', 'true')
    const user = userEvent.setup()
    await user.click(within(sidebar).getByRole('button', { name: /^Demo/ }))
    await waitFor(() => expect(screen.getByTestId('session-panel')).toHaveAttribute('data-terminal-shown', 'false'))
    expect(within(sidebar).getByTestId('session-row')).not.toHaveAttribute('aria-current')
    await user.click(within(sidebar).getByTestId('session-row'))
    await waitFor(() => expect(screen.getByTestId('session-panel')).toHaveAttribute('data-terminal-shown', 'true'))
  })

  it("the project ⋯ menu's Open section launches a session for THAT project", async () => {
    stub([runningStack], demoGet, demoAttention)
    const { term } = withTerm()
    ;(window.orchaDesktop as unknown as { term: unknown }).term = term
    render(<App />)
    const sidebar = await screen.findByTestId('host-sidebar')
    const user = userEvent.setup()
    await user.click(within(sidebar).getAllByTestId('project-menu')[0])
    const menu = within(sidebar).getByRole('menu')
    const items = within(menu).getAllByRole('menuitem').map((b) => b.textContent)
    expect(items.slice(0, 3)).toEqual(['New Terminal⌘T', 'Claude⌥⌘T', 'Codex'])
    await user.click(within(menu).getByRole('menuitem', { name: /^Claude/ }))
    await waitFor(() => expect(term.create).toHaveBeenCalledWith(expect.objectContaining({ kind: 'claude', project: 'orcha-x' })))
  })

  it('Claude from the command menu launches the claude kind', async () => {
    stub([runningStack], demoGet, demoAttention)
    const { term } = withTerm()
    ;(window.orchaDesktop as unknown as { term: unknown }).term = term
    render(<App />)
    await screen.findByTestId('host-sidebar')
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const menu = await screen.findByRole('dialog', { name: 'Command menu' })
    await userEvent.setup().click(within(menu).getByRole('option', { name: /^Claude/ }))
    await waitFor(() => expect(term.create).toHaveBeenCalledWith(expect.objectContaining({ kind: 'claude', project: null })))
    expect(window.orchaDesktop.setHostModal).toHaveBeenLastCalledWith(false, { focus: 'host' })
  })
})

describe('App — Settings › Agents wiring', () => {
  beforeEach(() => {
    vi.useRealTimers()
    window.localStorage.clear()
  })

  const IDS = ['claude', 'codex', 'gemini', 'copilot', 'cursor', 'opencode', 'qwen', 'amp', 'aider', 'goose', 'crush', 'droid', 'grok', 'kimi', 'cline', 'auggie']
  function withAgents(installed: string[], defaultAgent = 'gemini') {
    const snapshot = {
      permissionMode: 'yolo',
      defaultAgent,
      detection: 'ready',
      detectedAt: 1,
      agents: IDS.map((id) => ({ id, enabled: true, extraArgs: [], installed: installed.includes(id), path: null }))
    }
    let command: ((c: string) => void) | null = null
    const term = {
      create: vi.fn().mockImplementation(async (req: { kind: string; project: string | null }) => ({
        id: 1,
        kind: req.kind,
        project: req.project,
        cwd: '/Users/me/x',
        shell: 'zsh',
        note: null
      })),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      setFocus: vi.fn(),
      onEvent: vi.fn().mockReturnValue(() => {}),
      onCommand: vi.fn().mockImplementation((cb) => {
        command = cb
        return () => {}
      })
    }
    const agents = {
      get: vi.fn().mockResolvedValue(snapshot),
      refresh: vi.fn().mockResolvedValue(snapshot),
      update: vi.fn().mockResolvedValue(snapshot),
      openDocs: vi.fn().mockResolvedValue(undefined),
      copyInstall: vi.fn().mockResolvedValue(undefined),
      onChanged: vi.fn().mockReturnValue(() => {})
    }
    Object.assign(window.orchaDesktop as unknown as Record<string, unknown>, { term, agents })
    return { term, agents, send: (c: string) => act(() => command?.(c)) }
  }

  it('⌘K lists the ENABLED INSTALLED agents with real marks, Default first on ⌥⌘T', async () => {
    stub([runningStack], demoGet, demoAttention)
    withAgents(['claude', 'gemini'])
    render(<App />)
    await screen.findByTestId('host-sidebar')
    await waitFor(() => expect(window.orchaDesktop.agents!.get).toHaveBeenCalled())
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const menu = await screen.findByRole('dialog', { name: 'Command menu' })
    await waitFor(() => expect(within(menu).getByTestId('cmd-new-agent-gemini')).toBeInTheDocument())
    const ids = within(menu)
      .getAllByRole('option')
      .map((o) => o.getAttribute('data-testid'))
      .filter((id) => id?.startsWith('cmd-new-agent-'))
    expect(ids).toEqual(['cmd-new-agent-gemini', 'cmd-new-agent-claude'])
    expect(within(menu).getByTestId('cmd-new-agent-gemini')).toHaveTextContent('⌥⌘T')
    expect(within(menu).getByTestId('cmd-new-agent-gemini').querySelector('svg[data-mark="gemini"]')).not.toBeNull()
    expect(within(menu).queryByTestId('cmd-new-agent-codex')).not.toBeInTheDocument()
    expect(within(menu).getByTestId('cmd-desktop-settings')).toHaveTextContent('Settings…')
  })

  it("the project ⋯ Open section lists them too; ⌥⌘T (menu command) launches the Default by id", async () => {
    stub([runningStack], demoGet, demoAttention)
    const { term, send } = withAgents(['claude', 'gemini'])
    render(<App />)
    const sidebar = await screen.findByTestId('host-sidebar')
    await waitFor(() => expect(window.orchaDesktop.agents!.get).toHaveBeenCalled())
    const user = userEvent.setup()
    await user.click(within(sidebar).getAllByTestId('project-menu')[0])
    const menu = within(sidebar).getByRole('menu')
    await waitFor(() =>
      expect(within(menu).getAllByRole('menuitem').map((b) => b.textContent).slice(0, 3)).toEqual(['New Terminal⌘T', 'Gemini CLI⌥⌘T', 'Claude'])
    )
    fireEvent.keyDown(menu, { key: 'Escape' })
    send('new-default-agent')
    await waitFor(() => expect(term.create).toHaveBeenCalledWith(expect.objectContaining({ kind: 'gemini' })))
    // the renderer never sends a path, command or flags — only the registry id
    for (const [req] of term.create.mock.calls) expect(Object.keys(req).sort()).toEqual(['cols', 'kind', 'project', 'rows'])
  })

  it('⌘, opens Settings over the panel (main hides the view); Test launch opens a --version probe tab', async () => {
    stub([runningStack], demoGet, demoAttention)
    const { term, send } = withAgents(['claude', 'gemini'])
    render(<App />)
    const sidebar = await screen.findByTestId('host-sidebar')
    send('open-settings')
    const view = await screen.findByTestId('settings-view')
    await waitFor(() =>
      expect(window.orchaDesktop.setHostLayout).toHaveBeenLastCalledWith(expect.objectContaining({ terminalShown: true }))
    )
    expect(within(sidebar).getByTestId('sidebar-settings')).toHaveAttribute('aria-current', 'page')
    const user = userEvent.setup()
    await user.click(await within(view).findByTestId('expand-gemini'))
    await user.click(within(view).getByTestId('test-launch-gemini'))
    await waitFor(() => expect(term.create).toHaveBeenCalledWith(expect.objectContaining({ kind: 'gemini', probe: true })))
    await waitFor(() => expect(screen.queryByTestId('settings-view')).not.toBeInTheDocument())
    expect(await screen.findByRole('tab', { name: /Gemini CLI --version/ })).toBeInTheDocument()
  })

  it('DT-53: ⌃` while Settings is open closes Settings and shows the terminal (like ⌘T), never flips underneath', async () => {
    stub([runningStack], demoGet, demoAttention)
    const { send } = withAgents(['claude'])
    render(<App />)
    await screen.findByTestId('host-sidebar')
    send('new-shell')
    await screen.findByTestId('terminal-view')
    await waitFor(() => expect(screen.getByTestId('session-panel')).toHaveAttribute('data-terminal-shown', 'true'))
    // terminal already showing, then Settings on top
    send('open-settings')
    await screen.findByTestId('settings-view')
    send('toggle-panel')
    await waitFor(() => expect(screen.queryByTestId('settings-view')).not.toBeInTheDocument())
    expect(screen.getByTestId('session-panel')).toHaveAttribute('data-terminal-shown', 'true')
    // portal showing, then Settings on top: ⌃` lands on the terminal too
    send('show-portal')
    await waitFor(() => expect(screen.getByTestId('session-panel')).toHaveAttribute('data-terminal-shown', 'false'))
    send('open-settings')
    await screen.findByTestId('settings-view')
    send('toggle-panel')
    await waitFor(() => expect(screen.queryByTestId('settings-view')).not.toBeInTheDocument())
    expect(screen.getByTestId('session-panel')).toHaveAttribute('data-terminal-shown', 'true')
    // with Settings closed, ⌃` still flips back to the portal
    send('toggle-panel')
    await waitFor(() => expect(screen.getByTestId('session-panel')).toHaveAttribute('data-terminal-shown', 'false'))
  })

  it('DT-54: over Settings the ⌘K toggle says "Show terminal" (what it does), not "Back to …"', async () => {
    stub([runningStack], demoGet, demoAttention)
    const { send } = withAgents(['claude'])
    render(<App />)
    await screen.findByTestId('host-sidebar')
    send('new-shell')
    await screen.findByTestId('terminal-view')
    await waitFor(() => expect(screen.getByTestId('session-panel')).toHaveAttribute('data-terminal-shown', 'true'))
    send('open-settings')
    await screen.findByTestId('settings-view')
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const menu = await screen.findByRole('dialog', { name: 'Command menu' })
    const item = within(menu).getByTestId('cmd-toggle-panel')
    expect(item).toHaveTextContent(/Show terminal/)
    expect(item).not.toHaveTextContent(/Back to/)
  })

  it('DT-54: with the terminal on screen (no Settings) the ⌘K toggle still says "Back to …"', async () => {
    stub([runningStack], demoGet, demoAttention)
    const { send } = withAgents(['claude'])
    render(<App />)
    await screen.findByTestId('host-sidebar')
    send('new-shell')
    await screen.findByTestId('terminal-view')
    await waitFor(() => expect(screen.getByTestId('session-panel')).toHaveAttribute('data-terminal-shown', 'true'))
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const menu = await screen.findByRole('dialog', { name: 'Command menu' })
    expect(within(menu).getByTestId('cmd-toggle-panel')).toHaveTextContent(/Back to/)
  })

  it('the sidebar footer Settings item toggles the view; Escape closes it', async () => {
    stub([runningStack], demoGet, demoAttention)
    withAgents(['claude'])
    render(<App />)
    const sidebar = await screen.findByTestId('host-sidebar')
    await userEvent.setup().click(within(sidebar).getByTestId('sidebar-settings'))
    const view = await screen.findByTestId('settings-view')
    fireEvent.keyDown(view, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('settings-view')).not.toBeInTheDocument())
  })
})

describe('App — Remove project…', () => {
  beforeEach(() => {
    vi.useRealTimers()
    window.localStorage.clear()
  })

  const withRemoval = () => {
    const api = window.orchaDesktop as unknown as Record<string, unknown>
    api.removePlan = vi.fn(() => new Promise(() => {}))
    api.removeProject = vi.fn().mockResolvedValue({
      project: 'orcha-x',
      projectShort: 'x',
      dataDeleted: false,
      filesRemoved: false,
      removed: [],
      kept: [],
      warnings: []
    })
    api.onRemoveProgress = vi.fn().mockReturnValue(() => {})
  }

  it('⌘K offers "Remove project…" (danger) for the OPEN project only, and it opens the dialog', async () => {
    stub([runningStack], demoGet, demoAttention)
    withRemoval()
    render(<App />)
    const sidebar = await screen.findByTestId('host-sidebar')
    await waitFor(() => expect(within(sidebar).getByText('Second')).toBeInTheDocument())
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    let menu = await screen.findByRole('dialog', { name: 'Command menu' })
    expect(within(menu).queryByRole('option', { name: /Remove project/ })).not.toBeInTheDocument()
    fireEvent.keyDown(within(menu).getByRole('combobox'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Command menu' })).not.toBeInTheDocument())

    openV2('/')
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    menu = await screen.findByRole('dialog', { name: 'Command menu' })
    const option = within(menu).getByRole('option', { name: /Remove project…/ })
    expect(option).toHaveTextContent('Demo')
    expect(option.querySelector('.text-danger')).not.toBeNull()
    await userEvent.setup().click(option)
    expect(await screen.findByRole('alertdialog', { name: 'Remove “Demo”?' })).toBeInTheDocument()
  })

  it('removing the OPEN project from the sidebar: no other project can open → home screen, and a toast', async () => {
    stub([runningStack], demoGet, demoAttention)
    withRemoval()
    render(<App />)
    const sidebar = await screen.findByTestId('host-sidebar')
    await waitFor(() => expect(within(sidebar).getByText('Second')).toBeInTheDocument())
    openV2('/tasks')
    const user = userEvent.setup()
    await user.click(within(sidebar).getByRole('button', { name: 'More actions for Demo' }))
    await user.click(within(sidebar).getByRole('menuitem', { name: 'Remove project…' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove “Demo”?' })
    // the stack's other project goes with it — named up front
    expect(dialog).toHaveTextContent('It shares its stack with Second, which is removed too.')
    expect(window.orchaDesktop.setHostModal).toHaveBeenCalledWith(true)
    await user.click(within(dialog).getByRole('button', { name: 'Remove project' }))
    await waitFor(() => expect(window.orchaDesktop.removeProject).toHaveBeenCalledWith('orcha-x', { deleteData: false, removeFiles: false }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(window.orchaDesktop.portalHide).toHaveBeenCalled()
    expect(await screen.findByTestId('toast')).toHaveTextContent('Removed Demo. Its data is kept')
  })

  it('an older preload without the bridge offers no Remove anywhere', async () => {
    const sidebar = await renderHost()
    await userEvent.setup().click(within(sidebar).getByRole('button', { name: 'More actions for Demo' }))
    expect(within(sidebar).queryByRole('menuitem', { name: 'Remove project…' })).not.toBeInTheDocument()
  })
})
