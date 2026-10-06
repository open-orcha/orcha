// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { useProjectRemoval, type RemovalDeps } from './useProjectRemoval'
import { FAVORITES_KEY, ORDER_KEY } from './removeProject'
import type { ProjectRow } from './projectModel'
import type { TermTab } from '../terminal/termTabs'
import type { RemovePhase, RemoveResult, Stack } from '../../../shared/types'

const stack = (project: string, running = true): Stack => ({
  project,
  projectShort: project.replace(/^orcha-/, ''),
  apiPort: running ? 8001 : null,
  dbPort: null,
  portalStatus: running ? 'Up' : 'Exited',
  running,
  folder: '/Users/me/x'
})
const row = (project: string, cid: string, running = true): ProjectRow =>
  ({ key: `${project}:${cid}`, stack: stack(project, running), container: { id: cid }, name: project.replace(/^orcha-/, '') }) as unknown as ProjectRow
const tab = (key: string, project: string | null, status: TermTab['status'] = 'running'): TermTab => ({ key, project, status }) as TermTab

const ACME = row('orcha-acme', 'c1')
const WEB = row('orcha-acme-web', 'c2')

const OK: RemoveResult = { project: 'orcha-acme', projectShort: 'acme', dataDeleted: false, filesRemoved: false, removed: [], kept: [], warnings: [] }

let progress: ((e: { project: string; phase: RemovePhase }) => void) | null = null
let api: { removeProject: ReturnType<typeof vi.fn>; removePlan: ReturnType<typeof vi.fn> }

beforeEach(() => {
  progress = null
  api = { removeProject: vi.fn().mockResolvedValue(OK), removePlan: vi.fn().mockResolvedValue(null) }
  window.orchaDesktop = {
    setHostModal: vi.fn().mockResolvedValue(undefined),
    removeProject: api.removeProject,
    removePlan: vi.fn(() => new Promise(() => {})), // never resolves: the summary isn't under test here
    onRemoveProgress: (cb: typeof progress) => {
      progress = cb
      return () => {
        progress = null
      }
    }
  } as unknown as typeof window.orchaDesktop
})

function mem(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init))
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }
}

