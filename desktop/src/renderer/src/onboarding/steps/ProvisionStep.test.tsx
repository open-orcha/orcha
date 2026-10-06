// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ProgressEvent } from '../../../../shared/types'
import ProvisionStep from './ProvisionStep'

const props = {
  projectName: 'demo',
  failure: null,
  onContinue: vi.fn(),
  onRetry: vi.fn(),
  onBack: vi.fn()
}

const ev = (step: string, status: 'start' | 'ok'): ProgressEvent => ({ runId: 'r', step, status }) as ProgressEvent

describe('ProvisionStep (Create) — live launch view', () => {
  it('drives a stepped timeline from the real stream: done rails fill, the running stage leads', () => {
    render(
      <ProvisionStep
        {...props}
        status="running"
        events={[ev('render-compose', 'start'), ev('render-compose', 'ok'), ev('copy-templates', 'ok'), ev('compose-up', 'start')]}
      />
    )
    const items = screen.getAllByRole('listitem')
    expect(items.map((i) => i.getAttribute('data-state')).slice(0, 4)).toEqual(['done', 'done', 'running', 'todo'])
    expect(items[0].querySelector('.ob-tl-rail')).toHaveAttribute('data-filled', 'true')
    expect(items[2].querySelector('.ob-tl-rail')).toHaveAttribute('data-filled', 'false')
    expect(document.querySelector('.ob-launch')).toHaveAttribute('data-status', 'running')
    expect(document.querySelector('.ob-launch-stage')).toHaveTextContent('Start containers')
    expect(screen.getByLabelText(/^elapsed 0:0\d$/i)).toBeInTheDocument()
    expect(screen.getByText(/step 3 of 7/i)).toBeInTheDocument()
  })

  it('lands on a completion moment when done, and keeps Continue', () => {
    render(<ProvisionStep {...props} status="done" events={[ev('render-compose', 'ok')]} />)
    expect(screen.getByRole('heading', { name: 'demo is ready' })).toBeInTheDocument()
    expect(document.querySelector('.ob-launch')).toHaveAttribute('data-status', 'done')
    expect(document.querySelector('.ob-orb-core')).not.toBeNull()
    expect(screen.getByText(/next up: your agents/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^continue$/i })).toBeInTheDocument()
  })

  it('folds the timeline away when there are warnings to read first', () => {
    render(<ProvisionStep {...props} status="done" events={[]} warnings={['Port 8001 was busy; used 8002.']} />)
    expect(screen.getByText(/one thing to know/i)).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Progress' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /all 7 steps finished/i })).toHaveAttribute('aria-expanded', 'false')
  })
})
