import { describe, it, expect } from 'vitest'
import {
  cidFromSearch,
  parseHostMessage,
  parsePortalMessage,
  portalPreloadArgs,
  readPortalPreloadArgs,
  withCidParam,
  withEmbedHint
} from './embed'

describe('parsePortalMessage', () => {
  it('accepts ready only at version 1', () => {
    expect(parsePortalMessage({ type: 'ready', version: 1 })).toEqual({ type: 'ready', version: 1 })
    expect(parsePortalMessage({ type: 'ready', version: 2 })).toBeNull()
  })

  it('accepts a safe route and rejects protocol-relative / backslash paths', () => {
    expect(parsePortalMessage({ type: 'route', path: '/tasks', search: '?task=1&cid=c', title: 'Tasks' })).toEqual({
      type: 'route',
      path: '/tasks',
      search: '?task=1&cid=c',
      title: 'Tasks'
    })
    expect(parsePortalMessage({ type: 'route', path: '//evil.com', search: '', title: '' })).toBeNull()
    expect(parsePortalMessage({ type: 'route', path: '/\\evil.com', search: '', title: '' })).toBeNull()
    expect(parsePortalMessage({ type: 'route', path: 'tasks', search: '', title: '' })).toBeNull()
    expect(parsePortalMessage({ type: 'route', path: '/tasks', search: 'task=1', title: '' })).toBeNull()
  })

  it('keeps null (unknown) attention distinct from zero and rejects negative/fractional counts', () => {
    expect(parsePortalMessage({ type: 'attention', cid: 'c1', count: null, partial: false })).toEqual({
      type: 'attention',
      cid: 'c1',
      count: null,
      partial: false
    })
    expect(parsePortalMessage({ type: 'attention', cid: null, count: 0, partial: true })?.type).toBe('attention')
    expect(parsePortalMessage({ type: 'attention', cid: 'c1', count: -1, partial: false })).toBeNull()
    expect(parsePortalMessage({ type: 'attention', cid: 'c1', count: 1.5, partial: false })).toBeNull()
    expect(parsePortalMessage({ type: 'attention', cid: 7, count: 1, partial: false })).toBeNull()
  })

  it('caps live agents at 5 and strips unknown fields', () => {
    const agents = Array.from({ length: 8 }, (_, i) => ({
      alias: `a${i}`,
      status: 'working',
      task: null,
      updatedAt: null,
      secret: 'x'
    }))
    const msg = parsePortalMessage({ type: 'liveAgents', cid: 'c1', agents })
    expect(msg?.type).toBe('liveAgents')
    if (msg?.type !== 'liveAgents') return
    expect(msg.agents).toHaveLength(5)
    expect(Object.keys(msg.agents[0]).sort()).toEqual(['alias', 'status', 'task', 'updatedAt'])
  })

  it('only allows the fixed host-action allowlist', () => {
    expect(parsePortalMessage({ type: 'requestHostAction', action: 'stopStack' })).toEqual({
      type: 'requestHostAction',
      action: 'stopStack'
    })
    expect(parsePortalMessage({ type: 'requestHostAction', action: 'resetStack' })).toBeNull()
    expect(parsePortalMessage({ type: 'requestHostAction', action: 'rm -rf /' })).toBeNull()
  })

  it('drops unknown types and non-objects', () => {
    expect(parsePortalMessage({ type: 'exec', cmd: 'ls' })).toBeNull()
    expect(parsePortalMessage('ready')).toBeNull()
    expect(parsePortalMessage(null)).toBeNull()
    expect(parsePortalMessage([{ type: 'ready', version: 1 }])).toBeNull()
  })
})

describe('parseHostMessage', () => {
  it('validates navigate paths', () => {
    expect(parseHostMessage({ type: 'navigate', path: '/agents?agent=Atlas' })).toEqual({
      type: 'navigate',
      path: '/agents?agent=Atlas'
    })
    expect(parseHostMessage({ type: 'navigate', path: 'https://evil.com' })).toBeNull()
    expect(parseHostMessage({ type: 'navigate', path: '//evil.com' })).toBeNull()
  })
  it('accepts openSearch and boolean hostModal only', () => {
    expect(parseHostMessage({ type: 'openSearch' })).toEqual({ type: 'openSearch' })
    expect(parseHostMessage({ type: 'hostModal', open: true })).toEqual({ type: 'hostModal', open: true })
    expect(parseHostMessage({ type: 'hostModal', open: 'yes' })).toBeNull()
    expect(parseHostMessage({ type: 'shell' })).toBeNull()
  })
})

