// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import FinishStep from './FinishStep'

describe('FinishStep', () => {
  it('summarizes the real values in one list and opens Agents when a fleet was created', async () => {
    const onOpen = vi.fn()
    const user = userEvent.setup()
    render(
      <FinishStep
        project="orcha-demo"
        folder="/tmp/demo"
        portalUrl="http://localhost:8001"
        agents={['Atlas', 'Sable']}
        onOpen={onOpen}
      />
    )
    expect(screen.getByText('demo is ready')).toBeInTheDocument()
    expect(screen.getByText('localhost:8001')).toBeInTheDocument()
    expect(screen.getByText('Atlas, Sable')).toBeInTheDocument()
    expect(screen.getByText('/tmp/demo')).toBeInTheDocument()
    // One definition list, not a stack of cards.
    expect(document.querySelectorAll('dl')).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: /open demo/i }))
    expect(onOpen).toHaveBeenCalledWith('/agents')
  })

  it('lands on the Overview when no agents were created, and says so truthfully', async () => {
    const onOpen = vi.fn()
    const user = userEvent.setup()
    render(<FinishStep project="orcha-demo" portalUrl="http://localhost:8001" agents={[]} onOpen={onOpen} />)
    expect(screen.getByText(/none yet/i)).toBeInTheDocument()
    expect(screen.getByText('Opens Overview')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /open demo/i }))
    expect(onOpen).toHaveBeenCalledWith('/')
  })

  it('shows the code source row only when it was actually bound', () => {
    const { rerender } = render(
      <FinishStep project="orcha-demo" portalUrl="http://localhost:8001" agents={[]} codeSourceBound onOpen={vi.fn()} />
    )
    expect(screen.getByText('Code source')).toBeInTheDocument()
    expect(screen.getByText('Local repository')).toBeInTheDocument()
    rerender(<FinishStep project="orcha-demo" portalUrl="http://localhost:8001" agents={[]} onOpen={vi.fn()} />)
    expect(screen.queryByText('Code source')).not.toBeInTheDocument()
  })

  it('uses no emoji', () => {
    render(<FinishStep project="orcha-demo" portalUrl="http://localhost:8001" agents={[]} onOpen={vi.fn()} />)
    expect(document.body.textContent).not.toMatch(/\p{Extended_Pictographic}/u)
  })
})
