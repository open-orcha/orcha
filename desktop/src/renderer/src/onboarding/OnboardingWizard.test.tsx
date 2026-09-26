// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import OnboardingWizard from './OnboardingWizard'

beforeEach(() => {
  window.orchaDesktop = {
    listStacks: vi.fn().mockResolvedValue([]),
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
    pickFolder: vi.fn().mockResolvedValue({ folder: '/tmp/demo', mode: 'existing' }),
    inspectFolder: vi
      .fn()
      .mockResolvedValue({ initialized: false, writable: true, suggestedName: 'demo', isGitRepo: true }),
    provision: vi.fn().mockResolvedValue({ project: 'orcha-demo', apiPort: 8001, warnings: [] }),
    githubStatus: vi.fn().mockResolvedValue({ authenticated: false, gitInstalled: true }),
    githubRepos: vi.fn().mockResolvedValue([]),
    suggestCloneDest: vi.fn().mockResolvedValue({ parent: '/tmp/orcha-projects', repoName: 'demo' }),
    pickCloneDest: vi.fn().mockResolvedValue('/tmp/orcha-projects/demo'),
    cloneAndProvision: vi.fn().mockResolvedValue({ project: 'orcha-demo', apiPort: 8001, warnings: [] }),
    openOnboardingPortal: vi.fn().mockResolvedValue(undefined),
    openExternal: vi.fn().mockResolvedValue(undefined),
    onProvisionProgress: vi.fn().mockReturnValue(() => {}),
    onNavigate: vi.fn().mockReturnValue(() => {}),
    onPortalActive: vi.fn().mockReturnValue(() => {}),
    portalGet: vi.fn().mockRejectedValue({ code: 'PORTAL_REQUEST_FAILED', status: 404 }),
    portalPost: vi.fn().mockRejectedValue({ code: 'PORTAL_REQUEST_FAILED', status: 404 }),
    portalPut: vi.fn().mockRejectedValue({ code: 'PORTAL_REQUEST_FAILED', status: 404 }),
    analyzeProject: vi.fn().mockResolvedValue({ ok: false, reason: 'claude is not installed on this Mac' })
  }
})

/** Skips past the Welcome screen when present (only 'first-run' shows it — add-project
 *  starts straight on Setup). Welcome's feature-card stagger gates the CTA behind the
 *  typewriter effect finishing, so wait for it rather than racing the timer. */
async function skipWelcomeIfPresent(user: ReturnType<typeof userEvent.setup>) {
  // Welcome only shows for first-run; its CTA appears once the tagline typewriter
  // (~55ms/char) finishes — give it more than the default 1000ms waitFor budget. add-project
  // never renders "Orcha" as an h2-less glyph screen, so this resolves to a no-op there.
  if (!screen.queryByText('Orcha')) return
  await waitFor(() => expect(screen.getByRole('button', { name: /get started/i })).toBeInTheDocument(), {
    timeout: 3000
  })
  await user.click(screen.getByRole('button', { name: /get started/i }))
}

