// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import PreflightStep from './PreflightStep'

const ALL = {
  homebrew: true,
  dockerEngine: true,
  orcha: true,
  claude: true,
  codex: false,
  apiKey: true
}

function stub(over: Record<string, unknown> = {}) {
  window.orchaDesktop = {
    preflight: vi.fn().mockResolvedValue({ docker: 'ok', autoStarted: false, hint: null }),
    probePrereqs: vi.fn().mockResolvedValue(ALL),
    installPrereqs: vi.fn().mockResolvedValue({ ok: true, completed: [] }),
    onInstallProgress: vi.fn().mockReturnValue(() => {}),
    openExternal: vi.fn(),
    ...over
  } as never
}

const row = (key: string) => document.querySelector(`[data-row="${key}"]`) as HTMLElement

beforeEach(() => stub())

describe('PreflightStep (Setup)', () => {
  it('lists Docker, Homebrew, the AI agent and the Embodent command-line helper with their real state', async () => {
    render(<PreflightStep onContinue={vi.fn()} />)
    await waitFor(() => expect(within(row('docker')).getByText('Running')).toBeInTheDocument())
    // User-facing name for the orcha CLI — never "Orcha helper".
    expect(within(row('orcha')).getByText('Embodent command-line helper')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/orcha helper/i)
    // Readiness meter counts what resolved.
    expect(screen.getByText('4 of 4 ready')).toBeInTheDocument()
    expect(within(row('homebrew')).getByText('Installed')).toBeInTheDocument()
    expect(within(row('ai')).getByText('Claude Code')).toBeInTheDocument()
    expect(within(row('orcha')).getByText('Installed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^continue$/i })).toBeEnabled()
  })

  it('offers "Start Docker" (not a download link) when Docker is installed but not running', async () => {
    stub({
      preflight: vi.fn().mockResolvedValue({
        docker: 'daemon-down',
        autoStarted: false,
        hint: 'Open Docker Desktop manually, then re-check.'
      })
    })
    render(<PreflightStep onContinue={vi.fn()} />)
    await waitFor(() => expect(within(row('docker')).getByText('Not running')).toBeInTheDocument())
    expect(within(row('docker')).getByRole('button', { name: /start docker/i })).toBeInTheDocument()
    expect(screen.queryByText(/get docker/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^continue$/i })).toBeDisabled()
  })

  it('says "Not responding" (not "Not running"/"Start Docker") when the Docker CLI is hung', async () => {
    stub({
      preflight: vi.fn().mockResolvedValue({
        docker: 'daemon-down',
        autoStarted: false,
        hint: 'Docker isn’t responding — its command line stopped answering. Quit and reopen Docker Desktop, then re-check.',
        unresponsive: true
      })
    })
    render(<PreflightStep onContinue={vi.fn()} />)
    await waitFor(() => expect(within(row('docker')).getByText('Not responding')).toBeInTheDocument())
    expect(within(row('docker')).queryByText('Not running')).not.toBeInTheDocument()
    expect(within(row('docker')).queryByRole('button', { name: /start docker/i })).not.toBeInTheDocument()
    expect(screen.getByTestId('docker-unresponsive')).toHaveTextContent(/quit and reopen docker desktop/i)
    expect(screen.getByText('Restart Docker, then re-check')).toBeInTheDocument()
    expect(screen.queryByText('Start Docker, then re-check')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^continue$/i })).toBeDisabled()
  })

  it('offers "Get Docker" only when Docker is not installed', async () => {
    stub({
      preflight: vi.fn().mockResolvedValue({
        docker: 'not-installed',
        autoStarted: false,
        hint: null
      })
    })
    render(<PreflightStep onContinue={vi.fn()} />)
    await waitFor(() => expect(within(row('docker')).getByText('Not installed')).toBeInTheDocument())
    expect(within(row('docker')).getByRole('button', { name: /get docker/i })).toBeInTheDocument()
  })

  it('says the helper installs on Continue, then installs it', async () => {
    const onContinue = vi.fn()
    stub({ probePrereqs: vi.fn().mockResolvedValue({ ...ALL, orcha: false }) })
    const user = userEvent.setup()
    render(<PreflightStep onContinue={onContinue} />)
    await waitFor(() => expect(within(row('orcha')).getByText(/installs when you continue/i)).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /^continue$/i }))
    await waitFor(() => expect(onContinue).toHaveBeenCalled())
    expect(window.orchaDesktop.installPrereqs).toHaveBeenCalled()
  })

  it('recovers when the check itself fails (e.g. a hung Docker CLI rejects)', async () => {
    const preflight = vi
      .fn()
      .mockRejectedValueOnce({ code: 'DOCKER_UNAVAILABLE' })
      .mockResolvedValue({ docker: 'ok', autoStarted: false, hint: null })
    stub({ preflight })
    const user = userEvent.setup()
    render(<PreflightStep onContinue={vi.fn()} />)
    expect(await screen.findByText(/couldn.t check this mac/i)).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: /re-check/i })[0])
    await waitFor(() => expect(within(row('docker')).getByText('Running')).toBeInTheDocument())
  })

  it('fills in the tool rows while Docker is still being checked or started', async () => {
    stub({ preflight: vi.fn(() => new Promise(() => {})) })
    render(<PreflightStep onContinue={vi.fn()} />)
    await waitFor(() => expect(within(row('homebrew')).getByText('Installed')).toBeInTheDocument())
    expect(within(row('docker')).getByText(/checking/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^continue$/i })).toBeDisabled()
  })

  it('says Docker is not responding after 15 s instead of spinning silently, and recovers by itself', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      let resolve: (r: unknown) => void = () => {}
      stub({ preflight: vi.fn().mockReturnValue(new Promise((r) => (resolve = r))) })
      render(<PreflightStep onContinue={vi.fn()} />)
      await vi.advanceTimersByTimeAsync(7000)
      expect(within(row('docker')).getByText('Waiting for Docker…')).toBeInTheDocument()
      expect(screen.queryByTestId('docker-stuck')).not.toBeInTheDocument()
      await vi.advanceTimersByTimeAsync(9000)
      expect(within(row('docker')).getByText(/not responding · 1[5-7]s/i)).toBeInTheDocument()
      expect(screen.getByTestId('docker-stuck')).toHaveTextContent(/quit it from the menu bar/i)
      expect(row('docker').querySelector('[data-glyph="warning"]')).not.toBeNull()
      // Re-check stays available while waiting; Continue does not.
      expect(screen.getByRole('button', { name: /^re-check$/i })).toBeEnabled()
      expect(screen.getByRole('button', { name: /^continue$/i })).toBeDisabled()
      resolve({ docker: 'ok', autoStarted: true, hint: null })
      await waitFor(() => expect(within(row('docker')).getByText('Started')).toBeInTheDocument())
      expect(screen.queryByTestId('docker-stuck')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('PreflightStep — detour from Add a project', () => {
  it('says why it is shown and offers Back', async () => {
    const onBack = vi.fn()
    const user = userEvent.setup()
    render(<PreflightStep onContinue={vi.fn()} onBack={onBack} reason="Docker isn’t running." />)
    expect(screen.getByText(/embodent needs something on this mac first/i)).toBeInTheDocument()
    expect(screen.getByText('Docker isn’t running.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^back$/i }))
    expect(onBack).toHaveBeenCalled()
  })

  it('names the helper in its install failure', async () => {
    stub({
      probePrereqs: vi.fn().mockResolvedValue({ ...ALL, orcha: false }),
      installPrereqs: vi.fn().mockResolvedValue({ ok: false, detail: 'network down' })
    })
    const user = userEvent.setup()
    render(<PreflightStep onContinue={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /^continue$/i })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: /^continue$/i }))
    expect(await screen.findByText(/the embodent command-line helper didn.t install: network down/i)).toBeInTheDocument()
  })
})
