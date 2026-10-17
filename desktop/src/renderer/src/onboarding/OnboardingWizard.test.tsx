// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import OnboardingWizard from './OnboardingWizard'

beforeEach(() => {
  window.orchaDesktop = {
    listStacks: vi.fn().mockResolvedValue([]),
    startStack: vi.fn(),
    stopStack: vi.fn(),
    resetStack: vi.fn(),
    portalShow: vi.fn().mockResolvedValue(undefined),
    portalHide: vi.fn(),
    listAttention: vi.fn().mockResolvedValue([]),
    openManager: vi.fn(),
    quitApp: vi.fn(),
    preflight: vi.fn().mockResolvedValue({ docker: 'ok', autoStarted: false, hint: null }),
    probePrereqs: vi.fn().mockResolvedValue({
      homebrew: true,
      dockerEngine: true,
      orcha: true,
      claude: true,
      codex: true
    }),
    installPrereqs: vi.fn().mockResolvedValue({ ok: true, completed: [] }),
    onInstallProgress: vi.fn().mockReturnValue(() => {}),
    pickFolder: vi.fn().mockResolvedValue({ folder: '/tmp/demo', mode: 'existing' }),
    inspectFolder: vi.fn().mockResolvedValue({
      initialized: false,
      writable: true,
      suggestedName: 'demo',
      isGitRepo: true
    }),
    provision: vi.fn().mockResolvedValue({
      project: 'orcha-demo',
      apiPort: 8001,
      warnings: []
    }),
    githubStatus: vi.fn().mockResolvedValue({ authenticated: false, gitInstalled: true }),
    githubRepos: vi.fn().mockResolvedValue([]),
    suggestCloneDest: vi.fn().mockResolvedValue({ parent: '/tmp/orcha-projects', repoName: 'demo' }),
    pickCloneDest: vi.fn().mockResolvedValue('/tmp/orcha-projects/demo'),
    cloneAndProvision: vi.fn().mockResolvedValue({
      project: 'orcha-demo',
      apiPort: 8001,
      warnings: []
    }),
    openOnboardingPortal: vi.fn().mockResolvedValue(undefined),
    openExternal: vi.fn().mockResolvedValue(undefined),
    onProvisionProgress: vi.fn().mockReturnValue(() => {}),
    onNavigate: vi.fn().mockReturnValue(() => {}),
    onPortalActive: vi.fn().mockReturnValue(() => {}),
    portalGet: vi.fn().mockRejectedValue({ code: 'PORTAL_REQUEST_FAILED', status: 404 }),
    portalPost: vi.fn().mockRejectedValue({ code: 'PORTAL_REQUEST_FAILED', status: 404 }),
    portalPut: vi.fn().mockRejectedValue({ code: 'PORTAL_REQUEST_FAILED', status: 404 }),
    analyzeProject: vi.fn().mockResolvedValue({
      ok: false,
      reason: 'claude is not installed on this Mac'
    }),
    listAttentionStatus: vi.fn().mockResolvedValue({ items: [], projects: [] }),
    setHostLayout: vi.fn().mockResolvedValue(undefined),
    setHostModal: vi.fn().mockResolvedValue(undefined),
    embedSend: vi.fn().mockResolvedValue(true),
    onEmbedEvent: vi.fn().mockReturnValue(() => {})
  }
})

type ProgressCb = (e: { runId: string; step: string; status: string; line?: string }) => void
const mock = (f: unknown) => f as ReturnType<typeof vi.fn>

function captureProgress(): { cb: ProgressCb | null } {
  const holder: { cb: ProgressCb | null } = { cb: null }
  mock(window.orchaDesktop.onProvisionProgress).mockImplementation((f: ProgressCb) => {
    holder.cb = f
    return () => {}
  })
  return holder
}

async function skipWelcomeIfPresent(user: ReturnType<typeof userEvent.setup>) {
  if (!screen.queryByRole('heading', { name: /welcome to embodent/i })) return
  await user.click(screen.getByRole('button', { name: /get started/i }))
}

