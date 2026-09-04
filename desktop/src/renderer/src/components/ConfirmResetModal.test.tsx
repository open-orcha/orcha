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

  it('shows a progress state (Deleting…) and disables Cancel + input while busy', () => {
    render(
      <ConfirmResetModal project="orcha-foo" busy={true} onCancel={vi.fn()} onConfirm={vi.fn()} />
    )
    expect(screen.getByRole('button', { name: /deleting/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled()
    expect(screen.getByLabelText(/confirm project name/i)).toBeDisabled()
  })

  it('surfaces an error and stays open (does not call onCancel itself)', () => {
    const onCancel = vi.fn()
    render(
      <ConfirmResetModal
        project="orcha-foo"
        busy={false}
        error="docker: compose down failed"
        onCancel={onCancel}
        onConfirm={vi.fn()}
      />
    )
    expect(screen.getByRole('alert')).toHaveTextContent(/compose down failed/i)
    expect(onCancel).not.toHaveBeenCalled()
    // The form is still usable — the confirm button re-enables once the name is retyped.
    expect(screen.getByRole('button', { name: /delete everything/i })).toBeDisabled()
  })

  it('does not gate on the wrong name — a similar-but-different project stays disabled', async () => {
    const user = userEvent.setup()
    render(
      <ConfirmResetModal project="orcha-foo" busy={false} onCancel={vi.fn()} onConfirm={vi.fn()} />
    )
    await user.type(screen.getByLabelText(/confirm project name/i), 'orcha-foo-bar')
    expect(screen.getByRole('button', { name: /delete everything/i })).toBeDisabled()
  })
})
