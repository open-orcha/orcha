// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import StackRow from './StackRow'
import type { Stack } from '../../../shared/types'

const runningStack: Stack = {
  project: 'orcha-quantal-ehr',
  projectShort: 'quantal-ehr',
  apiPort: 8001,
  dbPort: 5435,
  portalStatus: 'Up 4 hours',
  running: true
}

const stoppedStack: Stack = {
  ...runningStack,
  apiPort: null,
  dbPort: null,
  portalStatus: 'Exited (0) 2 days ago',
  running: false
}

beforeEach(() => {
  window.orchaDesktop = {
    listStacks: vi.fn().mockResolvedValue([]),
    startStack: vi.fn().mockResolvedValue(undefined),
    stopStack: vi.fn().mockResolvedValue(undefined),
    openPortal: vi.fn().mockResolvedValue(undefined),
    listAttention: vi.fn().mockResolvedValue([]),
    openManager: vi.fn(),
    quitApp: vi.fn(),
    preflight: vi.fn().mockResolvedValue({ docker: 'ok', autoStarted: false, hint: null }),
    pickFolder: vi.fn().mockResolvedValue(null),
    inspectFolder: vi
      .fn()
      .mockResolvedValue({ initialized: false, writable: true, suggestedName: 'x' }),
    provision: vi.fn().mockResolvedValue({ project: 'orcha-x', apiPort: 8000, warnings: [] }),
    openOnboardingPortal: vi.fn().mockResolvedValue(undefined),
    openExternal: vi.fn().mockResolvedValue(undefined),
    onProvisionProgress: vi.fn().mockReturnValue(() => {}),
    onNavigate: vi.fn().mockReturnValue(() => {})
  }
})

/** Rows are <li> elements; render inside a <ul> like StackList does. */
function renderRow(ui: React.ReactElement) {
  return render(<ul>{ui}</ul>)
}

describe('StackRow', () => {
  it('shows name, ports, and a Stop button when running', () => {
    renderRow(<StackRow stack={runningStack} onChanged={vi.fn()} />)
    expect(screen.getByText('quantal-ehr')).toBeInTheDocument()
    expect(screen.getByText(/API :8001 · DB :5435/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Open portal' })).toBeEnabled()
  })

  it('shows a Start button and disables Open portal when stopped', () => {
    renderRow(<StackRow stack={stoppedStack} onChanged={vi.fn()} />)
    expect(screen.getByText(/Exited \(0\) 2 days ago/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Open portal' })).toBeDisabled()
  })

  it('calls stopStack then onChanged on Stop click', async () => {
    const onChanged = vi.fn()
    renderRow(<StackRow stack={runningStack} onChanged={onChanged} />)
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(window.orchaDesktop.stopStack).toHaveBeenCalledWith('orcha-quantal-ehr')
  })

  it('shows the Stopping… busy label while the stop action is in flight', async () => {
    let resolveStop!: () => void
    window.orchaDesktop.stopStack = vi
      .fn()
      .mockImplementation(() => new Promise<void>((resolve) => (resolveStop = resolve)))
    renderRow(<StackRow stack={runningStack} onChanged={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(screen.getByRole('button', { name: 'Stopping…' })).toBeDisabled()
    resolveStop()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled())
  })

  it('calls openPortal with the project on Open portal click', async () => {
    renderRow(<StackRow stack={runningStack} onChanged={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Open portal' }))
    expect(window.orchaDesktop.openPortal).toHaveBeenCalledWith('orcha-quantal-ehr')
  })

  it('shows an attention chip when the stack has attention items', () => {
    renderRow(<StackRow stack={runningStack} attentionCount={3} onChanged={vi.fn()} />)
    expect(screen.getByText('3 pending')).toBeInTheDocument()
  })

  it('shows the stderr tail inline when an action fails', async () => {
    window.orchaDesktop.startStack = vi
      .fn()
      .mockRejectedValue({ code: 'COMPOSE_FAILED', stderr: 'no such project' })
    renderRow(<StackRow stack={stoppedStack} onChanged={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Start' }))
    expect(await screen.findByText(/no such project/)).toBeInTheDocument()
  })
})
