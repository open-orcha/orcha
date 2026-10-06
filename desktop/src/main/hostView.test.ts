import { describe, expect, it, vi } from 'vitest'
import { applyHostModal, resyncActiveView, showInManagerWindow, type ViewLike } from './hostView'

function fakeView(destroyed = false): ViewLike & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    setVisible: (v: boolean) => calls.push(`visible:${v}`),
    webContents: { focus: () => calls.push('view.focus'), isDestroyed: () => destroyed }
  }
}

describe('showInManagerWindow (QA 0: tray links after the window was closed)', () => {
  it('re-creates/shows the manager window BEFORE showing the portal view', () => {
    const order: string[] = []
    showInManagerWindow(
      {
        ensureManagerWindow: () => order.push('ensure'),
        showPortalView: (s: string, p?: string) => order.push(`show:${s}:${p}`)
      },
      'orcha-x',
      '/tasks?cid=c1'
    )
    expect(order).toEqual(['ensure', 'show:orcha-x:/tasks?cid=c1'])
  })
})

describe('applyHostModal (QA 4: keyboard focus follows the host dialog)', () => {
  it('on open: hides the view, tells the portal, focuses the manager webContents', () => {
    const view = fakeView()
    const manager = { focus: vi.fn() }
    const notify = vi.fn()
    expect(applyHostModal(true, view, manager, notify)).toBe(true)
    expect(view.calls).toEqual(['visible:false'])
    expect(notify).toHaveBeenCalledWith(true)
    expect(manager.focus).toHaveBeenCalledTimes(1)
  })

  it('on close: restores the view and gives it focus back', () => {
    const view = fakeView()
    const manager = { focus: vi.fn() }
    const notify = vi.fn()
    applyHostModal(false, view, manager, notify)
    expect(view.calls).toEqual(['visible:true', 'view.focus'])
    expect(notify).toHaveBeenCalledWith(false)
    expect(manager.focus).not.toHaveBeenCalled()
  })

  it('on close with focusViewOnClose=false: restores the view but keeps focus in the host (a terminal tab just opened)', () => {
    const view = fakeView()
    const manager = { focus: vi.fn() }
    applyHostModal(false, view, manager, vi.fn(), false)
    expect(view.calls).toEqual(['visible:true'])
    expect(manager.focus).toHaveBeenCalledTimes(1)
  })

  it('on close while a terminal fills the panel: the view stays hidden and focus stays in the host', () => {
    const view = fakeView()
    const manager = { focus: vi.fn() }
    applyHostModal(false, view, manager, vi.fn(), true, true)
    expect(view.calls).toEqual(['visible:false'])
    expect(manager.focus).toHaveBeenCalledTimes(1)
  })

  it('does nothing for a missing or destroyed view', () => {
    const manager = { focus: vi.fn() }
    expect(applyHostModal(true, undefined, manager, vi.fn())).toBe(false)
    const dead = fakeView(true)
    expect(applyHostModal(true, dead, manager, vi.fn())).toBe(false)
    expect(dead.calls).toEqual([])
    expect(manager.focus).not.toHaveBeenCalled()
  })
})

describe('resyncActiveView (QA 1: manager renderer reload clears a stale host modal)', () => {
  it('re-shows the active view and tells the portal the host modal is closed', () => {
    const view = fakeView()
    const notify = vi.fn()
    resyncActiveView(view, notify)
    expect(view.calls).toEqual(['visible:true'])
    expect(notify).toHaveBeenCalledWith(false)
  })

  it('ignores a destroyed view', () => {
    const view = fakeView(true)
    const notify = vi.fn()
    resyncActiveView(view, notify)
    expect(view.calls).toEqual([])
    expect(notify).not.toHaveBeenCalled()
  })
})
