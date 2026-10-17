// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import TrayPanel from './TrayPanel'
import type { AttentionItem, Stack } from '../../../shared/types'

const stack: Stack = {
  project: 'orcha-acme-ehr',
  projectShort: 'acme-ehr',
  apiPort: 8001,
  dbPort: 5435,
  portalStatus: 'Up 4 hours',
  running: true,
  folder: null,
  runtime: 'docker',
  health: 'ok'
}
const items: AttentionItem[] = [
  { project: 'orcha-acme-ehr', projectShort: 'acme-ehr', kind: 'task_verify', id: 't1', title: 'Verify foundation layer', path: '/tasks?task=t1' },
  { project: 'orcha-acme-ehr', projectShort: 'acme-ehr', kind: 'request_answer', id: 'r1', title: '[Atlas → operator] Need a decision on PR #90.', path: '/requests?req=r1' }
]

beforeEach(() => {
  window.orchaDesktop = {
    listStacks: vi.fn().mockResolvedValue([stack]),
    startStack: vi.fn(),
    stopStack: vi.fn(),
    resetStack: vi.fn(),
    portalShow: vi.fn().mockResolvedValue(undefined),
    portalHide: vi.fn().mockResolvedValue(undefined),
    listAttention: vi.fn().mockResolvedValue(items),
    openManager: vi.fn().mockResolvedValue(undefined),
    quitApp: vi.fn().mockResolvedValue(undefined),
    preflight: vi.fn().mockResolvedValue({ docker: 'ok', autoStarted: false, hint: null }),
    probePrereqs: vi
      .fn()
      .mockResolvedValue({ homebrew: true, dockerEngine: true, orcha: true, claude: true, codex: true }),
    installPrereqs: vi.fn().mockResolvedValue({ ok: true, completed: [] }),
    onInstallProgress: vi.fn().mockReturnValue(() => {}),
    pickFolder: vi.fn().mockResolvedValue(null),
    inspectFolder: vi
      .fn()
      .mockResolvedValue({ initialized: false, writable: true, suggestedName: 'x', isGitRepo: true }),
    provision: vi.fn().mockResolvedValue({ project: 'orcha-x', apiPort: 8000, warnings: [] }),
    githubStatus: vi.fn().mockResolvedValue({ authenticated: false, gitInstalled: true }),
    githubRepos: vi.fn().mockResolvedValue([]),
    suggestCloneDest: vi.fn().mockResolvedValue({ parent: '/tmp/orcha-projects', repoName: 'repo' }),
    pickCloneDest: vi.fn().mockResolvedValue(null),
    cloneAndProvision: vi.fn().mockResolvedValue({ project: 'orcha-repo', apiPort: 8000, warnings: [] }),
    openOnboardingPortal: vi.fn().mockResolvedValue(undefined),
    openExternal: vi.fn().mockResolvedValue(undefined),
    onProvisionProgress: vi.fn().mockReturnValue(() => {}),
    onNavigate: vi.fn().mockReturnValue(() => {}),
    onPortalActive: vi.fn().mockReturnValue(() => {}),
    portalGet: vi.fn().mockResolvedValue({ containers: [{ id: 'c1', name: 'EHR', status: 'active' }] }),
    portalPost: vi.fn(),
    portalPut: vi.fn(),
    analyzeProject: vi.fn(),
    listAttentionStatus: vi.fn().mockResolvedValue({ items: [], projects: [] }),
    setHostLayout: vi.fn().mockResolvedValue(undefined),
    setHostModal: vi.fn().mockResolvedValue(undefined),
    embedSend: vi.fn().mockResolvedValue(true),
    onEmbedEvent: vi.fn().mockReturnValue(() => {})
  }
})

