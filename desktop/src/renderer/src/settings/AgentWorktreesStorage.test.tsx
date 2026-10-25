// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import StorageSettings from './StorageSettings'
import { notEmbodentWhy, stateSummary } from './AgentWorktreesStorage'
import { SCAN_SLOW_MS, SCAN_TIMEOUT_MS } from './useBoundedScan'
import type { AgentWorktree, AgentWorktreeCleanResult, ProjectWorktrees, WorktreeProject } from '../../../shared/types'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

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

afterEach(() => {
  vi.useRealTimers()
})

describe('Settings › Storage › Agent worktrees', () => {
  it('a worktree scan that never answers stops spinning, says so, and Scan retries (Verdikt: scans never finish)', async () => {
    vi.useFakeTimers()
    api.storageWorktrees.mockReturnValueOnce(new Promise(() => {})).mockResolvedValueOnce(PROJECTS)
    render(<StorageSettings />)
    expect(screen.getByText('Looking at agent worktrees…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Scan worktrees again' })).toBeDisabled()
    await act(async () => {
      vi.advanceTimersByTime(SCAN_TIMEOUT_MS)
    })
    vi.useRealTimers()
    expect(screen.queryByText('Looking at agent worktrees…')).not.toBeInTheDocument()
    expect(screen.getByText(/Couldn’t check agent worktrees: No answer after 60 seconds/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Scan worktrees again' }))
    expect(await screen.findByTestId('storage-wt-fleet-mate')).toBeInTheDocument()
    expect(screen.queryByText(/No answer after/)).not.toBeInTheDocument()
  })

  it('a late legacy scan replaces its timeout error without another scan', async () => {
    vi.useFakeTimers()
    const answer = deferred<ProjectWorktrees[]>()
    api.storageWorktrees.mockReturnValueOnce(answer.promise)
    render(<StorageSettings />)
    await act(async () => { await vi.advanceTimersByTimeAsync(SCAN_TIMEOUT_MS) })
    expect(screen.getByText(/Couldn’t check agent worktrees: No answer after 60 seconds/)).toBeInTheDocument()
    await act(async () => answer.resolve(PROJECTS))
    expect(screen.getByTestId('storage-wt-fleet-mate')).toHaveTextContent('5 worktrees')
    expect(screen.getByTestId('storage-worktrees')).toHaveTextContent('2.3 GB reclaimable')
    expect(screen.queryByText(/No answer after/)).not.toBeInTheDocument()
    expect(screen.queryByText('Looking at agent worktrees…')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Scan worktrees again' })).toBeEnabled()
    expect(api.storageWorktrees).toHaveBeenCalledTimes(1)
  })

  it.each(['running', 'finished'] as const)('an older late legacy answer cannot overwrite a newer %s scan', async (newer) => {
    vi.useFakeTimers()
    const oldAnswer = deferred<ProjectWorktrees[]>()
    const newAnswer = deferred<ProjectWorktrees[]>()
    const refreshed = [{ ...PROJECTS[0], items: [], reclaimable_bytes: 0 }]
    api.storageWorktrees.mockReturnValueOnce(oldAnswer.promise).mockReturnValueOnce(newAnswer.promise)
    render(<StorageSettings />)
    await act(async () => { await vi.advanceTimersByTimeAsync(SCAN_TIMEOUT_MS) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Scan worktrees again' })) })
    if (newer === 'finished') await act(async () => newAnswer.resolve(refreshed))
    await act(async () => oldAnswer.resolve(PROJECTS))
    if (newer === 'running') {
      expect(screen.queryByTestId('storage-wt-fleet-mate')).not.toBeInTheDocument()
      expect(screen.getByText('Looking at agent worktrees…')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Scan worktrees again' })).toBeDisabled()
      await act(async () => newAnswer.resolve(refreshed))
    }
    expect(screen.getByTestId('storage-wt-fleet-mate')).toHaveTextContent('0 worktrees')
    expect(screen.getByTestId('storage-worktrees')).toHaveTextContent('0 B reclaimable')
    expect(screen.queryByText(/No answer after/)).not.toBeInTheDocument()
    expect(screen.queryByText('Looking at agent worktrees…')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Scan worktrees again' })).toBeEnabled()
    expect(api.storageWorktrees).toHaveBeenCalledTimes(2)
  })

  it('a failed clean-up shows its error; a successful retry clears it (review: error stuck after retry)', async () => {
    api.storageCleanWorktrees.mockImplementation(async (req: { dryRun: boolean }) => (req.dryRun ? DRY : { ...DRY, dryRun: false }))
    api.storageCleanWorktrees.mockImplementationOnce(async () => DRY).mockImplementationOnce(async () => { throw { code: 'WORKTREE_CLI', message: 'disk busy' } })
    render(<StorageSettings />)
    const row = await screen.findByTestId('storage-wt-fleet-mate')
    await userEvent.click(within(row).getByRole('button', { name: 'Clean up existing…' }))
    const preview = await within(row).findByTestId('storage-wt-preview')
    await userEvent.click(within(preview).getByRole('button', { name: /^Clean up 3/ }))
    expect(await screen.findByText(/disk busy/)).toBeInTheDocument()
    await userEvent.click(within(row).getByRole('button', { name: /^Clean up 3/ }))
    expect(await within(row).findByText(/^Removed 3 worktrees/)).toBeInTheDocument()
    expect(screen.queryByText(/disk busy/)).not.toBeInTheDocument()
  })

  it('a clean-up error shows, and Scan clears it', async () => {
    api.storageCleanWorktrees.mockRejectedValueOnce({ code: 'WORKTREE_CLI', message: 'disk busy' })
    render(<StorageSettings />)
    const row = await screen.findByTestId('storage-wt-fleet-mate')
    await userEvent.click(within(row).getByRole('button', { name: 'Clean up existing…' }))
    expect(await screen.findByText(/Couldn’t check agent worktrees: disk busy/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Scan worktrees again' }))
    await waitFor(() => expect(screen.queryByText(/disk busy/)).not.toBeInTheDocument())
  })

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
    expect(out).toHaveTextContent('preserve output, then remove')
    expect(preview).toHaveTextContent('Before removal, output is attached to its task when possible, otherwise saved in the project’s .orcha/saved-output folder.')
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

describe('Settings › Storage › Agent worktrees, project by project (Verdikt: opaque 25 s scan)', () => {
  const G = '/Users/me/garden'
  const GARDEN: ProjectWorktrees = {
    project: 'orcha-garden', projectShort: 'garden', folder: G, reclaimable_bytes: 0,
    items: [
      wt('feat-a', 'not-quorate', 1_000, { branch: 'feat/a', reason: 'branch feat/a is not an Orcha branch' }),
      wt('feat-b', 'not-quorate', 1_000, { branch: 'fix/b', reason: 'branch fix/b is not an Orcha branch' }),
      wt('det', 'not-quorate', 1_000, { branch: null, reason: 'detached HEAD — not an Orcha branch' })
    ]
  }
  const LIST = [
    { project: 'orcha-fleet-mate', projectShort: 'fleet-mate', folder: F },
    { project: 'orcha-garden', projectShort: 'garden', folder: G }
  ]
  const streamed = (): { releaseGarden(): void } => {
    let releaseGarden = (): void => {}
    api.storageWorktrees.mockReturnValue(new Promise(() => {})) // the one-shot scan is not used
    api.storageWorktreeProjects = vi.fn().mockResolvedValue(LIST)
    api.storageProjectWorktrees = vi.fn((folder: string) =>
      folder === F ? Promise.resolve(PROJECTS[0]) : new Promise((resolve) => { releaseGarden = () => resolve(GARDEN) })
    )
    return { releaseGarden: () => releaseGarden() }
  }

  it('shows each project as soon as its own scan answers, with how many are done', async () => {
    const { releaseGarden } = streamed()
    render(<StorageSettings />)
    const fleet = await screen.findByTestId('storage-wt-fleet-mate')
    expect(fleet).toHaveTextContent('5 worktrees · 2 clean')
    expect(screen.getByTestId('storage-wt-garden')).toHaveTextContent('Checking…')
    expect(screen.getByTestId('storage-wt-progress')).toHaveTextContent('Checked 1 of 2 projects…')
    expect(screen.getByTestId('storage-worktrees')).toHaveTextContent('2.3 GB reclaimable so far')
    await act(async () => releaseGarden())
    expect(await screen.findByText(/3 worktrees · 3 not embodent/)).toBeInTheDocument()
    expect(screen.queryByTestId('storage-wt-progress')).toBeNull()
    expect(screen.getByTestId('storage-worktrees')).not.toHaveTextContent('so far')
    expect(api.storageProjectWorktrees).toHaveBeenCalledWith(G)
  })

  it('a project that never answers gets its own error after the limit; the others still show', async () => {
    vi.useFakeTimers()
    streamed()
    render(<StorageSettings />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SCAN_TIMEOUT_MS)
    })
    vi.useRealTimers()
    expect(screen.getByTestId('storage-wt-fleet-mate')).toHaveTextContent('5 worktrees')
    expect(screen.getByTestId('storage-wt-garden')).toHaveTextContent('No answer after 60 seconds')
    expect(screen.getByRole('button', { name: 'Scan worktrees again' })).toBeEnabled()
  })

  it('a slow project says "Still looking" and Scan works again; it is not an error yet', async () => {
    vi.useFakeTimers()
    streamed()
    render(<StorageSettings />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SCAN_SLOW_MS)
    })
    vi.useRealTimers()
    expect(screen.getByTestId('storage-wt-progress')).toHaveTextContent('Checked 1 of 2 projects… Still looking.')
    expect(screen.getByTestId('storage-wt-garden')).toHaveTextContent('Checking…')
    expect(screen.getByRole('button', { name: 'Scan worktrees again' })).toBeEnabled()
  })

  it('names projects the way the sidebar does', async () => {
    render(<StorageSettings projectNames={{ 'orcha-fleet-mate': 'Fleet Mate' }} />)
    const row = await screen.findByTestId('storage-wt-fleet-mate')
    expect(row).toHaveTextContent('Fleet Mate')
    expect(row).not.toHaveTextContent('fleet-mate')
    await userEvent.click(within(row).getByRole('button', { expanded: false }))
    expect(within(row).getByRole('list', { name: 'Worktrees of Fleet Mate' })).toBeInTheDocument()
  })

  it('a slow project still arrives when Scan rejoins the running scan', async () => {
    vi.useFakeTimers()
    const garden = deferred<ProjectWorktrees>()
    streamed()
    // Main shares an in-flight promise for repeat scans of the same folder.
    api.storageProjectWorktrees.mockImplementation((folder: string) =>
      folder === F ? Promise.resolve(PROJECTS[0]) : garden.promise
    )
    render(<StorageSettings />)
    await act(async () => { await vi.advanceTimersByTimeAsync(SCAN_SLOW_MS) })
    expect(screen.getByTestId('storage-wt-progress')).toHaveTextContent('Still looking.')
    expect(screen.queryByText(/No answer after/)).not.toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Scan worktrees again' })) })
    expect(api.storageProjectWorktrees.mock.calls.filter(([folder]) => folder === G)).toHaveLength(2)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
      garden.resolve(GARDEN)
    })
    expect(screen.getByTestId('storage-wt-garden')).toHaveTextContent('3 worktrees')
    expect(screen.queryByTestId('storage-wt-progress')).not.toBeInTheDocument()
    expect(screen.queryByText(/No answer after/)).not.toBeInTheDocument()
  })

  it('a project answering after the hard limit replaces its error without another scan', async () => {
    vi.useFakeTimers()
    const { releaseGarden } = streamed()
    render(<StorageSettings />)
    await act(async () => { await vi.advanceTimersByTimeAsync(SCAN_TIMEOUT_MS) })
    expect(screen.getByTestId('storage-wt-garden')).toHaveTextContent('No answer after 60 seconds')
    await act(async () => releaseGarden())
    expect(screen.getByTestId('storage-wt-garden')).toHaveTextContent('3 worktrees')
    expect(screen.queryByText(/No answer after/)).not.toBeInTheDocument()
    expect(api.storageProjectWorktrees).toHaveBeenCalledTimes(2)
  })

  it('an older project answer cannot replace a newer scan or stop its progress', async () => {
    vi.useFakeTimers()
    const { releaseGarden } = streamed()
    render(<StorageSettings />)
    await act(async () => { await vi.advanceTimersByTimeAsync(SCAN_SLOW_MS) })
    const newGarden = deferred<ProjectWorktrees>()
    api.storageProjectWorktrees.mockImplementation((folder: string) =>
      folder === F ? Promise.resolve(PROJECTS[0]) : newGarden.promise
    )
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Scan worktrees again' })) })
    await act(async () => releaseGarden())
    expect(screen.getByTestId('storage-wt-garden')).toHaveTextContent('Checking…')
    expect(screen.getByTestId('storage-wt-progress')).toHaveTextContent('Checked 1 of 2 projects…')
    expect(screen.getByRole('button', { name: 'Scan worktrees again' })).toBeDisabled()
    await act(async () => newGarden.resolve({ ...GARDEN, items: [] }))
    expect(screen.getByTestId('storage-wt-garden')).toHaveTextContent('0 worktrees')
    expect(screen.queryByTestId('storage-wt-progress')).not.toBeInTheDocument()
  })

  it('an older project list cannot replace the projects found by a newer scan', async () => {
    vi.useFakeTimers()
    streamed()
    const oldList = deferred<WorktreeProject[]>()
    api.storageWorktreeProjects.mockReturnValueOnce(oldList.promise).mockResolvedValueOnce([LIST[0]])
    render(<StorageSettings />)
    await act(async () => { await vi.advanceTimersByTimeAsync(SCAN_SLOW_MS) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Scan worktrees again' })) })
    expect(screen.getByTestId('storage-wt-fleet-mate')).toHaveTextContent('5 worktrees')
    await act(async () => oldList.resolve([LIST[1]]))
    expect(screen.getByTestId('storage-wt-fleet-mate')).toHaveTextContent('5 worktrees')
    expect(screen.queryByTestId('storage-wt-garden')).not.toBeInTheDocument()
    expect(api.storageProjectWorktrees).toHaveBeenCalledTimes(1)
    expect(api.storageProjectWorktrees).not.toHaveBeenCalledWith(G)
  })

  it('a rescan rechecks the projects without counting previous results as finished', async () => {
    const { releaseGarden } = streamed()
    render(<StorageSettings />)
    await screen.findByTestId('storage-wt-fleet-mate')
    await act(async () => releaseGarden())
    expect(screen.getByTestId('storage-wt-garden')).toHaveTextContent('3 worktrees')
    const fleet = deferred<ProjectWorktrees>()
    api.storageProjectWorktrees.mockImplementation((folder: string) =>
      folder === F ? fleet.promise : Promise.resolve({ ...GARDEN, items: [] })
    )
    await userEvent.click(screen.getByRole('button', { name: 'Scan worktrees again' }))
    expect(screen.getByTestId('storage-wt-fleet-mate')).toHaveTextContent('Checking…')
    expect(screen.getByTestId('storage-wt-progress')).toHaveTextContent('Checked 1 of 2 projects…')
    expect(screen.getByTestId('storage-worktrees')).toHaveTextContent('0 B reclaimable so far')
    await act(async () => fleet.resolve({ ...PROJECTS[0], items: [], reclaimable_bytes: 0 }))
    expect(screen.getByTestId('storage-wt-fleet-mate')).toHaveTextContent('0 worktrees')
    expect(screen.queryByTestId('storage-wt-progress')).not.toBeInTheDocument()
  })

  it('says why the "Not Embodent" worktrees are kept, and what automatic clean-up never removes', async () => {
    api.storageWorktrees.mockResolvedValue([PROJECTS[0], GARDEN])
    render(<StorageSettings />)
    expect(await screen.findByTestId('storage-wt-why-garden')).toHaveTextContent(
      'Not Embodent, so never removed: 2 on a branch Orcha didn’t create · 1 detached HEAD'
    )
    expect(screen.queryByTestId('storage-wt-why-fleet-mate')).toBeNull()
    const explanation = within(screen.getByTestId('storage-worktrees')).getByText(/Agents work in git worktrees/)
    expect(explanation).toHaveTextContent('Before removal, output is attached to its task when possible, otherwise saved in the project’s .orcha/saved-output folder.')
    expect(explanation).toHaveTextContent('ones with output using the same preservation steps')
    expect(explanation).toHaveTextContent('it never removes unmerged commits or a worktree in use')
  })

  it('groups the "Not Embodent" reasons (pure)', () => {
    expect(notEmbodentWhy(GARDEN.items)).toBe('2 on a branch Orcha didn’t create · 1 detached HEAD')
    expect(notEmbodentWhy([wt('x', 'not-quorate', 1, { reason: 'not registered with git — left alone' })])).toBe('1 not registered with git')
    expect(notEmbodentWhy(ITEMS)).toBe('')
  })
})
