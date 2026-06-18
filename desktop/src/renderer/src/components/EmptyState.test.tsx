// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import EmptyState from './EmptyState'

beforeEach(() => {
  window.orchaDesktop = {
    listStacks: vi.fn().mockResolvedValue([]),
    startStack: vi.fn(),
    stopStack: vi.fn(),
    openPortal: vi.fn(),
    listAttention: vi.fn().mockResolvedValue([]),
    openManager: vi.fn(),
    quitApp: vi.fn(),
    preflight: vi.fn(),
    pickFolder: vi.fn(),
    inspectFolder: vi.fn(),
    provision: vi.fn(),
    openOnboarding: vi.fn().mockResolvedValue(undefined),
    openOnboardingPortal: vi.fn(),
    onProvisionProgress: vi.fn().mockReturnValue(() => {})
  }
})

describe('EmptyState', () => {
  it('Create your first project calls openOnboarding', async () => {
    render(<EmptyState />)
    await userEvent.click(screen.getByRole('button', { name: /create your first project/i }))
    expect(window.orchaDesktop.openOnboarding).toHaveBeenCalledTimes(1)
  })
})
