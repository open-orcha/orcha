// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import RemoveProjectDialog, { type RemoveProjectDialogProps } from './RemoveProjectDialog'
import type { RemovePlan } from '../../../shared/types'

beforeEach(() => {
  window.orchaDesktop = { setHostModal: vi.fn().mockResolvedValue(undefined) } as unknown as typeof window.orchaDesktop
})

const PLAN: RemovePlan = {
  project: 'orcha-acme',
  projectShort: 'acme',
  folder: '/Users/me/acme',
  folderMatches: true,
  containers: ['orcha-acme-portal-1', 'orcha-acme-db-1'],
  sandboxes: ['orcha-run-aaaaaaaaaaaa'],
  networks: ['orcha-acme_default'],
  images: [{ name: 'orcha-acme-portal:latest', size: 347_000_000 }],
  volumes: [{ name: 'orcha-acme_pgdata', size: 66_800_000 }],
  daemonPidFiles: [],
  folderFiles: ['.orcha'],
  worktrees: [{ path: '/Users/me/acme/.orcha-worktrees/task-a', branch: 'orcha/task-a' }]
}

function setup(over: Partial<RemoveProjectDialogProps> = {}) {
  const props: RemoveProjectDialogProps = {
    name: 'acme',
    project: 'orcha-acme',
    projectShort: 'acme',
    liveTerminals: 0,
    loadPlan: vi.fn().mockResolvedValue(PLAN),
    busy: false,
    phase: null,
    error: null,
    onCancel: vi.fn(),
    onConfirm: vi.fn(),
    ...over
  }
  render(<RemoveProjectDialog {...props} />)
  return props
}

const confirmButton = () => screen.getByRole('button', { name: /^(Remove project|Remove and delete data|Try again)$/ })

