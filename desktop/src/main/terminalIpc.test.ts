import { describe, it, expect, vi } from 'vitest'
import { acceptTermSender, closeAction, createTermController, resolveCheckout, TermRequestError, type SenderFacts, type TermControllerHooks } from './terminalIpc'
import type { GitWorktree } from './checkouts'
import type { PtyHost } from './ptyHost'

const host: SenderFacts = { isHostRenderer: true, isMainFrame: true }
const portalView: SenderFacts = { isHostRenderer: false, isMainFrame: true }
const subFrame: SenderFacts = { isHostRenderer: true, isMainFrame: false }

const wt = (path: string, branch: string | null): GitWorktree => ({ path, branch, head: 'abc', detached: branch === null, bare: false })

function setup(opts: { dirs?: string[]; worktrees?: GitWorktree[] | null; hooks?: TermControllerHooks } = {}) {
  const dirs = new Set(opts.dirs ?? ['/Users/me/todo'])
  const created: unknown[] = []
  const fakeHost = {
    create: vi.fn((spec: Record<string, unknown>) => {
      created.push(spec)
      return { id: 1, kind: spec.kind, project: spec.project, cwd: spec.cwd, shell: 'zsh', note: spec.note }
    }),
    write: vi.fn(() => true),
    resize: vi.fn(() => true),
    kill: vi.fn(() => true),
    list: vi.fn(() => [])
  }
  const ctl = createTermController({
    host: fakeHost as unknown as PtyHost,
    listProjects: async () => [
      { project: 'orcha-todo', projectShort: 'todo', folder: '/Users/me/todo' },
      { project: 'orcha-gone', projectShort: 'gone', folder: '/Users/me/deleted' }
    ],
    env: { SHELL: '/bin/zsh', PATH: '/usr/bin', ANTHROPIC_API_KEY: 'secret' },
    home: '/Users/me',
    exists: (p) => p === '/bin/zsh',
    isDir: (p) => dirs.has(p),
    ...(opts.worktrees !== undefined ? { readWorktrees: async () => opts.worktrees ?? null } : {}),
    ...(opts.hooks !== undefined ? { hooks: opts.hooks, agentLaunch: (_id: string, probe: boolean) => ({ path: null, args: probe ? ['--version'] : ['--dangerously-skip-permissions'] }) } : {})
  })
  return { ctl, fakeHost, created }
}

const req = { kind: 'shell', project: 'orcha-todo', cols: 80, rows: 24 }

describe('acceptTermSender', () => {
  it('only the host renderer main frame may use the pty bridge', () => {
    expect(acceptTermSender(host)).toBe(true)
    expect(acceptTermSender(portalView)).toBe(false) // embedded portal (remote origin) / tray
    expect(acceptTermSender(subFrame)).toBe(false)
  })
})

