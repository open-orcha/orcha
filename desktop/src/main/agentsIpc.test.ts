import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentDetector, PATH_MARKER } from './agentDetect'
import { AgentsRequestError, createAgentsController } from './agentsIpc'
import { agentPrefsFilePath, readAgentPrefs, writeAgentPrefs } from './agentPrefs'
import { defaultAgentPrefs, type AgentPrefs } from '../shared/agents'

const HOST = { isHostRenderer: true, isMainFrame: true }
const PORTAL = { isHostRenderer: false, isMainFrame: true }
const IFRAME = { isHostRenderer: true, isMainFrame: false }

function setup(opts: { prefs?: AgentPrefs; migrated?: boolean; installed?: string[] } = {}) {
  const installed = opts.installed ?? ['claude', 'codex']
  const detector = new AgentDetector({
    shell: '/bin/zsh',
    run: async () => `${PATH_MARKER}/usr/local/bin`,
    isExecutable: (p) => installed.some((b) => p === `/usr/local/bin/${b}`),
    now: () => 42
  })
  const save = vi.fn()
  const openExternal = vi.fn().mockResolvedValue(undefined)
  const copyText = vi.fn()
  const onChange = vi.fn()
  const ctl = createAgentsController({
    detector,
    load: () => ({ prefs: opts.prefs ?? defaultAgentPrefs(), migrated: opts.migrated ?? false }),
    save,
    openExternal,
    copyText,
    onChange
  })
  return { ctl, save, openExternal, copyText, onChange, detector }
}

