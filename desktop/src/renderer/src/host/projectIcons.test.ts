import { describe, it, expect, vi } from 'vitest'
import {
  ICON_CACHE_KEY,
  LEGACY_ICONS_KEY,
  ProjectIconStore,
  RECENTS_MAX,
  UNREACHABLE_REASON,
  UNSUPPORTED_REASON,
  iconEditability,
  iconWriteFailure,
  loadLegacyIcons,
  loadRecents,
  parseIcon,
  projectIconKey,
  pushRecent,
  type ProjectIcon
} from './projectIcons'
import { containerIcon } from '../../../shared/projectIcon'
import type { ProjectContainer, Stack } from '../../../shared/types'

function mem() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    m
  }
}

const ROCKET: ProjectIcon = { kind: 'emoji', value: '🚀' }
const OCTO: ProjectIcon = { kind: 'emoji', value: '🐙' }
const DB: ProjectIcon = { kind: 'glyph', value: 'database', color: 3 }
const PATH = '/api/containers/c1/icon'

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

function stack(over: Partial<Stack> = {}): Stack {
  return { project: 'orcha-x', projectShort: 'x', running: true, apiPort: 8123, folder: '/tmp/x', ...over } as Stack
}
function container(over: Partial<ProjectContainer> = {}): ProjectContainer {
  return {
    id: 'c1',
    name: 'x',
    description: null,
    status: null,
    github_repo: null,
    agents: 0,
    tasks: 0,
    needs_you: 0,
    member_count: null,
    icon: null,
    ...over
  }
}

describe('project icon value (shared shape, D14)', () => {
  it('keys by container id, else the stack', () => {
    expect(projectIconKey({ container: { id: 'c1' }, stack: { project: 'orcha-x' } })).toBe('c1')
    expect(projectIconKey({ container: null, stack: { project: 'orcha-x' } })).toBe('stack:orcha-x')
  })

  it('validates like the portal: emoji rule, glyph list, colour 0-9', () => {
    expect(parseIcon({ kind: 'emoji', value: '1️⃣' })).toEqual({ kind: 'emoji', value: '1️⃣' })
    expect(parseIcon({ kind: 'emoji', value: '🇸🇴' })).toEqual({ kind: 'emoji', value: '🇸🇴' })
    expect(parseIcon({ kind: 'emoji', value: 'AB' })).toBeNull()
    expect(parseIcon({ kind: 'emoji', value: '🚀a' })).toBeNull() // no words (portal rule)
    expect(parseIcon({ kind: 'emoji', value: '🚀'.repeat(20) })).toBeNull()
    expect(parseIcon({ kind: 'glyph', value: 'not-a-glyph' })).toBeNull()
    expect(parseIcon({ kind: 'glyph', value: 'box', color: 99 })).toEqual({ kind: 'glyph', value: 'box', color: null })
  })

  it('reads the container row `icon`: absent = older portal, null = unset, malformed = unset', () => {
    expect(containerIcon({ id: 'c1' })).toBeUndefined()
    expect(containerIcon({ id: 'c1', icon: null })).toBeNull()
    expect(containerIcon({ id: 'c1', icon: { kind: 'glyph', value: 'nope' } })).toBeNull()
    expect(containerIcon({ id: 'c1', icon: DB })).toEqual(DB)
  })
})

