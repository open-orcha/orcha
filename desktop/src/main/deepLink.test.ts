import { describe, it, expect } from 'vitest'
import { parseDeepLink } from './deepLink'

describe('parseDeepLink', () => {
  it('parses orcha://open?project=…&path=… into a portal target', () => {
    expect(parseDeepLink('orcha://open?project=orcha-foo&path=%2Fagents')).toEqual({
      project: 'orcha-foo',
      path: '/agents'
    })
  })

  it('defaults the path to / when none is supplied', () => {
    expect(parseDeepLink('orcha://open?project=orcha-quantal-ehr')).toEqual({
      project: 'orcha-quantal-ehr',
      path: '/'
    })
  })

  it('rejects links with no project', () => {
    expect(parseDeepLink('orcha://open?path=%2Fagents')).toBeNull()
  })

  it('rejects injection-y project names (must be orcha-[A-Za-z0-9_-]+)', () => {
    expect(parseDeepLink('orcha://open?project=orcha-foo%2F..%2Fbar')).toBeNull()
    expect(parseDeepLink('orcha://open?project=evil')).toBeNull()
    expect(parseDeepLink('orcha://open?project=orcha-')).toBeNull()
  })

  it('falls back to / for unsafe paths (protocol-relative, backslash, relative)', () => {
    expect(parseDeepLink('orcha://open?project=orcha-foo&path=%2F%2Fevil.com')?.path).toBe('/')
    expect(parseDeepLink('orcha://open?project=orcha-foo&path=%2F%5Cevil.com')?.path).toBe('/')
    expect(parseDeepLink('orcha://open?project=orcha-foo&path=tasks')?.path).toBe('/')
  })

  it('rejects non-orcha schemes and unknown hosts', () => {
    expect(parseDeepLink('https://open?project=orcha-foo')).toBeNull()
    expect(parseDeepLink('orcha://settings?project=orcha-foo')).toBeNull()
  })

  it('rejects garbage strings without throwing', () => {
    expect(parseDeepLink('not a url at all')).toBeNull()
    expect(parseDeepLink('')).toBeNull()
  })
})
