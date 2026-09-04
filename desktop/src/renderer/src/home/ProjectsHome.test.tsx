// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ProjectsHome from './ProjectsHome'
import type { Stack } from '../../../shared/types'

function stack(over: Partial<Stack> = {}): Stack {
  return {
    project: 'orcha-a',
    projectShort: 'a',
    apiPort: 8001,
    dbPort: 5432,
    portalStatus: 'Up',
    running: true,
    folder: '/tmp/a',
    ...over
  }
}

function container(over: Record<string, unknown> = {}) {
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
    ...over
  }
}

function stubDesktop(overrides: Partial<typeof window.orchaDesktop> = {}) {
  window.orchaDesktop = {
    listStacks: vi.fn().mockResolvedValue([]),
    portalGet: vi.fn().mockResolvedValue({ containers: [] }),
    portalShow: vi.fn(),
    startStack: vi.fn(),
    stopStack: vi.fn(),
    resetStack: vi.fn(),
    listAttention: vi.fn().mockResolvedValue([]),
    // HelperMissingBanner (mounted unconditionally in the ready view) probes on mount —
    // stub it present/healthy so it self-hides and existing assertions are unaffected.
    probePrereqs: vi
      .fn()
      .mockResolvedValue({ homebrew: true, dockerEngine: true, orcha: true, claude: true, codex: true, apiKey: true }),
    installPrereqs: vi.fn().mockResolvedValue({ ok: true, completed: [] }),
    onInstallProgress: vi.fn().mockReturnValue(() => {}),
    ...overrides
  } as never
}

beforeEach(() => {
  window.localStorage.clear()
  vi.clearAllMocks()
})

