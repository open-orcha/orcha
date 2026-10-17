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
    const del = screen.getByRole('button', { name: /delete stack/i })
    expect(del).toBeDisabled()

    await user.type(screen.getByLabelText(/confirm stack name/i), 'orcha-fo') // partial
    expect(del).toBeDisabled()

    await user.type(screen.getByLabelText(/confirm stack name/i), 'o') // now "orcha-foo"
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

  it('names the stack and lists EVERY project that goes with it', () => {
    render(
      <ConfirmResetModal
        project="orcha-acme-web"
        stackName="acme-web"
        projects={['acme-web', 'acme-admin']}
        busy={false}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />
    )
    expect(screen.getByRole('alertdialog', { name: /delete the “acme-web” stack/i })).toBeInTheDocument()
    expect(screen.getByText(/holds 2 projects/i)).toBeInTheDocument()
    const list = screen.getByRole('list')
    expect(list).toHaveTextContent('acme-web')
    expect(list).toHaveTextContent('acme-admin')
  })

  it('shows a progress state (Deleting…) and disables Cancel + input while busy', () => {
    render(
      <ConfirmResetModal project="orcha-foo" busy={true} onCancel={vi.fn()} onConfirm={vi.fn()} />
    )
    expect(screen.getByRole('button', { name: /deleting/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled()
    expect(screen.getByLabelText(/confirm stack name/i)).toBeDisabled()
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
    expect(screen.getByRole('button', { name: /delete stack/i })).toBeDisabled()
  })

  it('does not gate on the wrong name — a similar-but-different project stays disabled', async () => {
    const user = userEvent.setup()
    render(
      <ConfirmResetModal project="orcha-foo" busy={false} onCancel={vi.fn()} onConfirm={vi.fn()} />
    )
    await user.type(screen.getByLabelText(/confirm stack name/i), 'orcha-foo-bar')
    expect(screen.getByRole('button', { name: /delete stack/i })).toBeDisabled()
  })

  it('Escape cancels, and the native portal view is hidden while the dialog is open', async () => {
    const setHostModal = vi.fn().mockResolvedValue(undefined)
    window.orchaDesktop = { setHostModal } as never
    const onCancel = vi.fn()
    const { unmount } = render(
      <ConfirmResetModal project="orcha-baz" busy={false} onCancel={onCancel} onConfirm={vi.fn()} />
    )
    expect(setHostModal).toHaveBeenCalledWith(true)
    await userEvent.setup().keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledTimes(1)
    unmount()
    expect(setHostModal).toHaveBeenLastCalledWith(false)
  })

  it('Escape does nothing while a delete is running', async () => {
    const onCancel = vi.fn()
    render(<ConfirmResetModal project="orcha-baz" busy onCancel={onCancel} onConfirm={vi.fn()} />)
    await userEvent.setup().keyboard('{Escape}')
    expect(onCancel).not.toHaveBeenCalled()
  })
})
