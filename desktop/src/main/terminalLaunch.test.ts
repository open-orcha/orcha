import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  agentScript,
  buildLaunch,
  buildTermEnv,
  FALLBACK_SHELL,
  notFoundMessage,
  resolveCwd,
  resolveShell,
  shQuote
} from './terminalLaunch'

const yes = (): boolean => true
const no = (): boolean => false

describe('resolveShell', () => {
  it("uses the user's $SHELL when it is an absolute, existing, known shell", () => {
    expect(resolveShell('/bin/zsh', yes)).toBe('/bin/zsh')
    expect(resolveShell('/opt/homebrew/bin/fish', yes)).toBe('/opt/homebrew/bin/fish')
    expect(resolveShell('/usr/local/bin/bash', yes)).toBe('/usr/local/bin/bash')
  })
  it('falls back to /bin/zsh for missing, relative, unknown or non-existent shells', () => {
    expect(resolveShell(undefined, yes)).toBe(FALLBACK_SHELL)
    expect(resolveShell('zsh', yes)).toBe(FALLBACK_SHELL)
    expect(resolveShell('/usr/bin/python3', yes)).toBe(FALLBACK_SHELL)
    expect(resolveShell('/tmp/evil', yes)).toBe(FALLBACK_SHELL)
    expect(resolveShell('/bin/zsh', no)).toBe(FALLBACK_SHELL)
  })
})

describe('buildLaunch', () => {
  it('New Terminal = the login shell', () => {
    expect(buildLaunch('shell', '/bin/zsh')).toEqual({ file: '/bin/zsh', args: ['-l'] })
  })
  it('Claude / Codex = the login+interactive shell running the CLI (so .zshrc PATH applies)', () => {
    const claude = buildLaunch('claude', '/bin/zsh')
    expect(claude.file).toBe('/bin/zsh')
    expect(claude.args.slice(0, 3)).toEqual(['-l', '-i', '-c'])
    expect(claude.args[3]).toContain('exec claude')
    const codex = buildLaunch('codex', '/bin/bash')
    expect(codex.args[3]).toContain('exec codex')
    expect(codex.args[3]).not.toContain('claude')
  })
  it('never launches anything but the resolved shell', () => {
    for (const kind of ['shell', 'claude', 'codex'] as const) {
      expect(buildLaunch(kind, '/bin/zsh').file).toBe('/bin/zsh')
    }
  })
  it('agent argv (yolo flag / extra args) is single-quoted after the binary', () => {
    const plan = buildLaunch('claude', '/bin/zsh', { path: '/opt/homebrew/bin/claude', args: ['--dangerously-skip-permissions'] })
    expect(plan.args[3]).toContain(`exec '/opt/homebrew/bin/claude' '--dangerously-skip-permissions'`)
    const fish = buildLaunch('codex', '/opt/homebrew/bin/fish', { path: null, args: ['--dangerously-bypass-approvals-and-sandbox'] })
    expect(fish.args[3]).toMatch(/^if command -q codex; exec codex '--dangerously-bypass-approvals-and-sandbox'; else;/)
  })
  it('uses fish syntax for fish, plain -l -c for sh', () => {
    expect(buildLaunch('claude', '/opt/homebrew/bin/fish').args[3]).toMatch(/^if command -q claude; exec claude; else;/)
    expect(buildLaunch('claude', '/bin/sh').args.slice(0, 2)).toEqual(['-l', '-c'])
  })
})

