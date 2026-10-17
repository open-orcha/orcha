import { describe, it, expect, vi } from 'vitest'
import {
  CLI_OUTDATED,
  cleanAgentWorktrees,
  isAgentWorktreePath,
  knownFolder,
  parseCleanRequest,
  scanAgentWorktrees
} from './agentWorktrees'

const A = '/Users/me/acme'
const B = '/Users/me/beta'
const PROJECTS = [
  { project: 'orcha-acme', projectShort: 'acme', folder: A },
  { project: 'orcha-beta', projectShort: 'beta', folder: B },
  { project: 'orcha-gone', projectShort: 'gone', folder: null }
]
const items = [
  { path: `${A}/.orcha-worktrees/wk-1`, name: 'wk-1', branch: 'orcha/wk-1', kind: 'wake', agent: 'A', state: 'clean', size_bytes: 2_000 },
  { path: `${A}/.orcha-worktrees/task-1`, name: 'task-1', branch: 'orcha/task-1', kind: 'task', agent: 'A', state: 'has-output', size_bytes: 500 },
  { path: `${A}/.orcha-worktrees/wk-2`, name: 'wk-2', branch: 'orcha/wk-2', kind: 'wake', agent: 'A', state: 'unmerged', size_bytes: 9_000 }
]

describe('agent worktrees (desktop → orcha worktrees --json)', () => {
  it('scans every known project folder that has .orcha-worktrees, through the CLI', async () => {
    const run = vi.fn(async (_cmd: string, args: string[]) => {
      if (args.includes(A)) return { stdout: 'noise line\n' + JSON.stringify({ ok: true, items }) }
      throw Object.assign(new Error('usage: orcha … invalid choice: worktrees'), { stderr: 'invalid choice' })
    })
    const out = await scanAgentWorktrees(PROJECTS, run, (f) => f === A || f === B)
    expect(run.mock.calls.map((c) => [c[0], c[1].join(' ')])).toEqual([
      ['orcha', `worktrees list --json --project ${A}`],
      ['orcha', `worktrees list --json --project ${B}`]
    ])
    expect(out[0]).toMatchObject({ projectShort: 'acme', reclaimable_bytes: 2_500 })
    expect(out[0].items).toHaveLength(3)
    expect(out[1]).toMatchObject({ projectShort: 'beta', items: [], error: CLI_OUTDATED })
  })

  it('only accepts known project folders and paths directly inside their .orcha-worktrees', () => {
    expect(knownFolder(PROJECTS, `${A}/`)).toBe(A)
    expect(() => knownFolder(PROJECTS, '/etc')).toThrow()
    expect(() => knownFolder(PROJECTS, 42)).toThrow()
    expect(isAgentWorktreePath(A, `${A}/.orcha-worktrees/wk-1`)).toBe(true)
    expect(isAgentWorktreePath(A, `${A}/.orcha-worktrees/wk-1/src`)).toBe(false)
    expect(isAgentWorktreePath(A, `${A}/.orcha-worktrees/../src`)).toBe(false)
    expect(isAgentWorktreePath(A, `${B}/.orcha-worktrees/wk-1`)).toBe(false)
    expect(isAgentWorktreePath(A, 'relative/.orcha-worktrees/x')).toBe(false)
    expect(() => parseCleanRequest({ folder: A, unmerged: [`${B}/.orcha-worktrees/x`] }, PROJECTS)).toThrow()
    expect(parseCleanRequest({ folder: A, dryRun: true, unmerged: [`${A}/.orcha-worktrees/wk-2`] }, PROJECTS)).toEqual({
      folder: A, dryRun: true, onlyClean: false, unmerged: [`${A}/.orcha-worktrees/wk-2`]
    })
  })

  it('previews with --dry-run, then runs with the opted-in unmerged worktrees', async () => {
    const res = { ok: true, removed: [items[0]], kept: [items[2]], skipped: [], freed_bytes: 2_000, dry_run: true }
    const run = vi.fn(async () => ({ stdout: JSON.stringify(res) }))
    const preview = await cleanAgentWorktrees({ folder: A, dryRun: true, onlyClean: false, unmerged: [] }, run)
    expect(preview).toMatchObject({ dryRun: true, freed_bytes: 2_000 })
    await cleanAgentWorktrees({ folder: A, dryRun: false, onlyClean: true, unmerged: [items[2].path] }, run)
    expect(run.mock.calls.map((c) => (c as unknown as [string, string[]])[1].join(' '))).toEqual([
      `worktrees clean --json --project ${A} --dry-run`,
      `worktrees clean --json --project ${A} --only-clean --unmerged ${items[2].path}`
    ])
  })

  it('an old CLI is a plain-words error', async () => {
    const run = vi.fn(async () => { throw new Error('invalid choice') })
    await expect(cleanAgentWorktrees({ folder: A, dryRun: true, onlyClean: false, unmerged: [] }, run)).rejects.toMatchObject({
      code: 'WORKTREE_CLI', message: CLI_OUTDATED
    })
  })
})
