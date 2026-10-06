// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import PreflightStep from './PreflightStep'

const ALL = {
  homebrew: false,
  dockerEngine: false,
  orcha: true,
  claude: true,
  codex: false
}

function stub(over: Record<string, unknown> = {}) {
  window.orchaDesktop = {
    preflight: vi.fn().mockResolvedValue({ docker: 'not-installed', autoStarted: false, hint: null }),
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
  it('lists only the AI agent and the Embodent command-line helper — no Docker, no Homebrew (GH #258)', async () => {
    render(<PreflightStep onContinue={vi.fn()} />)
    await waitFor(() => expect(within(row('orcha')).getByText('Installed')).toBeInTheDocument())
    // User-facing name for the orcha CLI — never "Orcha helper".
    expect(within(row('orcha')).getByText('Embodent command-line helper')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/orcha helper/i)
    expect(screen.getByText('2 of 2 ready')).toBeInTheDocument()
    expect(within(row('ai')).getByText('Claude Code')).toBeInTheDocument()
    expect(row('docker')).toBeNull()
    expect(row('homebrew')).toBeNull()
    expect(document.body.textContent).not.toMatch(/docker|homebrew/i)
    expect(window.orchaDesktop.preflight).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /^continue$/i })).toBeEnabled()
  })

  it('says agents can run on a subscription or an API key, with a link to Settings › API keys', async () => {
    const onUseApiKey = vi.fn()
    const { rerender } = render(<PreflightStep onContinue={vi.fn()} onUseApiKey={onUseApiKey} />)
    await waitFor(() => expect(within(row('ai')).getByText('Claude Code')).toBeInTheDocument())
    expect(within(row('ai')).getByTestId('preflight-billing')).toHaveTextContent(
      'Agents run on a Claude or ChatGPT subscription, or an API key.'
    )
    await userEvent.click(within(row('ai')).getByRole('button', { name: 'Use an API key instead' }))
    expect(onUseApiKey).toHaveBeenCalledTimes(1)
    // no handler (older bridge): the copy stays, the link goes
    rerender(<PreflightStep onContinue={vi.fn()} />)
    expect(screen.queryByTestId('use-api-key')).toBeNull()
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

  it('recovers when the check itself fails', async () => {
    const probePrereqs = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(ALL)
    stub({ probePrereqs })
    const user = userEvent.setup()
    render(<PreflightStep onContinue={vi.fn()} />)
    expect(await screen.findByText(/couldn.t check this mac/i)).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: /re-check/i })[0])
    await waitFor(() => expect(within(row('orcha')).getByText('Installed')).toBeInTheDocument())
  })

  it('blocks Continue until an AI coding agent is installed', async () => {
    stub({ probePrereqs: vi.fn().mockResolvedValue({ ...ALL, claude: false, codex: false }) })
    render(<PreflightStep onContinue={vi.fn()} />)
    await waitFor(() => expect(within(row('ai')).getByText('Not found')).toBeInTheDocument())
    expect(screen.getByText('Install what’s missing, then re-check')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^continue$/i })).toBeDisabled()
  })
})

describe('PreflightStep — detour from Add a project', () => {
  it('says why it is shown and offers Back', async () => {
    const onBack = vi.fn()
    const user = userEvent.setup()
    render(<PreflightStep onContinue={vi.fn()} onBack={onBack} reason="No AI coding agent found." />)
    expect(screen.getByText(/embodent needs something on this mac first/i)).toBeInTheDocument()
    expect(screen.getByText('No AI coding agent found.')).toBeInTheDocument()
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
