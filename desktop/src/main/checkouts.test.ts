import { describe, it, expect, vi } from 'vitest'
import { attributeCheckouts, parseWorktreePorcelain, readWorktrees, safeRef, taskBranch } from './checkouts'
import { fetchStackAttention, liveTaskIds } from './attention'
import type { HostLiveAgent, Stack } from '../shared/types'

const PORCELAIN = `worktree /Users/me/acme
HEAD 1111111aaaaaaa
branch refs/heads/main

worktree /Users/me/acme/.orcha-worktrees/task-lead-3f2a9c1e-4b7
HEAD 2222222bbbbbbb
branch refs/heads/orcha/task-lead-3f2a9c1e-4b7

worktree /Users/me/acme/.orcha-worktrees/20260928
HEAD 3333333ccccccc
detached
`

const agent = (alias: string, state: HostLiveAgent['state'] = 'working'): HostLiveAgent => ({
  alias,
  state,
  task: 'T',
  lastActive: null
})

describe('git worktree porcelain', () => {
  it('parses the main tree first, branches without refs/heads/, and detached trees', () => {
    const trees = parseWorktreePorcelain(PORCELAIN)
    expect(trees.map((t) => [t.path.split('/').pop(), t.branch, t.detached])).toEqual([
      ['acme', 'main', false],
      ['task-lead-3f2a9c1e-4b7', 'orcha/task-lead-3f2a9c1e-4b7', false],
      ['20260928', null, true]
    ])
    expect(trees[0].head).toBe('1111111aaaaaaa')
  })

  it('readWorktrees is null for no folder, a failing git, or a bare repo — never throws', async () => {
    expect(await readWorktrees(null, vi.fn())).toBeNull()
    expect(await readWorktrees('/x', vi.fn().mockRejectedValue(new Error('not a git repo')))).toBeNull()
    expect(await readWorktrees('/x', vi.fn().mockResolvedValue('worktree /x\nbare\n'))).toBeNull()
    const run = vi.fn().mockResolvedValue(PORCELAIN)
    expect(await readWorktrees('/Users/me/acme', run)).toHaveLength(3)
    expect(run).toHaveBeenCalledWith('/Users/me/acme', ['worktree', 'list', '--porcelain'])
  })

  it('safeRef / taskBranch mirror the notifier (notifier_worktree_base.safe_ref, provision_task)', () => {
    expect(safeRef('front end/dev')).toBe('front-end-dev')
    expect(safeRef('..weird..name..')).toBe('weird.name')
    expect(safeRef('')).toBe('agent')
    expect(taskBranch('lead', '3f2a9c1e-4b7d-4e2a-9d1c-0a0b0c0d0e0f')).toBe('orcha/task-lead-3f2a9c1e-4b7')
  })
})

describe('attributeCheckouts (D14 — real data only)', () => {
  const trees = parseWorktreePorcelain(PORCELAIN)
  const base = { folder: '/Users/me/acme', githubRepo: 'acme/web', worktreesDisabled: false }

  it('no git data → no checkouts, agents untouched (they nest under the project)', () => {
    const live = [agent('lead')]
    expect(attributeCheckouts({ ...base, worktrees: null, live, taskIds: new Map() })).toEqual({ checkouts: null, live })
  })

  it('primary checkout first; an agent sits on a worktree ONLY when its task branch exists', () => {
    const out = attributeCheckouts({
      ...base,
      worktrees: trees,
      live: [agent('lead'), agent('qa'), agent('docs')],
      taskIds: new Map([
        ['lead', '3f2a9c1e-4b7d-4e2a-9d1c-0a0b0c0d0e0f'], // worktree exists
        ['qa', 'ffffffff-0000-0000-0000-000000000000'] // no such worktree
      ])
    })
    expect(out.checkouts).toEqual([
      { branch: 'main', primary: true, detached: false, repo: 'acme/web' },
      { branch: 'orcha/task-lead-3f2a9c1e-4b7', primary: false, detached: false, repo: 'acme/web' }
    ])
    expect(out.live.map((a) => [a.alias, a.branch])).toEqual([
      ['lead', 'orcha/task-lead-3f2a9c1e-4b7'],
      ['qa', null],
      ['docs', null]
    ])
  })

  it('worktrees disabled → unattributed agents work in the primary checkout', () => {
    const out = attributeCheckouts({ ...base, worktreesDisabled: true, worktrees: trees.slice(0, 1), live: [agent('qa')], taskIds: new Map() })
    expect(out.live[0].branch).toBe('main')
  })

  it('local binding → the folder name is the muted repo line; detached primary is labelled', () => {
    const detached = parseWorktreePorcelain('worktree /Users/me/acme\nHEAD abcdef0123\ndetached\n')
    const out = attributeCheckouts({ ...base, githubRepo: 'local', worktrees: detached, live: [], taskIds: new Map() })
    expect(out.checkouts).toEqual([{ branch: 'detached @ abcdef0', primary: true, detached: true, repo: 'acme' }])
  })
})

describe('liveTaskIds', () => {
  it('review task for needs-review agents, else live run task, else claimed task', () => {
    const ids = liveTaskIds(
      [agent('a', 'needs_review'), agent('b'), agent('c', 'blocked'), agent('d')],
      [
        { id: '1', alias: 'b', kind: 'ai', active_run: { task_id: 'run-task' }, current_task: { task_id: 'claimed' } },
        { id: '2', alias: 'c', kind: 'ai', active_run: null, current_task: { task_id: 'claimed-c' } },
        { id: '3', alias: 'd', kind: 'ai' }
      ],
      [{ id: 'rev-1', title: 'R', status: 'needs_verification', assignees: ['a'] }]
    )
    expect([...ids]).toEqual([
      ['a', 'rev-1'],
      ['b', 'run-task'],
      ['c', 'claimed-c']
    ])
  })
})

describe('fetchStackAttention carries checkouts on the existing poll', () => {
  it('reads the stack folder once and attributes live agents per container', async () => {
    const stack: Stack = {
      project: 'orcha-acme',
      projectShort: 'acme',
      apiPort: 8001,
      dbPort: 5432,
      portalStatus: 'Up',
      running: true,
      folder: '/Users/me/acme',
      runtime: 'docker',
      health: 'ok'
    }
    const fetchJson = vi.fn(async (url: string) => {
      if (url.endsWith('/api/containers')) return { containers: [{ id: 'c1', name: 'Acme' }] }
      return {
        container: { autonomy_level: 'plan', github_repo: 'acme/web', worktrees_disabled: false },
        agents: [
          {
            id: 'a1',
            alias: 'lead',
            kind: 'ai',
            status: 'working',
            active_run: { task_id: '3f2a9c1e-4b7d-4e2a-9d1c-0a0b0c0d0e0f', task_title: 'Ship' }
          }
        ],
        tasks: [],
        requests: []
      }
    })
    const readTrees = vi.fn().mockResolvedValue(parseWorktreePorcelain(PORCELAIN))
    const out = await fetchStackAttention(stack, fetchJson, readTrees)
    expect(readTrees).toHaveBeenCalledTimes(1)
    expect(readTrees).toHaveBeenCalledWith('/Users/me/acme')
    const c = out.containers?.[0]
    expect(c?.checkouts?.map((x) => x.branch)).toEqual(['main', 'orcha/task-lead-3f2a9c1e-4b7'])
    expect(c?.live[0]).toMatchObject({ alias: 'lead', branch: 'orcha/task-lead-3f2a9c1e-4b7', task: 'Ship' })
  })
})