function Harness({ deps, start }: { deps: RemovalDeps; start: ProjectRow }) {
  const r = useProjectRemoval(deps)
  useEffect(() => {
    r.request(start)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return <>{r.ui}</>
}

function deps(over: Partial<RemovalDeps> = {}): RemovalDeps & { storage: ReturnType<typeof mem> } {
  return {
    rows: [ACME, WEB],
    tabs: [tab('t1', 'orcha-acme'), tab('t2', 'orcha-acme', 'exited'), tab('t3', 'orcha-acme-web'), tab('t4', null)],
    activeProject: null,
    closeTab: vi.fn(),
    storage: mem({ [FAVORITES_KEY]: JSON.stringify(['c1', 'c2']), [ORDER_KEY]: JSON.stringify(['orcha-acme-web:c2', 'orcha-acme:c1']) }),
    forgetIcons: vi.fn(),
    applyPrefs: vi.fn(),
    openRow: vi.fn(),
    showHome: vi.fn(),
    refresh: vi.fn(),
    ...over
  } as RemovalDeps & { storage: ReturnType<typeof mem> }
}

describe('useProjectRemoval', () => {
  it('success: removes, closes ONLY that project’s terminals, forgets its prefs/icons, toasts', async () => {
    const d = deps()
    render(<Harness deps={d} start={ACME} />)
    expect(screen.getByTestId('remove-terminals')).toHaveTextContent('1 running terminal')
    await userEvent.click(screen.getByRole('button', { name: 'Remove project' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(api.removeProject).toHaveBeenCalledWith('orcha-acme', { deleteData: false, removeFiles: false })
    expect((d.closeTab as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual(['t1', 't2'])
    expect(d.forgetIcons).toHaveBeenCalledWith(['c1'])
    expect(d.applyPrefs).toHaveBeenCalledWith({ favorites: new Set(['c2']), order: ['orcha-acme-web:c2'], expanded: {} })
    expect(d.refresh).toHaveBeenCalled()
    expect(screen.getByTestId('toast')).toHaveTextContent('Removed acme. Its data is kept — add the folder again to bring it back.')
    // not the open project: no navigation
    expect(d.openRow).not.toHaveBeenCalled()
    expect(d.showHome).not.toHaveBeenCalled()
  })

  it('the OPEN project removed → falls back to another running project', async () => {
    const d = deps({ activeProject: 'orcha-acme' })
    render(<Harness deps={d} start={ACME} />)
    await userEvent.click(screen.getByRole('button', { name: 'Remove project' }))
    await waitFor(() => expect(d.openRow).toHaveBeenCalledWith(WEB))
    expect(d.showHome).not.toHaveBeenCalled()
  })

  it('the open project removed and nothing else can open → the home screen', async () => {
    const d = deps({ activeProject: 'orcha-acme', rows: [ACME, row('orcha-acme-web', 'c2', false)] })
    render(<Harness deps={d} start={ACME} />)
    await userEvent.click(screen.getByRole('button', { name: 'Remove project' }))
    await waitFor(() => expect(d.showHome).toHaveBeenCalled())
    expect(d.openRow).not.toHaveBeenCalled()
  })

  it('progress events for THIS project update the dialog', async () => {
    let finish: (r: RemoveResult) => void = () => {}
    api.removeProject.mockImplementation(() => new Promise<RemoveResult>((r) => (finish = r)))
    render(<Harness deps={deps()} start={ACME} />)
    await userEvent.click(screen.getByRole('button', { name: 'Remove project' }))
    expect(screen.getByTestId('remove-progress')).toHaveTextContent('Stopping…')
    act(() => progress?.({ project: 'orcha-acme-web', phase: 'deleting-data' }))
    expect(screen.getByTestId('remove-progress')).toHaveTextContent('Stopping…')
    act(() => progress?.({ project: 'orcha-acme', phase: 'removing' }))
    expect(screen.getByTestId('remove-progress')).toHaveTextContent('Removing…')
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    await act(async () => finish(OK))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  })

  it('failure: plain-words error, nothing cleaned up; Try again succeeds', async () => {
    api.removeProject.mockRejectedValueOnce({ code: 'DOCKER_UNAVAILABLE' }).mockResolvedValueOnce(OK)
    const d = deps({ activeProject: 'orcha-acme' })
    render(<Harness deps={d} start={ACME} />)
    await userEvent.click(screen.getByRole('button', { name: 'Remove project' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t remove: Docker isn’t running.')
    expect(d.closeTab).not.toHaveBeenCalled()
    expect(d.applyPrefs).not.toHaveBeenCalled()
    expect(d.openRow).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(api.removeProject).toHaveBeenCalledTimes(2)
    expect(d.openRow).toHaveBeenCalledWith(WEB)
  })

  it('delete data: the toast says so; warnings are listed', async () => {
    api.removeProject.mockResolvedValue({ ...OK, dataDeleted: true, warnings: ['Kept branch orcha/task-wip — it has work that isn’t merged.'] })
    render(<Harness deps={deps()} start={ACME} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('checkbox', { name: /Also delete all project data/ }))
    await user.type(screen.getByRole('textbox', { name: /Type the project name/ }), 'acme')
    await user.click(screen.getByRole('button', { name: 'Remove and delete data' }))
    expect(await screen.findByTestId('toast')).toHaveTextContent('Removed acme and deleted its data.')
    expect(screen.getByTestId('toast')).toHaveTextContent('Kept branch orcha/task-wip')
    expect(api.removeProject).toHaveBeenCalledWith('orcha-acme', { deleteData: true, removeFiles: false })
  })
})
