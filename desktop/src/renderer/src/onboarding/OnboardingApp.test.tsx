// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import OnboardingApp from './OnboardingApp'
import type { ProgressEvent } from '../../../shared/types'

let progressCb: ((e: ProgressEvent) => void) | null = null

beforeEach(() => {
  progressCb = null
  window.orchaDesktop = {
    listStacks: vi.fn().mockResolvedValue([]),
    startStack: vi.fn().mockResolvedValue(undefined),
    stopStack: vi.fn().mockResolvedValue(undefined),
    openPortal: vi.fn().mockResolvedValue(undefined),
    listAttention: vi.fn().mockResolvedValue([]),
    openManager: vi.fn().mockResolvedValue(undefined),
    quitApp: vi.fn().mockResolvedValue(undefined),
    preflight: vi.fn().mockResolvedValue({ docker: 'ok', autoStarted: false, hint: null }),
    pickFolder: vi.fn().mockResolvedValue({ folder: '/tmp/demo', mode: 'existing' }),
    inspectFolder: vi.fn().mockResolvedValue({ initialized: false, writable: true, suggestedName: 'demo' }),
    provision: vi.fn().mockResolvedValue({ project: 'orcha-demo', apiPort: 8001, warnings: [] }),
    openOnboarding: vi.fn().mockResolvedValue(undefined),
    openOnboardingPortal: vi.fn().mockResolvedValue(undefined),
    onProvisionProgress: vi.fn().mockImplementation((cb) => {
      progressCb = cb
      return () => {
        progressCb = null
      }
    })
  }
})

describe('OnboardingApp', () => {
  it('walks preflight → folder → provision and hands off to the portal', async () => {
    const user = userEvent.setup()
    render(<OnboardingApp />)

    // Preflight resolves ok → Continue enabled.
    await waitFor(() => expect(screen.getByRole('button', { name: /continue/i })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: /continue/i }))

    // Folder step: choose a folder.
    await user.click(screen.getByRole('button', { name: /choose folder/i }))
    await waitFor(() => expect(screen.getByDisplayValue('demo')).toBeInTheDocument())

    // Start provisioning.
    await user.click(screen.getByRole('button', { name: /create project/i }))
    expect(window.orchaDesktop.provision).toHaveBeenCalledWith(
      expect.objectContaining({ folder: '/tmp/demo', mode: 'init', name: 'demo' })
    )

    // Hand-off opens the portal onboarding.
    await waitFor(() => expect(window.orchaDesktop.openOnboardingPortal).toHaveBeenCalledWith('orcha-demo'))
  })

  it('ignores progress events from a stale run id', async () => {
    render(<OnboardingApp />)
    await waitFor(() => expect(window.orchaDesktop.onProvisionProgress).toHaveBeenCalled())
    // emitting an event with an unknown runId should not throw / should be ignored
    progressCb?.({ runId: 'stale', step: 'compose-up', status: 'log', line: 'noise' })
    expect(screen.queryByText(/noise/)).not.toBeInTheDocument()
  })
})
