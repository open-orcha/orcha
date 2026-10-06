import { describe, it, expect, vi } from 'vitest'
import { createOrchaHost, type PortalBridgeDeps } from './portalBridge'
import { EMBED_TO_HOST_CHANNEL, EMBED_TO_PORTAL_CHANNEL, portalPreloadArgs } from '../shared/embed'

function deps(origin: string, overrides: Partial<PortalBridgeDeps> = {}) {
  let listener: ((payload: unknown) => void) | null = null
  const d: PortalBridgeDeps & { emit(p: unknown): void } = {
    argv: ['electron', ...portalPreloadArgs('http://localhost:8123', 'orcha-demo')],
    origin: () => origin,
    send: vi.fn(),
    on: vi.fn((_channel, l) => {
      listener = l
      return () => {
        listener = null
      }
    }),
    emit: (p) => listener?.(p),
    ...overrides
  }
  return d
}

describe('createOrchaHost (portal preload)', () => {
  it('exposes a v1 API with the sidebar capability on the expected origin', () => {
    const host = createOrchaHost(deps('http://localhost:8123'))
    expect(host).not.toBeNull()
    expect(host?.version).toBe(1)
    expect(host?.capabilities).toContain('sidebar')
    expect(host?.project).toBe('orcha-demo')
  })

  it('exposes nothing on any other origin (another stack, external page, file://)', () => {
    expect(createOrchaHost(deps('http://localhost:9999'))).toBeNull()
    expect(createOrchaHost(deps('https://evil.example'))).toBeNull()
    expect(createOrchaHost(deps('null'))).toBeNull()
  })

  it('exposes nothing without valid preload args', () => {
    expect(createOrchaHost(deps('http://localhost:8123', { argv: ['electron'] }))).toBeNull()
  })

  it('sends only validated messages on the fixed channel', () => {
    const d = deps('http://localhost:8123')
    const host = createOrchaHost(d)!
    host.send({ type: 'ready', version: 1 })
    host.send({ type: 'route', path: '//evil', search: '', title: '' } as never)
    host.send({ type: 'exec', cmd: 'ls' } as never)
    expect(d.send).toHaveBeenCalledTimes(1)
    expect(d.send).toHaveBeenCalledWith(EMBED_TO_HOST_CHANNEL, { type: 'ready', version: 1 })
  })

  it('stops sending if the page origin changes after exposure', () => {
    let origin = 'http://localhost:8123'
    const d = deps('', { origin: () => origin })
    const host = createOrchaHost(d)!
    origin = 'https://evil.example'
    host.send({ type: 'ready', version: 1 })
    expect(d.send).not.toHaveBeenCalled()
  })

  it('delivers only valid host messages to page callbacks, with unsubscribe', () => {
    const d = deps('http://localhost:8123')
    const host = createOrchaHost(d)!
    const cb = vi.fn()
    const off = host.on(cb)
    expect(d.on).toHaveBeenCalledWith(EMBED_TO_PORTAL_CHANNEL, expect.any(Function))
    d.emit({ type: 'navigate', path: '/tasks' })
    d.emit({ type: 'navigate', path: '//evil' })
    d.emit({ type: 'bogus' })
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith({ type: 'navigate', path: '/tasks' })
    off()
    d.emit({ type: 'openSearch' })
    expect(cb).toHaveBeenCalledTimes(1)
  })
})

describe('requestMicAccess (dictation)', () => {
  it('asks main on the ONE fixed channel and returns the access state', async () => {
    const invokeMic = vi.fn(async () => ({ ok: true, data: 'granted' }))
    const host = createOrchaHost(deps('http://localhost:8123', { invokeMic }))!
    await expect(host.requestMicAccess!()).resolves.toBe('granted')
    expect(invokeMic).toHaveBeenCalledTimes(1)
  })
  it('never rejects and never passes junk through', async () => {
    const bad = createOrchaHost(deps('http://localhost:8123', { invokeMic: vi.fn(async () => ({ ok: true, data: 'root' })) }))!
    await expect(bad.requestMicAccess!()).resolves.toBe('unknown')
    const boom = createOrchaHost(deps('http://localhost:8123', { invokeMic: vi.fn(async () => { throw new Error('x') }) }))!
    await expect(boom.requestMicAccess!()).resolves.toBe('unknown')
    const none = createOrchaHost(deps('http://localhost:8123'))!
    await expect(none.requestMicAccess!()).resolves.toBe('unknown')
  })
})
