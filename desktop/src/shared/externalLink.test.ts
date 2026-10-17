import { describe, it, expect } from 'vitest'
import { isExternalWebLink } from './externalLink'

describe('isExternalWebLink', () => {
  it('allows https and http (local portals) links', () => {
    expect(isExternalWebLink('https://ilmforyou.com/admin')).toBe(true)
    expect(isExternalWebLink('http://localhost:8000/?cid=x')).toBe(true)
  })
  it('refuses other schemes and junk', () => {
    for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'vscode://x', 'orcha://open', 'mailto:a@b.c', 'https://', 'not a url', 42, null]) {
      expect(isExternalWebLink(u)).toBe(false)
    }
  })
})
