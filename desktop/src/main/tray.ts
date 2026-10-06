import { BrowserWindow, Menu, Tray, nativeImage } from 'electron'
import { resourceFile } from './resources'
import { PRODUCT_NAME } from '../shared/brand'

/** extraResources file names of the menu-bar face (the @2x sibling is picked up by nativeImage). */
export const TRAY_IMAGE = 'trayTemplate.png'

export interface TrayController {
  update(count: number): void
  /** Usage in the menu bar: `title` (e.g. `C 77%`, '' = hidden) and the menu's usage rows. */
  setUsage(title: string, rows: readonly string[]): void
  destroy(): void
}

/** Menu-bar title: the decision count, then the usage figure (`3 · C 77%`). Pure. */
export function trayTitle(hasFace: boolean, count: number, usage: string): string {
  const base = hasFace ? (count > 0 ? ` ${count}` : '') : count > 0 ? `⬢ ${count}` : '⬡'
  if (!usage) return base
  return base.trim() ? `${base} · ${usage}` : ` ${usage}`
}

/** Menu-bar presence. The face is the Embodent mark silhouette as a macOS template image
 *  (resources/trayTemplate.png + @2x, black-on-transparent so the menu bar tints it);
 *  the decision count rides alongside as the title. If the image is missing (odd dev
 *  setups) it falls back to the old text glyph. Left-click toggles the popover;
 *  right-click shows a minimal native menu. */
export function createTray(opts: {
  onOpenManager(): void
  createPopover(): BrowserWindow
  onTestNotification(): void
  /** Open Stats & Usage in the manager. */
  onUsageDetails?(): void
}): TrayController {
  const face = nativeImage.createFromPath(resourceFile(TRAY_IMAGE))
  const hasFace = !face.isEmpty()
  if (hasFace) face.setTemplateImage(true)
  let count = 0
  let usage = ''
  let usageRows: readonly string[] = []
  const title = (n: number): string => trayTitle(hasFace, n, usage)
  const tray = new Tray(hasFace ? face : nativeImage.createEmpty())
  tray.setToolTip(PRODUCT_NAME)
  tray.setTitle(title(0))
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
        { label: `Open ${PRODUCT_NAME}`, click: opts.onOpenManager },
        ...(usageRows.length > 0
          ? [
              { type: 'separator' as const },
              ...usageRows.map((label) => ({ label, enabled: false })),
              ...(opts.onUsageDetails ? [{ label: 'Usage details & history…', click: opts.onUsageDetails }] : [])
            ]
          : opts.onUsageDetails
            ? [{ label: 'Usage details & history…', click: opts.onUsageDetails }]
            : []),
        { type: 'separator' },
        { label: 'Send test notification', click: opts.onTestNotification },
        { type: 'separator' },
        { label: `Quit ${PRODUCT_NAME}`, role: 'quit' }
      ])
    )
  })

  return {
    update(n: number): void {
      count = n
      if (tray.isDestroyed()) return
      tray.setTitle(title(count))
    },
    setUsage(next: string, rows: readonly string[]): void {
      usageRows = rows
      if (next === usage || tray.isDestroyed()) return
      usage = next
      tray.setTitle(title(count))
    },
    destroy(): void {
      if (!tray.isDestroyed()) tray.destroy()
    }
  }
}
