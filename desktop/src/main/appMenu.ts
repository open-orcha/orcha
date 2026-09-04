import type { MenuItemConstructorOptions } from 'electron'

export interface AppMenuHooks {
  onAddProject: () => void
}

/** Build the macOS app menu template. Kept pure (no Menu.setApplicationMenu) so it's unit-testable;
 *  index.ts calls Menu.buildFromTemplate(buildAppMenuTemplate(...)) + setApplicationMenu. */
export function buildAppMenuTemplate(hooks: AppMenuHooks): MenuItemConstructorOptions[] {
  const isMac = process.platform === 'darwin'
  return [
    ...(isMac
      ? [{ role: 'appMenu' as const }]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Add Project…',
          accelerator: 'CmdOrCtrl+N',
          click: () => hooks.onAddProject()
        },
        { type: 'separator' },
        isMac ? { role: 'close' as const } : { role: 'quit' as const }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]
}
