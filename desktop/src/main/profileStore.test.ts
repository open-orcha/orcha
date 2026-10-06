import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pickSelf, profileFilePath, readProfileName, renameSelfInProjects, writeProfileName } from './profileStore'
import { normalizeProfileName, profileState } from '../shared/profile'

describe('normalizeProfileName / profileState', () => {
  it('trims and collapses whitespace; blank clears', () => {
    expect(normalizeProfileName('  Hussein   Abdinoor ')).toBe('Hussein Abdinoor')
    expect(normalizeProfileName('   ')).toBeNull()
    expect(normalizeProfileName(null)).toBeNull()
  })
  it('rejects non-strings and over-long names', () => {
    expect(() => normalizeProfileName(42)).toThrow()
    expect(() => normalizeProfileName('x'.repeat(65))).toThrow()
  })
  it('falls back to the Mac name', () => {
    expect(profileState(null, 'hm')).toEqual({ name: null, deviceName: 'hm', effective: 'hm' })
    expect(profileState('Hussein', 'hm').effective).toBe('Hussein')
  })
})

describe('readProfileName / writeProfileName', () => {
  let dir = ''
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

  it('round-trips and clears', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'orcha-profile-'))
    expect(readProfileName(dir)).toBeNull()
    writeProfileName(dir, 'Hussein')
    expect(readProfileName(dir)).toBe('Hussein')
    writeProfileName(dir, null)
    expect(readProfileName(dir)).toBeNull()
  })
  it('treats a malformed file as no name', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'orcha-profile-'))
    writeFileSync(profileFilePath(dir), '{nope')
    expect(readProfileName(dir)).toBeNull()
  })
})

describe('pickSelf', () => {
  const ai = { id: 'a', kind: 'ai', alias: 'atlas' }
  it('prefers the human still carrying the previous name (case-insensitive)', () => {
    const me = { id: 'h1', kind: 'human', alias: 'HM' }
    expect(pickSelf([ai, { id: 'h2', kind: 'human', alias: 'kedar' }, me], 'hm')).toBe(me)
  })
  it('falls back to the only live human', () => {
    const me = { id: 'h1', kind: 'human', alias: 'renamed' }
    expect(pickSelf([ai, me, { id: 'h0', kind: 'human', alias: 'gone', status: 'terminated' }], 'hm')).toBe(me)
  })
  it('gives up when several humans and none match', () => {
    expect(pickSelf([{ id: 'h1', kind: 'human', alias: 'x' }, { id: 'h2', kind: 'human', alias: 'y' }], 'hm')).toBeNull()
  })
})

describe('renameSelfInProjects', () => {
  const roster = (agents: unknown[]) =>
    vi.fn(async (_port: number, p: string, method: string) => {
      if (method === 'PATCH') return {}
      if (p === '/api/containers') return { containers: [{ id: 'c1' }] }
      return { agents }
    })

  it('PATCHes your human as its own actor', async () => {
    const request = roster([{ id: 'h1', kind: 'human', alias: 'hm' }])
    const out = await renameSelfInProjects({ stacks: [{ projectShort: 'todo', apiPort: 9000 }], request }, 'hm', 'Hussein')
    expect(out).toEqual([{ project: 'todo', status: 'renamed' }])
    expect(request).toHaveBeenCalledWith(9000, '/api/agents/h1', 'PATCH', { actor_agent_id: 'h1', alias: 'Hussein' })
  })

  it('reports unchanged, skipped and a taken name per project', async () => {
    const same = roster([{ id: 'h1', kind: 'human', alias: 'Hussein' }])
    expect((await renameSelfInProjects({ stacks: [{ projectShort: 'a', apiPort: 1 }], request: same }, 'hm', 'Hussein'))[0].status).toBe('unchanged')
    const none = roster([])
    expect((await renameSelfInProjects({ stacks: [{ projectShort: 'b', apiPort: 2 }], request: none }, 'hm', 'Hussein'))[0].status).toBe('skipped')
    const taken = vi.fn(async (_p: number, _path: string, method: string) => {
      if (method === 'PATCH') throw { code: 'PORTAL_REQUEST_FAILED', status: 409 }
      return _path === '/api/containers' ? { containers: [{ id: 'c' }] } : { agents: [{ id: 'h', kind: 'human', alias: 'hm' }] }
    })
    expect(await renameSelfInProjects({ stacks: [{ projectShort: 'c', apiPort: 3 }], request: taken }, 'hm', 'atlas')).toEqual([
      { project: 'c', status: 'failed', reason: 'that name is already taken in this project' }
    ])
  })
})