describe('RemoveProjectDialog', () => {
  it('names the project and says, by default, code and data are kept', async () => {
    setup()
    const dialog = screen.getByRole('alertdialog', { name: 'Remove “acme”?' })
    expect(dialog).toHaveTextContent('Your code and the project’s data are kept; add the folder again to bring it back.')
    // the exact summary, with sizes
    await screen.findByText('Portal image · 347 MB')
    expect(screen.getByText('3 containers (incl. 1 agent sandbox)')).toBeInTheDocument()
    expect(screen.getByTestId('keep-data-row')).toHaveTextContent('Project data: tasks, agents, history · 66.8 MB')
    expect(screen.getByTitle("/Users/me/acme")).toBeInTheDocument()
  })

  it('default confirm keeps data: onConfirm({deleteData:false, removeFiles:false})', async () => {
    const p = setup()
    await screen.findByText('Portal image · 347 MB')
    await userEvent.click(confirmButton())
    expect(p.onConfirm).toHaveBeenCalledWith({ deleteData: false, removeFiles: false })
  })

  it('focus starts on Cancel; Escape cancels', async () => {
    const p = setup()
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expect(p.onCancel).toHaveBeenCalled()
  })

  it('"Also delete all project data" is off by default and needs the EXACT name typed', async () => {
    const p = setup()
    const user = userEvent.setup()
    const box = screen.getByRole('checkbox', { name: /Also delete all project data/ })
    expect(box).not.toBeChecked()
    await user.click(box)
    const button = screen.getByRole('button', { name: 'Remove and delete data' })
    expect(button).toBeDisabled()
    const input = screen.getByRole('textbox', { name: 'Type the project name to confirm deleting its data' })
    await user.type(input, 'acm')
    expect(button).toBeDisabled()
    await user.type(input, 'e-web')
    expect(button).toBeDisabled()
    await user.clear(input)
    await user.type(input, 'ACME')
    expect(button).toBeDisabled()
    await user.clear(input)
    await user.type(input, 'acme')
    expect(button).toBeEnabled()
    expect(screen.getByTestId('remove-data-row')).toHaveTextContent('All project data: tasks, agents, history · 66.8 MB')
    await user.click(button)
    expect(p.onConfirm).toHaveBeenCalledWith({ deleteData: true, removeFiles: false })
  })

  it('unchecking delete-data resets the typed name', async () => {
    setup()
    const user = userEvent.setup()
    const box = screen.getByRole('checkbox', { name: /Also delete all project data/ })
    await user.click(box)
    await user.type(screen.getByRole('textbox', { name: /Type the project name/ }), 'acme')
    await user.click(box)
    await user.click(box)
    expect(screen.getByRole('textbox', { name: /Type the project name/ })).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Remove and delete data' })).toBeDisabled()
  })

  it('"Remove Embodent’s files" is opt-in and only once the folder is known to belong to the project', async () => {
    const p = setup()
    const box = screen.getByRole('checkbox', { name: /Remove Embodent’s files from the folder/ })
    expect(box).toBeDisabled() // plan not loaded yet
    await screen.findByText('Portal image · 347 MB')
    expect(box).toBeEnabled()
    await userEvent.click(box)
    expect(screen.getByTestId('remove-files-row')).toHaveTextContent('and 1 agent worktree')
    await userEvent.click(confirmButton())
    expect(p.onConfirm).toHaveBeenCalledWith({ deleteData: false, removeFiles: true })
  })

  it('files option stays off when the folder belongs to another stack', async () => {
    setup({ loadPlan: vi.fn().mockResolvedValue({ ...PLAN, folderMatches: false }) })
    await screen.findByText('Portal image · 347 MB')
    expect(screen.getByRole('checkbox', { name: /Remove Embodent’s files/ })).toBeDisabled()
    expect(screen.getByText(/no longer belongs to this project/)).toBeInTheDocument()
  })

  it('names running terminals that will be closed', () => {
    setup({ liveTerminals: 2 })
    expect(screen.getByTestId('remove-terminals')).toHaveTextContent('2 running terminals in this project (closed)')
  })

  it('progress: the phase shows, every control is locked, Escape does nothing', async () => {
    const p = setup({ busy: true, phase: 'stopping' })
    expect(screen.getByTestId('remove-progress')).toHaveTextContent('Stopping…')
    expect(screen.getByRole('button', { name: 'Stopping…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: /Also delete all project data/ })).toBeDisabled()
    await userEvent.keyboard('{Escape}')
    expect(p.onCancel).not.toHaveBeenCalled()
  })

  it('each phase has its own words', () => {
    const { rerender } = render(<RemoveProjectDialog {...{ name: 'b', project: 'orcha-b', projectShort: 'b', liveTerminals: 0, busy: true, phase: 'removing', error: null, onCancel: vi.fn(), onConfirm: vi.fn() }} />)
    expect(screen.getAllByRole('status').some((s) => s.textContent?.includes('Removing…'))).toBe(true)
    rerender(<RemoveProjectDialog {...{ name: 'b', project: 'orcha-b', projectShort: 'b', liveTerminals: 0, busy: true, phase: 'deleting-data', error: null, onCancel: vi.fn(), onConfirm: vi.fn() }} />)
    expect(screen.getAllByRole('status').some((s) => s.textContent?.includes('Deleting data…'))).toBe(true)
  })

  it('error: plain words (Docker not running) and Try again re-confirms with the same choice', async () => {
    const p = setup({ error: { code: 'DOCKER_UNAVAILABLE' } })
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t remove: Docker isn’t running.')
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(p.onConfirm).toHaveBeenCalledWith({ deleteData: false, removeFiles: false })
  })

  it('a plan that could not load shows why, with Retry; removal is still possible', async () => {
    const loadPlan = vi.fn().mockRejectedValueOnce({ code: 'DOCKER_UNAVAILABLE' }).mockResolvedValueOnce(PLAN)
    setup({ loadPlan })
    const dialog = screen.getByRole('alertdialog')
    await within(dialog).findByText(/Couldn’t list the project’s resources/)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Retry' }))
    await screen.findByText('Portal image · 347 MB')
    expect(loadPlan).toHaveBeenCalledTimes(2)
  })

  it('lists sibling projects of a shared stack', () => {
    setup({ siblings: ['mobile'] })
    expect(screen.getByText(/shares its stack with/)).toHaveTextContent('It shares its stack with mobile, which is removed too.')
  })

  it('agent worktrees: scaffolding-only ones go, output is saved first (opt-out keeps them), unmerged ones stay', async () => {
    const W = '/Users/me/acme/.orcha-worktrees'
    const plan: RemovePlan = {
      ...PLAN,
      worktrees: [
        { path: `${W}/wk-a`, branch: 'orcha/wk-a', state: 'clean' },
        { path: `${W}/task-qa`, branch: 'orcha/task-qa', state: 'has-output', files: ['qa-runs/report.md', 'qa-runs/a.png', 'qa-runs/b.png', 'notes.md'] },
        { path: `${W}/wk-ahead`, branch: 'orcha/wk-ahead', state: 'unmerged' }
      ]
    }
    const p = setup({ loadPlan: vi.fn().mockResolvedValue(plan) })
    await screen.findByText('Portal image · 347 MB')
    await userEvent.click(screen.getByRole('checkbox', { name: /Remove Embodent’s files from the folder/ }))
    expect(screen.getByTestId('remove-files-row')).toHaveTextContent('and 2 agent worktrees')
    expect(screen.getByTestId('remove-save-output-row')).toHaveTextContent('Output of 1 worktree saved first (4 files)')
    expect(screen.getByTestId('keep-worktrees-row')).toHaveTextContent('1 agent worktree with unmerged commits or in use')
    const save = screen.getByRole('checkbox', { name: /Save agent output first/ })
    expect(save).toBeChecked()
    expect(screen.getByTestId('remove-save-output')).toHaveTextContent('qa-runs/report.md, qa-runs/a.png, qa-runs/b.png, +1 more')
    await userEvent.click(save)
    expect(screen.getByTestId('remove-files-row')).toHaveTextContent('and 1 agent worktree')
    await userEvent.click(confirmButton())
    expect(p.onConfirm).toHaveBeenCalledWith({ deleteData: false, removeFiles: true, saveOutput: false })
  })
})
