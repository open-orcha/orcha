// @vitest-environment jsdom
import { it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import StorageSettings from '../src/renderer/src/settings/StorageSettings'
import { storageOperations, worktreeOperations } from '../src/main/storageOperations'
import type { Run } from '../src/main/agentWorktrees'
import type { AgentWorktree, WorktreeCleanRequest } from '../src/shared/types'

it.each([false, true])('refresh after cleanup must not reuse the inventory captured before cleanup (per project: %s)', async (perProject) => {
  const folder = '/projects/small'
  const projects = [
    { project: 'orcha-small', projectShort: 'small', folder },
    { project: 'orcha-large', projectShort: 'large', folder: '/projects/large' }
  ]
  let live: AgentWorktree[] = [{ path: `${folder}/.orcha-worktrees/wake-a`, name: 'wake-a', branch: 'orcha/wake-a', kind: 'wake', agent: 'A', state: 'clean', size_bytes: 1_000_000 }]
  let holdLarge = false
  const finishLarge: Array<() => void> = []
  const run: Run = vi.fn(async (_cmd, args, cwd) => {
    if (args[1] === 'list') {
      if (cwd === folder) return { stdout: JSON.stringify({ ok: true, items: live }) }
      if (holdLarge) await new Promise<void>((resolve) => { finishLarge.push(resolve) })
      return { stdout: JSON.stringify({ ok: true, items: [] }) }
    }
    const removed = [...live]
    if (!args.includes('--dry-run')) live = []
    return { stdout: JSON.stringify({ ok: true, removed, kept: [], skipped: [], freed_bytes: 1_000_000 }) }
  })
  // Production operations used by the IPC handlers; only the CLI process is stubbed.
  const operations = worktreeOperations(async () => projects, () => run, () => true)
  window.orchaDesktop = {
    storageScan: vi.fn().mockResolvedValue({ items: [], inUse: [] }),
    storageWorktrees: vi.fn(operations.scan),
    storageCleanWorktrees: vi.fn((req: WorktreeCleanRequest) => operations.clean(req)),
    ...(perProject ? { storageWorktreeProjects: operations.projects, storageProjectWorktrees: operations.project } : {})
  } as unknown as typeof window.orchaDesktop
  render(<StorageSettings />)
  const row = await screen.findByTestId('storage-wt-small')
  expect(row).toHaveTextContent('1 worktree · 1 clean')
  holdLarge = true
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Scan worktrees again' })) })
  const pending = operations.scan()
  await act(async () => { fireEvent.click(within(row).getByRole('button', { name: 'Clean up existing…' })) })
  expect(operations.scan()).toBe(pending) // preview never invalidates the scan
  await act(async () => { fireEvent.click(within(row).getByRole('button', { name: /^Clean up 1/ })) })
  expect(live).toHaveLength(0)
  expect(row).toHaveTextContent('Removed 1 worktree')
  holdLarge = false
  await act(async () => { finishLarge.forEach((finish) => finish()) })
  // A fresh post-cleanup inventory must show zero, even when the other project was slow.
  expect(row).toHaveTextContent('0 worktrees')
  expect(within(row).getByRole('button', { name: 'Clean up existing…' })).toBeDisabled()
})


it('removing a Docker leftover cannot refresh from a scan captured before removal', async () => {
  let images = 'orcha-gone-portal\tlatest\ti1'
  let holdNextSizes = false
  let releaseSizes = () => {}
  const docker = vi.fn(async (args: string[]) => {
    if (args[0] === 'images') return { stdout: images }
    if (args[0] === 'system' && holdNextSizes) {
      holdNextSizes = false
      await new Promise<void>((resolve) => { releaseSizes = resolve })
    }
    if (args[0] === 'image' && args[1] === 'rm') images = ''
    return { stdout: '' }
  })
  const operations = storageOperations(() => ({ docker, kept: () => ({}) }))
  window.orchaDesktop = {
    storageScan: vi.fn(operations.scan),
    storageRemove: vi.fn(operations.remove)
  } as unknown as typeof window.orchaDesktop
  render(<StorageSettings />)
  const row = await screen.findByTestId('storage-item-image:orcha-gone-portal:latest')
  holdNextSizes = true
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Scan again' })) })
  await act(async () => { fireEvent.click(within(row).getByRole('button', { name: 'Remove' })) })
  expect(images).toBe('')
  await act(async () => releaseSizes())
  expect(screen.queryByTestId('storage-item-image:orcha-gone-portal:latest')).not.toBeInTheDocument()
  expect(screen.getByTestId('storage-empty')).toBeInTheDocument()
})
