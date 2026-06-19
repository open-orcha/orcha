// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import TrayPanel from './TrayPanel'
import type { AttentionItem, Stack } from '../../../shared/types'

const stack: Stack = {
  project: 'orcha-quantal-ehr',
  projectShort: 'quantal-ehr',
  apiPort: 8001,
  dbPort: 5435,
  portalStatus: 'Up 4 hours',
  running: true,
  folder: null
}
const items: AttentionItem[] = [
  { project: 'orcha-quantal-ehr', projectShort: 'quantal-ehr', kind: 'task_verify', id: 't1', title: 'Verify foundation layer', path: '/tasks?task=t1' },
  { project: 'orcha-quantal-ehr', projectShort: 'quantal-ehr', kind: 'request_answer', id: 'r1', title: '[Atlas → operator] Need a decision on PR #90.', path: '/requests?req=r1' }
]

beforeEach(() => {
  window.orchaDesktop = {
    listStacks: vi.fn().mockResolvedValue([stack]),
    startStack: vi.fn(),
    stopStack: vi.fn(),
    resetStack: vi.fn(),
    openPortal: vi.fn().mockResolvedValue(undefined),
    listAttention: vi.fn().mockResolvedValue(items),
    openManager: vi.fn().mockResolvedValue(undefined),
    quitApp: vi.fn().mockResolvedValue(undefined),
    preflight: vi.fn().mockResolvedValue({ docker: 'ok', autoStarted: false, hint: null }),
    probePrereqs: vi
      .fn()
      .mockResolvedValue({ homebrew: true, dockerEngine: true, orcha: true, claude: true, codex: true, apiKey: true }),
    installPrereqs: vi.fn().mockResolvedValue({ ok: true, completed: [] }),
    onInstallProgress: vi.fn().mockReturnValue(() => {}),
    pickFolder: vi.fn().mockResolvedValue(null),
    inspectFolder: vi
      .fn()
      .mockResolvedValue({ initialized: false, writable: true, suggestedName: 'x' }),
    provision: vi.fn().mockResolvedValue({ project: 'orcha-x', apiPort: 8000, warnings: [] }),
    openOnboardingPortal: vi.fn().mockResolvedValue(undefined),
    openExternal: vi.fn().mockResolvedValue(undefined),
    onProvisionProgress: vi.fn().mockReturnValue(() => {}),
    onNavigate: vi.fn().mockReturnValue(() => {})
  }
})

describe('TrayPanel', () => {
  it('shows the attention count and stack rows', async () => {
    render(<TrayPanel />)
    expect(await screen.findByText('2')).toBeInTheDocument()
    expect(screen.getByText('NEEDS ATTENTION')).toBeInTheDocument()
    expect(screen.getByText('quantal-ehr')).toBeInTheDocument()
  })

  it('shows ALL CLEAR when nothing needs attention', async () => {
    window.orchaDesktop.listAttention = vi.fn().mockResolvedValue([])
    render(<TrayPanel />)
    expect(await screen.findByText('ALL CLEAR')).toBeInTheDocument()
  })

  it('clicking a stack row opens its portal', async () => {
    render(<TrayPanel />)
    await userEvent.click(await screen.findByText('quantal-ehr'))
    expect(window.orchaDesktop.openPortal).toHaveBeenCalledWith('orcha-quantal-ehr')
  })

  it('the gear opens the manager window', async () => {
    render(<TrayPanel />)
    await userEvent.click(await screen.findByRole('button', { name: 'Open Orcha' }))
    expect(window.orchaDesktop.openManager).toHaveBeenCalled()
  })

  it('the primary button opens the most-urgent stack portal', async () => {
    render(<TrayPanel />)
    await userEvent.click(await screen.findByRole('button', { name: 'Open portal' }))
    expect(window.orchaDesktop.openPortal).toHaveBeenCalledWith('orcha-quantal-ehr')
  })

  it('lists each attention item under its stack with a kind chip', async () => {
    render(<TrayPanel />)
    expect(await screen.findByText('Verify foundation layer')).toBeInTheDocument()
    expect(screen.getByText('verify')).toBeInTheDocument()
    expect(screen.getByText('[Atlas → operator] Need a decision on PR #90.')).toBeInTheDocument()
    expect(screen.getByText('escalation')).toBeInTheDocument()
  })

  it('clicking an attention item deep-links into the portal', async () => {
    render(<TrayPanel />)
    await userEvent.click(await screen.findByText('[Atlas → operator] Need a decision on PR #90.'))
    expect(window.orchaDesktop.openPortal).toHaveBeenCalledWith('orcha-quantal-ehr', '/requests?req=r1')
  })
})
