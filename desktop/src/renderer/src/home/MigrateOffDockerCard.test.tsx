// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import MigrateOffDockerCard from './MigrateOffDockerCard'
import type { Stack } from '../../../shared/types'

const stack = (over: Partial<Stack>): Stack =>
  ({
    project: 'demo',
    projectShort: 'demo',
    running: true,
    apiPort: 8000,
    folder: '/tmp/demo',
    runtime: 'docker',
    health: 'ok',
    ...over
  }) as Stack

beforeEach(() => {
  window.orchaDesktop = { provision: vi.fn().mockResolvedValue({ project: 'demo', apiPort: 8000, warnings: [] }) } as never
})

describe('MigrateOffDockerCard (GH #258 D2)', () => {
  it('shows one card per Docker project with a folder — never for native ones', () => {
    render(
      <MigrateOffDockerCard
        stacks={[stack({}), stack({ project: 'nat', runtime: 'native' }), stack({ project: 'nofolder', folder: null })]}
        onDone={vi.fn()}
      />
    )
    expect(screen.getAllByTestId('migrate-card')).toHaveLength(1)
    expect(screen.getByText('Move demo off Docker')).toBeInTheDocument()
  })

  it('renders nothing when every project is native', () => {
    const { container } = render(<MigrateOffDockerCard stacks={[stack({ runtime: 'native' })]} onDone={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('moves the project through provision mode "migrate", then refreshes', async () => {
    const onDone = vi.fn()
    render(<MigrateOffDockerCard stacks={[stack({})]} onDone={onDone} />)
    await userEvent.click(screen.getByRole('button', { name: /move off docker/i }))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(window.orchaDesktop.provision).toHaveBeenCalledWith({ folder: '/tmp/demo', mode: 'migrate' })
  })

  it('shows the CLI’s own words when the move fails (e.g. Docker is off)', async () => {
    const msg = 'Your project’s data is still inside Docker. Start Docker once, run `orcha up`, then run this command again.'
    window.orchaDesktop.provision = vi.fn().mockRejectedValue({ code: 'PROVISION_FAILED', detail: msg })
    const onDone = vi.fn()
    render(<MigrateOffDockerCard stacks={[stack({})]} onDone={onDone} />)
    await userEvent.click(screen.getByRole('button', { name: /move off docker/i }))
    expect(await screen.findByTestId('migrate-error')).toHaveTextContent(/start docker once/i)
    expect(onDone).not.toHaveBeenCalled()
  })
})
