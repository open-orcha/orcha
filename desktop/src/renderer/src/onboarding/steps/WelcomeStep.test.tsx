// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import WelcomeStep from './WelcomeStep'

describe('WelcomeStep', () => {
  it('shows a Display title, the capability list and one primary that advances', async () => {
    const onContinue = vi.fn()
    const user = userEvent.setup()
    render(<WelcomeStep onContinue={onContinue} />)

    expect(screen.getByRole('heading', { name: 'Welcome to Embodent' })).toHaveClass('ob-display')
    expect(screen.getByText('A team of agents')).toBeInTheDocument()
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(document.body.textContent).not.toMatch(/\p{Extended_Pictographic}/u)

    await user.click(screen.getByRole('button', { name: /get started/i }))
    expect(onContinue).toHaveBeenCalled()
  })
})
