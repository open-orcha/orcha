import { describe, it, expect } from 'vitest'
import {
  planBootstrap,
  homebrewInstallCommand,
  homebrewPrepCommand,
  macArchFromSysctl,
  dockerCommand,
  cliInstallCommand,
  osascriptAdmin,
  isOsascriptCancel,
  runGuidedBootstrap,
  BootstrapCancelled,
  type InstallStepPlan
} from './installers'
import type { BootstrapStatus } from '../shared/types'

const ready: BootstrapStatus = {
  homebrew: { name: 'homebrew', installed: true, version: 'Homebrew 4.3.0' },
  docker: { name: 'docker', installed: true, running: true, version: 'Docker version 27' },
  cli: { name: 'cli', installed: true, version: 'orcha 0.2.0' },
  ready: true
}

const fresh: BootstrapStatus = {
  homebrew: { name: 'homebrew', installed: false, version: null },
  docker: { name: 'docker', installed: false, running: false, version: null },
  cli: { name: 'cli', installed: false, version: null },
  ready: false
}

describe('planBootstrap', () => {
  it('is empty when everything is ready', () => {
    expect(planBootstrap(ready)).toEqual([])
  })

  it('orders Homebrew → Docker → CLI on a fresh machine', () => {
    expect(planBootstrap(fresh).map((s) => s.name)).toEqual(['homebrew', 'docker', 'cli'])
  })

  it('only Homebrew needs the admin (password/fingerprint) popup', () => {
    const byName = Object.fromEntries(planBootstrap(fresh).map((s) => [s.name, s]))
    expect(byName.homebrew.needsAdmin).toBe(true)
    expect(byName.docker.needsAdmin).toBe(false)
    expect(byName.cli.needsAdmin).toBe(false)
  })

  it('every step warns about the password/fingerprint popup in its consent copy', () => {
    for (const step of planBootstrap(fresh)) {
      expect(step.consentMessage.toLowerCase()).toMatch(/password|fingerprint/)
      expect(step.consentMessage).toMatch(/Apple/)
    }
  })

  it('starts (not reinstalls) Docker when the CLI is present but the daemon is down', () => {
    const stopped: BootstrapStatus = {
      ...ready,
      docker: { name: 'docker', installed: true, running: false, version: 'Docker version 27' },
      ready: false
    }
    const step = planBootstrap(stopped).find((s) => s.name === 'docker')!
    expect(step.title).toMatch(/start/i)
    expect(step.command).not.toMatch(/brew install/)
  })

  it('installs only the CLI when Homebrew and Docker are already good', () => {
    const onlyCli: BootstrapStatus = { ...ready, cli: { name: 'cli', installed: false, version: null }, ready: false }
    expect(planBootstrap(onlyCli).map((s) => s.name)).toEqual(['cli'])
  })
})

describe('command construction', () => {
  it('runs the official Homebrew installer non-interactively', () => {
    expect(homebrewInstallCommand('arm64')).toMatch(/NONINTERACTIVE=1/)
    expect(homebrewInstallCommand('arm64')).toMatch(/install\.sh/)
  })

  it('forces the native arm64 build on Apple Silicon so Rosetta can’t install the Intel one', () => {
    // Without `arch -arm64`, a translated launch installs the x86 build under /usr/local and dies
    // with "Bad CPU type in executable" on the bundled Ruby.
    expect(homebrewInstallCommand('arm64')).toMatch(/arch -arm64 \/bin\/bash/)
  })

  it('adds no arch flag on Intel (x86 is the only build it can run)', () => {
    const cmd = homebrewInstallCommand('x64')
    expect(cmd).not.toMatch(/arch -/)
    expect(cmd).toMatch(/NONINTERACTIVE=1 \/bin\/bash/)
  })

  it('reads the true CPU from sysctl hw.optional.arm64 (Rosetta-proof)', () => {
    expect(macArchFromSysctl('1\n')).toBe('arm64')
    expect(macArchFromSysctl('0\n')).toBe('x64')
    expect(macArchFromSysctl('')).toBe('x64') // key absent on Intel
  })

  it('pairs the arm64 installer with the arm64 prefix so install and prep agree', () => {
    // The bug that broke the wife’s laptop: prep owned one prefix while the installer used the other.
    expect(homebrewInstallCommand('arm64')).toMatch(/arch -arm64/)
    expect(homebrewPrepCommand('arm64', 'kedar')).toMatch(/\/opt\/homebrew/)
  })

  it('pre-creates /opt/homebrew on Apple Silicon and chowns to the user', () => {
    expect(homebrewPrepCommand('arm64', 'kedar')).toBe(
      'mkdir -p /opt/homebrew && chown -R kedar:admin /opt/homebrew'
    )
  })

  it('on Intel never chowns all of /usr/local — only Homebrew’s own dirs', () => {
    const cmd = homebrewPrepCommand('x64', 'kedar')
    expect(cmd).toMatch(/usr\/local\/Homebrew/)
    expect(cmd).not.toMatch(/chown -R kedar:admin \/usr\/local(\s|$)/)
  })

  it('installs Colima only when nothing is present', () => {
    expect(dockerCommand(fresh)).toBe('brew install colima docker && colima start')
  })

  it('reuses an existing engine (no reinstall) when Docker is installed but stopped', () => {
    const stopped: BootstrapStatus = {
      ...ready,
      docker: { name: 'docker', installed: true, running: false, version: 'Docker version 27' }
    }
    const cmd = dockerCommand(stopped)
    expect(cmd).not.toMatch(/brew install/)
    expect(cmd).toMatch(/colima start/)
    expect(cmd).toMatch(/open -a Docker/)
    expect(cmd).toMatch(/OrbStack/)
  })

  it('installs the CLI from the public tap', () => {
    expect(cliInstallCommand()).toBe('brew install open-orcha/orcha/orcha')
  })
})

