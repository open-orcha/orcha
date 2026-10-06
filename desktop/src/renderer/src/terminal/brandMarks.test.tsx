// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { CLAUDE_HEX, CLAUDE_PATH, ClaudeMark, OPENAI_PATH, OpenAIMark, VENDORED_MARKS } from './brandMarks'
import { AgentMark, KindIcon } from './KindIcon'
import { AGENT_IDS } from '../../../shared/agents'

async function sha(s: string): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
}

describe('brand marks (vendored verbatim from simple-icons, CC0)', () => {
  it('paths are byte-identical to simple-icons icons/claude.svg (16.33.0) and icons/openai.svg (15.22.0)', async () => {
    expect(await sha(CLAUDE_PATH)).toBe('0442033dcc3824e52ffb0a07849c46becbeeacd75d1287f9081c00510e3bbf84')
    expect(await sha(OPENAI_PATH)).toBe('3fae9b38d571a5ab5aa662bc279dcda580855d6ca6b35330e4b4ba171367ffb1')
  })

  it('Claude renders in its brand colour; OpenAI in the current text colour; both decorative 24-unit marks', () => {
    const { container } = render(
      <>
        <ClaudeMark />
        <OpenAIMark />
      </>
    )
    const [claude, openai] = Array.from(container.querySelectorAll('svg'))
    expect(CLAUDE_HEX).toBe('#D97757')
    expect(claude.style.color).toBe('rgb(217, 119, 87)')
    expect(claude.getAttribute('viewBox')).toBe('0 0 24 24')
    expect(claude.getAttribute('aria-hidden')).toBe('true')
    expect(openai.style.color).toBe('')
    expect(openai.querySelector('path')?.getAttribute('fill')).toBe('currentColor')
  })

  it('KindIcon uses them for the agent launchers (shell keeps the terminal glyph)', () => {
    const { container } = render(
      <>
        <KindIcon kind="claude" />
        <KindIcon kind="codex" />
        <KindIcon kind="shell" />
      </>
    )
    const marks = Array.from(container.querySelectorAll('svg')).map((s) => s.getAttribute('data-mark'))
    expect(marks).toEqual(['claude', 'openai', null])
  })

  it('registry marks are byte-identical to their source files (simple-icons 16.33.0 / @lobehub/icons-static-svg 1.95.1)', async () => {
    const pins: Record<string, string> = {
      gemini: 'a27790dcbe07c23d88893d72097191599ebac4883fba370ea021f952fb75237f',
      copilot: '995f11748f4ada6b69d53672773139d38ceb2cc7111aaec7f21022da85a31073',
      cursor: '85eaa79be69a55d712a4843bf8d65a217d0e5b648177c8e5f2ad67fe9a46d9ad',
      opencode: 'f4f11e1603a4a49ca387925840ed9ebb4505786d6db512225205e076e54b4676',
      qwen: '03ceec197e87856774e5ccbf117d3fa2d761a5b111e378e9718759806ad5d63e',
      kimi: 'd1d77196ca0f82a0f15768b6968acdbf0d013e59d8b2f328aa20b75e4c15d2c7',
      cline: 'acae399a2d54db542d7810424e188691e994f37e5380102589e233b6a59df73b',
      amp: 'ccb72390c3853cee4c918871fd52c9bf87f2afc389d948c81d2b23453b1b482d',
      goose: '9a64d215213473edbbf4327e94e0ecb2829d91466af0f649410d9a33b0f2b62a',
      grok: 'b1c7535771ab4ca56c3678ac60cdbaccbcf7f7e53c6343717332e20bbb0c546b'
    }
    expect(Object.keys(VENDORED_MARKS).sort()).toEqual(Object.keys(pins).sort())
    for (const [id, mark] of Object.entries(VENDORED_MARKS)) {
      expect(await sha(mark.paths.join('|')), id).toBe(pins[id])
    }
    expect(VENDORED_MARKS.gemini.hex).toBe('#8E75B2')
    expect(VENDORED_MARKS.qwen.hex).toBe('#6950EF')
    expect(VENDORED_MARKS.amp.hex).toBe('#F34E3F')
    expect(VENDORED_MARKS.cursor.hex).toBeNull()
  })

  it('every registry agent renders its real mark, or the neutral initial tile when no licensed mark exists', () => {
    const { container } = render(
      <>
        {AGENT_IDS.map((id) => (
          <AgentMark key={id} id={id} />
        ))}
      </>
    )
    const marks = Array.from(container.querySelectorAll('svg')).map((s) => s.getAttribute('data-mark'))
    expect(marks).toEqual(
      AGENT_IDS.map((id) => (id === 'codex' ? 'openai' : ['aider', 'crush', 'droid', 'auggie'].includes(id) ? 'initial' : id))
    )
  })
})
