import { BrowserWindow, Menu, Tray, nativeImage } from 'electron'

export interface TrayController {
  update(count: number): void
  destroy(): void
}

/** Menu-bar presence. v1.1 uses a text glyph as the tray face (empty image +
 *  title) — a proper template-image icon lands with packaging. Left-click
 *  toggles the popover; right-click shows a minimal native menu. */
export function createTray(opts: {
  onOpenManager(): void
  createPopover(): BrowserWindow
  onTestNotification(): void
}): TrayController {
  const tray = new Tray(nativeImage.createEmpty())
  tray.setTitle('⬡')
  let popover: BrowserWindow | null = null

  tray.on('click', () => {
    if (popover && !popover.isDestroyed() && popover.isVisible()) {
      popover.hide()
      return
    }
    if (!popover || popover.isDestroyed()) {
      popover = opts.createPopover()
      popover.on('blur', () => {
        if (popover && !popover.isDestroyed()) popover.hide()
      })
    }
    const b = tray.getBounds()
    const { width } = popover.getBounds()
    popover.setPosition(Math.round(b.x + b.width / 2 - width / 2), Math.round(b.y + b.height + 4))
    popover.show()
  })

  tray.on('right-click', () => {
    tray.popUpContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Orcha', click: opts.onOpenManager },
        { label: 'Send test notification', click: opts.onTestNotification },
        { type: 'separator' },
        { label: 'Quit Orcha', role: 'quit' }
      ])
    )
  })

  return {
    update(count: number): void {
      if (tray.isDestroyed()) return
      tray.setTitle(count > 0 ? `⬢ ${count}` : '⬡')
    },
    destroy(): void {
      if (!tray.isDestroyed()) tray.destroy()
    }
  }
}