async function continueToSource(user: ReturnType<typeof userEvent.setup>) {
  await skipWelcomeIfPresent(user)
  await waitFor(() => expect(screen.getByRole('button', { name: /^continue$/i })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: /^continue$/i }))
  await waitFor(() => expect(screen.getByText(/where.s your code/i)).toBeInTheDocument())
}

async function pickLocalFolder(user: ReturnType<typeof userEvent.setup>, next: RegExp = /^next$/i) {
  await user.click(screen.getByRole('button', { name: /local folder/i }))
  await user.click(screen.getByRole('button', { name: /choose existing folder/i }))
  await waitFor(() => expect(screen.getByRole('button', { name: next })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: next }))
}

async function toDetailsAndCreate(user: ReturnType<typeof userEvent.setup>) {
  await continueToSource(user)
  await pickLocalFolder(user)
  await waitFor(() => expect(screen.getByDisplayValue('demo')).toBeInTheDocument())
  await user.click(screen.getByRole('button', { name: /create project/i }))
}

/** Finish's single primary opens the project on its next useful screen, then hands back. */
async function finishFromPortal(user: ReturnType<typeof userEvent.setup>, project: string, path = '/') {
  const btn = await screen.findByRole('button', { name: /^open /i })
  await user.click(btn)
  await waitFor(() => expect(window.orchaDesktop.portalShow).toHaveBeenCalledWith(project, path))
}

