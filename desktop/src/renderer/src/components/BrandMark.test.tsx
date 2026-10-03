// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { BrandMark } from './BrandMark'
import { OrchaMark } from './OrchaMark'
import { OrchaMark as OnboardingOrchaMark } from '../onboarding/ui'
import { PRODUCT_NAME } from '../../../shared/brand'
import master from '../../../../resources/logo-mark.svg?raw'
import indexHtml from '../../index.html?raw'

describe('BrandMark (Embodent mark)', () => {
  it('renders a square dark tile with the light | grey figure, decorative', () => {
    render(<BrandMark size={18} className="shrink-0" />)
    const svg = screen.getByTestId('brand-mark')
    expect(svg.getAttribute('height')).toBe('18')
    expect(svg.getAttribute('width')).toBe('18')
    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(svg).toHaveClass('shrink-0')
    // Always on its #121314 tile so the light half reads on the light canvas too.
    expect(svg.querySelector(':scope > rect')?.getAttribute('fill')).toBe('#121314')
    const halves = [...svg.querySelectorAll(':scope > g')].map((g) => g.getAttribute('fill'))
    expect(halves).toEqual(['#ECEDF1', '#7C808A'])
  })

  it('uses the same geometry as resources/logo-mark.svg', () => {
    const arch = [...master.matchAll(/ d="([^"]+)"/g)].map((m) => m[1])
    const head = master.match(/<circle cx="(\d+)" cy="(\d+)" r="(\d+)"/)!.slice(1)
    render(<BrandMark />)
    const svg = screen.getByTestId('brand-mark')
    const ds = new Set([...svg.querySelectorAll('path')].map((p) => p.getAttribute('d')))
    expect([...ds]).toEqual(arch)
    const c = svg.querySelector('circle')!
    expect([c.getAttribute('cx'), c.getAttribute('cy'), c.getAttribute('r')]).toEqual(head)
  })

  it('gives each instance its own clip ids', () => {
    render(
      <>
        <BrandMark />
        <BrandMark />
      </>
    )
    const ids = [...document.querySelectorAll('clipPath')].map((c) => c.id)
    expect(new Set(ids).size).toBe(4)
  })

  it('keeps the OrchaMark API as a compat alias (components + onboarding re-export)', () => {
    expect(OrchaMark).toBe(BrandMark)
    expect(OnboardingOrchaMark).toBe(BrandMark)
  })
})

describe('renderer branding', () => {
  it('product name is Embodent and the window title follows it', () => {
    expect(PRODUCT_NAME).toBe('Embodent')
    expect(indexHtml).toContain('<title>Embodent</title>')
  })
})
