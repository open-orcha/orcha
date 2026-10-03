import { describe, it, expect } from 'vitest'
import { pinnedUserDataPath } from './userDataPath'
import { LEGACY_USER_DATA_DIRNAME, PRODUCT_NAME } from '../shared/brand'

describe('userData path pinned across the Embodent rebrand', () => {
  it('stays at <appData>/Orcha, not <appData>/Embodent', () => {
    const appData = '/Users/x/Library/Application Support'
    expect(pinnedUserDataPath(appData)).toBe('/Users/x/Library/Application Support/Orcha')
    expect(pinnedUserDataPath(appData)).not.toContain(PRODUCT_NAME)
    expect(LEGACY_USER_DATA_DIRNAME).toBe('Orcha')
  })
})