describe('URL helpers', () => {
  it('withEmbedHint appends to bare, queried and hashed paths', () => {
    expect(withEmbedHint('/')).toBe('/?embed=desktop')
    expect(withEmbedHint('/?cid=c1')).toBe('/?cid=c1&embed=desktop')
    expect(withEmbedHint('/settings?cid=c1#tab=pairing')).toBe('/settings?cid=c1&embed=desktop#tab=pairing')
    expect(withEmbedHint('/x?embed=desktop')).toBe('/x?embed=desktop')
    expect(withEmbedHint('//evil')).toBe('/?embed=desktop')
  })

  it('withCidParam adds or replaces cid, keeping other params and hash', () => {
    expect(withCidParam('/tasks', 'c1')).toBe('/tasks?cid=c1')
    expect(withCidParam('/tasks?task=t1', 'c1')).toBe('/tasks?task=t1&cid=c1')
    expect(withCidParam('/settings?cid=old#tab=pairing', 'c2')).toBe('/settings?cid=c2#tab=pairing')
    expect(withCidParam('/tasks', null)).toBe('/tasks')
  })

  it('cidFromSearch reads the cid param', () => {
    expect(cidFromSearch('?task=1&cid=abc')).toBe('abc')
    expect(cidFromSearch('')).toBeNull()
  })

  it('preload args round-trip and reject anything but localhost origins / orcha-* projects', () => {
    const args = portalPreloadArgs('http://localhost:8123', 'orcha-demo')
    expect(readPortalPreloadArgs(['electron', ...args])).toEqual({ origin: 'http://localhost:8123', project: 'orcha-demo' })
    expect(readPortalPreloadArgs(portalPreloadArgs('https://evil.com', 'orcha-demo'))).toBeNull()
    expect(readPortalPreloadArgs(portalPreloadArgs('http://localhost:8123', 'demo'))).toBeNull()
    expect(readPortalPreloadArgs([])).toBeNull()
  })
})

describe('canSpaNavigate (tray/notification into the open V2 project, QA)', () => {
  it('SPA only when the target stays in the reported container', async () => {
    const { canSpaNavigate } = await import('./embed')
    expect(canSpaNavigate('/tasks?task=t1&cid=c1', '?cid=c1')).toBe(true)
    expect(canSpaNavigate('/tasks?task=t1', '')).toBe(true) // single-container stack
    expect(canSpaNavigate('/tasks?cid=c2', '?cid=c1')).toBe(false) // container switch → full load
    expect(canSpaNavigate('/tasks?task=t1', '?cid=c1')).toBe(false) // unscoped path on a multi stack
    expect(canSpaNavigate('/settings?cid=c1#tab=pairing', '?cid=c1')).toBe(true)
  })
  it('prefers the portal-RESOLVED cid over a route that dropped ?cid= (QA 2/6)', async () => {
    const { canSpaNavigate } = await import('./embed')
    // portal is on c2 but its last route reported no cid (in-portal link without cid)
    expect(canSpaNavigate('/tasks?cid=c2', '', 'c2')).toBe(true)
    expect(canSpaNavigate('/tasks?cid=c1', '', 'c2')).toBe(false) // container switch → full load
    // stale route cid never overrides the resolved one
    expect(canSpaNavigate('/tasks?cid=c1', '?cid=c1', 'c2')).toBe(false)
    // an unscoped target while a container is known → full load (cannot prove same scope)
    expect(canSpaNavigate('/tasks', '', 'c2')).toBe(false)
  })
  it('no reported route or an unsafe path → full load', async () => {
    const { canSpaNavigate } = await import('./embed')
    expect(canSpaNavigate('/tasks', null)).toBe(false)
    expect(canSpaNavigate('//evil.example/x', '')).toBe(false)
  })
})
