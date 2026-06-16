// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import StackCard from './StackCard'
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
    quitApp: vi.fn()
  }
})

describe('StackCard', () => {
  it('shows name, running pill, ports, and a Stop button when running', () => {
    render(<StackCard stack={runningStack} onChanged={vi.fn()} />)
    expect(screen.getByText('quantal-ehr')).toBeInTheDocument()
    expect(screen.getByText('running')).toBeInTheDocument()
    expect(screen.getByText(/API :8001/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Open portal' })).toBeEnabled()
  })

  it('shows stopped pill, Start button, and disables Open portal when stopped', () => {
    render(<StackCard stack={stoppedStack} onChanged={vi.fn()} />)
    expect(screen.getByText('stopped')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Open portal' })).toBeDisabled()
  })

  it('calls stopStack then onChanged on Stop click', async () => {
    const onChanged = vi.fn()
    render(<StackCard stack={runningStack} onChanged={onChanged} />)
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(window.orchaDesktop.stopStack).toHaveBeenCalledWith('orcha-quantal-ehr')
  })

  it('calls openPortal with the project on Open portal click', async () => {
    render(<StackCard stack={runningStack} onChanged={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Open portal' }))
    expect(window.orchaDesktop.openPortal).toHaveBeenCalledWith('orcha-quantal-ehr')
  })

  it('shows an attention badge when the stack has attention items', () => {
    render(<StackCard stack={runningStack} attentionCount={3} onChanged={vi.fn()} />)
    expect(screen.getByText('needs attention · 3')).toBeInTheDocument()
  })

  it('shows the stderr tail inline when an action fails', async () => {
    window.orchaDesktop.startStack = vi
      .fn()
      .mockRejectedValue({ code: 'COMPOSE_FAILED', stderr: 'no such project' })
    render(<StackCard stack={stoppedStack} onChanged={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Start' }))
    expect(await screen.findByText(/no such project/)).toBeInTheDocument()
  })
})
