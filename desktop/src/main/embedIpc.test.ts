import { describe, it, expect } from 'vitest'
import { acceptPortalSender, type PortalSenderFacts } from './embedIpc'

const ok: PortalSenderFacts = {
  project: 'orcha-a',
  isRegisteredView: true,
  isMainFrame: true,
  frameUrl: 'http://localhost:8123/tasks?cid=c1',
  expectedOrigin: 'http://localhost:8123'
}

describe('acceptPortalSender', () => {
  it('accepts the registered view main frame on its own stack origin', () => {
    expect(acceptPortalSender(ok)).toBe(true)
  })
  it('rejects unknown senders (manager window, tray, a destroyed/replaced view)', () => {
    expect(acceptPortalSender({ ...ok, project: undefined })).toBe(false)
    expect(acceptPortalSender({ ...ok, isRegisteredView: false })).toBe(false)
  })
  it('rejects sub-frames', () => {
    expect(acceptPortalSender({ ...ok, isMainFrame: false })).toBe(false)
  })
  it("rejects another stack's origin, external pages and malformed URLs", () => {
    expect(acceptPortalSender({ ...ok, frameUrl: 'http://localhost:9999/' })).toBe(false)
    expect(acceptPortalSender({ ...ok, frameUrl: 'https://evil.example/' })).toBe(false)
    expect(acceptPortalSender({ ...ok, frameUrl: 'http://localhost:8123.evil.example/' })).toBe(false)
    expect(acceptPortalSender({ ...ok, frameUrl: 'not a url' })).toBe(false)
    expect(acceptPortalSender({ ...ok, frameUrl: null })).toBe(false)
    expect(acceptPortalSender({ ...ok, expectedOrigin: undefined })).toBe(false)
  })
})
