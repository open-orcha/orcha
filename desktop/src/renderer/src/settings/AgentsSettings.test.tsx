// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AGENT_IDS, AGENT_REGISTRY, type AgentsApi, type AgentsSnapshot } from '../../../shared/agents'
import { AgentsProvider, useAgentsController } from '../agents/AgentsContext'
import AgentsSettings, { splitAgents } from './AgentsSettings'

function snap(over: Partial<AgentsSnapshot> = {}, installed: string[] = ['claude', 'codex', 'gemini']): AgentsSnapshot {
  return {
    permissionMode: 'yolo',
    defaultAgent: 'claude',
    detection: 'ready',
    detectedAt: 1,
    agents: AGENT_IDS.map((id) => ({
      id,
      enabled: true,
      extraArgs: [],
      installed: installed.includes(id),
      path: installed.includes(id) ? `/usr/local/bin/${id}` : null
    })),
    ...over
  }
}

function mockApi(initial: AgentsSnapshot | Promise<AgentsSnapshot>) {
  let current: AgentsSnapshot | null = null
  let changed: ((s: AgentsSnapshot) => void) | null = null
  const api: AgentsApi & { push(s: AgentsSnapshot): void } = {
    get: vi.fn(async () => (current = await initial)),
    refresh: vi.fn(async () => current as AgentsSnapshot),
    update: vi.fn(async (u) => {
      const s = structuredClone(current as AgentsSnapshot)
      if (u.op === 'permissionMode') s.permissionMode = u.mode
      if (u.op === 'default') s.defaultAgent = u.id
      if (u.op === 'enabled') s.agents.find((a) => a.id === u.id)!.enabled = u.enabled
      if (u.op === 'extraArgs') s.agents.find((a) => a.id === u.id)!.extraArgs = u.args
      if (u.op === 'restoreSessions') s.restoreSessions = u.on
      if (u.op === 'resumeAgents') s.resumeAgents = u.on
      return (current = s)
    }),
    openDocs: vi.fn(async () => {}),
    copyInstall: vi.fn(async () => {}),
    onChanged: vi.fn((cb) => {
      changed = cb
      return () => {}
    }),
    push: (s) => act(() => changed?.(s))
  }
  return api
}

function Harness({ api, onTestLaunch }: { api: AgentsApi; onTestLaunch?: (id: string) => void }) {
  const value = useAgentsController(api)
  return (
    <AgentsProvider value={value}>
      <AgentsSettings onTestLaunch={onTestLaunch} />
    </AgentsProvider>
  )
}

describe('Settings › Agents › terminal session restore', () => {
  it('defaults on; "Don’t resume" and Off send typed updates; resume is disabled while restore is off', async () => {
    const api = mockApi(snap())
    render(<Harness api={api} />)
    const restore = await screen.findByTestId('restore-sessions')
    expect(within(restore).getByRole('radio', { name: 'On' })).toHaveAttribute('aria-checked', 'true')
    const resume = screen.getByTestId('resume-agents')
    expect(within(resume).getByRole('radio', { name: 'Resume' })).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(within(resume).getByRole('radio', { name: 'Don’t resume' }))
    expect(api.update).toHaveBeenLastCalledWith({ op: 'resumeAgents', on: false })
    await userEvent.click(within(restore).getByRole('radio', { name: 'Off' }))
    expect(api.update).toHaveBeenLastCalledWith({ op: 'restoreSessions', on: false })
    await waitFor(() => expect(within(screen.getByTestId('resume-agents')).getByRole('radio', { name: 'Resume' })).toBeDisabled())
  })
})