async function continueToSource(user: ReturnType<typeof userEvent.setup>) {
  await skipWelcomeIfPresent(user)
  await waitFor(() => expect(screen.getByRole('button', { name: /^continue$/i })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: /^continue$/i }))
  await waitFor(() => expect(screen.getByText(/where's the project/i)).toBeInTheDocument())
}

/** After a successful provision with no warnings/git-tip pause, the wizard auto-advances
 *  straight through Fleet (portalGet stubbed to 404 by default → auto-skip) to Finish,
 *  whose CTA is what actually opens the portal + calls onDone. */
async function finishFromPortal(user: ReturnType<typeof userEvent.setup>, project: string) {
  await waitFor(() => expect(screen.getByRole('button', { name: /open your portal/i })).toBeInTheDocument())
  await user.click(screen.getByRole('button', { name: /open your portal/i }))
  await waitFor(() => expect(window.orchaDesktop.openOnboardingPortal).toHaveBeenCalledWith(project))
}

describe('OnboardingWizard — local folder source', () => {
  it('walks preflight → source → folder → details → provision and hands off to the portal', async () => {
    const onDone = vi.fn()
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={onDone} />)

    await continueToSource(user)
    await user.click(screen.getByRole('button', { name: /local folder/i }))

    // Folder step
    await user.click(screen.getByRole('button', { name: /choose existing folder/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /next/i })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: /next/i }))

    // Details step (name prefilled) → Create
    await waitFor(() => expect(screen.getByDisplayValue('demo')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /create project/i }))

    expect(window.orchaDesktop.provision).toHaveBeenCalledWith(
      expect.objectContaining({ folder: '/tmp/demo', mode: 'init', name: 'demo' })
    )
    // Success (isGitRepo: true → no pause on the git tip) → Fleet auto-skips (404 stub) →
    // Finish → portal handoff + onDone.
    await finishFromPortal(user, 'orcha-demo')
    await waitFor(() => expect(onDone).toHaveBeenCalled())
  })

  it('auto-binds the code source (PUT .../github) right after a successful provision of a git folder', async () => {
    ;(window.orchaDesktop.portalGet as ReturnType<typeof vi.fn>).mockImplementation(
      async (_apiPort: number, path: string) => {
        if (path === '/api/containers') return { containers: [{ id: 'c1' }] }
        if (path === '/api/containers/c1') return { agents: [{ id: 'h1', kind: 'human' }] }
        throw { code: 'PORTAL_REQUEST_FAILED', status: 404 }
      }
    )
    ;(window.orchaDesktop.portalPut as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true })
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={vi.fn()} />)

    await continueToSource(user)
    await user.click(screen.getByRole('button', { name: /local folder/i }))
    await user.click(screen.getByRole('button', { name: /choose existing folder/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /next/i })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: /next/i }))
    await waitFor(() => expect(screen.getByDisplayValue('demo')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /create project/i }))

    await waitFor(() =>
      expect(window.orchaDesktop.portalPut).toHaveBeenCalledWith(8001, '/api/containers/c1/github', {
        repo: 'local',
        actor_agent_id: 'h1'
      })
    )
    // Surfaced on the Finish step's summary once bound.
    await waitFor(() => expect(screen.getByRole('button', { name: /open your portal/i })).toBeInTheDocument())
    expect(screen.getByText('Code source')).toBeInTheDocument()
    expect(screen.getByText('local repository')).toBeInTheDocument()
  })

  it('tolerates a non-200 on the github bind (e.g. an open-portal stack rejecting "local") — never blocks the wizard', async () => {
    ;(window.orchaDesktop.portalGet as ReturnType<typeof vi.fn>).mockImplementation(
      async (_apiPort: number, path: string) => {
        if (path === '/api/containers') return { containers: [{ id: 'c1' }] }
        if (path === '/api/containers/c1') return { agents: [{ id: 'h1', kind: 'human' }] }
        throw { code: 'PORTAL_REQUEST_FAILED', status: 404 }
      }
    )
    ;(window.orchaDesktop.portalPut as ReturnType<typeof vi.fn>).mockRejectedValue({
      code: 'PORTAL_REQUEST_FAILED',
      status: 400
    })
    const onDone = vi.fn()
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={onDone} />)

    await continueToSource(user)
    await user.click(screen.getByRole('button', { name: /local folder/i }))
    await user.click(screen.getByRole('button', { name: /choose existing folder/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /next/i })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: /next/i }))
    await waitFor(() => expect(screen.getByDisplayValue('demo')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /create project/i }))

    // The wizard still completes normally — no error surfaced for the failed bind.
    await finishFromPortal(user, 'orcha-demo')
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(screen.queryByText('Code source')).not.toBeInTheDocument()
  })

  it('reconnects (mode upgrade) and skips the Details step for an already-initialized folder', async () => {
    ;(window.orchaDesktop.inspectFolder as ReturnType<typeof vi.fn>).mockResolvedValue({
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
    await waitFor(() => expect(screen.getByRole('button', { name: /next/i })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: /next/i }))

    // Reconnect fires straight from Folder's Next — no Details step, no "Create project" button.
    await waitFor(() =>
      expect(window.orchaDesktop.provision).toHaveBeenCalledWith(
        expect.objectContaining({ folder: '/tmp/demo', mode: 'upgrade' })
      )
    )
    await finishFromPortal(user, 'orcha-demo')
    await waitFor(() => expect(onDone).toHaveBeenCalled())
  })

  it('shows the git-init tip and pauses on Continue for a non-git folder', async () => {
    ;(window.orchaDesktop.inspectFolder as ReturnType<typeof vi.fn>).mockResolvedValue({
      initialized: false,
      writable: true,
      suggestedName: 'demo',
      isGitRepo: false
    })
    const onDone = vi.fn()
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={onDone} />)

    await continueToSource(user)
    await user.click(screen.getByRole('button', { name: /local folder/i }))
    await user.click(screen.getByRole('button', { name: /choose existing folder/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /next/i })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: /next/i }))
    await waitFor(() => expect(screen.getByDisplayValue('demo')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /create project/i }))

    expect(await screen.findByText(/git init.*unlocks the local code-source features/i)).toBeInTheDocument()
    // Paused — the Fleet/Finish handoff waits on the explicit Continue click.
    expect(window.orchaDesktop.openOnboardingPortal).not.toHaveBeenCalled()
    // Auto-bind is skipped entirely for a non-git folder — never calls portalPut.
    expect(window.orchaDesktop.portalPut).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: /^continue$/i }))
    await finishFromPortal(user, 'orcha-demo')
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(window.orchaDesktop.portalPut).not.toHaveBeenCalled()
  })

  it('ignores progress events from a stale run id', async () => {
    type ProgressCb = (e: { runId: string; step: string; status: string; line?: string }) => void
    const holder: { cb: ProgressCb | null } = { cb: null }
    ;(window.orchaDesktop.onProvisionProgress as ReturnType<typeof vi.fn>).mockImplementation(
      (f: ProgressCb) => {
        holder.cb = f
        return () => {}
      }
    )
    render(<OnboardingWizard onDone={vi.fn()} />)
    await waitFor(() => expect(window.orchaDesktop.onProvisionProgress).toHaveBeenCalled())
    holder.cb?.({ runId: 'stale', step: 'compose-up', status: 'log', line: 'noise' })
    expect(screen.queryByText(/noise/)).not.toBeInTheDocument()
  })
})

