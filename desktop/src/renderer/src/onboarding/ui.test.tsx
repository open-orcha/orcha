// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Avatar, avatarColor } from './ui'
import { AVATAR_HUES, assignPalette, paletteColor, paletteIndex } from '../ui/Avatar'

describe('onboarding Avatar', () => {
  it('uses the fixed identity palette slot for the alias and one initial', () => {
    const { container } = render(<Avatar name="backend-dev" />)
    const el = container.querySelector('.ob-avatar') as HTMLElement
    expect(el.textContent).toBe('B')
    expect(avatarColor('backend-dev')).toBe(paletteColor(paletteIndex('backend-dev')).background)
    expect(el.getAttribute('data-color')).toBe(avatarColor('backend-dev'))
  })

  it('gives the suggested roster distinct colours where the old 8-colour palette collided', () => {
    // lead/backend-dev and frontend-dev/qa-bot shared a colour with the old palette.
    expect(avatarColor('lead')).not.toBe(avatarColor('backend-dev'))
    expect(avatarColor('frontend-dev')).not.toBe(avatarColor('qa-bot'))
    const slots = ['lead', 'backend-dev', 'frontend-dev', 'qa-bot'].map(paletteIndex)
    expect(new Set(slots).size).toBe(4)
  })

  it('palette hues are well separated (≥ 20° apart around the wheel)', () => {
    const hs = [...AVATAR_HUES].sort((a, b) => a - b)
    const gaps = hs.map((h, i) => (i === 0 ? h + 360 - hs[hs.length - 1] : h - hs[i - 1]))
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(20)
  })

  it('assignPalette never repeats a colour within a list until the palette is exhausted', () => {
    const names = ['orcha-web', 'billing-service', 'mobile', 'empty-sandbox', 'legacy-marketing-site', 'lead', 'frontend-dev', 'qa-bot', 'backend-dev', 'docs']
    const slots = assignPalette(names)
    expect(new Set(slots.values()).size).toBe(names.length)
    // deterministic
    expect([...assignPalette(names).entries()]).toEqual([...slots.entries()])
  })
})
