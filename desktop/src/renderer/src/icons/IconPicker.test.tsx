// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IconPicker } from './IconPicker'
import { searchEmoji, toGroups } from './emojiData'

function setup(over: Partial<Parameters<typeof IconPicker>[0]> = {}) {
  const p = { label: 'Change icon for web', value: null, recents: [], onPick: vi.fn(), onReset: vi.fn(), onClose: vi.fn(), ...over }
  render(<IconPicker {...p} />)
  return p
}

describe('IconPicker (D14)', () => {
  it('emoji search finds by name-word prefixes and picks', async () => {
    const p = setup()
    const user = userEvent.setup()
    await screen.findByRole('region', { name: 'Smileys' })
    await user.type(screen.getByRole('textbox', { name: 'Search emoji' }), 'red hea')
    await user.click(await screen.findByRole('button', { name: 'red heart' }))
    expect(p.onPick).toHaveBeenCalledWith({ kind: 'emoji', value: '❤️' }, true)
  })

  it('says so when nothing matches', async () => {
    setup()
    const user = userEvent.setup()
    await screen.findByRole('region', { name: 'Smileys' })
    await user.type(screen.getByRole('textbox', { name: 'Search emoji' }), 'zzzzqq')
    expect(screen.getByText('No emoji match “zzzzqq”.')).toBeInTheDocument()
  })

  it('an existing glyph opens on the Icons tab; a colour change applies live without closing', async () => {
    const p = setup({ value: { kind: 'glyph', value: 'server', color: null } })
    expect(screen.getByRole('tab', { name: 'Icons' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: 'server' })).toHaveAttribute('aria-pressed', 'true')
    await userEvent.setup().click(screen.getByRole('radio', { name: 'Colour 2' }))
    expect(p.onPick).toHaveBeenCalledWith({ kind: 'glyph', value: 'server', color: 1 }, false)
  })

  it('icon search uses keywords ("db" → database); Reset only when an icon is set', async () => {
    setup()
    expect(screen.queryByRole('button', { name: 'Reset' })).toBeNull()
    const user = userEvent.setup()
    await user.click(screen.getByRole('tab', { name: 'Icons' }))
    await user.type(screen.getByRole('textbox', { name: 'Search icons' }), 'db')
    const icons = within(screen.getByRole('group', { name: 'Icons' })).getAllByRole('button')
    expect(icons.map((b) => b.getAttribute('aria-label'))).toEqual(['database'])
  })

  it('Reset clears back to the default; Escape closes', async () => {
    const p = setup({ value: { kind: 'emoji', value: '🚀' } })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Reset' }))
    expect(p.onReset).toHaveBeenCalled()
    await user.keyboard('{Escape}')
    expect(p.onClose).toHaveBeenCalled()
  })
})

describe('emoji dataset', () => {
  it('keeps known groups and drops emoji newer than 15.1', () => {
    const groups = toGroups([
      { slug: 'component', name: 'Component', emojis: [{ emoji: '🏻', name: 'light skin tone', emoji_version: '1.0' }] },
      {
        slug: 'objects',
        name: 'Objects',
        emojis: [
          { emoji: '🚀', name: 'rocket', emoji_version: '0.6' },
          { emoji: '🫟', name: 'splatter', emoji_version: '16.0' }
        ]
      }
    ])
    expect(groups).toEqual([{ slug: 'objects', label: 'Objects', emojis: [{ emoji: '🚀', name: 'rocket' }] }])
    expect(searchEmoji(groups, 'roc')).toEqual([{ emoji: '🚀', name: 'rocket' }])
    expect(searchEmoji(groups, 'obj')).toEqual([{ emoji: '🚀', name: 'rocket' }])
    expect(searchEmoji(groups, '  ')).toEqual([])
  })

  it('offers the icon picked on this Mac as one click (D14 migration)', async () => {
    const p = setup({ suggestion: { kind: 'glyph', value: 'rocket', color: 2 } })
    const offer = screen.getByTestId('icon-suggestion')
    expect(offer).toHaveTextContent('Your icon from this Mac')
    await userEvent.setup().click(within(offer).getByRole('button', { name: 'Use it' }))
    expect(p.onPick).toHaveBeenCalledWith({ kind: 'glyph', value: 'rocket', color: 2 }, true)
  })
})