describe('OnboardingWizard — local folder source', () => {
  it('walks setup → source → folder → details → create and opens the project', async () => {
    const onDone = vi.fn()
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={onDone} />)

    await toDetailsAndCreate(user)
    expect(window.orchaDesktop.provision).toHaveBeenCalledWith(
      expect.objectContaining({
        folder: '/tmp/demo',
        mode: 'init',
        name: 'demo'
      })
    )
    // Success (git repo → no pause) → Agents auto-skips (404) → Finish → open Overview.
    await finishFromPortal(user, 'orcha-demo', '/')
    await waitFor(() => expect(onDone).toHaveBeenCalled())
  })

  it('labels progress with a stepper that says which step you are on', async () => {
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={vi.fn()} />)
    await continueToSource(user)
    const stepper = screen.getByRole('list', { name: /step 2 of 5/i })
    expect(stepper).toHaveTextContent(/Setup.*Source.*Details.*Create.*Agents/)
  })

  it('auto-binds the code source (PUT .../github) right after a successful provision of a git folder', async () => {
    mock(window.orchaDesktop.portalGet).mockImplementation(async (_apiPort: number, path: string) => {
      if (path === '/api/containers') return { containers: [{ id: 'c1' }] }
      if (path === '/api/containers/c1') return { agents: [{ id: 'h1', kind: 'human' }] }
      throw { code: 'PORTAL_REQUEST_FAILED', status: 404 }
    })
    mock(window.orchaDesktop.portalPut).mockResolvedValue({ ok: true })
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={vi.fn()} />)
    await toDetailsAndCreate(user)

    await waitFor(() =>
      expect(window.orchaDesktop.portalPut).toHaveBeenCalledWith(8001, '/api/containers/c1/github', {
        repo: 'local',
        actor_agent_id: 'h1'
      })
    )
    await screen.findByRole('button', { name: /^open /i })
    await waitFor(() => expect(screen.getByText('Code source')).toBeInTheDocument())
    expect(screen.getByText('Local repository')).toBeInTheDocument()
  })

  it('tolerates a non-200 on the github bind — never blocks the wizard', async () => {
    mock(window.orchaDesktop.portalGet).mockImplementation(async (_apiPort: number, path: string) => {
      if (path === '/api/containers') return { containers: [{ id: 'c1' }] }
      if (path === '/api/containers/c1') return { agents: [{ id: 'h1', kind: 'human' }] }
      throw { code: 'PORTAL_REQUEST_FAILED', status: 404 }
    })
    mock(window.orchaDesktop.portalPut).mockRejectedValue({
      code: 'PORTAL_REQUEST_FAILED',
      status: 400
    })
    const onDone = vi.fn()
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={onDone} />)
    await toDetailsAndCreate(user)
    await finishFromPortal(user, 'orcha-demo')
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(screen.queryByText('Code source')).not.toBeInTheDocument()
  })

  it('protects an initialized folder: says so neutrally, reconnects (upgrade) and skips Details', async () => {
    mock(window.orchaDesktop.inspectFolder).mockResolvedValue({
      initialized: true,
      writable: true,
      suggestedName: 'demo',
      isGitRepo: true
    })
    const onDone = vi.fn()
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={onDone} />)
    await continueToSource(user)
    await user.click(screen.getByRole('button', { name: /local folder/i }))
    await user.click(screen.getByRole('button', { name: /choose existing folder/i }))

    const notice = await screen.findByText(/already has an orcha project/i)
    expect(notice.closest('[data-tone]')).toHaveAttribute('data-tone', 'info')
    // The stepper keeps all five steps; Details is shown as skipped for a reconnect.
    const stepper = screen.getByRole('list', { name: /of 5/i })
    expect(stepper).toHaveTextContent('Details')
    expect(within(stepper).getByText('Details').closest('[data-state]')).toHaveAttribute('data-state', 'skipped')
    await user.click(screen.getByRole('button', { name: /^reconnect$/i }))

    await waitFor(() =>
      expect(window.orchaDesktop.provision).toHaveBeenCalledWith(
        expect.objectContaining({ folder: '/tmp/demo', mode: 'upgrade' })
      )
    )
    await finishFromPortal(user, 'orcha-demo')
    await waitFor(() => expect(onDone).toHaveBeenCalled())
  })

  it('blocks a folder Embodent cannot write to', async () => {
    mock(window.orchaDesktop.inspectFolder).mockResolvedValue({
      initialized: false,
      writable: false,
      suggestedName: 'demo',
      isGitRepo: false
    })
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={vi.fn()} />)
    await continueToSource(user)
    await user.click(screen.getByRole('button', { name: /local folder/i }))
    await user.click(screen.getByRole('button', { name: /choose existing folder/i }))
    expect(await screen.findByText(/can.t write to this folder/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^next$/i })).toBeDisabled()
  })

  it('shows the git-init tip with inline code and pauses on Continue for a non-git folder', async () => {
    mock(window.orchaDesktop.inspectFolder).mockResolvedValue({
      initialized: false,
      writable: true,
      suggestedName: 'demo',
      isGitRepo: false
    })
    const onDone = vi.fn()
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={onDone} />)
    await toDetailsAndCreate(user)

    const code = await screen.findByText('git init')
    expect(code.tagName).toBe('CODE')
    expect(document.body.textContent).not.toContain('`')
    expect(window.orchaDesktop.portalShow).not.toHaveBeenCalled()
    expect(window.orchaDesktop.portalPut).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: /^continue$/i }))
    await finishFromPortal(user, 'orcha-demo')
    await waitFor(() => expect(onDone).toHaveBeenCalled())
  })

  it('ignores progress events that arrive before any attempt starts', async () => {
    const holder = captureProgress()
    render(<OnboardingWizard onDone={vi.fn()} />)
    await waitFor(() => expect(window.orchaDesktop.onProvisionProgress).toHaveBeenCalled())
    holder.cb?.({
      runId: 'stale',
      step: 'start',
      status: 'log',
      line: 'noise'
    })
    expect(screen.queryByText(/noise/)).not.toBeInTheDocument()
  })
})

