import { describe, it, expect } from 'vitest'
import {
  AGENT_IDS,
  AGENT_REGISTRY,
  applyAgentUpdate,
  reconcileDefault,
  commandLine,
  composeAgentArgs,
  defaultAgentPrefs,
  docsUrlFor,
  launcherIds,
  notFoundText,
  parseAgentPrefs,
  parseAgentUpdate,
  parseArgsInput,
  validateExtraArgs,
  type AgentsSnapshot
} from './agents'
import { isTermKind, parseCreateRequest } from './terminal'

describe('agent registry', () => {
  it('ids and binaries are unique, shell-inert names; docs are https', () => {
    expect(new Set(AGENT_IDS).size).toBe(AGENT_IDS.length)
    expect(new Set(AGENT_REGISTRY.map((a) => a.bin)).size).toBe(AGENT_REGISTRY.length)
    for (const a of AGENT_REGISTRY) {
      expect(a.id).toMatch(/^[a-z][a-z0-9-]*$/)
      expect(a.bin).toMatch(/^[a-z][a-z0-9-]*$/)
      expect(new URL(a.docsUrl).protocol).toBe('https:')
      expect(a.install.length).toBeGreaterThan(5)
      // Yolo flags are themselves valid extra args (shell-inert)
      if (a.yolo) expect(validateExtraArgs([...a.yolo.args]).ok).toBe(true)
      else expect(a.yoloNote).toBeTruthy()
    }
  })

  it('keeps the legacy Claude/Codex install hints and documented skip-permission flags', () => {
    expect(composeAgentArgs('claude', 'yolo', [])).toEqual(['--dangerously-skip-permissions'])
    expect(composeAgentArgs('codex', 'yolo', [])).toEqual(['--dangerously-bypass-approvals-and-sandbox'])
    expect(AGENT_REGISTRY.find((a) => a.id === 'claude')!.install).toBe('npm install -g @anthropic-ai/claude-code')
    expect(AGENT_REGISTRY.find((a) => a.id === 'codex')!.install).toBe('npm install -g @openai/codex')
  })

  it('not-found copy never says "CLI CLI"', () => {
    expect(notFoundText('claude')).toBe('Claude Code CLI not found — install it, then Restart.')
    expect(notFoundText('gemini')).toBe('Gemini CLI not found — install it, then Restart.')
    expect(notFoundText('copilot')).toBe('GitHub Copilot CLI not found — install it, then Restart.')
  })
})

describe('yolo flag composition', () => {
  it('Yolo prepends the documented flag, Manual omits it, extra args follow', () => {
    expect(composeAgentArgs('claude', 'yolo', ['--model', 'opus'])).toEqual(['--dangerously-skip-permissions', '--model', 'opus'])
    expect(composeAgentArgs('claude', 'manual', ['--model', 'opus'])).toEqual(['--model', 'opus'])
    expect(composeAgentArgs('gemini', 'yolo', [])).toEqual(['--approval-mode=yolo'])
    expect(composeAgentArgs('cline', 'yolo', [])).toEqual(['--auto-approve', 'true'])
  })
  it('Manual keeps an auto-approving-by-default CLI (Cline) asking first, via its documented flag', () => {
    expect(composeAgentArgs('cline', 'manual', [])).toEqual(['--auto-approve', 'false'])
    expect(commandLine('cline', 'manual', ['--retries', '5'])).toBe('cline --auto-approve false --retries 5')
    for (const a of AGENT_REGISTRY) {
      const m = (a as { manualArgs?: readonly string[] }).manualArgs
      if (m) expect(validateExtraArgs([...m]).ok).toBe(true)
      else if (a.id !== 'cline') expect(composeAgentArgs(a.id, 'manual', [])).toEqual([])
    }
  })
  it('agents with no documented flag launch normally in Yolo', () => {
    for (const id of ['opencode', 'goose', 'droid', 'auggie'] as const) expect(composeAgentArgs(id, 'yolo', [])).toEqual([])
  })
  it('a probe (Test launch) is just --version, whatever the mode or args', () => {
    expect(composeAgentArgs('claude', 'yolo', ['--model', 'opus'], true)).toEqual(['--version'])
  })
  it('the command line shown in the row is bin + composed argv', () => {
    expect(commandLine('claude', 'yolo', [])).toBe('claude --dangerously-skip-permissions')
    expect(commandLine('cursor', 'yolo', [])).toBe('cursor-agent --force')
    expect(commandLine('codex', 'manual', ['-m', 'o3'])).toBe('codex -m o3')
  })
})