describe('term controller', () => {
  it('rejects every call from the embedded portal / a sub-frame', async () => {
    const { ctl, fakeHost } = setup()
    await expect(ctl.create(portalView, req)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(ctl.create(subFrame, req)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(() => ctl.list(portalView)).toThrow(TermRequestError)
    expect(() => ctl.kill(portalView, 1)).toThrow(TermRequestError)
    expect(ctl.write(portalView, { id: 1, data: 'rm -rf ~\r' })).toBe(false)
    expect(ctl.resize(portalView, { id: 1, cols: 10, rows: 10 })).toBe(false)
    expect(fakeHost.create).not.toHaveBeenCalled()
    expect(fakeHost.write).not.toHaveBeenCalled()
  })

  it('rejects unknown kinds and smuggled paths/argv before spawning', async () => {
    const { ctl, fakeHost } = setup()
    for (const bad of [
      { ...req, kind: 'python' },
      { ...req, project: '/etc' },
      { ...req, cwd: '/' },
      { ...req, file: '/bin/sh', args: ['-c', 'id'] }
    ]) {
      await expect(ctl.create(host, bad)).rejects.toMatchObject({ code: 'INVALID' })
    }
    expect(fakeHost.create).not.toHaveBeenCalled()
  })

  it('rejects a well-formed but unknown project (not in discovery)', async () => {
    const { ctl } = setup()
    await expect(ctl.create(host, { ...req, project: 'orcha-nope' })).rejects.toMatchObject({ code: 'UNKNOWN_STACK' })
  })

  it("spawns the login shell in the project's folder with a scrubbed env", async () => {
    const { ctl, created } = setup()
    await ctl.create(host, req)
    expect(created[0]).toMatchObject({ kind: 'shell', file: '/bin/zsh', args: ['-l'], cwd: '/Users/me/todo', note: null, project: 'orcha-todo' })
    expect((created[0] as { env: Record<string, string> }).env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('shell and agent tabs alike carry the personal-session marker', async () => {
    const { ctl, created } = setup()
    await ctl.create(host, req)
    await ctl.create(host, { ...req, kind: 'claude' })
    await ctl.create(host, { ...req, kind: 'codex' })
    for (const spec of created) expect((spec as { env: Record<string, string> }).env.ORCHA_PERSONAL_SESSION).toBe('1')
  })

  it('Claude/Codex launch the CLI through the login shell', async () => {
    const { ctl, created } = setup()
    await ctl.create(host, { ...req, kind: 'claude' })
    await ctl.create(host, { ...req, kind: 'codex' })
    expect((created[0] as { args: string[] }).args.join(' ')).toContain('exec claude')
    expect((created[1] as { args: string[] }).args.join(' ')).toContain('exec codex')
  })

  it('falls back to $HOME (with a note) for no project or a missing folder', async () => {
    const { ctl, created } = setup()
    await ctl.create(host, { ...req, project: null })
    await ctl.create(host, { ...req, project: 'orcha-gone' })
    expect(created[0]).toMatchObject({ cwd: '/Users/me', project: null })
    expect((created[0] as { note: string }).note).toMatch(/home folder/)
    expect(created[1]).toMatchObject({ cwd: '/Users/me', project: 'orcha-gone' })
  })

  it('validates write/resize/kill payloads', () => {
    const { ctl, fakeHost } = setup()
    expect(ctl.write(host, { id: 1, data: 'ls\r' })).toBe(true)
    expect(ctl.write(host, { id: 'x', data: 'ls' })).toBe(false)
    expect(ctl.resize(host, { id: 1, cols: 0, rows: 5 })).toBe(false)
    expect(() => ctl.kill(host, 'all')).toThrow(TermRequestError)
    expect(ctl.kill(host, 1)).toBe(true)
    expect(fakeHost.write).toHaveBeenCalledTimes(1)
  })

  it('reports spawn failures as SPAWN_FAILED with the message', async () => {
    const { ctl, fakeHost } = setup()
    fakeHost.create.mockImplementationOnce(() => {
      throw new Error('posix_spawnp failed.')
    })
    await expect(ctl.create(host, req)).rejects.toMatchObject({ code: 'SPAWN_FAILED', message: 'posix_spawnp failed.' })
  })
})

describe('closeAction (⌘W)', () => {
  const all = { focusedIsManager: true, managerContentsFocused: true, termFocused: true }
  it('closes the tab only with focus inside the terminal dock of the manager window', () => {
    expect(closeAction(all)).toBe('tab')
  })
  it('closes the window when the portal view, another window or non-terminal host chrome has focus', () => {
    expect(closeAction({ ...all, managerContentsFocused: false })).toBe('window') // portal view focused
    expect(closeAction({ ...all, focusedIsManager: false })).toBe('window') // tray popover etc.
    expect(closeAction({ ...all, termFocused: false })).toBe('window')
  })
})

describe('sessions in a branch checkout (sidebar branch row → New Terminal)', () => {
  const trees = [wt('/Users/me/todo', 'main'), wt('/Users/me/todo-wt/feat-x', 'feat/x')]

  it('resolveCheckout: the project folder is its own branch; a requested branch maps to its worktree', () => {
    const isDir = (p: string): boolean => p.startsWith('/Users/me/')
    expect(resolveCheckout('/Users/me/todo', null, trees, isDir)).toEqual({ cwd: '/Users/me/todo', branch: 'main' })
    expect(resolveCheckout('/Users/me/todo/', null, trees, isDir)).toEqual({ cwd: '/Users/me/todo/', branch: 'main' })
    expect(resolveCheckout('/Users/me/todo', 'feat/x', trees, isDir)).toEqual({ cwd: '/Users/me/todo-wt/feat-x', branch: 'feat/x' })
    expect(resolveCheckout('/Users/me/todo', 'nope', trees, isDir)).toBeNull()
    expect(resolveCheckout('/Users/me/todo', 'feat/x', trees, () => false)).toBeNull() // worktree dir gone
    expect(resolveCheckout('/Users/me/todo', null, null, isDir)).toEqual({ cwd: '/Users/me/todo', branch: null })
  })

  it('create: starts in the branch worktree main found (never a renderer path) and reports the branch', async () => {
    const { ctl, created } = setup({ dirs: ['/Users/me/todo', '/Users/me/todo-wt/feat-x'], worktrees: trees })
    await ctl.create(host, { ...req, branch: 'feat/x' })
    expect(created[0]).toMatchObject({ cwd: '/Users/me/todo-wt/feat-x', branch: 'feat/x' })
    await ctl.create(host, req)
    expect(created[1]).toMatchObject({ cwd: '/Users/me/todo', branch: 'main' })
  })

  it('create: an unknown branch is refused (UNKNOWN_BRANCH), and so is a branch without a project', async () => {
    const { ctl, fakeHost } = setup({ worktrees: trees })
    await expect(ctl.create(host, { ...req, branch: 'gone' })).rejects.toMatchObject({ code: 'UNKNOWN_BRANCH' })
    await expect(ctl.create(host, { ...req, project: null, branch: 'main' })).rejects.toMatchObject({ code: 'INVALID' })
    await expect(ctl.create(host, { ...req, branch: '../../etc' })).rejects.toMatchObject({ code: 'INVALID' })
    await expect(ctl.create(host, { ...req, branch: '--upload-pack=x' })).rejects.toMatchObject({ code: 'INVALID' })
    expect(fakeHost.create).not.toHaveBeenCalled()
  })

  it('create: the project folder is missing (home fallback) → a requested branch is refused', async () => {
    const { ctl } = setup({ dirs: [], worktrees: trees })
    await expect(ctl.create(host, { ...req, branch: 'main' })).rejects.toMatchObject({ code: 'UNKNOWN_BRANCH' })
  })
})

describe('agent hooks wiring', () => {
  const hooks: TermControllerHooks = {
    endpointFile: '/ud/agent-hooks/endpoint.env',
    wire: (id, args, probe) => (id === 'claude' && !probe ? { args: ['--settings', '/ud/s.json', ...args], mode: 'lifecycle' } : null)
  }

  it('a hooked agent launch gets the hook argv first (mode flags kept) and hook routing for the pty env', async () => {
    const { ctl, created } = setup({ hooks })
    await ctl.create(host, { ...req, kind: 'claude' })
    const spec = created[0] as { args: string[]; hooks: unknown; env: Record<string, string> }
    expect(spec.hooks).toEqual({ mode: 'lifecycle', endpointFile: '/ud/agent-hooks/endpoint.env' })
    expect(spec.args.at(-1)).toContain(`'--settings' '/ud/s.json' '--dangerously-skip-permissions'`)
    expect(spec.env.ORCHA_TERM_ID).toBeUndefined() // ptyHost adds it with the id it mints
  })

  it('shells, probes, unhooked agents and a missing receiver launch without hooks', async () => {
    const { ctl, created } = setup({ hooks })
    await ctl.create(host, req)
    await ctl.create(host, { ...req, kind: 'claude', probe: true })
    await ctl.create(host, { ...req, kind: 'codex' })
    for (const spec of created) expect((spec as { hooks?: unknown }).hooks).toBeUndefined()
    const off = setup({ hooks: null })
    await off.ctl.create(host, { ...req, kind: 'claude' })
    expect((off.created[0] as { hooks?: unknown }).hooks).toBeUndefined()
    expect((off.created[0] as { args: string[] }).args.at(-1)).not.toContain('--settings')
  })
})
