import { describe, it, expect, vi } from 'vitest'
import { ensureOrchaLink, type OrchaLinkDeps } from './orchaLink'

const SIDECAR = '/Applications/Embodent.app/Contents/Resources/orcha-runtime/bin/orcha'
const AT = '/Users/x/.local/bin/orcha'

function deps(over: Partial<OrchaLinkDeps> = {}): OrchaLinkDeps {
  return {
    sidecar: SIDECAR,
    home: '/Users/x',
    exists: (p) => p === SIDECAR,
    readLink: () => null,
    isRealFile: () => false,
    otherOrcha: () => null,
    link: vi.fn(),
    unlink: vi.fn(),
    mkdirp: vi.fn(),
    ...over
  }
}

describe('ensureOrchaLink (GH #258 plan D3)', () => {
  it('creates ~/.local/bin/orcha → the bundled runtime when no orcha is installed', () => {
    const d = deps()
    expect(ensureOrchaLink(d)).toBe('created')
    expect(d.mkdirp).toHaveBeenCalledWith('/Users/x/.local/bin')
    expect(d.link).toHaveBeenCalledWith(SIDECAR, AT)
  })

  it('keeps a link that already points at this app', () => {
    const d = deps({ readLink: () => SIDECAR })
    expect(ensureOrchaLink(d)).toBe('kept')
    expect(d.link).not.toHaveBeenCalled()
  })

  it('re-points our link when the app moved', () => {
    const d = deps({ readLink: () => '/Users/x/Downloads/Embodent.app/Contents/Resources/orcha-runtime/bin/orcha' })
    expect(ensureOrchaLink(d)).toBe('refreshed')
    expect(d.unlink).toHaveBeenCalledWith(AT)
    expect(d.link).toHaveBeenCalledWith(SIDECAR, AT)
  })

  it('never touches a developer’s own orcha (a real file, another symlink, or one on PATH)', () => {
    for (const over of [
      { isRealFile: () => true },
      { readLink: () => '/Users/x/.local/share/uv/tools/orcha-cli/bin/orcha' },
      { otherOrcha: () => '/opt/homebrew/bin/orcha' }
    ] as Partial<OrchaLinkDeps>[]) {
      const d = deps(over)
      expect(ensureOrchaLink(d)).toBe('other-orcha')
      expect(d.link).not.toHaveBeenCalled()
      expect(d.unlink).not.toHaveBeenCalled()
    }
  })

  it('does nothing outside a packaged app (no bundled runtime)', () => {
    expect(ensureOrchaLink(deps({ sidecar: null }))).toBe('no-runtime')
    expect(ensureOrchaLink(deps({ exists: () => false }))).toBe('no-runtime')
  })
})
