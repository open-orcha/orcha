// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ConfirmStopDialog from './ConfirmStopDialog'

beforeEach(() => {
  window.orchaDesktop = { setHostModal: vi.fn().mockResolvedValue(undefined) } as unknown as typeof window.orchaDesktop
})

const base = { stackName: 'web', busy: false, onCancel: vi.fn(), onConfirm: vi.fn() }

describe('ConfirmStopDialog error notice', () => {
  it('no Details toggle when the raw error is already the friendly line', () => {
    render(<ConfirmStopDialog {...base} error={{ code: 'COMPOSE_FAILED', stderr: 'Error: no such container: orcha-web-db' }} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t stop: No such container: orcha-web-db')
    expect(screen.queryByRole('button', { name: 'Details' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('no Details toggle for a plain message error either', () => {
    render(<ConfirmStopDialog {...base} error="Docker daemon timed out" />)
    expect(screen.queryByRole('button', { name: 'Details' })).toBeNull()
  })

  it('keeps Details when the raw output says more than the summary', async () => {
    const stderr = ' Container orcha-web-portal  Stopping\n Container orcha-web-db  Error\nError response from daemon: cannot stop container: permission denied'
    render(<ConfirmStopDialog {...base} error={{ code: 'COMPOSE_FAILED', stderr }} />)
    const toggle = screen.getByRole('button', { name: 'Details' })
    await userEvent.click(toggle)
    expect(screen.getByText(/orcha-web-portal Stopping/)).toBeInTheDocument()
  })
})
