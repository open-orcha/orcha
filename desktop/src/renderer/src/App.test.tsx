// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'

/** Captured onNavigate listener so tests can simulate main→renderer IPC (e.g. the
 *  File→Add Project menu item) without a real Electron process. */
let navigateListener: ((nav: { target: 'onboarding' | 'manager'; variant?: string }) => void) | null = null
/** Captured onPortalActive listener so tests can simulate main's "which portal view is
 *  showing" broadcast (tray/notification/deep-link can change it without a click here). */
let portalActiveListener: ((active: { project: string | null }) => void) | null = null

function stub(stacks: unknown[], portalGetImpl?: (apiPort: number, path: string) => unknown) {
  navigateListener = null
  portalActiveListener = null
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
    analyzeProject: vi.fn().mockResolvedValue({ ok: false, reason: 'claude is not installed on this Mac' })
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
  beforeEach(() => vi.useRealTimers())

  it('starts in onboarding mode when there are no stacks', async () => {
    stub([])
    render(<App />)
    await waitFor(() => expect(screen.getByText(/set up orcha/i)).toBeInTheDocument())
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

  it('the dashed New-project card opens the wizard in add-project framing, with Cancel back home', async () => {
    stub([runningStack])
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByText(/new project/i)).toBeInTheDocument())

    await user.click(screen.getByText(/new project/i))
    await waitFor(() => expect(screen.getByText(/add a project/i)).toBeInTheDocument())

    // add-project variant offers a Cancel back to the home screen (first-run onboarding has
    // none — there's nowhere to cancel to before any stack exists).
    // The header Cancel opens a confirm dialog ("Skip setup?"); its own "Skip" button is
    // the actual confirm.
    await user.click(screen.getByRole('button', { name: /cancel/i }))
    await user.click(screen.getByRole('button', { name: /^skip$/i }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Projects' })).toBeInTheDocument())
  })

  it('opening a project card calls portalShow with a ?cid= path and shows the TopBar', async () => {
    stub([runningStack], async (_port, path) =>
      path === '/api/containers'
        ? { containers: [{ id: 'c1', name: 'Demo', description: null, status: 'active', github_repo: null, agents: 1, tasks: 2, needs_you: 0, member_count: 1 }] }
        : {}
    )
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByText('Demo')).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: /^open$/i }))
    expect(window.orchaDesktop.portalShow).toHaveBeenCalledWith('orcha-x', '/?cid=c1')

    // Simulate main confirming the switch (mirrors production: main is the source of truth).
    portalActiveListener?.({ project: 'orcha-x' })
    await waitFor(() => expect(screen.getByTestId('topbar')).toBeInTheDocument())
    expect(screen.getByText('x')).toBeInTheDocument() // the stack's short name in the TopBar
  })

  it('TopBar "← Projects" hides the portal and returns to the home grid', async () => {
    stub([runningStack])
    render(<App />)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Projects' })).toBeInTheDocument())

    portalActiveListener?.({ project: 'orcha-x' })
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