describe('OnboardingWizard — From GitHub source', () => {
  it('gh-authenticated: lists repos, picks one, clones, then provisions', async () => {
    ;(window.orchaDesktop.githubStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      authenticated: true,
      gitInstalled: true
    })
    ;(window.orchaDesktop.githubRepos as ReturnType<typeof vi.fn>).mockResolvedValue([
      { nameWithOwner: 'open-orcha/orcha', description: 'The orcha CLI' }
    ])
    const onDone = vi.fn()
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={onDone} />)

    await continueToSource(user)
    await user.click(screen.getByRole('button', { name: /from github/i }))

    await waitFor(() => expect(screen.getByText('open-orcha/orcha')).toBeInTheDocument())
    await user.click(screen.getByText('open-orcha/orcha'))

    await waitFor(() => expect(screen.getByRole('button', { name: /choose destination/i })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: /choose destination/i }))
    await waitFor(() => expect(screen.getByText('/tmp/orcha-projects/demo')).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: /clone.*continue/i }))

    expect(window.orchaDesktop.cloneAndProvision).toHaveBeenCalledWith({
      repoUrl: 'https://github.com/open-orcha/orcha',
      dest: '/tmp/orcha-projects/demo'
    })
    await finishFromPortal(user, 'orcha-demo')
    await waitFor(() => expect(onDone).toHaveBeenCalled())
  })

  it('falls back to the URL field alone when gh is not authenticated', async () => {
    ;(window.orchaDesktop.githubStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      authenticated: false,
      gitInstalled: true
    })
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={vi.fn()} />)

    await continueToSource(user)
    await user.click(screen.getByRole('button', { name: /from github/i }))

    await waitFor(() => expect(screen.getByText(/no authenticated gh cli/i)).toBeInTheDocument())
    expect(window.orchaDesktop.githubRepos).not.toHaveBeenCalled()
    expect(screen.getByLabelText(/repository url/i)).toBeInTheDocument()
  })

  it('rejects an invalid repo URL inline (ssh/http/garbage never reach the main process)', async () => {
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={vi.fn()} />)

    await continueToSource(user)
    await user.click(screen.getByRole('button', { name: /from github/i }))

    const urlField = await screen.findByLabelText(/repository url/i)
    await user.type(urlField, 'git@github.com:open-orcha/orcha.git')
    expect(await screen.findByText(/ssh urls aren.t supported/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /choose destination/i })).not.toBeInTheDocument()
  })

  it('refuses a non-empty destination (pickCloneDest resolves null) without crashing', async () => {
    ;(window.orchaDesktop.pickCloneDest as ReturnType<typeof vi.fn>).mockRejectedValue({
      code: 'DEST_NOT_EMPTY'
    })
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={vi.fn()} />)

    await continueToSource(user)
    await user.click(screen.getByRole('button', { name: /from github/i }))
    const urlField = await screen.findByLabelText(/repository url/i)
    await user.type(urlField, 'https://github.com/open-orcha/orcha')

    await waitFor(() => expect(screen.getByRole('button', { name: /choose destination/i })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: /choose destination/i }))

    expect(await screen.findByText(/isn.t empty/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /clone.*continue/i })).toBeDisabled()
  })

  it('streams clone-repo progress into the same provisioning UI', async () => {
    ;(window.orchaDesktop.githubStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      authenticated: true,
      gitInstalled: true
    })
    ;(window.orchaDesktop.githubRepos as ReturnType<typeof vi.fn>).mockResolvedValue([
      { nameWithOwner: 'open-orcha/orcha', description: null }
    ])
    type ProgressCb = (e: { runId: string; step: string; status: string; line?: string }) => void
    const holder: { cb: ProgressCb | null } = { cb: null }
    ;(window.orchaDesktop.onProvisionProgress as ReturnType<typeof vi.fn>).mockImplementation(
      (f: ProgressCb) => {
        holder.cb = f
        return () => {}
      }
    )
    // Hold cloneAndProvision open so the test can inject a progress event and assert it
    // renders WHILE still on the Provision screen, before the mock resolves and the wizard
    // auto-advances into Fleet/Finish.
    type CloneResult = { project: string; apiPort: number; warnings: string[] }
    const cloneResolver: { current: ((res: CloneResult) => void) | null } = { current: null }
    ;(window.orchaDesktop.cloneAndProvision as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise<CloneResult>((resolve) => {
        cloneResolver.current = resolve
      })
    )
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={vi.fn()} />)

    await continueToSource(user)
    await user.click(screen.getByRole('button', { name: /from github/i }))
    await waitFor(() => expect(screen.getByText('open-orcha/orcha')).toBeInTheDocument())
    await user.click(screen.getByText('open-orcha/orcha'))
    await waitFor(() => expect(screen.getByRole('button', { name: /choose destination/i })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: /choose destination/i }))
    await waitFor(() => expect(screen.getByText('/tmp/orcha-projects/demo')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /clone.*continue/i }))

    holder.cb?.({ runId: 'r1', step: 'clone-repo', status: 'log', line: 'Receiving objects: 42%' })
    expect(await screen.findByText(/receiving objects: 42%/i)).toBeInTheDocument()

    cloneResolver.current?.({ project: 'orcha-demo', apiPort: 8001, warnings: [] })
  })
})

