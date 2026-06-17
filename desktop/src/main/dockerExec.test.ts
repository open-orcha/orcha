import { describe, it, expect } from 'vitest'
import { dockerPath } from './dockerExec'

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
