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
  it('renders a square dark tile with the one-colour Halo E, decorative', () => {
    render(<BrandMark size={18} className="shrink-0" />)
    const svg = screen.getByTestId('brand-mark')
    expect(svg.getAttribute('height')).toBe('18')
    expect(svg.getAttribute('width')).toBe('18')
    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(svg).toHaveClass('shrink-0')
    // Always on its #121314 tile so the light mark reads on the light canvas too.
    expect(svg.querySelector(':scope > rect')?.getAttribute('fill')).toBe('#121314')
    expect(svg.querySelector(':scope > g')?.getAttribute('stroke')).toBe('#ECEDF1')
    const opacities = [...svg.querySelectorAll('path')].map((p) => p.getAttribute('stroke-opacity'))
    expect(opacities).toEqual(['0.5', null])
  })

  it('uses the same geometry as resources/logo-mark.svg', () => {
    const norm = (d: string) => (d.match(/[A-Za-z]|-?\d+(?:\.\d+)?/g) ?? []).map((t) => (/[A-Za-z]/.test(t) ? t : String(Number(t)))).join(' ')
    const master_ds = [...master.matchAll(/ d="([^"]+)"/g)].map((m) => norm(m[1]))
    render(<BrandMark />)
    const svg = screen.getByTestId('brand-mark')
    const ds = [...svg.querySelectorAll('path')].map((p) => norm(p.getAttribute('d')!))
    expect(ds).toEqual(master_ds)
  })

  it('uses no SVG ids, so many marks on one page never collide', () => {
    render(
      <>
        <BrandMark />
        <BrandMark />
      </>
    )
    expect(document.querySelectorAll('[id]').length).toBe(0)
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
