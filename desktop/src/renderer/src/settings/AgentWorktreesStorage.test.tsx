// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import StorageSettings from './StorageSettings'
import { stateSummary } from './AgentWorktreesStorage'
import type { AgentWorktree, AgentWorktreeCleanResult, ProjectWorktrees } from '../../../shared/types'

const F = '/Users/me/fleet-mate'
const W = `${F}/.orcha-worktrees`
const wt = (name: string, state: AgentWorktree['state'], size: number, extra: Partial<AgentWorktree> = {}): AgentWorktree => ({
  path: `${W}/${name}`, name, branch: `orcha/${name}`, kind: 'wake', agent: 'Atlas', state, size_bytes: size, ...extra
})
const ITEMS = [
  wt('wk-Probe-1', 'clean', 2_300_000_000),
  wt('wk-Vault-1', 'clean', 20_000_000),
  wt('task-Atlas-eecc', 'has-output', 21_900_000, { output: ['qa-runs/report.md', 'qa-runs/shot.png'] }),
  wt('wk-Ferry-9', 'unmerged', 300_000, { unmerged_commits: 1 }),
  wt('live-Atlas', 'in-use', 19_800_000)
]
const PROJECTS: ProjectWorktrees[] = [
  { project: 'orcha-fleet-mate', projectShort: 'fleet-mate', folder: F, items: ITEMS, reclaimable_bytes: 2_341_900_000 }
]
const entry = (w: AgentWorktree, extra: Record<string, unknown> = {}) => ({ path: w.path, name: w.name, branch: w.branch, state: w.state, size_bytes: w.size_bytes, ...extra })
const DRY: AgentWorktreeCleanResult = {
  folder: F, dryRun: true, freed_bytes: 2_341_900_000,
  removed: [entry(ITEMS[0]), entry(ITEMS[1]), entry(ITEMS[2], { saves: ['qa-runs/report.md', 'qa-runs/shot.png'] })],
  kept: [entry(ITEMS[3], { reason: 'unmerged commits — kept' })],
  skipped: [entry(ITEMS[4])]
}

let api: Record<string, ReturnType<typeof vi.fn>>
beforeEach(() => {
  api = {
    storageScan: vi.fn().mockResolvedValue({ items: [], inUse: [] }),
    storageRemove: vi.fn(),
    storageWorktrees: vi.fn().mockResolvedValue(PROJECTS),
    storageCleanWorktrees: vi.fn(async (req: { dryRun: boolean }) =>
      req.dryRun ? DRY : { ...DRY, dryRun: false, removed: [...DRY.removed, entry(ITEMS[3])], kept: [], freed_bytes: 2_342_200_000 }),
    revealWorktree: vi.fn().mockResolvedValue(undefined)
  }
  window.orchaDesktop = api as unknown as typeof window.orchaDesktop
})

describe('Settings › Storage › Agent worktrees', () => {
  it('summarises states (pure)', () => {
    expect(stateSummary(ITEMS)).toBe('2 clean · 1 has output · 1 unmerged commits · 1 in use')
  })

  it('lists every project with its worktrees, states and reclaimable size', async () => {
    render(<StorageSettings />)
    const row = await screen.findByTestId('storage-wt-fleet-mate')
    expect(row).toHaveTextContent('5 worktrees · 2 clean · 1 has output · 1 unmerged commits · 1 in use')
    expect(row).toHaveTextContent('2.3 GB')
    expect(screen.getByTestId('storage-worktrees')).toHaveTextContent('2.3 GB reclaimable')
    await userEvent.click(within(row).getByRole('button', { expanded: false }))
    const list = within(row).getByRole('list', { name: 'Worktrees of fleet-mate' })
    expect(within(list).getByText('orcha/task-Atlas-eecc')).toBeInTheDocument()
    await userEvent.click(within(list).getByRole('button', { name: 'Show wk-Probe-1 in Finder' }))
    expect(api.revealWorktree).toHaveBeenCalledWith(F, `${W}/wk-Probe-1`)
  })

  it('"Clean up existing…" previews first (dry run, grouped), then runs once and reports what was freed', async () => {
    render(<StorageSettings />)
    const row = await screen.findByTestId('storage-wt-fleet-mate')
    await userEvent.click(within(row).getByRole('button', { name: 'Clean up existing…' }))
    const preview = await within(row).findByTestId('storage-wt-preview')
    expect(api.storageCleanWorktrees).toHaveBeenCalledWith({ folder: F, dryRun: true, onlyClean: false, unmerged: [] })
    expect(within(preview).getByRole('region', { name: 'Clean' })).toHaveTextContent('2 · 2.3 GB · remove')
    const out = within(preview).getByRole('region', { name: 'Has output' })
    expect(out).toHaveTextContent('save output to the task, then remove')
    expect(out).toHaveTextContent('qa-runs/report.md')
    expect(within(preview).getByRole('region', { name: 'Unmerged commits' })).toHaveTextContent('kept unless ticked')
    expect(within(preview).getByRole('region', { name: 'In use / not Embodent' })).toHaveTextContent('skipped')
    expect(api.storageCleanWorktrees).toHaveBeenCalledTimes(1) // nothing ran yet
    await userEvent.click(within(preview).getByRole('checkbox', { name: 'Remove wk-Ferry-9, keep branch' }))
    await userEvent.click(within(preview).getByRole('button', { name: /^Clean up 4 · free 2\.3 GB$/ }))
    await waitFor(() => expect(api.storageCleanWorktrees).toHaveBeenLastCalledWith({ folder: F, dryRun: false, onlyClean: false, unmerged: [`${W}/wk-Ferry-9`] }))
    expect(await within(row).findByText('Removed 4 worktrees · 2.3 GB freed')).toBeInTheDocument()
    expect(api.storageWorktrees).toHaveBeenCalledTimes(2) // rescanned
  })

  it('"Clean up now" previews only the clean ones', async () => {
    render(<StorageSettings />)
    const row = await screen.findByTestId('storage-wt-fleet-mate')
    await userEvent.click(within(row).getByRole('button', { name: 'Clean up now (2)' }))
    await within(row).findByTestId('storage-wt-preview')
    expect(api.storageCleanWorktrees).toHaveBeenCalledWith({ folder: F, dryRun: true, onlyClean: true, unmerged: [] })
  })

  it('is hidden when the app has no worktree support', async () => {
    delete (api as Record<string, unknown>).storageWorktrees
    render(<StorageSettings />)
    await screen.findByTestId('settings-storage')
    expect(screen.queryByTestId('storage-worktrees')).toBeNull()
  })
})
