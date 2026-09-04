// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import StoppedStackRow from './StoppedStackRow'
import type { Stack } from '../../../shared/types'

const stoppedStack: Stack = {
  project: 'orcha-demo',
  projectShort: 'demo',
  apiPort: null,
  dbPort: null,
  portalStatus: 'Exited (0) 2 days ago',
  running: false,
  folder: null
}

beforeEach(() => {
  window.orchaDesktop = {
    startStack: vi.fn().mockResolvedValue(undefined),
    stopStack: vi.fn().mockResolvedValue(undefined),
    resetStack: vi.fn().mockResolvedValue(undefined),
    portalShow: vi.fn()
  } as never
})

describe('StoppedStackRow', () => {
  it('renders the stack name and a Start action', () => {
    render(<StoppedStackRow stack={stoppedStack} onChanged={vi.fn()} />)
    expect(screen.getByText('demo')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^start$/i })).toBeInTheDocument()
  })

  it('clicking Start calls startStack and onChanged', async () => {
    const onChanged = vi.fn()
    const user = userEvent.setup()
    render(<StoppedStackRow stack={stoppedStack} onChanged={onChanged} />)

    await user.click(screen.getByRole('button', { name: /^start$/i }))
    await waitFor(() => expect(window.orchaDesktop.startStack).toHaveBeenCalledWith('orcha-demo'))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('opens an overflow menu with Remove, gated by a type-to-confirm dialog', async () => {
    const user = userEvent.setup()
    render(<StoppedStackRow stack={stoppedStack} onChanged={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: /more actions for demo/i }))
    await user.click(screen.getByRole('menuitem', { name: /remove/i }))

    expect(screen.getByRole('dialog', { name: /delete.*orcha-demo/i })).toBeInTheDocument()
    // Confirm is disabled until the exact project name is typed.
    expect(screen.getByRole('button', { name: /delete everything/i })).toBeDisabled()
  })

  it('confirming the type-to-confirm dialog calls resetStack', async () => {
    const user = userEvent.setup()
    render(<StoppedStackRow stack={stoppedStack} onChanged={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: /more actions for demo/i }))
    await user.click(screen.getByRole('menuitem', { name: /remove/i }))
    await user.type(screen.getByLabelText(/confirm project name/i), 'orcha-demo')
    await user.click(screen.getByRole('button', { name: /delete everything/i }))

    await waitFor(() => expect(window.orchaDesktop.resetStack).toHaveBeenCalledWith('orcha-demo'))
  })
})
