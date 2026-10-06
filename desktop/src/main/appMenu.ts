import type { MenuItemConstructorOptions } from 'electron'
import type { TermCommand } from '../shared/terminal'
import { PRODUCT_NAME } from '../shared/brand'

export interface AppMenuHooks {
  onAddProject: () => void
  /** Terminal menu commands (forwarded to the host renderer). Optional so older callers and
   *  tests that only care about File keep working. */
  onTerminal?: (command: TermCommand) => void
  /** File → Close (⌘W). When provided, main decides between "close terminal tab" (focus in
   *  the dock) and "close window"; without it the stock role is used. */
  onClose?: () => void
  /** App › Settings… (⌘,) — the desktop Settings view (Agents). */
  onSettings?: () => void
  /** Label of the Default agent (Settings › Agents) for the ⌥⌘T item; defaults to Claude. */
  defaultAgentLabel?: string
  /** View › Reload Page (⌘R): reload the project page on screen. The stock `reload` role only
   *  reloads the host window, never the embedded portal — so a portal upgraded underneath
   *  (`orcha upgrade`) kept showing its old build until the app restarted. */
  onReloadPage?: () => void
}

/** Build the macOS app menu template. Kept pure (no Menu.setApplicationMenu) so it's unit-testable;
 *  index.ts calls Menu.buildFromTemplate(buildAppMenuTemplate(...)) + setApplicationMenu.
 *
 *  Terminal accelerators live in the MENU (not a renderer keydown) so they work whichever
 *  surface has focus — the host chrome, a terminal, or the embedded portal view. ⌘K is
 *  shown but not registered: the host renderer opens the command menu itself, and inside
 *  the portal ⌘K stays the portal's own search. */
export function buildAppMenuTemplate(hooks: AppMenuHooks): MenuItemConstructorOptions[] {
  const isMac = process.platform === 'darwin'
  const term = hooks.onTerminal
  const close: MenuItemConstructorOptions = hooks.onClose
    ? { id: 'close', label: isMac ? 'Close' : 'Close Window', accelerator: 'CmdOrCtrl+W', click: () => hooks.onClose?.() }
    : isMac
      ? { role: 'close' as const }
      : { role: 'quit' as const }
  return [
    ...(isMac
      ? [
          hooks.onSettings
            ? ({
                // First macOS menu = the app menu (titled with the app name by the OS).
                label: PRODUCT_NAME,
                submenu: [
                  { role: 'about' as const, label: `About ${PRODUCT_NAME}` },
                  { type: 'separator' as const },
                  { id: 'settings', label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => hooks.onSettings?.() },
                  { type: 'separator' as const },
                  { role: 'services' as const },
                  { type: 'separator' as const },
                  { role: 'hide' as const, label: `Hide ${PRODUCT_NAME}` },
                  { role: 'hideOthers' as const },
                  { role: 'unhide' as const },
                  { type: 'separator' as const },
                  { role: 'quit' as const, label: `Quit ${PRODUCT_NAME}` }
                ]
              } satisfies MenuItemConstructorOptions)
            : { role: 'appMenu' as const }
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Add Project…',
          accelerator: 'CmdOrCtrl+N',
          click: () => hooks.onAddProject()
        },
        ...(!isMac && hooks.onSettings
          ? [{ id: 'settings', label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => hooks.onSettings?.() }]
          : []),
        { type: 'separator' },
        close
      ]
    },
    { role: 'editMenu' },
    hooks.onReloadPage
      ? ({
          label: 'View',
          submenu: [
            { id: 'reload-page', label: 'Reload Page', accelerator: 'CmdOrCtrl+R', click: () => hooks.onReloadPage?.() },
            { role: 'forceReload' as const, label: 'Reload App Window' },
            { role: 'toggleDevTools' as const },
            { type: 'separator' as const },
            { role: 'resetZoom' as const },
            { role: 'zoomIn' as const },
            { role: 'zoomOut' as const },
            { type: 'separator' as const },
            { role: 'togglefullscreen' as const }
          ]
        } satisfies MenuItemConstructorOptions)
      : { role: 'viewMenu' as const },
    ...(term
      ? [
          {
            label: 'Terminal',
            submenu: [
              { id: 'term-new-shell', label: 'New Terminal', accelerator: 'CmdOrCtrl+T', click: () => term('new-shell') },
              {
                id: 'term-new-default-agent',
                label: `New ${hooks.defaultAgentLabel ?? 'Claude'} Tab`,
                accelerator: 'CmdOrCtrl+Alt+T',
                click: () => term('new-default-agent')
              },
              { type: 'separator' as const },
              { id: 'term-toggle', label: 'Toggle Terminal Panel', accelerator: 'Ctrl+`', click: () => term('toggle-panel') },
              {
                id: 'term-command-menu',
                label: 'Command Menu…',
                accelerator: 'CmdOrCtrl+K',
                registerAccelerator: false,
                click: () => term('command-menu')
              }
            ]
          } satisfies MenuItemConstructorOptions
        ]
      : []),
    { role: 'windowMenu' }
  ]
}
