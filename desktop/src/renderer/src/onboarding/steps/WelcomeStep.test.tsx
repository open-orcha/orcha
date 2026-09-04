// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import WelcomeStep from './WelcomeStep'

describe('WelcomeStep', () => {
  it('renders the glyph, types the tagline, reveals feature cards, and advances on Get started', async () => {
    const onContinue = vi.fn()
    const user = userEvent.setup()
    render(<WelcomeStep onContinue={onContinue} />)

    expect(screen.getByText('Orcha')).toBeInTheDocument()
    // The tagline typewriter finishes and reveals the CTA + feature cards.
    await waitFor(() => expect(screen.getByRole('button', { name: /get started/i })).toBeInTheDocument(), {
      timeout: 3000
    })
    expect(screen.getByText(/a fleet, not one bot/i)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /get started/i }))
    expect(onContinue).toHaveBeenCalled()
  })
})
