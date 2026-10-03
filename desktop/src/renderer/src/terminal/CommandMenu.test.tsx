// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CommandMenu, { type CommandAction } from './CommandMenu'

function setup() {
  const runs: string[] = []
  const mk = (id: string, section: CommandAction['section'], label: string, extra: Partial<CommandAction> = {}): CommandAction => ({
    id,
    section,
    label,
    run: () => runs.push(id),
    ...extra
  })
  const items = [
    mk('new-shell', 'actions', 'New Terminal', { shortcut: ['⌘', 'T'] }),
    mk('new-claude', 'actions', 'Claude', { shortcut: ['⌥', '⌘', 'T'] }),
    mk('new-codex', 'actions', 'Codex'),
    mk('agent-settings', 'actions', 'Agent settings…'),
    mk('tab-1', 'tabs', 'zsh · todo'),
    mk('project-a', 'projects', 'todo'),
    mk('project-b', 'projects', 'billing', { disabled: true, hint: 'stopped' })
  ]
  const onClose = vi.fn()
  render(<CommandMenu items={items} left={272} width={1100} onClose={onClose} />)
  return { runs, onClose, input: screen.getByRole('combobox') }
}

describe('CommandMenu', () => {
  it('is an accessible combobox + listbox with grouped options, focused on open', () => {
    const { input } = setup()
    expect(screen.getByRole('dialog', { name: 'Command menu' })).toBeInTheDocument()
    expect(input).toHaveFocus()
    expect(input).toHaveAttribute('aria-controls', screen.getByRole('listbox').id)
    expect(screen.getByRole('group', { name: 'Actions' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Open tabs' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Projects' })).toBeInTheDocument()
    const first = screen.getByRole('option', { name: /New Terminal/ })
    expect(first).toHaveAttribute('aria-selected', 'true')
    expect(input).toHaveAttribute('aria-activedescendant', first.id)
  })

  it('Enter runs the first option; arrows move; typing filters and reselects the best match', async () => {
    const user = userEvent.setup()
    const { runs, input } = setup()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('option', { name: /Claude/ })).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{ArrowUp}{ArrowUp}') // wraps to the last SELECTABLE (skips disabled billing)
    expect(screen.getByRole('option', { name: /^todo/ })).toHaveAttribute('aria-selected', 'true')
    await user.type(input, 'codex')
    expect(screen.getAllByRole('option')).toHaveLength(1)
    await user.keyboard('{Enter}')
    expect(runs).toEqual(['new-codex'])
  })

  it('Escape and a click outside close it; disabled options do not run', async () => {
    const user = userEvent.setup()
    const { runs, onClose } = setup()
    await user.click(screen.getByRole('option', { name: /billing/ }))
    expect(runs).toEqual([])
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
    await user.click(screen.getByTestId('command-menu-layer'))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('shows an empty state', async () => {
    const user = userEvent.setup()
    const { input } = setup()
    await user.type(input, 'zzzz')
    expect(screen.getByText(/No results for “zzzz”/)).toBeInTheDocument()
  })

  it('clicking an option runs it', async () => {
    const user = userEvent.setup()
    const { runs } = setup()
    await user.click(screen.getByRole('option', { name: /Agent settings/ }))
    expect(runs).toEqual(['agent-settings'])
  })
})
