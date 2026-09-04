import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ghAuthToken, ghIsAuthenticated, ghListRepos, defaultClonesParent, resolveCloneDest } from './githubSource'
import type { Exec } from './dockerExec'

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), 'orcha-gh-'))
}

describe('ghIsAuthenticated', () => {
  it('true when `gh auth status` exits 0', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '' }) as unknown as Exec
    expect(await ghIsAuthenticated(exec)).toBe(true)
  })

  it('false when gh is missing or logged out (never throws)', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('ENOENT')) as unknown as Exec
    expect(await ghIsAuthenticated(exec)).toBe(false)
  })
})

describe('ghAuthToken', () => {
  it('returns the trimmed token when `gh auth token` succeeds', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'gho_abc123\n' }) as unknown as Exec
    expect(await ghAuthToken(exec)).toBe('gho_abc123')
    expect(exec).toHaveBeenCalledWith('gh', ['auth', 'token'])
  })

  it('returns null (never throws) when gh is missing or logged out', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('ENOENT')) as unknown as Exec
    expect(await ghAuthToken(exec)).toBeNull()
  })

  it('returns null on empty output', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '   \n' }) as unknown as Exec
    expect(await ghAuthToken(exec)).toBeNull()
  })
})

describe('ghListRepos', () => {
  it('parses the gh repo list JSON output', async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify([
        { nameWithOwner: 'open-orcha/orcha', description: 'The orcha CLI' },
        { nameWithOwner: 'acme/widgets', description: null }
      ])
    }) as unknown as Exec
    expect(await ghListRepos(exec)).toEqual([
      { nameWithOwner: 'open-orcha/orcha', description: 'The orcha CLI' },
      { nameWithOwner: 'acme/widgets', description: null }
    ])
  })

  it('returns [] (not a throw) on failure', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('not authenticated')) as unknown as Exec
    expect(await ghListRepos(exec)).toEqual([])
  })

  it('returns [] on malformed JSON', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'not json' }) as unknown as Exec
    expect(await ghListRepos(exec)).toEqual([])
  })
})

describe('defaultClonesParent', () => {
  it('falls back to ~/orcha-projects when no stack folders are known', () => {
    expect(defaultClonesParent([], '/Users/x')).toBe('/Users/x/orcha-projects')
    expect(defaultClonesParent([null, null], '/Users/x')).toBe('/Users/x/orcha-projects')
  })

  it('picks the most common parent directory among existing stacks', () => {
    const parent = defaultClonesParent(
      ['/Users/x/dev/a', '/Users/x/dev/b', '/Users/x/other/c'],
      '/Users/x'
    )
    expect(parent).toBe('/Users/x/dev')
  })
})

describe('resolveCloneDest', () => {
  it('resolves <parent>/<sanitized-repo-name>', () => {
    const parent = tmp()
    try {
      expect(resolveCloneDest(parent, 'My Repo')).toBe(path.join(parent, 'my-repo'))
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('refuses a non-empty existing destination', () => {
    const parent = tmp()
    mkdirSync(path.join(parent, 'taken'))
    writeFileSync(path.join(parent, 'taken', 'f'), 'x')
    try {
      expect(() => resolveCloneDest(parent, 'taken')).toThrow()
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('allows an empty existing destination dir', () => {
    const parent = tmp()
    mkdirSync(path.join(parent, 'empty-dir'))
    try {
      expect(resolveCloneDest(parent, 'empty-dir')).toBe(path.join(parent, 'empty-dir'))
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })
})
