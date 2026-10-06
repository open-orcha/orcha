// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SourceStep from './SourceStep'

describe('SourceStep', () => {
  it('offers illustrated source cards; the last choice keeps its selected state', async () => {
    const onChoose = vi.fn()
    const user = userEvent.setup()
    render(<SourceStep selected="github" onChoose={onChoose} />)
    const local = screen.getByRole('button', { name: /local folder/i })
    const gh = screen.getByRole('button', { name: /from github/i })
    expect(local.querySelector('.ob-source-art svg')).not.toBeNull()
    expect(gh).toHaveAttribute('data-selected', 'true')
    expect(gh).toHaveAttribute('aria-pressed', 'true')
    expect(local).toHaveAttribute('data-selected', 'false')
    await user.click(local)
    expect(onChoose).toHaveBeenCalledWith('local')
  })

  it('has no Back without onBack, and renders the setup notice slot under the title', () => {
    render(<SourceStep onChoose={vi.fn()} notice={<div data-testid="slot">Docker isn’t running</div>} />)
    expect(screen.queryByRole('button', { name: /^back$/i })).not.toBeInTheDocument()
    expect(screen.getByTestId('slot')).toBeInTheDocument()
  })
})