describe('OnboardingWizard — provisioning failure is recoverable', () => {
  it('shows a failure title, a readable reason, details on demand, and retries the same request', async () => {
    const holder = captureProgress()
    mock(window.orchaDesktop.provision)
      .mockImplementationOnce(async () => {
        holder.cb?.({ runId: 'r1', step: 'config', status: 'ok' })
        holder.cb?.({ runId: 'r1', step: 'start', status: 'start' })
        holder.cb?.({
          runId: 'r1',
          step: 'start',
          status: 'log',
          line: 'Error response from daemon: port is already allocated'
        })
        throw {
          code: 'PROVISION_FAILED',
          step: 'start',
          stderr: 'Error response from daemon: port is already allocated'
        }
      })
      .mockResolvedValue({
        project: 'orcha-demo',
        apiPort: 8001,
        warnings: []
      })
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={vi.fn()} />)
    await toDetailsAndCreate(user)

    expect(await screen.findByRole('heading', { name: /couldn.t create demo/i })).toBeInTheDocument()
    // A recognizable cause (port clash) becomes the headline instead of the generic step line.
    expect(screen.getByText(/a port this project needs is already in use/i)).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('[object Object]')
    // The failed step is marked, the log opens by itself.
    expect(document.querySelector('[data-state="failed"]')).toHaveTextContent('Start Orcha in the background')
    expect(screen.getByLabelText('Provisioning log')).toHaveTextContent(/port is already allocated/)

    await user.click(screen.getByRole('button', { name: /try again/i }))
    await waitFor(() => expect(window.orchaDesktop.provision).toHaveBeenCalledTimes(2))
    expect(mock(window.orchaDesktop.provision).mock.calls[1][0]).toEqual(
      mock(window.orchaDesktop.provision).mock.calls[0][0]
    )
    // The retry's checklist starts clean — the old failure doesn't leak in.
    await screen.findByRole('button', { name: /^open /i })
  })

  it('Back from a failure returns to Details with the typed name preserved', async () => {
    mock(window.orchaDesktop.provision).mockRejectedValueOnce({
      code: 'PORTAL_TIMEOUT'
    })
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={vi.fn()} />)
    await continueToSource(user)
    await pickLocalFolder(user)
    const name = await screen.findByLabelText(/project name/i)
    await user.clear(name)
    await user.type(name, 'storefront')
    await user.type(screen.getByLabelText(/objective/i), 'Ship checkout')
    await user.click(screen.getByRole('button', { name: /create project/i }))

    expect(await screen.findByText(/portal didn.t answer in time/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^back$/i }))
    expect(screen.getByLabelText(/project name/i)).toHaveValue('storefront')
    expect(screen.getByLabelText(/objective/i)).toHaveValue('Ship checkout')
  })
})

