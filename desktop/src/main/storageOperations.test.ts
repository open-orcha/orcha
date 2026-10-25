import { it, expect, vi } from 'vitest'
import { worktreeOperations } from './storageOperations'
import type { Run } from './agentWorktrees'

it('cleanup invalidates the changed project’s in-flight inventory but preserves other projects’ scans', async () => {
  const projects = [
    { project: 'orcha-small', projectShort: 'small', folder: '/projects/small' },
    { project: 'orcha-large', projectShort: 'large', folder: '/projects/large' }
  ]
  let items = [{ name: 'wake-a', state: 'clean', size_bytes: 1_000 }]
  const finish: Array<() => void> = []
  const reads: string[] = []
  const run: Run = vi.fn(async (_cmd, args, folder) => {
    if (args[1] === 'list') {
      const snapshot = JSON.stringify({ ok: true, items })
      reads.push(folder)
      if (reads.length <= 2) await new Promise<void>((resolve) => { finish.push(resolve) })
      return { stdout: snapshot }
    }
    items = []
    return { stdout: JSON.stringify({ ok: true, removed: [], freed_bytes: 1_000 }) }
  })
  const operations = worktreeOperations(async () => projects, () => run, () => true)
  const old = operations.project('/projects/small')
  const other = operations.project('/projects/large')
  await operations.clean({ folder: '/projects/small', dryRun: false })
  const fresh = operations.project('/projects/small')
  const sameOther = operations.project('/projects/large')
  finish.forEach((done) => done())
  expect((await fresh).items).toEqual([])
  expect((await old).items).toHaveLength(1)
  expect(await sameOther).toEqual(await other)
  expect(reads.filter((folder) => folder === '/projects/large')).toHaveLength(1)
  expect(reads.filter((folder) => folder === '/projects/small')).toHaveLength(2)
})

it('project scans reject unknown folders and projects without worktrees before running the CLI', async () => {
  const run = vi.fn()
  const operations = worktreeOperations(
    async () => [{ project: 'orcha-small', projectShort: 'small', folder: '/projects/small' }],
    () => run,
    () => false
  )
  await expect(operations.project('/unknown')).rejects.toEqual({ code: 'INVALID_WORKTREE' })
  await expect(operations.project('/projects/small')).rejects.toEqual({ code: 'INVALID_WORKTREE' })
  expect(run).not.toHaveBeenCalled()
})