describe('extra args validation', () => {
  it('accepts plain flags and values', () => {
    expect(parseArgsInput('  --model opus  --add-dir ../lib ')).toEqual({ ok: true, args: ['--model', 'opus', '--add-dir', '../lib'] })
    expect(parseArgsInput('')).toEqual({ ok: true, args: [] })
    expect(validateExtraArgs(['--x=a,b@c%d+e:f'])).toEqual({ ok: true, args: ['--x=a,b@c%d+e:f'] })
  })
  it.each([
    ['; rm -rf ~'],
    ['$(whoami)'],
    ['`id`'],
    ['a|b'],
    ['a&&b'],
    ["'quoted'"],
    ['"dq"'],
    ['>out'],
    ['*.ts'],
    ['~/x'],
    ['back\\slash'],
    ['new\nline']
  ])('rejects shell metacharacters: %j', (arg) => {
    expect(validateExtraArgs([arg]).ok).toBe(false)
  })
  it('rejects non-arrays, non-strings, empties, too many and too long', () => {
    expect(validateExtraArgs('--model opus').ok).toBe(false)
    expect(validateExtraArgs([1]).ok).toBe(false)
    expect(validateExtraArgs(['']).ok).toBe(false)
    expect(validateExtraArgs(Array(17).fill('-v')).ok).toBe(false)
    expect(validateExtraArgs(['x'.repeat(201)]).ok).toBe(false)
  })
})

describe('update parsing (renderer payloads)', () => {
  it('accepts the four ops', () => {
    expect(parseAgentUpdate({ op: 'permissionMode', mode: 'manual' })).toEqual({ op: 'permissionMode', mode: 'manual' })
    expect(parseAgentUpdate({ op: 'enabled', id: 'codex', enabled: false })).toEqual({ op: 'enabled', id: 'codex', enabled: false })
    expect(parseAgentUpdate({ op: 'default', id: 'gemini' })).toEqual({ op: 'default', id: 'gemini' })
    expect(parseAgentUpdate({ op: 'extraArgs', id: 'claude', args: ['--model', 'opus'] })).toEqual({
      op: 'extraArgs',
      id: 'claude',
      args: ['--model', 'opus']
    })
  })
  it('rejects unknown ids, ops, modes, extra keys and bad args', () => {
    expect(parseAgentUpdate({ op: 'default', id: 'bash' })).toBeNull()
    expect(parseAgentUpdate({ op: 'default', id: '/bin/sh' })).toBeNull()
    expect(parseAgentUpdate({ op: 'enabled', id: 'claude', enabled: 'yes' })).toBeNull()
    expect(parseAgentUpdate({ op: 'permissionMode', mode: 'yes' })).toBeNull()
    expect(parseAgentUpdate({ op: 'exec', id: 'claude' })).toBeNull()
    expect(parseAgentUpdate({ op: 'default', id: 'claude', path: '/tmp/x' })).toBeNull()
    expect(parseAgentUpdate({ op: 'extraArgs', id: 'claude', args: ['$(id)'] })).toBeNull()
    expect(parseAgentUpdate({ op: 'extraArgs', id: 'claude', args: '--model opus' })).toBeNull()
    expect(parseAgentUpdate(null)).toBeNull()
  })
})

describe('terminal create validation uses the registry', () => {
  const base = { project: null, cols: 80, rows: 24 }
  it('kinds are shell or registry ids', () => {
    expect(isTermKind('gemini')).toBe(true)
    expect(isTermKind('shell')).toBe(true)
    expect(isTermKind('bash')).toBe(false)
    expect(isTermKind('/usr/bin/claude')).toBe(false)
    expect(parseCreateRequest({ kind: 'gemini', ...base })).toEqual({ kind: 'gemini', ...base })
    expect(parseCreateRequest({ kind: 'rm', ...base })).toBeNull()
  })
  it('probe is a boolean for agent kinds only; no command / path / args keys', () => {
    expect(parseCreateRequest({ kind: 'claude', probe: true, ...base })).toEqual({ kind: 'claude', probe: true, ...base })
    expect(parseCreateRequest({ kind: 'claude', probe: false, ...base })).toEqual({ kind: 'claude', ...base })
    expect(parseCreateRequest({ kind: 'shell', probe: true, ...base })).toBeNull()
    expect(parseCreateRequest({ kind: 'claude', probe: 'yes', ...base })).toBeNull()
    expect(parseCreateRequest({ kind: 'claude', args: ['--x'], ...base })).toBeNull()
    expect(parseCreateRequest({ kind: 'claude', command: 'claude --x', ...base })).toBeNull()
  })
})