describe('OnboardingWizard — From GitHub source', () => {
  it('gh-authenticated: lists repos, prefills the destination, clones, then provisions', async () => {
    mock(window.orchaDesktop.githubStatus).mockResolvedValue({
      authenticated: true,
      gitInstalled: true
    })
    mock(window.orchaDesktop.githubRepos).mockResolvedValue([
      { nameWithOwner: 'open-orcha/orcha', description: 'The orcha CLI' }
    ])
    const onDone = vi.fn()
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={onDone} />)

    await continueToSource(user)
    await user.click(screen.getByRole('button', { name: /from github/i }))
    await user.click(await screen.findByText('open-orcha/orcha'))

    // No extra "Choose destination" step: the suggestion is filled in.
    await waitFor(() => expect(screen.getByText('/tmp/orcha-projects/demo')).toBeInTheDocument())
    expect(window.orchaDesktop.pickCloneDest).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: /clone.*continue/i }))

    expect(window.orchaDesktop.cloneAndProvision).toHaveBeenCalledWith({
      repoUrl: 'https://github.com/open-orcha/orcha',
      dest: '/tmp/orcha-projects/demo'
    })
    await finishFromPortal(user, 'orcha-demo')
    await waitFor(() => expect(onDone).toHaveBeenCalled())
  })

  it('falls back to the URL field alone when gh is not authenticated', async () => {
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={vi.fn()} />)
    await continueToSource(user)
    await user.click(screen.getByRole('button', { name: /from github/i }))
    await waitFor(() => expect(screen.getByText(/isn.t signed in/i)).toBeInTheDocument())
    expect(window.orchaDesktop.githubRepos).not.toHaveBeenCalled()
    expect(screen.getByLabelText(/repository url/i)).toBeInTheDocument()
  })

  it('rejects an invalid repo URL inline (ssh/http/garbage never reach the main process)', async () => {
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={vi.fn()} />)
    await continueToSource(user)
    await user.click(screen.getByRole('button', { name: /from github/i }))
    await user.type(await screen.findByLabelText(/repository url/i), 'git@github.com:open-orcha/orcha.git')
    expect(await screen.findByText(/ssh urls aren.t supported/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /clone.*continue/i })).toBeDisabled()
  })

  it('Change… refuses a non-empty destination without losing the suggested one', async () => {
    mock(window.orchaDesktop.pickCloneDest).mockRejectedValue({
      code: 'DEST_NOT_EMPTY'
    })
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={vi.fn()} />)
    await continueToSource(user)
    await user.click(screen.getByRole('button', { name: /from github/i }))
    await user.type(await screen.findByLabelText(/repository url/i), 'https://github.com/open-orcha/orcha')
    await waitFor(() => expect(screen.getByText('/tmp/orcha-projects/demo')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /change/i }))
    expect(await screen.findByText(/isn.t empty/i)).toBeInTheDocument()
    expect(screen.getByText('/tmp/orcha-projects/demo')).toBeInTheDocument()
  })

  it('shows clone progress AND the provision steps that follow under a different run id', async () => {
    mock(window.orchaDesktop.githubStatus).mockResolvedValue({
      authenticated: true,
      gitInstalled: true
    })
    mock(window.orchaDesktop.githubRepos).mockResolvedValue([{ nameWithOwner: 'open-orcha/orcha', description: null }])
    const holder = captureProgress()
    type CloneResult = { project: string; apiPort: number; warnings: string[] }
    const resolver: { current: ((r: CloneResult) => void) | null } = {
      current: null
    }
    mock(window.orchaDesktop.cloneAndProvision).mockReturnValue(new Promise<CloneResult>((r) => (resolver.current = r)))
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={vi.fn()} />)

    await continueToSource(user)
    await user.click(screen.getByRole('button', { name: /from github/i }))
    await user.click(await screen.findByText('open-orcha/orcha'))
    await waitFor(() => expect(screen.getByText('/tmp/orcha-projects/demo')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /clone.*continue/i }))

    holder.cb?.({
      runId: 'clone:1',
      step: 'clone-repo',
      status: 'log',
      line: 'Receiving objects: 42%'
    })
    expect(await screen.findByText(/receiving objects: 42%/i)).toBeInTheDocument()
    holder.cb?.({ runId: 'clone:1', step: 'clone-repo', status: 'ok' })
    holder.cb?.({
      runId: '/tmp/orcha-projects/demo:init:2',
      step: 'config',
      status: 'ok'
    })
    await waitFor(() =>
      expect(screen.getByText('Write project settings').closest('[data-state]')).toHaveAttribute('data-state', 'done')
    )
    expect(screen.getByText('Clone the repository').closest('[data-state]')).toHaveAttribute('data-state', 'done')
    expect(screen.getByText(/step 3 of 9/i)).toBeInTheDocument()

    resolver.current?.({ project: 'orcha-demo', apiPort: 8001, warnings: [] })
  })
})