describe('OnboardingWizard — walker: welcome / fleet / finish', () => {
  it('first-run shows the cinematic Welcome screen first', async () => {
    render(<OnboardingWizard onDone={vi.fn()} variant="first-run" />)
    await waitFor(
      () => expect(screen.getByRole('button', { name: /get started/i })).toBeInTheDocument(),
      { timeout: 3000 }
    )
  })

  it('add-project skips straight to Setup — no Welcome screen', async () => {
    render(<OnboardingWizard onDone={vi.fn()} variant="add-project" onCancel={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/what orcha needs/i)).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /get started/i })).not.toBeInTheDocument()
  })

  it('shows the Fleet step with suggestions when the portal supports roster/suggest, then Finish', async () => {
    const suggestPayload = {
      available: true,
      project_kind: 'ios',
      signals: ['ios/'],
      suggestions: [
        { alias: 'Atlas', role: 'Lead', focus: 'Coordination', is_main: true, rationale: 'found ios/' }
      ]
    }
    // Keyed on path (not a shared mockResolvedValueOnce queue) — the auto-bind fire-and-forget
    // call (bindCodeSource, wired into finishProvision) ALSO hits portalGet/portalPut around
    // the same time FleetStep mounts, so a shared once-queue is order-dependent and flaky.
    ;(window.orchaDesktop.portalGet as ReturnType<typeof vi.fn>).mockImplementation(
      async (_apiPort: number, path: string) => {
        if (path === '/api/containers') return { containers: [{ id: 'c1' }] }
        if (path === '/api/containers/c1/roster/suggest') return suggestPayload
        if (path === '/api/containers/c1') return { agents: [{ id: 'h1', kind: 'human' }] }
        throw { code: 'PORTAL_REQUEST_FAILED', status: 404 }
      }
    )
    ;(window.orchaDesktop.portalPost as ReturnType<typeof vi.fn>).mockResolvedValue({ created: ['Atlas'] })

    const user = userEvent.setup()
    render(<OnboardingWizard onDone={vi.fn()} />)

    await continueToSource(user)
    await user.click(screen.getByRole('button', { name: /local folder/i }))
    await user.click(screen.getByRole('button', { name: /choose existing folder/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /next/i })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: /next/i }))
    await waitFor(() => expect(screen.getByDisplayValue('demo')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /create project/i }))

    await waitFor(() => expect(screen.getByText(/meet your suggested fleet/i)).toBeInTheDocument())
    expect(screen.getByText('Atlas')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /create fleet/i }))
    await waitFor(() => expect(screen.getByText(/fleet created/i)).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /^continue$/i }))

    await waitFor(() => expect(screen.getByText(/is ready/i)).toBeInTheDocument())
    expect(screen.getByText('Created')).toBeInTheDocument()
  })
})
