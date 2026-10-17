// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StepIndicator, type StepItem } from './StepIndicator'

const steps = (current: number, n = 4): StepItem[] =>
  ['Source', 'Details', 'Create', 'Agents'].slice(0, n).map((label, i) => ({
    key: label.toLowerCase(),
    label,
    state: i < current ? 'done' : i === current ? 'current' : 'upcoming'
  }))

describe('StepIndicator', () => {
  it('announces the position and fills the connectors up to the current step', () => {
    render(<StepIndicator steps={steps(2)} />)
    const list = screen.getByRole('list', { name: 'Step 3 of 4' })
    const seps = list.querySelectorAll('.ob-step-sep')
    expect([...seps].map((s) => s.getAttribute('data-filled'))).toEqual(['true', 'true', 'false'])
    expect(within(list).getByText('Create').closest('li')).toHaveAttribute('aria-current', 'step')
    expect(within(list).getByText('Source').closest('[data-state]')).toHaveAttribute('data-state', 'done')
  })

  it('makes finished steps jumpable only when onJump is given', async () => {
    const onJump = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(<StepIndicator steps={steps(2)} onJump={onJump} />)
    await user.click(screen.getByRole('button', { name: /details/i }))
    expect(onJump).toHaveBeenCalledWith('details')
    rerender(<StepIndicator steps={steps(2)} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
