/** Electron-free host ↔ native-view choreography extracted from index.ts so the ordering and
 *  focus rules are unit-testable (QA findings 0, 1, 4). index.ts passes the real
 *  BrowserWindow / WebContentsView objects, which satisfy these structural types. */

export interface Focusable {
  focus(): void
}

export interface ViewLike {
  setVisible(visible: boolean): void
  webContents: Focusable & { isDestroyed(): boolean }
}

/** Open a project's view from any entry point (tray popover, notification, deep link).
 *  After Cmd+W on macOS the manager window is gone while the app lives on in the tray, so
 *  the window MUST be (re)created before the view is shown — otherwise the show is a silent
 *  no-op (QA 0). */
export function showInManagerWindow<S>(
  deps: { ensureManagerWindow: () => void; showPortalView: (stack: S, path?: string) => void },
  stack: S,
  path?: string
): void {
  deps.ensureManagerWindow()
  deps.showPortalView(stack, path)
}

/** A host dialog opened/closed. Hide/restore the active native view and move keyboard focus
 *  with it: a hidden view that still holds focus would swallow Escape/Enter/Tab meant for the
 *  host dialog (QA 4). Returns false when there was no live view to act on. */
export function applyHostModal(
  open: boolean,
  view: ViewLike | undefined,
  manager: Focusable,
  notifyPortal: (open: boolean) => void,
  /** On close: hand focus back to the view (default) or keep it in the host renderer (the
   *  command menu just opened a terminal tab there). */
  focusViewOnClose = true,
  /** A terminal session fills the panel: the view stays hidden (and focus stays in the host)
   *  even after the dialog closes. */
  terminalShown = false
): boolean {
  if (!view || view.webContents.isDestroyed()) return false
  view.setVisible(!open && !terminalShown)
  notifyPortal(open)
  if (open || !focusViewOnClose || terminalShown) manager.focus()
  else view.webContents.focus()
  return true
}

/** The manager renderer (re)loaded or its process died: any host dialog that was open never
 *  ran its cleanup, so the host-modal flag is stale. Re-show the active view and tell the
 *  portal no host modal is open. The caller resets its flag, re-applies bounds and re-sends
 *  portalActive (QA 1). */
export function resyncActiveView(view: ViewLike | undefined, notifyPortal: (open: boolean) => void): void {
  if (!view || view.webContents.isDestroyed()) return
  view.setVisible(true)
  notifyPortal(false)
}