describe('OnboardingWizard — walker: welcome / agents / finish / cancel', () => {
  it('first-run shows the Welcome screen first', () => {
    render(<OnboardingWizard onDone={vi.fn()} variant="first-run" />)
    expect(screen.getByRole('heading', { name: /welcome to embodent/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /get started/i })).toBeInTheDocument()
  })

  it('add-project starts at Source — no Welcome and no "Check your Mac" screen', async () => {
    render(<OnboardingWizard onDone={vi.fn()} variant="add-project" onCancel={vi.fn()} />)
    expect(screen.getByText(/where.s your code/i)).toBeInTheDocument()
    expect(screen.queryByText(/check your mac/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /get started/i })).not.toBeInTheDocument()
    // Let the silent background check settle — it must not surface anything when all is well.
    await waitFor(() => expect(window.orchaDesktop.probePrereqs).toHaveBeenCalled())
    expect(screen.queryByTestId('setup-notice')).not.toBeInTheDocument()
    // GH #258: Docker is no longer part of the setup check.
    expect(window.orchaDesktop.preflight).not.toHaveBeenCalled()
  })

  it('add-project Cancel asks the right question, Keep going is the primary, Escape closes it', async () => {
    const onCancel = vi.fn()
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={vi.fn()} variant="add-project" onCancel={onCancel} />)
    await user.click(screen.getByRole('button', { name: /^cancel$/i }))
    expect(screen.getByRole('alertdialog', { name: /cancel adding this project/i })).toBeInTheDocument()
    expect(screen.queryByText(/skip setup/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /keep going/i })).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^cancel$/i }))
    await user.click(screen.getByRole('button', { name: /cancel setup/i }))
    expect(onCancel).toHaveBeenCalled()
  })

  it('shows suggested agents, creates them and goes straight to Finish, which opens Agents', async () => {
    const suggestPayload = {
      available: true,
      project_kind: 'ios',
      signals: ['ios/'],
      suggestions: [
        {
          alias: 'Atlas',
          role: 'Lead',
          focus: 'Coordination',
          is_main: true,
          rationale: 'found ios/'
        }
      ]
    }
    mock(window.orchaDesktop.portalGet).mockImplementation(async (_apiPort: number, path: string) => {
      if (path === '/api/containers') return { containers: [{ id: 'c1' }] }
      if (path === '/api/containers/c1/roster/suggest') return suggestPayload
      if (path === '/api/containers/c1') return { agents: [{ id: 'h1', kind: 'human' }] }
      throw { code: 'PORTAL_REQUEST_FAILED', status: 404 }
    })
    mock(window.orchaDesktop.portalPost).mockResolvedValue({
      created: [{ agent_id: 'a1', alias: 'Atlas' }]
    })
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={vi.fn()} />)
    await toDetailsAndCreate(user)

    await waitFor(() => expect(screen.getByRole('heading', { name: /suggested agents/i })).toBeInTheDocument())
    expect(screen.getByText('Atlas')).toBeInTheDocument()
    // Revealed as a card with an avatar, selected by default.
    const card = screen.getByText('Atlas').closest('.ob-agent-card')
    expect(card).toHaveAttribute('data-checked', 'true')
    expect(card?.querySelector('.ob-avatar')).toHaveTextContent('A')
    await user.click(screen.getByRole('button', { name: /create 1 agent/i }))

    await waitFor(() => expect(screen.getByRole('heading', { name: /demo is ready/i })).toBeInTheDocument())
    expect(screen.queryByText(/fleet created/i)).not.toBeInTheDocument()
    expect(screen.getByText('Atlas')).toBeInTheDocument()
    await finishFromPortal(user, 'orcha-demo', '/agents')
  })

  it('falls back to the default landing when portalShow is unavailable', async () => {
    mock(window.orchaDesktop.portalShow).mockRejectedValue({
      code: 'UNKNOWN_STACK'
    })
    const onDone = vi.fn()
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={onDone} />)
    await toDetailsAndCreate(user)
    await user.click(await screen.findByRole('button', { name: /^open /i }))
    await waitFor(() => expect(window.orchaDesktop.openOnboardingPortal).toHaveBeenCalledWith('orcha-demo'))
    expect(onDone).toHaveBeenCalled()
  })
})

