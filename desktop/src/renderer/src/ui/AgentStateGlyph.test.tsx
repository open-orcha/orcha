// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { AgentStateGlyph } from './AgentStateGlyph'

describe('AgentStateGlyph', () => {
  it('VD-09: waiting renders a neutral glyph, never the red blocked one', () => {
    const { container } = render(<AgentStateGlyph state="waiting" />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('data-state-glyph')).toBe('waiting')
    expect(svg.innerHTML).not.toContain('--color-danger')
  })
  it('blocked stays red', () => {
    const { container } = render(<AgentStateGlyph state="blocked" />)
    expect(container.querySelector('svg')!.innerHTML).toContain('--color-danger')
  })
})