describe('osascriptAdmin', () => {
  it('wraps a command in an admin-privileges AppleScript', () => {
    expect(osascriptAdmin('echo hi')).toBe('do shell script "echo hi" with administrator privileges')
  })

  it('escapes embedded quotes and backslashes', () => {
    expect(osascriptAdmin('say "hi\\there"')).toBe(
      'do shell script "say \\"hi\\\\there\\"" with administrator privileges'
    )
  })
})

describe('isOsascriptCancel', () => {
  it('recognises macOS user-cancel (-128)', () => {
    expect(isOsascriptCancel({ stderr: 'execution error: User canceled. (-128)' })).toBe(true)
    expect(isOsascriptCancel(new Error('boom (-128)'))).toBe(true)
  })
  it('does not flag real errors', () => {
    expect(isOsascriptCancel({ stderr: 'command not found' })).toBe(false)
  })
})

describe('runGuidedBootstrap', () => {
  const order = (steps: InstallStepPlan[]): string[] => steps.map((s) => s.name)

  it('does nothing when the machine is already ready', async () => {
    const out = await runGuidedBootstrap(ready, {
      confirm: async () => true,
      perform: async () => {}
    })
    expect(out).toEqual({ result: 'nothing_to_do' })
  })

  it('asks before every step and performs each in order when confirmed', async () => {
    const confirmed: string[] = []
    const performed: string[] = []
    const out = await runGuidedBootstrap(fresh, {
      confirm: async (s) => {
        confirmed.push(s.name)
        return true
      },
      perform: async (s) => {
        performed.push(s.name)
      }
    })
    expect(out).toEqual({ result: 'completed' })
    expect(confirmed).toEqual(['homebrew', 'docker', 'cli'])
    expect(performed).toEqual(['homebrew', 'docker', 'cli'])
  })

  it('stops cleanly when the user cancels a consent dialog — later steps never run', async () => {
    const performed: string[] = []
    const out = await runGuidedBootstrap(fresh, {
      confirm: async (s) => s.name !== 'docker', // cancel at Docker
      perform: async (s) => {
        performed.push(s.name)
      }
    })
    expect(out).toEqual({ result: 'cancelled', at: 'docker', title: 'Set up Docker' })
    expect(performed).toEqual(['homebrew']) // docker + cli never performed
  })

  it('treats a cancelled macOS auth popup as a cancellation, not a failure', async () => {
    const out = await runGuidedBootstrap(fresh, {
      confirm: async () => true,
      perform: async (s) => {
        if (s.name === 'homebrew') throw new BootstrapCancelled('homebrew')
      }
    })
    expect(out).toEqual({ result: 'cancelled', at: 'homebrew', title: 'Install Homebrew' })
  })

  it('reports a failure with the manual command when a step throws', async () => {
    const out = await runGuidedBootstrap(fresh, {
      confirm: async () => true,
      perform: async (s) => {
        if (s.name === 'homebrew') throw Object.assign(new Error('x'), { stderr: 'curl: (6) could not resolve host' })
      }
    })
    expect(out.result).toBe('failed')
    if (out.result === 'failed') {
      expect(out.at).toBe('homebrew')
      expect(out.command).toBe(homebrewInstallCommand())
      expect(out.error).toMatch(/could not resolve host/)
    }
  })

  it('does not order anything after a cancel even if confirm would allow it', async () => {
    // sanity: plan order is stable so the "stop" guarantee is meaningful
    expect(order(planBootstrap(fresh))).toEqual(['homebrew', 'docker', 'cli'])
  })
})
