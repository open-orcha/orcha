import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileVersionStore, restartNativeAfterUpdate, type AppUpdateDeps } from './appUpdate'

function deps(last: string | null, over: Partial<AppUpdateDeps> = {}) {
  let stored = last
  const d: AppUpdateDeps = {
    readLastVersion: () => stored,
    writeLastVersion: vi.fn((v: string) => {
      stored = v
    }),
    registry: () => ({
      notes: { path: '/Users/me/notes', api_port: 8010, runtime: 'native' },
      old: { path: '/Users/me/old', api_port: 8011, runtime: 'docker' },
      shop: { path: '/Users/me/shop', api_port: 8012, runtime: 'native' }
    }),
    upgrade: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn(),
    ...over
  }
  return d
}

describe('restartNativeAfterUpdate (GH #258 D3)', () => {
  it('same version as last launch: nothing runs', async () => {
    const d = deps('1.2.0')
    expect(await restartNativeAfterUpdate('1.2.0', d)).toEqual([])
    expect(d.upgrade).not.toHaveBeenCalled()
  })

  it('new version: `orcha upgrade` in every registered native project, never a Docker one', async () => {
    const d = deps('1.1.2')
    expect(await restartNativeAfterUpdate('1.2.0', d)).toEqual(['/Users/me/notes', '/Users/me/shop'])
    expect(d.upgrade).toHaveBeenCalledTimes(2)
    expect(d.writeLastVersion).toHaveBeenCalledWith('1.2.0')
  })

  it('first launch ever (no stored version) counts as an update', async () => {
    const d = deps(null)
    expect(await restartNativeAfterUpdate('1.2.0', d)).toHaveLength(2)
  })

  it('one failing project is logged and skipped; the rest still upgrade; version recorded', async () => {
    const upgrade = vi.fn(async (folder: string) => {
      if (folder.endsWith('notes')) throw new Error('boom')
    })
    const d = deps('1.1.2', { upgrade })
    expect(await restartNativeAfterUpdate('1.2.0', d)).toEqual(['/Users/me/shop'])
    expect(d.warn).toHaveBeenCalledWith(expect.stringContaining('boom'))
    expect(d.writeLastVersion).toHaveBeenCalledWith('1.2.0')
  })
})

describe('fileVersionStore', () => {
  it('round-trips the version under userData', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appupdate-'))
    const s = fileVersionStore(path.join(dir, 'ud'))
    expect(s.readLastVersion()).toBeNull()
    s.writeLastVersion('1.2.0')
    expect(s.readLastVersion()).toBe('1.2.0')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
