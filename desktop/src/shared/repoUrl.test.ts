import { describe, it, expect } from 'vitest'
import { validateRepoUrl } from './repoUrl'

describe('validateRepoUrl', () => {
  it('accepts a plain https GitHub repo URL', () => {
    const r = validateRepoUrl('https://github.com/open-orcha/orcha')
    expect(r).toEqual({ ok: true, url: 'https://github.com/open-orcha/orcha', host: 'github.com', repoName: 'orcha' })
  })

  it('accepts a .git-suffixed URL and strips .git from the derived repo name', () => {
    const r = validateRepoUrl('https://github.com/open-orcha/orcha.git')
    expect(r.ok).toBe(true)
    expect(r.ok && r.repoName).toBe('orcha')
  })

  it('accepts GitLab and Bitbucket hosts', () => {
    expect(validateRepoUrl('https://gitlab.com/group/proj').ok).toBe(true)
    expect(validateRepoUrl('https://bitbucket.org/team/proj').ok).toBe(true)
  })

  it('rejects empty input', () => {
    expect(validateRepoUrl('').ok).toBe(false)
    expect(validateRepoUrl('   ').ok).toBe(false)
  })

  it('rejects scp-style ssh URLs (git@host:owner/repo.git)', () => {
    expect(validateRepoUrl('git@github.com:open-orcha/orcha.git').ok).toBe(false)
  })

  it('rejects ssh:// URLs', () => {
    expect(validateRepoUrl('ssh://git@github.com/open-orcha/orcha.git').ok).toBe(false)
  })

  it('rejects plain http:// (not just https)', () => {
    expect(validateRepoUrl('http://github.com/open-orcha/orcha').ok).toBe(false)
  })

  it('rejects garbage strings without throwing', () => {
    expect(validateRepoUrl('not a url at all').ok).toBe(false)
    expect(validateRepoUrl('javascript:alert(1)').ok).toBe(false)
  })

  it('rejects unknown / unsupported hosts', () => {
    expect(validateRepoUrl('https://evil.example.com/owner/repo').ok).toBe(false)
  })

  it('rejects URLs with embedded credentials', () => {
    expect(validateRepoUrl('https://user:token@github.com/owner/repo').ok).toBe(false)
  })

  it('rejects URLs missing an owner/repo path', () => {
    expect(validateRepoUrl('https://github.com/').ok).toBe(false)
    expect(validateRepoUrl('https://github.com/onlyowner').ok).toBe(false)
  })
})
