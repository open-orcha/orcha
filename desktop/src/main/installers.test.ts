import { describe, it, expect, vi } from 'vitest'
import {
  appleScriptEscape,
  adminOsascriptArgs,
  orchaCliStep,
  planInstall,
  runInstall,
  type InstallDeps
} from './installers'
import type { InstallProgress, InstallStep, PrereqProbe } from '../shared/types'

describe('appleScriptEscape', () => {
  it('escapes backslashes before quotes so the result is valid AppleScript', () => {
    expect(appleScriptEscape('a "b" c')).toBe('a \\"b\\" c')
    expect(appleScriptEscape('path\\to')).toBe('path\\\\to')
    // a quote already preceded by a backslash: both get escaped, not collapsed
    expect(appleScriptEscape('x\\"y')).toBe('x\\\\\\"y')
  })
})

describe('adminOsascriptArgs', () => {
  it('wraps the script in a do-shell-script-with-admin one-liner', () => {
    expect(adminOsascriptArgs('mkdir -p /opt/homebrew')).toEqual([
      '-e',
      'do shell script "mkdir -p /opt/homebrew" with administrator privileges'
    ])
  })
})

describe('orchaCliStep', () => {
  it('taps the formula repo BEFORE installing (user/repo/formula does not auto-tap)', () => {
    const step = orchaCliStep()
    const script = step.actions[0].script
    expect(script).toContain('brew tap open-orcha/orcha')
    expect(script).toContain('brew install open-orcha/orcha/orcha')
    // tap must come before install
    expect(script.indexOf('brew tap')).toBeLessThan(script.indexOf('brew install'))
  })

  it('trusts the tap between tap and install, guarded for older brew without the subcommand', () => {
    const script = orchaCliStep().actions[0].script
    expect(script).toContain('brew trust open-orcha/orcha')
    // trust must sit AFTER the tap and BEFORE the install
    expect(script.indexOf('brew tap')).toBeLessThan(script.indexOf('brew trust'))
    expect(script.indexOf('brew trust')).toBeLessThan(script.indexOf('brew install'))
    // and must not abort the chain on an older brew that lacks `trust`
    expect(script).toContain('|| true')
  })
})

describe('planInstall', () => {
  const all: PrereqProbe = { homebrew: false, dockerEngine: false, orcha: true, claude: true, codex: true }

  it('returns nothing when everything is already present', () => {
    expect(planInstall(all)).toEqual([])
  })

  it('never plans Homebrew or a Docker engine (GH #258: projects run natively)', () => {
    const probe: PrereqProbe = { homebrew: false, dockerEngine: false, orcha: false, claude: false, codex: false }
    expect(planInstall(probe).map((s) => s.id)).toEqual(['orcha', 'claude'])
  })

  it('never plans an API-key step: keys live on each project (Settings › API keys)', () => {
    expect(planInstall({ ...all, codex: false })).toEqual([])
  })
})

describe('runInstall', () => {
  const deps = (over: Partial<InstallDeps> = {}): { d: InstallDeps; events: InstallProgress[] } => {
    const events: InstallProgress[] = []
    const d: InstallDeps = {
      runUser: vi.fn(async () => undefined),
      runAdmin: vi.fn(async () => undefined),
      onProgress: (e) => events.push(e),
      ...over
    }
    return { d, events }
  }

  it('runs admin then user actions and reports each step ok', async () => {
    const { d, events } = deps()
    const step: InstallStep = {
      id: 'orcha',
      title: 'Orcha helper',
      detail: '',
      actions: [
        { kind: 'admin', script: 'mkdir -p /opt/x' },
        { kind: 'user', script: 'echo hi' }
      ]
    }
    const res = await runInstall([step], d)
    expect(res).toEqual({ ok: true, completed: ['orcha'] })
    expect(d.runAdmin).toHaveBeenCalledWith('mkdir -p /opt/x')
    expect(d.runUser).toHaveBeenCalledOnce()
    expect(events.map((e) => e.status)).toContain('ok')
  })

  it('stops at the first failed step, surfacing the (trimmed) error and what completed', async () => {
    const { d, events } = deps({
      runUser: vi.fn(async () => {
        throw Object.assign(new Error('x'), { stderr: 'brew: No such formula' })
      })
    })
    const res = await runInstall([orchaCliStep(), orchaCliStep()], d)
    expect(res.ok).toBe(false)
    expect(res).toMatchObject({ failedAt: 'orcha', completed: [] })
    if (!res.ok) expect(res.detail).toMatch(/No such formula/)
    expect(events.some((e) => e.status === 'fail')).toBe(true)
    // second step never started
    expect(events.filter((e) => e.status === 'start')).toHaveLength(1)
  })
})
