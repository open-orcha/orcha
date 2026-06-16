// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import type { Stack } from '../../shared/types'

const stack: Stack = {
  project: 'orcha-demo',
  projectShort: 'demo',
  apiPort: 8001,
  dbPort: 5433,
  portalStatus: 'Up 1 hour',
  running: true
}

beforeEach(() => {
  // shouldAdvanceTime keeps findBy*/waitFor working while the 5s poll timer is faked.
  vi.useFakeTimers({ shouldAdvanceTime: true })
  localStorage.clear()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('App', () => {
  it('renders stack cards when stacks exist', async () => {
    window.orchaDesktop = {
      listStacks: vi.fn().mockResolvedValue([stack]),
      startStack: vi.fn(),
      stopStack: vi.fn(),
      openPortal: vi.fn(),
      listAttention: vi.fn().mockResolvedValue([]),
      openManager: vi.fn(),
      quitApp: vi.fn()
    }
    render(<App />)
    expect(await screen.findByText('demo')).toBeInTheDocument()
  })

  it('shows the Docker banner when discovery rejects with DOCKER_UNAVAILABLE', async () => {
    window.orchaDesktop = {
      listStacks: vi.fn().mockRejectedValue({ code: 'DOCKER_UNAVAILABLE' }),
      startStack: vi.fn(),
      stopStack: vi.fn(),
      openPortal: vi.fn(),
      listAttention: vi.fn().mockResolvedValue([]),
      openManager: vi.fn(),
      quitApp: vi.fn()
    }
    render(<App />)
    expect(await screen.findByText(/Docker isn't running/)).toBeInTheDocument()
  })

  it('shows the empty state when Docker is up but no stacks exist', async () => {
    window.orchaDesktop = {
      listStacks: vi.fn().mockResolvedValue([]),
      startStack: vi.fn(),
      stopStack: vi.fn(),
      openPortal: vi.fn(),
      listAttention: vi.fn().mockResolvedValue([]),
      openManager: vi.fn(),
      quitApp: vi.fn()
    }
    render(<App />)
    expect(await screen.findByText(/No orcha stacks yet/)).toBeInTheDocument()
  })

  it('defaults to card view and switches to list rows on toggle', async () => {
    window.orchaDesktop = {
      listStacks: vi.fn().mockResolvedValue([stack]),
      startStack: vi.fn(),
      stopStack: vi.fn(),
      openPortal: vi.fn(),
      listAttention: vi.fn().mockResolvedValue([]),
      openManager: vi.fn(),
      quitApp: vi.fn()
    }
    render(<App />)
    expect(await screen.findByTestId('stack-card')).toBeInTheDocument()
    expect(screen.queryByTestId('stack-row')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cards' })).toHaveAttribute('aria-pressed', 'true')

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    await user.click(screen.getByRole('button', { name: 'List' }))
    expect(screen.getByTestId('stack-row')).toBeInTheDocument()
    expect(screen.queryByTestId('stack-card')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('persists the chosen view to localStorage on toggle', async () => {
    window.orchaDesktop = {
      listStacks: vi.fn().mockResolvedValue([stack]),
      startStack: vi.fn(),
      stopStack: vi.fn(),
      openPortal: vi.fn(),
      listAttention: vi.fn().mockResolvedValue([]),
      openManager: vi.fn(),
      quitApp: vi.fn()
    }
    render(<App />)
    await screen.findByTestId('stack-card')

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    await user.click(screen.getByRole('button', { name: 'List' }))
    expect(localStorage.getItem('orcha.viewMode')).toBe('list')
    await user.click(screen.getByRole('button', { name: 'Cards' }))
    expect(localStorage.getItem('orcha.viewMode')).toBe('cards')
  })

  it('reads the persisted view from localStorage on mount', async () => {
    localStorage.setItem('orcha.viewMode', 'list')
    window.orchaDesktop = {
      listStacks: vi.fn().mockResolvedValue([stack]),
      startStack: vi.fn(),
      stopStack: vi.fn(),
      openPortal: vi.fn(),
      listAttention: vi.fn().mockResolvedValue([]),
      openManager: vi.fn(),
      quitApp: vi.fn()
    }
    render(<App />)
    expect(await screen.findByTestId('stack-row')).toBeInTheDocument()
    expect(screen.queryByTestId('stack-card')).not.toBeInTheDocument()
  })
})
