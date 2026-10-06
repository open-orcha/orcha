import { describe, it, expect } from 'vitest'
import { dockerExecWithTimeout, dockerPath, killPendingProbes } from './dockerExec'

describe('dockerPath', () => {
  it('prepends common Docker install locations to the inherited PATH', () => {
    const path = dockerPath({ PATH: '/usr/bin:/bin' }, '/Users/me')
    const parts = path.split(':')
    expect(parts).toContain('/opt/homebrew/bin')
    expect(parts).toContain('/usr/local/bin')
    expect(parts).toContain('/Applications/Docker.app/Contents/Resources/bin')
    expect(parts).toContain('/Users/me/.orbstack/bin')
    // inherited entries are preserved, after the candidates
    expect(parts).toContain('/usr/bin')
    expect(parts.indexOf('/opt/homebrew/bin')).toBeLessThan(parts.indexOf('/usr/bin'))
  })

  it('works when the Finder-launched PATH is empty', () => {
    const path = dockerPath({}, '/Users/me')
    expect(path.split(':')).toContain('/opt/homebrew/bin')
  })

  it('de-duplicates a candidate that is already on PATH', () => {
    const path = dockerPath({ PATH: '/usr/local/bin:/usr/bin' }, '/Users/me')
    const parts = path.split(':')
    expect(parts.filter((p) => p === '/usr/local/bin')).toHaveLength(1)
  })
})

describe('dockerExecWithTimeout (a hung docker CLI must settle, audit BLOCKER)', () => {
  it('kills the child and rejects with timedOut after the ceiling', async () => {
    const exec = dockerExecWithTimeout(150)
    const started = Date.now()
    await expect(exec('sleep', ['5'])).rejects.toMatchObject({ timedOut: true })
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('resolves normally for a fast command', async () => {
    await expect(dockerExecWithTimeout(2000)('echo', ['ok'])).resolves.toEqual({ stdout: 'ok\n' })
  })

  it('killPendingProbes kills an in-flight probe (no orphan on quit)', async () => {
    const p = dockerExecWithTimeout(10_000)('sleep', ['5'])
    killPendingProbes()
    await expect(p).rejects.toBeTruthy()
  })
})
