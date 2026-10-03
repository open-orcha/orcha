import { describe, expect, it, vi } from 'vitest'
import type { MicAccess } from '../shared/mic'
import { installMediaPermissions, isTrustedMediaOrigin, micAccessStatus, requestMicAccess, type SessionLike } from './micPermission'

const sp = (status: string, answer = true) => ({
  getMediaAccessStatus: vi.fn(() => status),
  askForMediaAccess: vi.fn(async () => answer)
})

describe('macOS microphone access', () => {
  it('reports the TCC state; non-mac is always granted (Chromium prompts)', () => {
    expect(micAccessStatus(sp('granted'), 'darwin')).toBe('granted')
    expect(micAccessStatus(sp('denied'), 'darwin')).toBe('denied')
    expect(micAccessStatus(sp('weird'), 'darwin')).toBe('unknown')
    expect(micAccessStatus(sp('denied'), 'linux')).toBe('granted')
  })
  it('asks only when not yet determined', async () => {
    const asked = sp('not-determined', true)
    await expect(requestMicAccess(asked, 'darwin')).resolves.toBe('granted')
    expect(asked.askForMediaAccess).toHaveBeenCalledWith('microphone')
    const refused = sp('not-determined', false)
    await expect(requestMicAccess(refused, 'darwin')).resolves.toBe('denied')
    const blocked = sp('denied')
    await expect(requestMicAccess(blocked, 'darwin')).resolves.toBe('denied')
    expect(blocked.askForMediaAccess).not.toHaveBeenCalled()
  })
})

describe('Chromium media permission handler', () => {
  function install(ask: () => Promise<MicAccess> = async () => 'granted') {
    let request: Parameters<SessionLike['setPermissionRequestHandler']>[0] = null
    let check: Parameters<SessionLike['setPermissionCheckHandler']>[0] = null
    installMediaPermissions(
      { setPermissionRequestHandler: (h) => (request = h), setPermissionCheckHandler: (h) => (check = h) },
      { ask, trustedExtra: () => ['http://devhost:5173'] }
    )
    const req = (permission: string, details: object) =>
      new Promise<boolean>((resolve) => request!(null, permission, resolve, details))
    return { req, check: (p: string, origin: string, d: object = {}) => check!(null, p, origin, d) }
  }

  it('grants audio to our portal views and the manager window after macOS says yes', async () => {
    const { req } = install()
    await expect(req('media', { mediaTypes: ['audio'], requestingUrl: 'http://localhost:8123/tasks' })).resolves.toBe(true)
    await expect(req('media', { mediaTypes: ['audio'], requestingUrl: 'http://127.0.0.1:8123/' })).resolves.toBe(true)
    await expect(req('media', { mediaTypes: ['audio'], requestingUrl: 'file:///app/index.html' })).resolves.toBe(true)
    await expect(req('media', { mediaTypes: ['audio'], requestingUrl: 'http://devhost:5173/' })).resolves.toBe(true)
  })

  it('refuses the camera, foreign origins, and a macOS "no"', async () => {
    const { req } = install()
    await expect(req('media', { mediaTypes: ['audio', 'video'], requestingUrl: 'http://localhost:8123/' })).resolves.toBe(false)
    await expect(req('media', { mediaTypes: ['audio'], requestingUrl: 'https://evil.example/' })).resolves.toBe(false)
    const denied = install(async () => 'denied')
    await expect(denied.req('media', { mediaTypes: ['audio'], requestingUrl: 'http://localhost:8123/' })).resolves.toBe(false)
  })

  it('leaves every other permission at Electron’s default', async () => {
    const { req, check } = install()
    await expect(req('notifications', {})).resolves.toBe(true)
    expect(check('clipboard-read', 'http://localhost:8123')).toBe(true)
    expect(check('media', 'http://localhost:8123', { mediaType: 'audio' })).toBe(true)
    expect(check('media', 'http://localhost:8123', { mediaType: 'video' })).toBe(false)
    expect(check('media', 'https://evil.example', { mediaType: 'audio' })).toBe(false)
  })

  it('origin rule', () => {
    expect(isTrustedMediaOrigin('http://localhost:1')).toBe(true)
    expect(isTrustedMediaOrigin('https://localhost:1')).toBe(false)
    expect(isTrustedMediaOrigin('http://localhost.evil.example')).toBe(false)
    expect(isTrustedMediaOrigin(undefined)).toBe(false)
  })
})