describe('preferences + migration', () => {
  it('fresh install / pre-registry user (no file): Yolo, Claude default, everything enabled', () => {
    const p = parseAgentPrefs(null)
    expect(p.permissionMode).toBe('yolo')
    expect(p.defaultAgent).toBe('claude')
    expect(p.agents.claude).toEqual({ enabled: true, extraArgs: [] })
    expect(p.agents.codex).toEqual({ enabled: true, extraArgs: [] })
    expect(Object.keys(p.agents).sort()).toEqual([...AGENT_IDS].sort())
  })
  it('keeps valid stored values and drops unknown ids / invalid args', () => {
    const p = parseAgentPrefs({
      version: 1,
      permissionMode: 'manual',
      defaultAgent: 'codex',
      agents: { codex: { enabled: true, extraArgs: ['-m', 'o3'] }, claude: { enabled: false, extraArgs: ['$(id)'] }, evil: { enabled: true } }
    })
    expect(p.permissionMode).toBe('manual')
    expect(p.defaultAgent).toBe('codex')
    expect(p.agents.codex.extraArgs).toEqual(['-m', 'o3'])
    expect(p.agents.claude).toEqual({ enabled: false, extraArgs: [] })
    expect('evil' in p.agents).toBe(false)
  })
  it('a default that is disabled or unknown falls back to the first enabled agent', () => {
    expect(parseAgentPrefs({ defaultAgent: 'nope' }).defaultAgent).toBe('claude')
    expect(parseAgentPrefs({ defaultAgent: 'codex', agents: { codex: { enabled: false } } }).defaultAgent).toBe('claude')
    expect(parseAgentPrefs({ permissionMode: 'sudo' }).permissionMode).toBe('yolo')
  })
})

describe('applyAgentUpdate', () => {
  const installed = new Set(['claude', 'gemini'] as const)
  it('Set default enables the agent; disabling the default hands it to an installed enabled agent', () => {
    let p = defaultAgentPrefs()
    p = applyAgentUpdate(p, { op: 'enabled', id: 'gemini', enabled: false }, installed)
    p = applyAgentUpdate(p, { op: 'default', id: 'gemini' }, installed)
    expect(p.defaultAgent).toBe('gemini')
    expect(p.agents.gemini.enabled).toBe(true)
    p = applyAgentUpdate(p, { op: 'enabled', id: 'gemini', enabled: false }, installed)
    expect(p.defaultAgent).toBe('claude')
  })
  it('the last enabled agent cannot be disabled away from being the default', () => {
    let p = defaultAgentPrefs()
    for (const id of AGENT_IDS) if (id !== 'claude') p = applyAgentUpdate(p, { op: 'enabled', id, enabled: false }, null)
    p = applyAgentUpdate(p, { op: 'enabled', id: 'claude', enabled: false }, null)
    expect(p.defaultAgent).toBe('claude')
    expect(p.agents.claude.enabled).toBe(true)
  })
  it('DT-32: disabling the last INSTALLED agent is refused — an uninstalled one never becomes the default', () => {
    const cc = new Set(['claude', 'codex'] as const)
    let p = defaultAgentPrefs() // every catalogue agent enabled, only Claude + Codex installed
    p = applyAgentUpdate(p, { op: 'enabled', id: 'codex', enabled: false }, cc)
    p = applyAgentUpdate(p, { op: 'enabled', id: 'claude', enabled: false }, cc)
    expect(p.defaultAgent).toBe('claude')
    expect(p.agents.claude.enabled).toBe(true)
    // With Codex back on, disabling Claude hands the default to Codex (installed), not Gemini.
    p = applyAgentUpdate(p, { op: 'enabled', id: 'codex', enabled: true }, cc)
    p = applyAgentUpdate(p, { op: 'enabled', id: 'claude', enabled: false }, cc)
    expect(p.defaultAgent).toBe('codex')
    expect(p.agents.claude.enabled).toBe(false)
  })
  it('DT-32: re-enabling an installed agent repairs a saved uninstalled default', () => {
    const cc = new Set(['claude', 'codex'] as const)
    let p = defaultAgentPrefs()
    p = { ...p, defaultAgent: 'gemini', agents: { ...p.agents, claude: { enabled: false, extraArgs: [] }, codex: { enabled: false, extraArgs: [] } } }
    p = applyAgentUpdate(p, { op: 'enabled', id: 'codex', enabled: true }, cc)
    expect(p.defaultAgent).toBe('codex')
    // An explicit "Set default" is still honoured, installed or not.
    p = applyAgentUpdate(p, { op: 'default', id: 'gemini' }, cc)
    expect(p.defaultAgent).toBe('gemini')
    // Before detection finishes nothing is known to be installed: old fallback applies.
    const q = applyAgentUpdate(defaultAgentPrefs(), { op: 'enabled', id: 'claude', enabled: false }, null)
    expect(q.defaultAgent).toBe(AGENT_IDS.find((id) => id !== 'claude'))
  })
  it('DT-32: reconcileDefault moves an uninstalled default to the first enabled installed agent', () => {
    const cc = new Set(['claude', 'codex'] as const)
    const p = { ...defaultAgentPrefs(), defaultAgent: 'gemini' as const }
    expect(reconcileDefault(p, cc).defaultAgent).toBe('claude')
    const noClaude = { ...p, agents: { ...p.agents, claude: { enabled: false, extraArgs: [] } } }
    expect(reconcileDefault(noClaude, cc).defaultAgent).toBe('codex')
    expect(reconcileDefault(p, null)).toBe(p)
    expect(reconcileDefault(p, new Set())).toBe(p)
    const ok = defaultAgentPrefs()
    expect(reconcileDefault(ok, cc)).toBe(ok)
  })
  it('does not mutate its input', () => {
    const p = defaultAgentPrefs()
    applyAgentUpdate(p, { op: 'permissionMode', mode: 'manual' }, null)
    expect(p.permissionMode).toBe('yolo')
  })
})

