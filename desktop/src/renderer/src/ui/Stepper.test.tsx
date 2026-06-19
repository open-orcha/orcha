// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Stepper } from './Stepper'

const steps = ['Docker', 'Folder', 'Details', 'Create']

describe('Stepper', () => {
  it('marks the current step with aria-current and counts done steps', () => {
    render(<Stepper steps={steps} current={2} />)
    const current = screen.getByText('Details').closest('[data-state]')
    expect(current?.getAttribute('data-state')).toBe('current')
    expect(current?.getAttribute('aria-current')).toBe('step')
    const done = screen.getByText('Docker').closest('[data-state]')
    expect(done?.getAttribute('data-state')).toBe('done')
    const upcoming = screen.getByText('Create').closest('[data-state]')
    expect(upcoming?.getAttribute('data-state')).toBe('upcoming')
  })
})
