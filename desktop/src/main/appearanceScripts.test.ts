// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { buildReadAppearanceScript, buildApplyAppearanceScript } from './appearanceScripts'

/** These snippets are meant for Electron's executeJavaScript (a real browser-ish context);
 *  jsdom + eval is a faithful enough stand-in to test the ACTUAL behavior, not just the
 *  string shape — window.localStorage and document.documentElement both work under jsdom. */
function run(script: string): unknown {
  // eslint-disable-next-line no-eval
  return eval(script)
}

beforeEach(() => {
  window.localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('data-skin')
})

describe('buildReadAppearanceScript', () => {
  it('returns {theme:null, skin:null} when nothing is stored', () => {
    expect(run(buildReadAppearanceScript())).toEqual({ theme: null, skin: null })
  })

  it('reads whatever is in localStorage', () => {
    window.localStorage.setItem('orcha:theme', 'dark')
    window.localStorage.setItem('orcha:skin', 'minimal')
    expect(run(buildReadAppearanceScript())).toEqual({ theme: 'dark', skin: 'minimal' })
  })

  it('reads a partial bag (theme only)', () => {
    window.localStorage.setItem('orcha:theme', 'light')
    expect(run(buildReadAppearanceScript())).toEqual({ theme: 'light', skin: null })
  })
})

describe('buildApplyAppearanceScript', () => {
  it('sets data-theme and writes localStorage for a theme value', () => {
    run(buildApplyAppearanceScript({ theme: 'dark', skin: null }))
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(window.localStorage.getItem('orcha:theme')).toBe('dark')
  })

  it('sets data-skin for a non-classic skin and writes localStorage', () => {
    run(buildApplyAppearanceScript({ theme: null, skin: 'minimal' }))
    expect(document.documentElement.getAttribute('data-skin')).toBe('minimal')
    expect(window.localStorage.getItem('orcha:skin')).toBe('minimal')
  })

  it('removes data-skin (does not set it to the string "classic") for skin "classic"', () => {
    document.documentElement.setAttribute('data-skin', 'minimal')
    run(buildApplyAppearanceScript({ theme: null, skin: 'classic' }))
    expect(document.documentElement.hasAttribute('data-skin')).toBe(false)
    // classic is still recorded in localStorage (mirrors the portal's own applySkin).
    expect(window.localStorage.getItem('orcha:skin')).toBe('classic')
  })

  it('leaves an untouched field alone when it is null (no attribute, no localStorage write)', () => {
    document.documentElement.setAttribute('data-theme', 'light')
    window.localStorage.setItem('orcha:theme', 'light')
    run(buildApplyAppearanceScript({ theme: null, skin: 'swiss' }))
    expect(document.documentElement.getAttribute('data-theme')).toBe('light') // untouched
    expect(document.documentElement.getAttribute('data-skin')).toBe('swiss')
  })

  it('applies both fields together', () => {
    run(buildApplyAppearanceScript({ theme: 'dark', skin: 'swiss' }))
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(document.documentElement.getAttribute('data-skin')).toBe('swiss')
  })

  it('never throws even with both fields null', () => {
    expect(() => run(buildApplyAppearanceScript({ theme: null, skin: null }))).not.toThrow()
  })
})
