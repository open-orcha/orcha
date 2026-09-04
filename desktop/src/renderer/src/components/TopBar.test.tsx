// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import TopBar from './TopBar'
import type { Stack } from '../../../shared/types'

function stack(over: Partial<Stack> = {}): Stack {
  return {
    project: 'orcha-demo',
    projectShort: 'demo',
    apiPort: 8001,
    dbPort: 5432,
    portalStatus: 'Up',
    running: true,
    folder: '/tmp/demo',
    ...over
  }
}

describe('TopBar', () => {
  it('shows the project short name and a "← Projects" back affordance', () => {
    render(<TopBar stack={stack()} onBack={vi.fn()} />)
    expect(screen.getByText('demo')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /projects/i })).toBeInTheDocument()
  })

  it('clicking back calls onBack', async () => {
    const onBack = vi.fn()
    const user = userEvent.setup()
    render(<TopBar stack={stack()} onBack={onBack} />)
    await user.click(screen.getByRole('button', { name: /projects/i }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('renders a running-state dot distinct from a stopped one', () => {
    const { rerender } = render(<TopBar stack={stack({ running: true })} onBack={vi.fn()} />)
    const runningDot = document.querySelector('[aria-hidden="true"].bg-ok')
    expect(runningDot).not.toBeNull()

    rerender(<TopBar stack={stack({ running: false })} onBack={vi.fn()} />)
    expect(document.querySelector('[aria-hidden="true"].bg-ok')).toBeNull()
  })
})
