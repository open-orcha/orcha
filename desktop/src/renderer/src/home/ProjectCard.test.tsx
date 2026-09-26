// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ProjectCard from './ProjectCard'
import type { ProjectContainer } from '../../../shared/types'

function container(over: Partial<ProjectContainer> = {}): ProjectContainer {
  return {
    id: 'c1',
    name: 'Demo project',
    description: 'A demo',
    status: 'active',
    github_repo: 'local',
    agents: 2,
    tasks: 3,
    needs_you: 0,
    member_count: 1,
    ...over
  }
}

describe('ProjectCard', () => {
  it('shows Open and Pair actions', () => {
    render(
      <ProjectCard
        container={container()}
        favorited={false}
        onToggleFavorite={vi.fn()}
        onOpen={vi.fn()}
        onPair={vi.fn()}
        onDelete={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: /^open$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /pair phone/i })).toBeInTheDocument()
  })

  it('shows a Delete affordance in the overflow menu', async () => {
    const onDelete = vi.fn()
    const user = userEvent.setup()
    render(
      <ProjectCard
        container={container()}
        favorited={false}
        onToggleFavorite={vi.fn()}
        onOpen={vi.fn()}
        onPair={vi.fn()}
        onDelete={onDelete}
      />
    )
    // Not visible until the overflow menu is opened.
    expect(screen.queryByRole('menuitem', { name: /delete project/i })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /more actions for demo project/i }))
    const deleteItem = screen.getByRole('menuitem', { name: /delete project/i })
    expect(deleteItem).toBeInTheDocument()

    await user.click(deleteItem)
    expect(onDelete).toHaveBeenCalledTimes(1)
  })

  it('closes the overflow menu after choosing Delete', async () => {
    const user = userEvent.setup()
    render(
      <ProjectCard
        container={container()}
        favorited={false}
        onToggleFavorite={vi.fn()}
        onOpen={vi.fn()}
        onPair={vi.fn()}
        onDelete={vi.fn()}
      />
    )
    await user.click(screen.getByRole('button', { name: /more actions for demo project/i }))
    await user.click(screen.getByRole('menuitem', { name: /delete project/i }))
    expect(screen.queryByRole('menuitem', { name: /delete project/i })).not.toBeInTheDocument()
  })

  it('clicking Open/Pair does not trigger delete', async () => {
    const onOpen = vi.fn()
    const onDelete = vi.fn()
    const user = userEvent.setup()
    render(
      <ProjectCard
        container={container()}
        favorited={false}
        onToggleFavorite={vi.fn()}
        onOpen={onOpen}
        onPair={vi.fn()}
        onDelete={onDelete}
      />
    )
    await user.click(screen.getByRole('button', { name: /^open$/i }))
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onDelete).not.toHaveBeenCalled()
  })
})