describe('ProjectsHome', () => {
  it('renders one card per container and the dashed New-project card', async () => {
    stubDesktop({
      listStacks: vi.fn().mockResolvedValue([stack()]),
      portalGet: vi.fn().mockResolvedValue({ containers: [container()] })
    })
    render(<ProjectsHome onCreate={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Demo project')).toBeInTheDocument())
    expect(screen.getByText('No description yet.')).toBeInTheDocument()
    expect(screen.getByText(/2/)).toBeInTheDocument()
    expect(screen.getByText(/new project/i)).toBeInTheDocument()
  })

  it('shows a LOCAL chip for a local-bound repo, the repo name otherwise', async () => {
    stubDesktop({
      listStacks: vi.fn().mockResolvedValue([stack()]),
      portalGet: vi.fn().mockResolvedValue({ containers: [container({ github_repo: 'local' })] })
    })
    render(<ProjectsHome onCreate={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Local')).toBeInTheDocument())
  })

  it('shows the github repo name (not a LOCAL chip) for a real GitHub binding', async () => {
    stubDesktop({
      listStacks: vi.fn().mockResolvedValue([stack()]),
      portalGet: vi.fn().mockResolvedValue({ containers: [container({ github_repo: 'acme/widgets' })] })
    })
    render(<ProjectsHome onCreate={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('acme/widgets')).toBeInTheDocument())
    expect(screen.queryByText('Local')).not.toBeInTheDocument()
  })

  it('clicking Open calls portalShow with a ?cid= path', async () => {
    const portalShow = vi.fn()
    stubDesktop({
      listStacks: vi.fn().mockResolvedValue([stack()]),
      portalGet: vi.fn().mockResolvedValue({ containers: [container()] }),
      portalShow
    })
    const user = userEvent.setup()
    render(<ProjectsHome onCreate={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Demo project')).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: /^open$/i }))
    expect(portalShow).toHaveBeenCalledWith('orcha-a', '/?cid=c1')
  })

  it('clicking Pair phone calls portalShow with the settings pairing path', async () => {
    const portalShow = vi.fn()
    stubDesktop({
      listStacks: vi.fn().mockResolvedValue([stack()]),
      portalGet: vi.fn().mockResolvedValue({ containers: [container()] }),
      portalShow
    })
    const user = userEvent.setup()
    render(<ProjectsHome onCreate={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Demo project')).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: /pair phone/i }))
    expect(portalShow).toHaveBeenCalledWith('orcha-a', '/settings?cid=c1#tab=general')
  })

  it('favoriting a card moves it into a Favorites section, persisted in localStorage', async () => {
    stubDesktop({
      listStacks: vi.fn().mockResolvedValue([stack()]),
      portalGet: vi.fn().mockResolvedValue({ containers: [container()] })
    })
    const user = userEvent.setup()
    render(<ProjectsHome onCreate={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Demo project')).toBeInTheDocument())
    expect(screen.queryByText('Favorites')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /favorite demo project/i }))
    expect(screen.getByText('Favorites')).toBeInTheDocument()
    expect(JSON.parse(window.localStorage.getItem('orcha:desktop:favorites') ?? '[]')).toEqual(['c1'])
  })

  it('renders a muted row (not a card) for a stopped stack, with a Start action', async () => {
    stubDesktop({
      listStacks: vi.fn().mockResolvedValue([stack({ project: 'orcha-b', projectShort: 'b', running: false, apiPort: null })]),
      portalGet: vi.fn()
    })
    render(<ProjectsHome onCreate={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('stopped-stack-row')).toBeInTheDocument())
    expect(screen.getByText('b')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^start$/i })).toBeInTheDocument()
    // Stopped stacks are never fetched for cards (nothing to fetch — portal isn't up).
    expect(window.orchaDesktop.portalGet).not.toHaveBeenCalled()
  })

  it('shows the Docker-down banner when listStacks rejects', async () => {
    stubDesktop({ listStacks: vi.fn().mockRejectedValue(new Error('docker down')) })
    render(<ProjectsHome onCreate={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/docker/i)).toBeInTheDocument())
  })

  it('clicking New project calls onCreate', async () => {
    stubDesktop({ listStacks: vi.fn().mockResolvedValue([]) })
    const onCreate = vi.fn()
    const user = userEvent.setup()
    render(<ProjectsHome onCreate={onCreate} />)
    await waitFor(() => expect(screen.getByText(/new project/i)).toBeInTheDocument())
    await user.click(screen.getByText(/new project/i))
    expect(onCreate).toHaveBeenCalledTimes(1)
  })

  describe('delete a running project (ProjectCard overflow menu)', () => {
    async function openDeleteDialog(user: ReturnType<typeof userEvent.setup>) {
      await waitFor(() => expect(screen.getByText('Demo project')).toBeInTheDocument())
      await user.click(screen.getByRole('button', { name: /more actions for demo project/i }))
      await user.click(screen.getByRole('menuitem', { name: /delete project/i }))
    }

    it('opens the shared type-to-confirm dialog naming the stack project', async () => {
      stubDesktop({
        listStacks: vi.fn().mockResolvedValue([stack()]),
        portalGet: vi.fn().mockResolvedValue({ containers: [container()] })
      })
      const user = userEvent.setup()
      render(<ProjectsHome onCreate={vi.fn()} />)
      await openDeleteDialog(user)

      expect(screen.getByRole('dialog', { name: /delete.*orcha-a/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /delete everything/i })).toBeDisabled()
    })

    it('confirming calls resetStack with the stack project and refreshes on success', async () => {
      const listStacks = vi.fn().mockResolvedValue([stack()])
      const resetStack = vi.fn().mockResolvedValue(undefined)
      stubDesktop({
        listStacks,
        portalGet: vi.fn().mockResolvedValue({ containers: [container()] }),
        resetStack
      })
      const user = userEvent.setup()
      render(<ProjectsHome onCreate={vi.fn()} />)
      await openDeleteDialog(user)

      await user.type(screen.getByLabelText(/confirm project name/i), 'orcha-a')
      await user.click(screen.getByRole('button', { name: /delete everything/i }))

      await waitFor(() => expect(resetStack).toHaveBeenCalledWith('orcha-a'))
      // Refresh (listStacks) ran again after a successful delete.
      await waitFor(() => expect(listStacks.mock.calls.length).toBeGreaterThanOrEqual(2))
      // Dialog closes on success.
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    })

    it('a failed delete keeps the dialog open and shows the error', async () => {
      stubDesktop({
        listStacks: vi.fn().mockResolvedValue([stack()]),
        portalGet: vi.fn().mockResolvedValue({ containers: [container()] }),
        resetStack: vi.fn().mockRejectedValue({ code: 'COMPOSE_FAILED', stderr: 'boom' })
      })
      const user = userEvent.setup()
      render(<ProjectsHome onCreate={vi.fn()} />)
      await openDeleteDialog(user)

      await user.type(screen.getByLabelText(/confirm project name/i), 'orcha-a')
      await user.click(screen.getByRole('button', { name: /delete everything/i }))

      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/boom/i))
      expect(screen.getByRole('dialog')).toBeInTheDocument()
    })

    it('Cancel closes the dialog without calling resetStack', async () => {
      const resetStack = vi.fn()
      stubDesktop({
        listStacks: vi.fn().mockResolvedValue([stack()]),
        portalGet: vi.fn().mockResolvedValue({ containers: [container()] }),
        resetStack
      })
      const user = userEvent.setup()
      render(<ProjectsHome onCreate={vi.fn()} />)
      await openDeleteDialog(user)

      await user.click(screen.getByRole('button', { name: /cancel/i }))
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(resetStack).not.toHaveBeenCalled()
    })
  })
})
