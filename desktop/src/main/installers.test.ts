import { describe, it, expect, vi } from 'vitest'
import {
  appleScriptEscape,
  adminOsascriptArgs,
  homebrewPrefix,
  homebrewStep,
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

describe('homebrewPrefix', () => {
  it('is /opt/homebrew on Apple Silicon and /usr/local on Intel', () => {
    expect(homebrewPrefix('arm64')).toBe('/opt/homebrew')
    expect(homebrewPrefix('x64')).toBe('/usr/local')
  })
})

describe('homebrewStep', () => {
  it('Apple Silicon: chowns /opt/homebrew as admin, then runs the official installer as user', () => {
    const step = homebrewStep('arm64', 'alice')
    expect(step.actions[0]).toEqual({
      kind: 'admin',
      script: 'mkdir -p /opt/homebrew && chown -R alice:admin /opt/homebrew'
    })
    expect(step.actions[1].kind).toBe('user')
    expect(step.actions[1].script).toMatch(/NONINTERACTIVE=1/)
    expect(step.actions[1].script).toContain('install.sh')
    expect(step.actions.every((a) => !/sudo/.test(a.script))).toBe(true) // brew refuses root
  })

  it('Intel: owns the /usr/local subdirs as admin before the installer', () => {
    const step = homebrewStep('x64', 'bob')
    expect(step.actions[0].kind).toBe('admin')
    expect(step.actions[0].script).toContain('/usr/local/bin')
    expect(step.actions[0].script).toContain('/usr/local/Homebrew')
    expect(step.actions[1].script).toMatch(/NONINTERACTIVE=1/)
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
})

describe('planInstall', () => {
  const all: PrereqProbe = { homebrew: true, dockerEngine: true, orcha: true, claude: true, apiKey: true }
  const opts = { arch: 'arm64', user: 'alice' }

  it('returns nothing when everything is already present', () => {
    expect(planInstall(all, opts)).toEqual([])
  })

  it('emits only the missing steps, in dependency order (Homebrew first)', () => {
    const probe: PrereqProbe = { homebrew: false, dockerEngine: false, orcha: false, claude: false, apiKey: false }
    expect(planInstall(probe, opts).map((s) => s.id)).toEqual([
      'homebrew',
      'dockerEngine',
      'orcha',
      'claude',
      'apiKey'
    ])
  })

  it('skips Homebrew/engine when present but still installs the CLIs + key', () => {
    const probe: PrereqProbe = { homebrew: true, dockerEngine: true, orcha: false, claude: false, apiKey: false }
    expect(planInstall(probe, opts).map((s) => s.id)).toEqual(['orcha', 'claude', 'apiKey'])
  })
})

describe('runInstall', () => {
  const deps = (over: Partial<InstallDeps> = {}): { d: InstallDeps; events: InstallProgress[] } => {
    const events: InstallProgress[] = []
    const d: InstallDeps = {
      runUser: vi.fn(async () => undefined),
      runAdmin: vi.fn(async () => undefined),
      promptSecret: vi.fn(async () => 'sk-ant-test'),
      persistApiKey: vi.fn(async () => undefined),
      onProgress: (e) => events.push(e),
      ...over
    }
    return { d, events }
  }

  it('runs admin then user actions and reports each step ok', async () => {
    const { d, events } = deps()
    const res = await runInstall([homebrewStep('arm64', 'alice')], d)
    expect(res).toEqual({ ok: true, completed: ['homebrew'] })
    expect(d.runAdmin).toHaveBeenCalledWith('mkdir -p /opt/homebrew && chown -R alice:admin /opt/homebrew')
    expect(d.runUser).toHaveBeenCalledOnce()
    expect(events.map((e) => e.status)).toContain('ok')
  })

  it('prompts for and persists the API key', async () => {
    const { d } = deps()
    const apiKey: InstallStep = { id: 'apiKey', title: 'Anthropic API key', detail: '', actions: [] }
    const res = await runInstall([apiKey], d)
    expect(res.ok).toBe(true)
    expect(d.persistApiKey).toHaveBeenCalledWith('sk-ant-test')
  })

  it('treats a cancelled API-key prompt as a soft skip, not a failure', async () => {
    const { d, events } = deps({ promptSecret: vi.fn(async () => null) })
    const apiKey: InstallStep = { id: 'apiKey', title: 'Anthropic API key', detail: '', actions: [] }
    const res = await runInstall([apiKey], d)
    expect(res).toEqual({ ok: true, completed: [] })
    expect(d.persistApiKey).not.toHaveBeenCalled()
    expect(events.some((e) => e.status === 'skip')).toBe(true)
  })

  it('stops at the first failed step, surfacing the (trimmed) error and what completed', async () => {
    const { d, events } = deps({
      runUser: vi.fn(async () => {
        throw Object.assign(new Error('x'), { stderr: 'brew: No such formula' })
      })
    })
    const res = await runInstall([homebrewStep('arm64', 'alice'), homebrewStep('arm64', 'alice')], d)
    expect(res.ok).toBe(false)
    expect(res).toMatchObject({ failedAt: 'homebrew', completed: [] })
    if (!res.ok) expect(res.detail).toMatch(/No such formula/)
    expect(events.some((e) => e.status === 'fail')).toBe(true)
    // second step never started
    expect(events.filter((e) => e.status === 'start')).toHaveLength(1)
  })
})
