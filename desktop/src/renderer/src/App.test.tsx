// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import App from './App'

function stub(stacks: unknown[]) {
  window.orchaDesktop = {
    listStacks: vi.fn().mockResolvedValue(stacks),
    startStack: vi.fn(),
    stopStack: vi.fn(),
    resetStack: vi.fn(),
    openPortal: vi.fn(),
    listAttention: vi.fn().mockResolvedValue([]),
    openManager: vi.fn(),
    quitApp: vi.fn(),
    preflight: vi.fn().mockResolvedValue({ docker: 'ok', autoStarted: false, hint: null }),
    probePrereqs: vi
      .fn()
      .mockResolvedValue({ homebrew: true, dockerEngine: true, orcha: true, claude: true, apiKey: true }),
    installPrereqs: vi.fn().mockResolvedValue({ ok: true, completed: [] }),
    onInstallProgress: vi.fn().mockReturnValue(() => {}),
    pickFolder: vi.fn().mockResolvedValue(null),
    inspectFolder: vi
      .fn()
      .mockResolvedValue({ initialized: false, writable: true, suggestedName: 'x' }),
    provision: vi.fn().mockResolvedValue({ project: 'orcha-x', apiPort: 8000, warnings: [] }),
    openOnboardingPortal: vi.fn(),
    openExternal: vi.fn(),
    onProvisionProgress: vi.fn().mockReturnValue(() => {}),
    onNavigate: vi.fn().mockReturnValue(() => {})
  } as never
}

describe('App single-window host', () => {
  beforeEach(() => vi.useRealTimers())

  it('starts in onboarding mode when there are no stacks', async () => {
    stub([])
    render(<App />)
    await waitFor(() => expect(screen.getByText(/set up orcha/i)).toBeInTheDocument())
  })

  it('starts in manager mode when stacks exist', async () => {
    stub([
      {
        project: 'orcha-x',
        projectShort: 'x',
        apiPort: 8000,
        dbPort: 5432,
        portalStatus: 'Up',
        running: true,
        folder: null
      }
    ])
    render(<App />)
    await waitFor(() => expect(screen.getByText(/orcha stacks/i)).toBeInTheDocument())
  })
})
