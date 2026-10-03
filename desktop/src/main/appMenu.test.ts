import { describe, it, expect, vi } from 'vitest'
import { buildAppMenuTemplate } from './appMenu'

describe('app menu', () => {
  it('has a File submenu with Add Project wired to the callback', () => {
    const onAddProject = vi.fn()
    const tmpl = buildAppMenuTemplate({ onAddProject })
    const file = tmpl.find((m) => m.label === 'File')
    expect(file).toBeDefined()
    const item = (file!.submenu as Array<{ label?: string; click?: () => void; accelerator?: string }>).find(
      (i) => i.label === 'Add Project…'
    )
    expect(item).toBeDefined()
    expect(item!.accelerator).toBe('CmdOrCtrl+N')
    item!.click!()
    expect(onAddProject).toHaveBeenCalledTimes(1)
  })

  it('Settings… (⌘,) opens the desktop Settings view', () => {
    const onSettings = vi.fn()
    const tmpl = buildAppMenuTemplate({ onAddProject: vi.fn(), onSettings })
    const items = tmpl.flatMap((m) => (Array.isArray(m.submenu) ? m.submenu : [])) as Array<{ id?: string; accelerator?: string; click?: () => void }>
    const settings = items.find((i) => i.id === 'settings')!
    expect(settings.accelerator).toBe('CmdOrCtrl+,')
    settings.click!()
    expect(onSettings).toHaveBeenCalledTimes(1)
  })

  it('keeps the stock Close role when no close hook is given', () => {
    const tmpl = buildAppMenuTemplate({ onAddProject: vi.fn() })
    expect(tmpl.some((m) => m.label === 'Terminal')).toBe(false)
  })

  describe('Terminal menu (accelerators work whichever view has focus)', () => {
    type Item = { id?: string; label?: string; accelerator?: string; registerAccelerator?: boolean; click?: () => void }
    const build = () => {
      const onTerminal = vi.fn()
      const onClose = vi.fn()
      const tmpl = buildAppMenuTemplate({ onAddProject: vi.fn(), onTerminal, onClose })
      const term = tmpl.find((m) => m.label === 'Terminal')!.submenu as Item[]
      const file = tmpl.find((m) => m.label === 'File')!.submenu as Item[]
      return { onTerminal, onClose, term, file }
    }
    it('New Terminal ⌘T, the Default agent ⌥⌘T, toggle ⌃` send their commands', () => {
      const { term, onTerminal } = build()
      const byId = (id: string) => term.find((i) => i.id === id)!
      expect(byId('term-new-shell').accelerator).toBe('CmdOrCtrl+T')
      expect(byId('term-new-default-agent').accelerator).toBe('CmdOrCtrl+Alt+T')
      // no Default label given: the pre-registry behaviour (Claude)
      expect(byId('term-new-default-agent').label).toBe('New Claude Tab')
      expect(byId('term-toggle').accelerator).toBe('Ctrl+`')
      for (const id of ['term-new-shell', 'term-new-default-agent', 'term-toggle', 'term-command-menu']) byId(id).click!()
      expect(onTerminal.mock.calls.map((c) => c[0])).toEqual(['new-shell', 'new-default-agent', 'toggle-panel', 'command-menu'])
    })
    it('the ⌥⌘T item is labelled with the Default agent from Settings › Agents', () => {
      const tmpl = buildAppMenuTemplate({ onAddProject: vi.fn(), onTerminal: vi.fn(), defaultAgentLabel: 'Gemini CLI' })
      const term = tmpl.find((m) => m.label === 'Terminal')!.submenu as Item[]
      expect(term.find((i) => i.id === 'term-new-default-agent')!.label).toBe('New Gemini CLI Tab')
    })
    it('shows ⌘K for the command menu without registering it (the portal keeps its own ⌘K)', () => {
      const item = build().term.find((i) => i.id === 'term-command-menu')!
      expect(item.accelerator).toBe('CmdOrCtrl+K')
      expect(item.registerAccelerator).toBe(false)
    })
    it('routes ⌘W through the close hook (tab vs window is decided in main)', () => {
      const { file, onClose } = build()
      const close = file.find((i) => i.id === 'close')!
      expect(close.accelerator).toBe('CmdOrCtrl+W')
      close.click!()
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })

  it('macOS app menu is branded Embodent (About / Hide / Quit Embodent)', () => {
    const orig = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    try {
      const tmpl = buildAppMenuTemplate({ onAddProject: vi.fn(), onSettings: vi.fn() })
      expect(tmpl[0].label).toBe('Embodent')
      const labels = (tmpl[0].submenu as Array<{ label?: string; role?: string }>).map((i) => i.label).filter(Boolean)
      expect(labels).toEqual(expect.arrayContaining(['About Embodent', 'Hide Embodent', 'Quit Embodent']))
      expect(JSON.stringify(labels)).not.toMatch(/Orcha/)
    } finally {
      Object.defineProperty(process, 'platform', orig)
    }
  })
})

describe('View › Reload Page', () => {
  it('⌘R reloads the project page via the hook (the stock role only reloads the host window)', () => {
    let reloaded = 0
    const tpl = buildAppMenuTemplate({ onAddProject: () => {}, onReloadPage: () => void reloaded++ })
    const view = tpl.find((m) => m.label === 'View')!
    const items = view.submenu as Array<{ id?: string; accelerator?: string; click?: () => void }>
    const item = items.find((i) => i.id === 'reload-page')!
    expect(item.accelerator).toBe('CmdOrCtrl+R')
    item.click?.()
    expect(reloaded).toBe(1)
  })

  it('without the hook the stock View menu is kept', () => {
    const tpl = buildAppMenuTemplate({ onAddProject: () => {} })
    expect(tpl.some((m) => m.role === 'viewMenu')).toBe(true)
  })
})