describe('agentScript (runs under a real /bin/sh)', () => {
  const run = (script: string, pathEnv: string) =>
    spawnSync('/bin/sh', ['-c', script], { env: { PATH: pathEnv }, encoding: 'utf8' })

  it('prints a clear not-found message with the install hint and exits 127 when the CLI is missing', () => {
    const r = run(agentScript('claude', 'sh'), '/usr/bin:/bin')
    expect(r.status).toBe(127)
    expect(r.stdout).toContain('Claude Code CLI not found — install it, then Restart.')
    expect(r.stdout).toContain('npm install -g @anthropic-ai/claude-code')
    const c = run(agentScript('codex', 'sh'), '/usr/bin:/bin')
    expect(c.status).toBe(127)
    expect(c.stdout).toContain('Codex CLI not found')
  })

  it('execs the CLI when it is on PATH', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orcha-term-'))
    const fake = path.join(dir, 'claude')
    writeFileSync(fake, '#!/bin/sh\necho "fake claude ran in $(pwd)"\nexit 3\n')
    chmodSync(fake, 0o755)
    const r = run(agentScript('claude', 'sh'), `${dir}:/usr/bin:/bin`)
    expect(r.stdout).toContain('fake claude ran')
    expect(r.status).toBe(3)
  })

  it('messages match the renderer copy', () => {
    expect(notFoundMessage('claude')).toBe('Claude Code CLI not found — install it, then Restart.')
    expect(notFoundMessage('codex')).toBe('Codex CLI not found — install it, then Restart.')
  })

  it('runs the RESOLVED binary with each argument passed verbatim (one argv element each)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orcha-term-'))
    const fake = path.join(dir, 'gemini')
    writeFileSync(fake, '#!/bin/sh\nfor a in "$@"; do printf "<%s>" "$a"; done\n')
    chmodSync(fake, 0o755)
    // PATH does NOT contain dir: main's resolved absolute path is what runs.
    const r = run(agentScript('gemini', 'sh', { path: fake, args: ['--approval-mode=yolo', '--model', 'x'] }), '/usr/bin:/bin')
    expect(r.stdout).toBe('<--approval-mode=yolo><--model><x>')
  })

  it('a resolved path that vanished → the not-found message and 127 (no PATH fallback)', () => {
    const r = run(agentScript('claude', 'sh', { path: '/nonexistent/claude', args: [] }), '/usr/bin:/bin')
    expect(r.status).toBe(127)
    expect(r.stdout).toContain('Claude Code CLI not found')
  })

  it('ignores a resolved path that is not the registry binary (defence in depth)', () => {
    const s = agentScript('claude', 'sh', { path: '/bin/sh', args: [] })
    expect(s).not.toContain('/bin/sh')
    expect(s).toContain('command -v claude')
  })

  it('even a hostile argument stays one inert argv element (it is also rejected earlier)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orcha-term-'))
    const fake = path.join(dir, 'claude')
    const marker = path.join(dir, 'pwned')
    writeFileSync(fake, '#!/bin/sh\nprintf "%s|" "$@"\n')
    chmodSync(fake, 0o755)
    const r = run(agentScript('claude', 'sh', { path: fake, args: [`'; touch ${marker}; '`, '$(id)'] }), '/usr/bin:/bin')
    expect(r.stdout).toBe(`'; touch ${marker}; '|$(id)|`)
    expect(existsSync(marker)).toBe(false)
  })

  it('shQuote survives single quotes', () => {
    const r = spawnSync('/bin/sh', ['-c', `printf %s ${shQuote("it's")}`], { encoding: 'utf8' })
    expect(r.stdout).toBe("it's")
  })
})

describe('resolveCwd', () => {
  const project = { project: 'orcha-todo', projectShort: 'todo', folder: '/Users/me/todo' }
  it("uses a known project's folder when it exists", () => {
    expect(resolveCwd(project, '/Users/me', yes)).toEqual({ cwd: '/Users/me/todo', note: null })
  })
  it('falls back to $HOME with a note when no project is selected', () => {
    const r = resolveCwd(null, '/Users/me', yes)
    expect(r.cwd).toBe('/Users/me')
    expect(r.note).toMatch(/No project selected/)
  })
  it('falls back to $HOME with a note when the folder is unknown, relative or missing', () => {
    expect(resolveCwd({ ...project, folder: null }, '/Users/me', yes).cwd).toBe('/Users/me')
    expect(resolveCwd({ ...project, folder: 'relative/dir' }, '/Users/me', yes).cwd).toBe('/Users/me')
    const missing = resolveCwd(project, '/Users/me', no)
    expect(missing.cwd).toBe('/Users/me')
    expect(missing.note).toMatch(/todo’s folder isn’t on this Mac/)
  })
})

describe('buildTermEnv', () => {
  it('strips Electron internals and secrets Orcha injected; sets terminal defaults', () => {
    const env = buildTermEnv({
      PATH: '/usr/bin',
      HOME: '/Users/me',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      ORCHA_LLM_API_KEY: 'x',
      CLAUDE_CODE_ENTRYPOINT: 'y',
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_RENDERER_URL: 'http://localhost:5173',
      NODE_OPTIONS: '--inspect'
    })
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/Users/me')
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.ORCHA_LLM_API_KEY).toBeUndefined()
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined()
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(env.ELECTRON_RENDERER_URL).toBeUndefined()
    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env.TERM).toBe('xterm-256color')
    expect(env.COLORTERM).toBe('truecolor')
    expect(env.TERM_PROGRAM).toBe('Orcha')
    expect(env.LANG).toBe('en_US.UTF-8')
  })
  it('marks the pty a personal session, overriding any inherited value', () => {
    expect(buildTermEnv({ PATH: '/usr/bin' }).ORCHA_PERSONAL_SESSION).toBe('1')
    expect(buildTermEnv({ ORCHA_PERSONAL_SESSION: '0' }).ORCHA_PERSONAL_SESSION).toBe('1')
  })
  it("keeps the user's own locale", () => {
    expect(buildTermEnv({ LANG: 'de_DE.UTF-8' }).LANG).toBe('de_DE.UTF-8')
  })
})


describe('buildTermEnv COLORFGBG', () => {
  it('tells CLIs whether the terminal background is light or dark', () => {
    expect(buildTermEnv({}, 'light').COLORFGBG).toBe('0;15')
    expect(buildTermEnv({}, 'dark').COLORFGBG).toBe('15;0')
    expect(buildTermEnv({})).not.toHaveProperty('COLORFGBG')
  })
})