describe('agents controller', () => {
  it('only the manager window main frame may call it', async () => {
    const { ctl } = setup()
    for (const f of [PORTAL, IFRAME]) {
      await expect(ctl.get(f)).rejects.toBeInstanceOf(AgentsRequestError)
      await expect(ctl.refresh(f)).rejects.toBeInstanceOf(AgentsRequestError)
      expect(() => ctl.update(f, { op: 'permissionMode', mode: 'manual' })).toThrow(AgentsRequestError)
      await expect(ctl.openDocs(f, 'claude')).rejects.toBeInstanceOf(AgentsRequestError)
      expect(() => ctl.copyInstall(f, 'claude')).toThrow(AgentsRequestError)
    }
  })

  it('get runs the first detection and reports installed/paths', async () => {
    const { ctl } = setup({ installed: ['claude', 'gemini'] })
    const s = await ctl.get(HOST)
    expect(s.detection).toBe('ready')
    expect(s.permissionMode).toBe('yolo')
    expect(s.agents.find((a) => a.id === 'gemini')).toEqual({ id: 'gemini', enabled: true, extraArgs: [], installed: true, path: '/usr/local/bin/gemini' })
    expect(s.agents.find((a) => a.id === 'codex')!.installed).toBe(false)
  })

  it('DT-32: with Codex disabled, disabling Claude is refused — ⌥⌘T never becomes an uninstalled Gemini', async () => {
    const { ctl, save } = setup({ installed: ['claude', 'codex'] })
    await ctl.get(HOST) // detection ready: claude + codex installed, every catalogue agent enabled
    ctl.update(HOST, { op: 'enabled', id: 'codex', enabled: false })
    const s = ctl.update(HOST, { op: 'enabled', id: 'claude', enabled: false })
    expect(s.defaultAgent).toBe('claude')
    expect(s.agents.find((a) => a.id === 'claude')!.enabled).toBe(true)
    expect(ctl.launchFor(s.defaultAgent, false).path).toBe('/usr/local/bin/claude')
    const s2 = ctl.update(HOST, { op: 'enabled', id: 'codex', enabled: true })
    expect(s2.defaultAgent).toBe('claude')
    expect(ctl.update(HOST, { op: 'enabled', id: 'claude', enabled: false }).defaultAgent).toBe('codex')
    expect(save.mock.calls.at(-1)![0].defaultAgent).toBe('codex')
  })

  it('DT-32: a saved uninstalled default (from an older build) is repaired once detection is ready', async () => {
    const base = defaultAgentPrefs()
    const saved: AgentPrefs = { ...base, defaultAgent: 'gemini' }
    const { ctl, save } = setup({ prefs: saved, installed: ['claude', 'codex'] })
    expect(ctl.prefs().defaultAgent).toBe('gemini') // detection pending: nothing known yet
    const s = await ctl.get(HOST)
    expect(s.defaultAgent).toBe('claude')
    expect(save.mock.calls.at(-1)![0].defaultAgent).toBe('claude')
    // Nothing installed at all: leave the choice alone (no launchable alternative).
    const none = setup({ prefs: saved, installed: [] })
    expect((await none.ctl.get(HOST)).defaultAgent).toBe('gemini')
    expect(none.save).not.toHaveBeenCalled()
  })

  it('writes migrated prefs back once at start', () => {
    const { save } = setup({ migrated: true })
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0]).toEqual(defaultAgentPrefs())
  })

  it('update validates, persists and notifies; invalid payloads change nothing', () => {
    const { ctl, save, onChange } = setup()
    const s = ctl.update(HOST, { op: 'extraArgs', id: 'claude', args: ['--model', 'opus'] })
    expect(s.agents.find((a) => a.id === 'claude')!.extraArgs).toEqual(['--model', 'opus'])
    expect(save).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(() => ctl.update(HOST, { op: 'extraArgs', id: 'claude', args: ['; rm -rf /'] })).toThrow(AgentsRequestError)
    expect(() => ctl.update(HOST, { op: 'default', id: 'not-an-agent' })).toThrow(AgentsRequestError)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('launchFor composes the resolved path + yolo flag + extra args (and a probe)', async () => {
    const { ctl } = setup()
    await ctl.refresh(HOST)
    ctl.update(HOST, { op: 'extraArgs', id: 'claude', args: ['--model', 'opus'] })
    expect(ctl.launchFor('claude', false)).toEqual({ path: '/usr/local/bin/claude', args: ['--dangerously-skip-permissions', '--model', 'opus'] })
    ctl.update(HOST, { op: 'permissionMode', mode: 'manual' })
    expect(ctl.launchFor('claude', false).args).toEqual(['--model', 'opus'])
    expect(ctl.launchFor('claude', true).args).toEqual(['--version'])
    expect(ctl.launchFor('gemini', false).path).toBeNull()
  })

  it('docs open only registry https URLs, looked up by id', async () => {
    const { ctl, openExternal } = setup()
    await ctl.openDocs(HOST, 'codex')
    expect(openExternal).toHaveBeenCalledWith('https://developers.openai.com/codex/cli')
    await expect(ctl.openDocs(HOST, 'https://evil.example/')).rejects.toBeInstanceOf(AgentsRequestError)
    await expect(ctl.openDocs(HOST, 'javascript:alert(1)')).rejects.toBeInstanceOf(AgentsRequestError)
    expect(openExternal).toHaveBeenCalledTimes(1)
  })

  it('copyInstall copies the official command for an id (never renderer text)', () => {
    const { ctl, copyText } = setup()
    ctl.copyInstall(HOST, 'gemini')
    expect(copyText).toHaveBeenCalledWith('npm install -g @google/gemini-cli')
    expect(() => ctl.copyInstall(HOST, 'rm -rf /')).toThrow(AgentsRequestError)
  })
})

describe('agents.json persistence', () => {
  it('absent file → defaults flagged for migration; round-trips; 0600; malformed → defaults', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orcha-agents-'))
    const first = readAgentPrefs(dir)
    expect(first).toEqual({ prefs: defaultAgentPrefs(), migrated: true })
    const next: AgentPrefs = { ...first.prefs, permissionMode: 'manual', defaultAgent: 'codex' }
    expect(writeAgentPrefs(dir, next)).toBe(true)
    expect(readAgentPrefs(dir)).toEqual({ prefs: next, migrated: false })
    expect(statSync(agentPrefsFilePath(dir)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(agentPrefsFilePath(dir), 'utf8')).version).toBe(1)
    writeFileSync(agentPrefsFilePath(dir), '{not json')
    expect(readAgentPrefs(dir)).toEqual({ prefs: defaultAgentPrefs(), migrated: true })
  })
})
