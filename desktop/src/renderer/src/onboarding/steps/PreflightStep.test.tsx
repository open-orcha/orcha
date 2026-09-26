// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import PreflightStep from './PreflightStep'

beforeEach(() => {
  window.orchaDesktop = {
    preflight: vi.fn().mockResolvedValue({ docker: 'ok', autoStarted: false, hint: null }),
    probePrereqs: vi
      .fn()
      .mockResolvedValue({ homebrew: true, dockerEngine: true, orcha: true, claude: true, codex: true, apiKey: true }),
    installPrereqs: vi.fn().mockResolvedValue({ ok: true, completed: [] }),
    onInstallProgress: vi.fn().mockReturnValue(() => {}),
    openExternal: vi.fn()
  } as never
})

describe('PreflightStep (Setup)', () => {
  it('shows the prerequisite checklist and the passive showcase carousel side by side', async () => {
    render(<PreflightStep onContinue={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Homebrew')).toBeInTheDocument())
    expect(screen.getByText(/claude code or codex/i)).toBeInTheDocument()
    expect(screen.getByText('Docker')).toBeInTheDocument()

    // Showcase carousel captions render (hidden from a11y tree, but present in the DOM).
    expect(screen.getByText(/your whole fleet, one view/i)).toBeInTheDocument()
  })

  it('enables Continue once every requirement checks out', async () => {
    render(<PreflightStep onContinue={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /^continue$/i })).toBeEnabled())
  })
})
