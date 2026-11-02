// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ProjectWorktreeCleanup } from './ProjectWorktreeCleanup'
import type { ProjectCleanupResult } from '../../../shared/types'

afterEach(() => { cleanup(); vi.useRealTimers() })

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

it('finds a direct CLI interruption after reopening and retries the same saved plan', async () => {
  const interrupted: ProjectCleanupResult = { ok: true, plan_id: '11111111-2222-3333-4444-555555555555',
    status: 'executing', scanned: 1, total: 1, candidate_count: 1, candidate_bytes: 900,
    unknown_sizes: 0, removed: [], items: [{ name: 'saved-folder', path: '/tmp/saved-folder',
      state: 'eligible', reason: 'Save files and keep commits before removing this checkout' }] }
  const list = vi.fn().mockResolvedValue([interrupted])
  const execute = vi.fn().mockImplementation(async () => {
    list.mockResolvedValue([])
    return { ...interrupted, status: 'done', removed: [{}] }
  })
  window.orchaDesktop = { storageProjectCleanup: execute, storagePendingCleanups: list } as unknown as typeof window.orchaDesktop
  const first = render(<ProjectWorktreeCleanup folder="/project" />)
  await screen.findByText('Review unfinished cleanup (1 folders)')
  first.unmount()
  render(<ProjectWorktreeCleanup folder="/project" />)
  fireEvent.click(await screen.findByText('Review unfinished cleanup (1 folders)'))
  expect(screen.getByText(/Unfinished cleanup can pause replies/)).toBeTruthy()
  expect(execute).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('Retry interrupted cleanup'))
  await waitFor(() => expect(execute).toHaveBeenCalledExactlyOnceWith({
    folder: '/project', phase: 'execute', planId: interrupted.plan_id
  }))
  expect(await screen.findByText('Removed 1 folders.')).toBeTruthy()
  await waitFor(() => expect(screen.queryByText('Review unfinished cleanup (1 folders)')).toBeNull())
})

it('shows discovery failures instead of suggesting there are no interrupted attempts', async () => {
  window.orchaDesktop = {
    storageProjectCleanup: vi.fn(),
    storagePendingCleanups: vi.fn().mockRejectedValue({ message: 'Saved cleanup could not be read' })
  } as unknown as typeof window.orchaDesktop
  render(<ProjectWorktreeCleanup folder="/project" />)
  expect(await screen.findByText(/Saved cleanup could not be read/)).toBeTruthy()
})

it.each(['preview', 'execute'] as const)('ignores a late progress reply after %s finishes', async phase => {
  vi.useFakeTimers()
  const ready: ProjectCleanupResult = { ok: true, plan_id: '11111111-2222-3333-4444-555555555555',
    status: 'ready', scanned: 1, total: 1, candidate_count: 1, candidate_bytes: 900,
    unknown_sizes: 0, removed: [], items: [{ name: 'saved-folder', path: '/tmp/saved-folder',
      state: 'eligible', reason: 'Save files first' }] }
  const interrupted = { ...ready, status: 'executing' }
  let finish!: (value: ProjectCleanupResult) => void
  let progress!: (value: ProjectCleanupResult) => void
  let discover!: (value: ProjectCleanupResult[]) => void
  const list = vi.fn().mockResolvedValueOnce(phase === 'execute' ? [interrupted] : [])
    .mockImplementationOnce(() => new Promise<ProjectCleanupResult[]>(resolve => { discover = resolve }))
  const call = vi.fn().mockImplementation(({ phase: requested }) => new Promise<ProjectCleanupResult>(resolve => {
    if (requested === 'status') progress = resolve
    else finish = resolve
  }))
  window.orchaDesktop = { storageProjectCleanup: call, storagePendingCleanups: list } as unknown as typeof window.orchaDesktop
  await act(async () => { render(<ProjectWorktreeCleanup folder="/project" />) })
  if (phase === 'execute') fireEvent.click(screen.getByText('Review unfinished cleanup (1 folders)'))
  fireEvent.click(screen.getByText(phase === 'execute' ? 'Retry interrupted cleanup' : 'Preview project-wide cleanup'))
  await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
  expect(call).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'status' }))
  await act(async () => { finish(phase === 'preview' ? ready : { ...ready, status: 'done', removed: [{}] }) })
  // Discovery keeps the main operation pending while the earlier poll arrives.
  expect(list).toHaveBeenCalledTimes(2)
  await act(async () => { progress({ ...ready, status: phase === 'preview' ? 'scanning' : 'executing' }) })
  await act(async () => { discover([]) })
  expect(screen.getByText(phase === 'preview' ? 'Save work and remove 1 folders' : 'Removed 1 folders.')).toBeTruthy()
  expect(screen.queryByText('Retry interrupted cleanup')).toBeNull()
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
  expect(call).toHaveBeenCalledTimes(2)
})
