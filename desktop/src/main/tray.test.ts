import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'node:path'
import { existsSync } from 'node:fs'

const h = vi.hoisted(() => ({
  createFromPath: vi.fn(),
  setTemplateImage: vi.fn(),
  trayOpts: { toolTip: '', title: '', handlers: {} as Record<string, () => void> },
  menuTemplates: [] as Array<Array<{ label?: string; role?: string }>>
}))

vi.mock('electron', () => {
  class Tray {
    constructor(_img: unknown) {}
    setToolTip(t: string): void {
      h.trayOpts.toolTip = t
    }
    setTitle(t: string): void {
      h.trayOpts.title = t
    }
    on(ev: string, fn: () => void): void {
      h.trayOpts.handlers[ev] = fn
    }
    popUpContextMenu(): void {}
    isDestroyed(): boolean {
      return false
    }
    destroy(): void {}
  }
  return {
    app: { isPackaged: false },
    Tray,
    BrowserWindow: class {},
    Menu: { buildFromTemplate: (t: Array<{ label?: string; role?: string }>) => (h.menuTemplates.push(t), t) },
    nativeImage: {
      createFromPath: (p: string) => {
        h.createFromPath(p)
        return { isEmpty: () => false, setTemplateImage: h.setTemplateImage }
      },
      createEmpty: () => ({})
    }
  }
})

import { createTray, TRAY_IMAGE } from './tray'

describe('tray (Embodent mark template image)', () => {
  beforeEach(() => {
    h.menuTemplates.length = 0
    h.createFromPath.mockClear()
  })

  it('loads the mark template image from resources and marks it as a template', () => {
    createTray({ onOpenManager: vi.fn(), createPopover: vi.fn(), onTestNotification: vi.fn() })
    const p = h.createFromPath.mock.calls[0][0] as string
    expect(path.basename(p)).toBe(TRAY_IMAGE)
    expect(TRAY_IMAGE).toBe('trayTemplate.png')
    expect(h.setTemplateImage).toHaveBeenCalledWith(true)
    // Both densities ship in resources/ (and via electron-builder extraResources).
    const res = path.join(__dirname, '..', '..', 'resources')
    expect(existsSync(path.join(res, 'trayTemplate.png'))).toBe(true)
    expect(existsSync(path.join(res, 'trayTemplate@2x.png'))).toBe(true)
  })

  it('is branded Embodent: tooltip and right-click menu', () => {
    createTray({ onOpenManager: vi.fn(), createPopover: vi.fn(), onTestNotification: vi.fn() })
    expect(h.trayOpts.toolTip).toBe('Embodent')
    h.trayOpts.handlers['right-click']()
    const labels = h.menuTemplates.at(-1)!.map((i) => i.label)
    expect(labels).toContain('Open Embodent')
    expect(labels).toContain('Quit Embodent')
    expect(labels.join(' ')).not.toMatch(/Orcha/)
  })
})

describe('trayTitle (decisions + usage)', () => {
  it('composes the count and the usage figure', async () => {
    const { trayTitle } = await import('./tray')
    expect(trayTitle(true, 0, '')).toBe('')
    expect(trayTitle(true, 3, '')).toBe(' 3')
    expect(trayTitle(true, 0, 'C 77%')).toBe(' C 77%')
    expect(trayTitle(true, 3, 'C 77%')).toBe(' 3 · C 77%')
  })
  it('setUsage updates the title and adds the usage rows to the right-click menu', () => {
    const onUsageDetails = vi.fn()
    const t = createTray({ onOpenManager: vi.fn(), createPopover: vi.fn(), onTestNotification: vi.fn(), onUsageDetails })
    t.setUsage('C 77%', ['Claude — 5h 10% · wk 77%'])
    expect(h.trayOpts.title).toBe(' C 77%')
    h.trayOpts.handlers['right-click']()
    const labels = h.menuTemplates.at(-1)!.map((i) => i.label)
    expect(labels).toContain('Claude — 5h 10% · wk 77%')
    expect(labels).toContain('Usage details & history…')
  })
})