describe('OnboardingWizard — variants: steps, indicator and Back', () => {
  it('first run walks Welcome → Setup → Source with a 5-step indicator that starts at Setup', async () => {
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={vi.fn()} variant="first-run" />)
    // Welcome is a bookend: no indicator.
    expect(screen.queryByRole('list', { name: /step \d of/i })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /get started/i }))
    expect(screen.getByRole('heading', { name: /check your mac/i })).toBeInTheDocument()
    const stepper = screen.getByRole('list', { name: /step 1 of 5/i })
    expect(stepper).toHaveTextContent(/Setup.*Source.*Details.*Create.*Agents/)
    expect(within(stepper).getByText('Setup').closest('[data-state]')).toHaveAttribute('data-state', 'current')
    await waitFor(() => expect(screen.getByRole('button', { name: /^continue$/i })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: /^continue$/i }))
    const next = await screen.findByRole('list', { name: /step 2 of 5/i })
    expect(within(next).getByText('Setup').closest('[data-state]')).toHaveAttribute('data-state', 'done')
    // The connector into Source has filled; the one into Details hasn't yet.
    const seps = next.querySelectorAll('.ob-step-sep')
    expect(seps[0]).toHaveAttribute('data-filled', 'true')
    expect(seps[1]).toHaveAttribute('data-filled', 'false')
  })

  it('add-project shows a 4-step indicator without Setup: Source · Details · Create · Agents', () => {
    render(<OnboardingWizard onDone={vi.fn()} variant="add-project" onCancel={vi.fn()} />)
    const stepper = screen.getByRole('list', { name: /step 1 of 4/i })
    expect(stepper).toHaveTextContent(/Source.*Details.*Create.*Agents/)
    expect(stepper).not.toHaveTextContent(/Setup/)
    expect(within(stepper).getByText('Source').closest('[data-state]')).toHaveAttribute('data-state', 'current')
  })

  it('add-project walks Source → Folder → Details → Create without ever showing Setup', async () => {
    const onDone = vi.fn()
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={onDone} variant="add-project" onCancel={vi.fn()} />)
    await pickLocalFolder(user)
    expect(await screen.findByRole('list', { name: /step 2 of 4/i })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /create project/i }))
    await waitFor(() => expect(window.orchaDesktop.provision).toHaveBeenCalled())
    await finishFromPortal(user, 'orcha-demo', '/')
    expect(onDone).toHaveBeenCalled()
    expect(screen.queryByText(/check your mac/i)).not.toBeInTheDocument()
  })

  it('add-project Back on Source closes the wizard — it never goes to Setup', async () => {
    const onCancel = vi.fn()
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={vi.fn()} variant="add-project" onCancel={onCancel} />)
    await user.click(screen.getByRole('button', { name: /^back$/i }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/check your mac/i)).not.toBeInTheDocument()
  })

  it('first run Back on Source returns to Setup', async () => {
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={vi.fn()} variant="first-run" />)
    await continueToSource(user)
    await user.click(screen.getByRole('button', { name: /^back$/i }))
    expect(screen.getByRole('heading', { name: /check your mac/i })).toBeInTheDocument()
  })
})

describe('OnboardingWizard — add-project background setup check', () => {
  it('surfaces a missing AI coding agent on Source with the fix, and Check again clears it', async () => {
    const ok = await window.orchaDesktop.probePrereqs()
    mock(window.orchaDesktop.probePrereqs)
      .mockResolvedValueOnce({ homebrew: false, dockerEngine: false, orcha: true, claude: false, codex: false })
      .mockResolvedValue(ok)
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={vi.fn()} variant="add-project" onCancel={vi.fn()} />)
    const notice = await screen.findByTestId('setup-notice')
    expect(notice).toHaveTextContent(/no ai coding agent found/i)
    expect(notice).toHaveTextContent(/install claude code or codex/i)
    // Still on Source — nothing blocks choosing a source meanwhile.
    expect(screen.getByRole('button', { name: /local folder/i })).toBeEnabled()
    await user.click(within(notice).getByRole('button', { name: /check again/i }))
    await waitFor(() => expect(screen.queryByTestId('setup-notice')).not.toBeInTheDocument())
    expect(window.orchaDesktop.probePrereqs).toHaveBeenCalledTimes(3)
  })

  it('names the missing helper as the "Embodent command-line helper", never "Orcha helper"', async () => {
    mock(window.orchaDesktop.probePrereqs).mockResolvedValue({
      homebrew: true,
      dockerEngine: true,
      orcha: false,
      claude: true,
      codex: false
    })
    render(<OnboardingWizard onDone={vi.fn()} variant="add-project" onCancel={vi.fn()} />)
    const notice = await screen.findByTestId('setup-notice')
    expect(notice).toHaveTextContent(/embodent command-line helper/i)
    expect(document.body.textContent).not.toMatch(/orcha helper/i)
  })

  it('Open setup routes to the Setup step with the reason; Back returns to Source', async () => {
    mock(window.orchaDesktop.probePrereqs).mockResolvedValue({ homebrew: false, dockerEngine: false, orcha: true, claude: false, codex: false })
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={vi.fn()} variant="add-project" onCancel={vi.fn()} />)
    const notice = await screen.findByTestId('setup-notice')
    await user.click(within(notice).getByRole('button', { name: /open setup/i }))
    expect(screen.getByRole('heading', { name: /check your mac/i })).toBeInTheDocument()
    expect(screen.getByText(/embodent needs something on this mac first/i)).toBeInTheDocument()
    expect(screen.getByText(/no ai coding agent found\./i)).toBeInTheDocument()
    // The detour is not one of Add a project's steps — no indicator there.
    expect(screen.queryByRole('list', { name: /step \d of/i })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^back$/i }))
    expect(screen.getByText(/where.s your code/i)).toBeInTheDocument()
  })

  it('never starts a create the check knows will fail: routes to Setup with the reason instead', async () => {
    mock(window.orchaDesktop.probePrereqs).mockResolvedValue({ homebrew: false, dockerEngine: false, orcha: true, claude: false, codex: false })
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={vi.fn()} variant="add-project" onCancel={vi.fn()} />)
    await screen.findByTestId('setup-notice')
    await pickLocalFolder(user)
    // The notice follows the user through the pre-create steps.
    expect(await screen.findByTestId('setup-notice')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /create project/i }))
    expect(window.orchaDesktop.provision).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: /check your mac/i })).toBeInTheDocument()
    expect(screen.getByText(/no ai coding agent found\./i)).toBeInTheDocument()
    // Back returns to Details with the name still filled in.
    await user.click(screen.getByRole('button', { name: /^back$/i }))
    expect(screen.getByLabelText(/project name/i)).toHaveValue('demo')
  })
})

