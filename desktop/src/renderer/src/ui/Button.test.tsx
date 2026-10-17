// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Button } from './Button'

describe('Button', () => {
  it('renders and fires onClick', async () => {
    const onClick = vi.fn()
    render(<Button onClick={onClick}>Go</Button>)
    await userEvent.click(screen.getByRole('button', { name: 'Go' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
  it('is disabled when disabled prop set', () => {
    render(<Button disabled>Go</Button>)
    expect(screen.getByRole('button', { name: 'Go' })).toBeDisabled()
  })
  it('is Linear-compact: 28px tall, 6px radius by default (D2)', () => {
    render(<Button>Go</Button>)
    const cls = screen.getByRole('button', { name: 'Go' }).className
    expect(cls).toContain('h-7')
    expect(cls).toContain('rounded-md')
    expect(cls).not.toMatch(/\bh-(9|10)\b/)
  })
  it('secondary is subtle (no accent fill)', () => {
    render(<Button variant="secondary">Later</Button>)
    expect(screen.getByRole('button', { name: 'Later' }).className).not.toContain('bg-accent')
  })
})