describe('ProjectIconStore — read', () => {
  it('shows the server icon from the poll and caches it for the next first paint', () => {
    const s = mem()
    const store = new ProjectIconStore(s, vi.fn())
    const seen = vi.fn()
    store.subscribe(seen)
    store.applyServer([{ cid: 'c1', apiPort: 8123, icon: DB }, { cid: 'c2', apiPort: 8123, icon: null }])
    expect(store.icons()).toEqual({ c1: DB })
    expect(seen).toHaveBeenCalled()
    expect(new ProjectIconStore(s, vi.fn()).icons()).toEqual({ c1: DB })
  })

  it('server wins: a change or a clear on the server replaces the cached icon', () => {
    const store = new ProjectIconStore(mem(), vi.fn())
    store.applyServer([{ cid: 'c1', apiPort: 8123, icon: DB }])
    const before = store.icons()
    store.applyServer([{ cid: 'c1', apiPort: 8123, icon: DB }])
    expect(store.icons()).toBe(before) // no change → stable identity (no re-render)
    store.applyServer([{ cid: 'c1', apiPort: 8123, icon: ROCKET }])
    expect(store.icons()).toEqual({ c1: ROCKET })
    store.applyServer([{ cid: 'c1', apiPort: 8123, icon: null }])
    expect(store.icons()).toEqual({})
  })

  it('an older portal (no `icon` field) leaves the cached value alone', () => {
    const store = new ProjectIconStore(mem(), vi.fn())
    store.applyServer([{ cid: 'c1', apiPort: 8123, icon: DB }])
    store.applyServer([{ cid: 'c1', apiPort: 8123, icon: undefined }])
    expect(store.icons()).toEqual({ c1: DB })
  })

  it('never trusts the cache in storage', () => {
    const s = mem()
    s.setItem(ICON_CACHE_KEY, JSON.stringify({ c1: { kind: 'emoji', value: 'AB' }, c2: OCTO, 'stack:x': ROCKET }))
    expect(new ProjectIconStore(s, vi.fn()).icons()).toEqual({ c2: OCTO })
    s.setItem(ICON_CACHE_KEY, '{not json')
    expect(new ProjectIconStore(s, vi.fn()).icons()).toEqual({})
  })
})

describe('ProjectIconStore — write', () => {
  it('PUTs /api/containers/{cid}/icon with {icon} and keeps the stored value', async () => {
    const put = vi.fn().mockResolvedValue({ container_id: 'c1', icon: DB })
    const store = new ProjectIconStore(mem(), put)
    const res = await store.set({ cid: 'c1', apiPort: 8123 }, DB)
    expect(res).toEqual({ ok: true })
    expect(put).toHaveBeenCalledWith(8123, PATH, { icon: DB })
    expect(store.icons()).toEqual({ c1: DB })
  })

  it('reset sends icon:null', async () => {
    const put = vi.fn().mockResolvedValue({ container_id: 'c1', icon: null })
    const store = new ProjectIconStore(mem(), put)
    store.applyServer([{ cid: 'c1', apiPort: 8123, icon: DB }])
    await store.set({ cid: 'c1', apiPort: 8123 }, null)
    expect(put).toHaveBeenCalledWith(8123, PATH, { icon: null })
    expect(store.icons()).toEqual({})
  })

  it('paints optimistically, and a poll during the write does not undo the pick', async () => {
    const d = deferred<unknown>()
    const store = new ProjectIconStore(mem(), () => d.promise)
    store.applyServer([{ cid: 'c1', apiPort: 8123, icon: DB }])
    const p = store.set({ cid: 'c1', apiPort: 8123 }, ROCKET)
    expect(store.icons()).toEqual({ c1: ROCKET })
    store.applyServer([{ cid: 'c1', apiPort: 8123, icon: DB }]) // stale poll
    expect(store.icons()).toEqual({ c1: ROCKET })
    d.resolve({ container_id: 'c1', icon: ROCKET })
    await p
    expect(store.icons()).toEqual({ c1: ROCKET })
  })

  it('rolls back to the server icon when the write fails', async () => {
    const d = deferred<unknown>()
    const store = new ProjectIconStore(mem(), () => d.promise)
    store.applyServer([{ cid: 'c1', apiPort: 8123, icon: DB }])
    const p = store.set({ cid: 'c1', apiPort: 8123 }, ROCKET)
    expect(store.icons()).toEqual({ c1: ROCKET })
    d.reject({ code: 'PORTAL_REQUEST_FAILED', status: 500 })
    const res = await p
    expect(res.ok).toBe(false)
    expect(store.icons()).toEqual({ c1: DB })
  })

  it('403 → a clear permission message and the previous icon stays', async () => {
    const store = new ProjectIconStore(mem(), vi.fn().mockRejectedValue({ code: 'PORTAL_REQUEST_FAILED', status: 403 }))
    store.applyServer([{ cid: 'c1', apiPort: 8123, icon: DB }])
    const res = await store.set({ cid: 'c1', apiPort: 8123 }, ROCKET)
    expect(res).toEqual({ ok: false, failure: 'permission', message: "You don't have permission to change this project's icon" })
    expect(store.icons()).toEqual({ c1: DB })
  })

  it('unreachable (stack gone / network) → rolled back with a "couldn\'t reach" message, nothing stored locally', async () => {
    const s = mem()
    const store = new ProjectIconStore(s, vi.fn().mockRejectedValue({ code: 'INVALID_PORTAL_REQUEST' }))
    store.applyServer([{ cid: 'c1', apiPort: 8123, icon: null }])
    const res = await store.set({ cid: 'c1', apiPort: 8123 }, ROCKET)
    expect(res).toMatchObject({ ok: false, failure: 'unreachable' })
    expect(store.icons()).toEqual({})
    expect(JSON.parse(s.getItem(ICON_CACHE_KEY) ?? '{}')).toEqual({ c1: null })
  })

  it('maps bridge errors to reasons', () => {
    expect(iconWriteFailure({ code: 'PORTAL_REQUEST_FAILED', status: 422 }).failure).toBe('invalid')
    expect(iconWriteFailure({ code: 'PORTAL_REQUEST_FAILED', status: 404 })).toEqual({ failure: 'unsupported', message: UNSUPPORTED_REASON })
    expect(iconWriteFailure({ code: 'INTERNAL' }).failure).toBe('unreachable')
    expect(iconWriteFailure(new Error('x')).failure).toBe('unreachable')
  })

  it('refuses a malformed icon without calling the portal', async () => {
    const put = vi.fn()
    const store = new ProjectIconStore(mem(), put)
    const res = await store.set({ cid: 'c1', apiPort: 8123 }, { kind: 'emoji', value: 'nope' })
    expect(res.ok).toBe(false)
    expect(put).not.toHaveBeenCalled()
  })
})