describe('OnboardingWizard — motion', () => {
  function setMotion(reduce: boolean): void {
    window.matchMedia = vi.fn().mockImplementation((q: string) => ({
      matches: q.includes('no-preference') ? !reduce : reduce,
      media: q,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })) as never
  }
  type VTDoc = { startViewTransition?: unknown }
  afterEach(() => {
    delete (window as { matchMedia?: unknown }).matchMedia
    delete (document as unknown as VTDoc).startViewTransition
    delete document.documentElement.dataset.obDir
  })
  function stubViewTransition(): ReturnType<typeof vi.fn> {
    const dirs: string[] = []
    const vt = vi.fn((cb: () => void) => {
      dirs.push(document.documentElement.dataset.obDir ?? '')
      cb()
      return { finished: Promise.resolve() }
    })
    ;(vt as unknown as { dirs: string[] }).dirs = dirs
    ;(document as unknown as VTDoc).startViewTransition = vt
    return vt
  }

  it('reduced motion: steps swap instantly — no view transition is started', async () => {
    setMotion(true)
    const vt = stubViewTransition()
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={vi.fn()} variant="first-run" />)
    await user.click(screen.getByRole('button', { name: /get started/i }))
    expect(screen.getByRole('heading', { name: /check your mac/i })).toBeInTheDocument()
    expect(vt).not.toHaveBeenCalled()
    expect(document.documentElement.dataset.obDir).toBeUndefined()
  })

  it('with motion allowed, moves are direction-aware view transitions (forward, then back)', async () => {
    setMotion(false)
    const vt = stubViewTransition()
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={vi.fn()} variant="first-run" />)
    await continueToSource(user)
    await user.click(screen.getByRole('button', { name: /^back$/i }))
    expect(screen.getByRole('heading', { name: /check your mac/i })).toBeInTheDocument()
    expect((vt as unknown as { dirs: string[] }).dirs).toEqual(['forward', 'forward', 'back'])
  })

  it('with motion allowed, Create holds its completion moment, then moves on by itself', async () => {
    setMotion(false)
    stubViewTransition()
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={vi.fn()} variant="first-run" />)
    await toDetailsAndCreate(user)
    expect(await screen.findByRole('heading', { name: /demo is ready/i })).toBeInTheDocument()
    expect(document.querySelector('.ob-launch')).toHaveAttribute('data-status', 'done')
    // Still on Create for the moment (the Finish primary isn't there yet)…
    expect(screen.queryByRole('button', { name: /^open /i })).not.toBeInTheDocument()
    // …then Agents (404 → skipped) → Finish.
    expect(await screen.findByRole('button', { name: /^open /i }, { timeout: 3000 })).toBeInTheDocument()
  })

  it('reduced motion: Create moves on at once (no completion hold)', async () => {
    setMotion(true)
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={vi.fn()} variant="first-run" />)
    await toDetailsAndCreate(user)
    expect(await screen.findByRole('button', { name: /^open /i })).toBeInTheDocument()
  })
})
