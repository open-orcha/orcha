// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import EmptyState from './EmptyState'

describe('EmptyState', () => {
  it('Create your first project calls onCreate', async () => {
    const onCreate = vi.fn()
    render(<EmptyState onCreate={onCreate} />)
    await userEvent.click(screen.getByRole('button', { name: /create your first project/i }))
    expect(onCreate).toHaveBeenCalledTimes(1)
  })
})
