// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ConfirmResetModal from './ConfirmResetModal'

describe('ConfirmResetModal', () => {
  it('keeps Delete disabled until the exact project name is typed', async () => {
    const onConfirm = vi.fn()
    const user = userEvent.setup()
    render(
      <ConfirmResetModal project="orcha-foo" busy={false} onCancel={vi.fn()} onConfirm={onConfirm} />
    )
    const del = screen.getByRole('button', { name: /delete everything/i })
    expect(del).toBeDisabled()

    await user.type(screen.getByLabelText(/confirm project name/i), 'orcha-fo') // partial
    expect(del).toBeDisabled()

    await user.type(screen.getByLabelText(/confirm project name/i), 'o') // now "orcha-foo"
    expect(del).toBeEnabled()

    await user.click(del)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('Cancel fires onCancel and never confirms', async () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    await userEvent.setup().click(
      (() => {
        render(
          <ConfirmResetModal
            project="orcha-bar"
            busy={false}
            onCancel={onCancel}
            onConfirm={onConfirm}
          />
        )
        return screen.getByRole('button', { name: /cancel/i })
      })()
    )
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('names exactly what is destroyed', () => {
    render(
      <ConfirmResetModal project="orcha-foo" busy={false} onCancel={vi.fn()} onConfirm={vi.fn()} />
    )
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument()
    expect(screen.getByText(/agents, tasks, requests/i)).toBeInTheDocument()
  })
})
