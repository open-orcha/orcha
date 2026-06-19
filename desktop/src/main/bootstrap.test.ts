import { describe, it, expect } from 'vitest'
import { checkDependencies, installPlan } from './bootstrap'
import type { Exec } from './dockerExec'
import type { BootstrapStatus } from '../shared/types'

/** Build a fake exec driven by a map of "<cmd> <arg0>" → stdout. Missing keys throw (tool
 *  absent / command fails), mirroring execFile's reject-on-nonzero-exit behaviour. */
function fakeExec(table: Record<string, string>): Exec {
  return (cmd, args) => {
    const key = `${cmd} ${args[0] ?? ''}`.trim()
    if (key in table) return Promise.resolve({ stdout: table[key] })
    return Promise.reject(Object.assign(new Error(`not found: ${key}`), { stderr: '' }))
  }
}

describe('checkDependencies', () => {
  it('reports everything present and Docker up as ready', async () => {
    const exec = fakeExec({
      'brew --version': 'Homebrew 4.3.0\n',
      'docker --version': 'Docker version 27.0.3, build abc\n',
      'docker info': '27.0.3\n',
      'orcha --version': 'orcha 0.2.0\n'
    })
    const status = await checkDependencies(exec)
    expect(status.homebrew).toEqual({ name: 'homebrew', installed: true, version: 'Homebrew 4.3.0' })
    expect(status.docker.installed).toBe(true)
    expect(status.docker.running).toBe(true)
    expect(status.docker.version).toBe('Docker version 27.0.3, build abc')
    expect(status.cli).toEqual({ name: 'cli', installed: true, version: 'orcha 0.2.0' })
    expect(status.ready).toBe(true)
  })

  it('treats Docker CLI present but daemon down as not ready', async () => {
    const exec = fakeExec({
      'docker --version': 'Docker version 27.0.3, build abc\n',
      'orcha --version': 'orcha 0.2.0\n'
      // no `docker info` key → daemon unreachable
    })
    const status = await checkDependencies(exec)
    expect(status.docker.installed).toBe(true)
    expect(status.docker.running).toBe(false)
    expect(status.ready).toBe(false)
  })

  it('reports a fresh machine with nothing installed', async () => {
    const status = await checkDependencies(fakeExec({}))
    expect(status.homebrew.installed).toBe(false)
    expect(status.docker.installed).toBe(false)
    expect(status.docker.running).toBe(false)
    expect(status.cli.installed).toBe(false)
    expect(status.ready).toBe(false)
  })

  it('is not ready when the CLI is missing even if Docker is up', async () => {
    const exec = fakeExec({
      'docker --version': 'Docker version 27.0.3\n',
      'docker info': '27.0.3\n'
    })
    const status = await checkDependencies(exec)
    expect(status.docker.running).toBe(true)
    expect(status.cli.installed).toBe(false)
    expect(status.ready).toBe(false)
  })
})

describe('installPlan', () => {
  const base: BootstrapStatus = {
    homebrew: { name: 'homebrew', installed: true, version: 'Homebrew 4.3.0' },
    docker: { name: 'docker', installed: true, running: true, version: 'Docker version 27' },
    cli: { name: 'cli', installed: true, version: 'orcha 0.2.0' },
    ready: true
  }

  it('is empty when everything is ready', () => {
    expect(installPlan(base)).toEqual([])
  })

  it('proposes Homebrew, Docker and CLI installs on a fresh machine', () => {
    const fresh: BootstrapStatus = {
      homebrew: { name: 'homebrew', installed: false, version: null },
      docker: { name: 'docker', installed: false, running: false, version: null },
      cli: { name: 'cli', installed: false, version: null },
      ready: false
    }
    const names = installPlan(fresh).map((s) => s.name)
    expect(names).toEqual(['homebrew', 'docker', 'cli'])
  })

  it('proposes starting (not installing) Docker when the CLI is present but the daemon is down', () => {
    const stopped: BootstrapStatus = {
      ...base,
      docker: { name: 'docker', installed: true, running: false, version: 'Docker version 27' },
      ready: false
    }
    const step = installPlan(stopped).find((s) => s.name === 'docker')
    expect(step?.label).toMatch(/start/i)
  })
})