describe('TrayPanel', () => {
  it('shows the attention count and stack rows', async () => {
    render(<TrayPanel />)
    expect(await screen.findByText('2')).toBeInTheDocument()
    expect(screen.getByText(/needs you/i)).toBeInTheDocument()
    expect(screen.getByText('acme-ehr')).toBeInTheDocument()
  })

  it('shows ALL CLEAR when nothing needs attention', async () => {
    window.orchaDesktop.listAttention = vi.fn().mockResolvedValue([])
    render(<TrayPanel />)
    expect(await screen.findByText('All clear')).toBeInTheDocument()
  })

  it('clicking a stack row opens its portal', async () => {
    render(<TrayPanel />)
    await userEvent.click(await screen.findByText('acme-ehr'))
    expect(window.orchaDesktop.portalShow).toHaveBeenCalledWith('orcha-acme-ehr')
  })

  it('the gear opens the manager window', async () => {
    render(<TrayPanel />)
    await userEvent.click(await screen.findByRole('button', { name: 'Open Embodent' }))
    expect(window.orchaDesktop.openManager).toHaveBeenCalled()
  })

  it('a quiet footer action opens the most-urgent stack portal', async () => {
    render(<TrayPanel />)
    await userEvent.click(await screen.findByRole('button', { name: 'Open acme-ehr' }))
    expect(window.orchaDesktop.portalShow).toHaveBeenCalledWith('orcha-acme-ehr')
  })

  it('lists each attention item under its stack with a kind chip', async () => {
    render(<TrayPanel />)
    expect(await screen.findByText('Verify foundation layer')).toBeInTheDocument()
    expect(screen.getByText('verify')).toBeInTheDocument()
    expect(screen.getByText('[Atlas → operator] Need a decision on PR #90.')).toBeInTheDocument()
    expect(screen.getByText('request')).toBeInTheDocument()
  })

  it('clicking an attention item deep-links into the portal', async () => {
    render(<TrayPanel />)
    await userEvent.click(await screen.findByText('[Atlas → operator] Need a decision on PR #90.'))
    expect(window.orchaDesktop.portalShow).toHaveBeenCalledWith('orcha-acme-ehr', '/requests?req=r1')
  })

  it('counts decisions only: follow-ups are listed (labelled) but excluded from the badge', async () => {
    window.orchaDesktop.listAttention = vi.fn().mockResolvedValue([
      { ...items[0], kind: 'task_plan', id: 'p1', title: 'Approve the plan', path: '/tasks?task=p1&cid=c1' },
      { ...items[1], kind: 'request_close', id: 'f1', title: 'Close my question', path: '/requests?req=f1&cid=c1' }
    ])
    render(<TrayPanel />)
    expect(await screen.findByText('Approve the plan')).toBeInTheDocument()
    expect(screen.getByText('plan')).toBeInTheDocument()
    expect(screen.getByText('follow-up')).toBeInTheDocument()
    expect(screen.getByText('1 follow-up (not counted)')).toBeInTheDocument()
    expect(screen.getByText('1 waiting')).toBeInTheDocument()
    await userEvent.click(screen.getByText('Approve the plan'))
    expect(window.orchaDesktop.portalShow).toHaveBeenCalledWith('orcha-acme-ehr', '/tasks?task=p1&cid=c1')
  })

  it('shows ALL CLEAR when only follow-ups remain', async () => {
    window.orchaDesktop.listAttention = vi.fn().mockResolvedValue([{ ...items[1], kind: 'request_close' }])
    render(<TrayPanel />)
    expect(await screen.findByText('All clear')).toBeInTheDocument()
  })

  it('stack status comes from the manager\'s band helper: running / paused / starting… match the manager', async () => {
    window.orchaDesktop.listAttention = vi.fn().mockResolvedValue([])
    const paused: Stack = { ...stack, project: 'orcha-p', projectShort: 'pay' }
    const starting: Stack = { ...stack, project: 'orcha-s', projectShort: 'warming' }
    const stopped: Stack = { ...stack, project: 'orcha-x', projectShort: 'off', running: false, apiPort: null }
    window.orchaDesktop.listStacks = vi.fn().mockResolvedValue([stack, paused, starting, stopped])
    // per-stack container lists: EHR active, pay paused, warming not answering yet
    const byProject: Record<string, unknown> = {
      'orcha-acme-ehr': { containers: [{ id: 'c1', name: 'EHR', status: 'active' }] },
      'orcha-p': { containers: [{ id: 'p1', name: 'Pay', status: 'paused' }] }
    }
    const ports = new Map<number, string>([[8001, 'orcha-acme-ehr'], [8002, 'orcha-p'], [8003, 'orcha-s']])
    paused.apiPort = 8002
    starting.apiPort = 8003
    window.orchaDesktop.portalGet = vi.fn(async (port: number) => {
      const res = byProject[ports.get(port) ?? '']
      if (!res) throw new Error('not up')
      return res
    })
    render(<TrayPanel />)
    const row = async (name: string) => (await screen.findByText(name)).closest('button') as HTMLElement
    expect(await row('acme-ehr')).toHaveTextContent('running')
    expect(await row('pay')).toHaveTextContent('paused')
    expect(await row('warming')).toHaveTextContent('starting…')
    expect(await row('off')).toHaveTextContent('stopped')
    expect((await row('pay')).querySelector('[data-band]')?.getAttribute('data-band')).toBe('paused')
  })
})
