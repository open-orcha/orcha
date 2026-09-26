import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { appearanceFilePath, readAppearance, writeAppearance, isEmpty } from './appearanceStore'

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), 'orcha-appearance-'))
}

describe('appearanceFilePath', () => {
  it('is <userDataDir>/appearance.json', () => {
    expect(appearanceFilePath('/Users/x/Library/Application Support/Orcha')).toBe(
      '/Users/x/Library/Application Support/Orcha/appearance.json'
    )
  })
})

describe('readAppearance / writeAppearance', () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('returns {theme:null, skin:null} when the file is absent', () => {
    dir = tmp()
    expect(readAppearance(dir)).toEqual({ theme: null, skin: null })
  })

  it('round-trips a written bag', () => {
    dir = tmp()
    writeAppearance(dir, { theme: 'dark', skin: 'minimal' })
    expect(readAppearance(dir)).toEqual({ theme: 'dark', skin: 'minimal' })
  })

  it('mkdirp\'s a userData dir that does not exist yet', () => {
    dir = path.join(tmp(), 'nested', 'deeper')
    writeAppearance(dir, { theme: 'light', skin: null })
    expect(readAppearance(dir)).toEqual({ theme: 'light', skin: null })
  })

  it('returns {theme:null, skin:null} on malformed JSON (never throws)', () => {
    dir = tmp()
    writeAppearance(dir, { theme: 'dark', skin: null })
    // Corrupt the file directly.
    writeFileSync(appearanceFilePath(dir), 'not json')
    expect(readAppearance(dir)).toEqual({ theme: null, skin: null })
  })

  it('overwrites a previously-written bag', () => {
    dir = tmp()
    writeAppearance(dir, { theme: 'dark', skin: 'classic' })
    writeAppearance(dir, { theme: 'light', skin: 'swiss' })
    expect(readAppearance(dir)).toEqual({ theme: 'light', skin: 'swiss' })
  })
})

describe('isEmpty', () => {
  it('true when both fields are null', () => {
    expect(isEmpty({ theme: null, skin: null })).toBe(true)
  })

  it('false when either field is set', () => {
    expect(isEmpty({ theme: 'dark', skin: null })).toBe(false)
    expect(isEmpty({ theme: null, skin: 'classic' })).toBe(false)
  })
})