describe('launcherIds (what the menus list)', () => {
  const snap = (over: Partial<AgentsSnapshot>): AgentsSnapshot => ({
    permissionMode: 'yolo',
    defaultAgent: 'claude',
    detection: 'ready',
    detectedAt: 1,
    agents: AGENT_IDS.map((id) => ({ id, enabled: true, extraArgs: [], installed: id === 'claude' || id === 'gemini' || id === 'codex', path: null })),
    ...over
  })
  it('enabled + installed, Default first', () => {
    expect(launcherIds(snap({ defaultAgent: 'gemini' }))).toEqual(['gemini', 'claude', 'codex'])
    const s = snap({})
    s.agents.find((a) => a.id === 'codex')!.enabled = false
    expect(launcherIds(s)).toEqual(['claude', 'gemini'])
  })
  it('before detection (or when it failed) the legacy Claude/Codex launchers stay', () => {
    expect(launcherIds(null)).toEqual(['claude', 'codex'])
    expect(launcherIds(snap({ detection: 'pending' }))).toEqual(['claude', 'codex'])
    expect(launcherIds(snap({ detection: 'error', defaultAgent: 'codex' }))).toEqual(['codex', 'claude'])
  })
})

describe('docs allowlist', () => {
  it('only registry ids resolve, only to https vendor URLs', () => {
    expect(docsUrlFor('claude')).toBe('https://code.claude.com/docs/en/overview')
    expect(docsUrlFor('https://evil.example')).toBeNull()
    expect(docsUrlFor(42)).toBeNull()
    for (const id of AGENT_IDS) expect(docsUrlFor(id)).toMatch(/^https:\/\//)
  })
})

describe('terminal session restore prefs', () => {
  it('default on; absent in an older agents.json → on; typed updates only', () => {
    expect(defaultAgentPrefs()).toMatchObject({ restoreSessions: true, resumeAgents: true })
    expect(parseAgentPrefs({ version: 1, permissionMode: 'manual' })).toMatchObject({ restoreSessions: true, resumeAgents: true })
    expect(parseAgentPrefs({ restoreSessions: false, resumeAgents: 'no' })).toMatchObject({ restoreSessions: false, resumeAgents: true })
    expect(parseAgentUpdate({ op: 'restoreSessions', on: false })).toEqual({ op: 'restoreSessions', on: false })
    expect(parseAgentUpdate({ op: 'resumeAgents', on: true })).toEqual({ op: 'resumeAgents', on: true })
    expect(parseAgentUpdate({ op: 'resumeAgents', on: 'yes' })).toBeNull()
    expect(parseAgentUpdate({ op: 'restoreSessions', on: true, x: 1 })).toBeNull()
    const p = applyAgentUpdate(defaultAgentPrefs(), { op: 'resumeAgents', on: false }, null)
    expect(p).toMatchObject({ restoreSessions: true, resumeAgents: false })
  })
})