describe('iconEditability — stopped / unreachable / older portal', () => {
  it('a running project on a store-aware portal can be changed', () => {
    expect(iconEditability({ container: container(), stack: stack() })).toEqual({ ok: true, target: { cid: 'c1', apiPort: 8123 } })
  })
  it('a stopped stack or a project that could not be listed is disabled with a reason', () => {
    expect(iconEditability({ container: null, stack: stack({ running: false, apiPort: null }) })).toEqual({ ok: false, reason: UNREACHABLE_REASON })
    expect(iconEditability({ container: null, stack: stack() })).toEqual({ ok: false, reason: UNREACHABLE_REASON })
    expect(iconEditability({ container: container(), stack: stack({ apiPort: null }) })).toEqual({ ok: false, reason: UNREACHABLE_REASON })
  })
  it('an older portal without the shared store is disabled (never a divergent local value)', () => {
    const { icon: _drop, ...old } = container()
    expect(iconEditability({ container: old, stack: stack() })).toEqual({ ok: false, reason: UNSUPPORTED_REASON })
  })
})

describe('one-time migration of icons picked on this Mac', () => {
  function legacyStorage(map: Record<string, unknown>) {
    const s = mem()
    s.setItem(LEGACY_ICONS_KEY, JSON.stringify(map))
    return s
  }

  it('shows the local icon until the store reports, then pushes it when the server has none and drops local storage', async () => {
    const s = legacyStorage({ c1: ROCKET })
    const put = vi.fn().mockResolvedValue({ container_id: 'c1', icon: ROCKET })
    const store = new ProjectIconStore(s, put)
    expect(store.icons()).toEqual({ c1: ROCKET })
    store.applyServer([{ cid: 'c1', apiPort: 8123, icon: null }])
    expect(put).toHaveBeenCalledWith(8123, PATH, { icon: ROCKET })
    expect(store.icons()).toEqual({ c1: ROCKET }) // no flicker to the default while pushing
    await flush()
    expect(store.icons()).toEqual({ c1: ROCKET })
    expect(s.getItem(LEGACY_ICONS_KEY)).toBeNull()
    expect(loadLegacyIcons(s)).toEqual({})
  })

  it('the server already has an icon → server wins, the local one is dropped without a write', () => {
    const s = legacyStorage({ c1: ROCKET })
    const put = vi.fn()
    const store = new ProjectIconStore(s, put)
    store.applyServer([{ cid: 'c1', apiPort: 8123, icon: DB }])
    expect(put).not.toHaveBeenCalled()
    expect(store.icons()).toEqual({ c1: DB })
    expect(s.getItem(LEGACY_ICONS_KEY)).toBeNull()
  })

  it('no permission → the server value shows, the local icon is OFFERED, and a later successful write drops it', async () => {
    const s = legacyStorage({ c1: ROCKET })
    const put = vi.fn().mockRejectedValueOnce({ code: 'PORTAL_REQUEST_FAILED', status: 403 })
    const store = new ProjectIconStore(s, put)
    store.applyServer([{ cid: 'c1', apiPort: 8123, icon: null }])
    await flush()
    expect(store.icons()).toEqual({})
    expect(store.offer('c1')).toEqual(ROCKET)
    // not retried on every poll once refused
    store.applyServer([{ cid: 'c1', apiPort: 8123, icon: null }])
    expect(put).toHaveBeenCalledTimes(1)
    // the user (now with permission) applies it from the picker
    put.mockResolvedValueOnce({ container_id: 'c1', icon: ROCKET })
    expect(await store.set({ cid: 'c1', apiPort: 8123 }, ROCKET)).toEqual({ ok: true })
    expect(store.offer('c1')).toBeNull()
    expect(s.getItem(LEGACY_ICONS_KEY)).toBeNull()
  })

  it('unreachable during the push → kept locally and retried on a later poll', async () => {
    const s = legacyStorage({ c1: ROCKET })
    const put = vi.fn().mockRejectedValueOnce({ code: 'INTERNAL' }).mockResolvedValueOnce({ container_id: 'c1', icon: ROCKET })
    const store = new ProjectIconStore(s, put)
    store.applyServer([{ cid: 'c1', apiPort: 8123, icon: null }])
    await flush()
    expect(loadLegacyIcons(s)).toEqual({ c1: ROCKET })
    store.applyServer([{ cid: 'c1', apiPort: 8123, icon: null }])
    await flush()
    expect(put).toHaveBeenCalledTimes(2)
    expect(s.getItem(LEGACY_ICONS_KEY)).toBeNull()
  })

  it('an older portal never triggers a push; the local icon keeps showing', () => {
    const s = legacyStorage({ c1: ROCKET, 'stack:orcha-x': OCTO })
    const put = vi.fn()
    const store = new ProjectIconStore(s, put)
    store.applyServer([{ cid: 'c1', apiPort: 8123, icon: undefined }])
    expect(put).not.toHaveBeenCalled()
    expect(store.icons()).toEqual({ c1: ROCKET }) // stack-level keys were never writable: dropped
  })
})

describe('emoji recents (local)', () => {
  it('most recent first, de-duplicated, capped', () => {
    const s = mem()
    let r: string[] = []
    r = pushRecent(s, r, '🚀')
    r = pushRecent(s, r, '🐙')
    r = pushRecent(s, r, '🚀')
    expect(r).toEqual(['🚀', '🐙'])
    expect(loadRecents(s)).toEqual(['🚀', '🐙'])
    for (let i = 0; i < 30; i++) r = pushRecent(s, r, String.fromCodePoint(0x1f600 + i))
    expect(loadRecents(s)).toHaveLength(RECENTS_MAX)
    expect(pushRecent(s, r, 'plain')).toBe(r)
  })

  it('a failing storage never throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('quota')
      }
    }
    const store = new ProjectIconStore(broken, vi.fn())
    expect(store.icons()).toEqual({})
    store.applyServer([{ cid: 'c1', apiPort: 8123, icon: DB }])
    expect(store.icons()).toEqual({ c1: DB })
    expect(loadRecents(broken)).toEqual([])
  })
})
