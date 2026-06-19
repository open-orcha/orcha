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
    pickFolder: vi.fn().mockResolvedValue({ folder: '/tmp/demo', mode: 'existing' }),
    inspectFolder: vi.fn().mockResolvedValue({ initialized: false, writable: true, suggestedName: 'demo' }),
    provision: vi.fn().mockResolvedValue({ project: 'orcha-demo', apiPort: 8001, warnings: [] }),
    openOnboardingPortal: vi.fn().mockResolvedValue(undefined),
    openExternal: vi.fn().mockResolvedValue(undefined),
    onProvisionProgress: vi.fn().mockReturnValue(() => {}),
    onNavigate: vi.fn().mockReturnValue(() => {})
  }
})

describe('OnboardingWizard', () => {
  it('walks the 4 steps and hands off to the portal, then calls onDone', async () => {
    const onDone = vi.fn()
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={onDone} />)

    // Step 1: Docker preflight ok → Continue
    await waitFor(() => expect(screen.getByRole('button', { name: /continue/i })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: /continue/i }))

    // Step 2: choose folder
    await user.click(screen.getByRole('button', { name: /choose folder/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /next/i })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: /next/i }))

    // Step 3: details (name prefilled) → Create
    await waitFor(() => expect(screen.getByDisplayValue('demo')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /create project/i }))

    expect(window.orchaDesktop.provision).toHaveBeenCalledWith(
      expect.objectContaining({ folder: '/tmp/demo', mode: 'init', name: 'demo' })
    )
    // Step 4: success → portal handoff + onDone
    await waitFor(() => expect(window.orchaDesktop.openOnboardingPortal).toHaveBeenCalledWith('orcha-demo'))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
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
