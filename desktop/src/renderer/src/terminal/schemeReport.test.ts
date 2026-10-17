import { describe, it, expect } from 'vitest'
import { schemeReport } from './TerminalView'

describe('colour-scheme change report (DECSET ?2031 subscribers, e.g. Claude Code auto theme)', () => {
  it('is CSI ? 997 ; 1 n for dark and ; 2 n for light', () => {
    expect(schemeReport('dark')).toBe('\x1b[?997;1n')
    expect(schemeReport('light')).toBe('\x1b[?997;2n')
  })
})
