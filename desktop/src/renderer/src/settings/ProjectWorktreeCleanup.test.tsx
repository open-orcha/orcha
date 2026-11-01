// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ProjectWorktreeCleanup } from './ProjectWorktreeCleanup'
import type { ProjectCleanupResult } from '../../../shared/types'

afterEach(cleanup)

it('confirms only the completed preview and sends its exact identifier', async () => {
  const ready: ProjectCleanupResult = { ok: true, plan_id: '11111111-2222-3333-4444-555555555555', status: 'ready',
    scanned: 1, total: 1, candidate_count: 1, candidate_bytes: 900, unknown_sizes: 0, removed: [],
    items: [{ name: 'outside', path: '/tmp/outside', state: 'eligible', reason: 'save files first', unmerged_commits: 2 }] }
  let finish!: (value: ProjectCleanupResult) => void
  const call = vi.fn().mockImplementationOnce(() => new Promise<ProjectCleanupResult>(resolve => { finish = resolve }))
    .mockResolvedValue({ ...ready, status: 'done', removed: [{}] })
  window.orchaDesktop = { storageProjectCleanup: call } as unknown as typeof window.orchaDesktop
  render(<ProjectWorktreeCleanup folder="/project" />)
  fireEvent.click(screen.getByText('Preview project-wide cleanup'))
  expect(screen.queryByText('Save work and remove 1 folders')).toBeNull()
  finish(ready)
  fireEvent.click(await screen.findByText('Save work and remove 1 folders'))
  await waitFor(() => expect(call).toHaveBeenLastCalledWith({ folder: '/project', phase: 'execute', planId: ready.plan_id }))
  expect(await screen.findByText('Removed 1 folders.')).toBeTruthy()
})