describe('Settings › Agents', () => {
  it('shows a detecting state until main answers', async () => {
    let resolve!: (s: AgentsSnapshot) => void
    const api = mockApi(new Promise((r) => (resolve = r)))
    render(<Harness api={api} />)
    expect(screen.getByTestId('agents-detecting')).toBeInTheDocument()
    await act(async () => resolve(snap()))
    expect(await screen.findByTestId('installed-count')).toHaveTextContent('3 detected')
  })

  it('Installed rows: real mark, exact command line (Yolo flag), Default first; Available lists the rest with install commands', async () => {
    const api = mockApi(snap({ defaultAgent: 'gemini' }))
    render(<Harness api={api} />)
    const installed = await screen.findByRole('list', { name: 'Installed agents' })
    const rows = within(installed).getAllByRole('listitem')
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual(['agent-row-gemini', 'agent-row-claude', 'agent-row-codex'])
    expect(screen.getByTestId('cmd-claude')).toHaveTextContent('claude --dangerously-skip-permissions')
    expect(screen.getByTestId('cmd-codex')).toHaveTextContent('codex --dangerously-bypass-approvals-and-sandbox')
    expect(screen.getByTestId('default-gemini')).toHaveTextContent('Default')
    expect(rows[1].querySelector('svg[data-mark="claude"]')).not.toBeNull()
    expect(rows[0].querySelector('svg[data-mark="gemini"]')).not.toBeNull()
    const available = screen.getByRole('list', { name: 'Available to install' })
    expect(within(available).getAllByRole('listitem')).toHaveLength(AGENT_REGISTRY.length - 3)
    expect(screen.getByTestId('available-count')).toHaveTextContent(`${AGENT_REGISTRY.length - 3} agents`)
    expect(within(available).getByTestId('available-row-copilot')).toHaveTextContent('npm install -g @github/copilot')
    // no licensed mark → neutral initial tile, never a lookalike
    expect(within(available).getByTestId('available-row-aider').querySelector('svg[data-mark="initial"]')).not.toBeNull()
  })

  it('Manual drops the skip-permission flag from every command line', async () => {
    const api = mockApi(snap())
    render(<Harness api={api} />)
    await screen.findByTestId('cmd-claude')
    const user = userEvent.setup()
    await user.click(within(screen.getByTestId('permission-mode')).getByRole('radio', { name: 'Manual' }))
    expect(api.update).toHaveBeenCalledWith({ op: 'permissionMode', mode: 'manual' })
    await waitFor(() => expect(screen.getByTestId('cmd-claude')).toHaveTextContent(/^claude$/))
    expect(within(screen.getByTestId('permission-mode')).getByRole('radio', { name: 'Manual' })).toHaveAttribute('aria-checked', 'true')
  })

  it('Yolo on an agent without a documented flag says it launches normally', async () => {
    const api = mockApi(snap({}, ['claude', 'opencode']))
    render(<Harness api={api} />)
    const row = await screen.findByTestId('agent-row-opencode')
    expect(within(row).getByTestId('cmd-opencode')).toHaveTextContent(/^opencode$/)
    expect(row).toHaveTextContent(/No documented skip-permission flag/)
  })

  it('Enabled|Disabled and Set default go through the typed update', async () => {
    const api = mockApi(snap())
    render(<Harness api={api} />)
    await screen.findByTestId('agent-row-codex')
    const user = userEvent.setup()
    await user.click(within(screen.getByTestId('enabled-codex')).getByRole('radio', { name: 'Disabled' }))
    expect(api.update).toHaveBeenCalledWith({ op: 'enabled', id: 'codex', enabled: false })
    // a disabled row offers no "Set default"
    await waitFor(() => expect(screen.queryByTestId('set-default-codex')).not.toBeInTheDocument())
    await user.click(screen.getByTestId('set-default-gemini'))
    expect(api.update).toHaveBeenCalledWith({ op: 'default', id: 'gemini' })
    expect(await screen.findByTestId('default-gemini')).toBeInTheDocument()
  })

  it('expanded row: extra args are validated before saving; Test launch; docs + copy by id', async () => {
    const api = mockApi(snap())
    const onTestLaunch = vi.fn()
    render(<Harness api={api} onTestLaunch={onTestLaunch} />)
    const user = userEvent.setup()
    await user.click(await screen.findByTestId('expand-claude'))
    const opts = screen.getByTestId('agent-options-claude')
    const input = within(opts).getByTestId('args-claude')
    await user.type(input, '--model $(id)')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(within(opts).getByRole('alert')).toHaveTextContent(/isn’t allowed/)
    expect(within(opts).getByRole('button', { name: 'Save' })).toBeDisabled()
    await user.clear(input)
    await user.type(input, '--model opus')
    await user.click(within(opts).getByRole('button', { name: 'Save' }))
    expect(api.update).toHaveBeenCalledWith({ op: 'extraArgs', id: 'claude', args: ['--model', 'opus'] })
    await waitFor(() => expect(screen.getByTestId('cmd-claude')).toHaveTextContent('claude --dangerously-skip-permissions --model opus'))
    await user.click(within(opts).getByTestId('test-launch-claude'))
    expect(onTestLaunch).toHaveBeenCalledWith('claude')
    await user.click(screen.getByRole('button', { name: 'Claude Code docs' }))
    expect(api.openDocs).toHaveBeenCalledWith('claude')
    await user.click(screen.getByTestId('copy-install-aider'))
    expect(api.copyInstall).toHaveBeenCalledWith('aider')
    expect(await screen.findByTestId('copy-install-aider')).toHaveTextContent('Copied')
  })

  it('Refresh re-detects; a pushed snapshot from main updates the list', async () => {
    const api = mockApi(snap())
    render(<Harness api={api} />)
    await screen.findByTestId('installed-count')
    await userEvent.setup().click(screen.getByTestId('agents-refresh'))
    expect(api.refresh).toHaveBeenCalled()
    api.push(snap({}, ['claude', 'codex', 'gemini', 'qwen']))
    await waitFor(() => expect(screen.getByTestId('installed-count')).toHaveTextContent('4 detected'))
  })

  it('detection error and none-installed states', async () => {
    const api = mockApi(snap({ detection: 'error' }))
    const { unmount } = render(<Harness api={api} />)
    expect(await screen.findByTestId('agents-detect-error')).toBeInTheDocument()
    unmount()
    render(<Harness api={mockApi(snap({}, []))} />)
    expect(await screen.findByTestId('agents-none')).toBeInTheDocument()
  })

  it('splitAgents: nothing before detection is ready', () => {
    expect(splitAgents(snap({ detection: 'pending' }))).toEqual({ installed: [], available: [] })
  })
})
