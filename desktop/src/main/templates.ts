import path from 'node:path'
import { app } from 'electron'

/** Resolve the bundled template root. In packaged builds resources live under
 *  process.resourcesPath; in dev they sit in the repo's desktop/resources. */
export function templatesRoot(): string {
  return resourceFile('orcha-templates')
}

/** Resolve a file/dir shipped via electron-builder `extraResources` (templates, the tray
 *  template image): process.resourcesPath when packaged, desktop/resources in dev. */
export function resourceFile(name: string): string {
  // app.isPackaged is false under electron-vite dev and vitest.
  const packaged = (() => {
    try {
      return app?.isPackaged ?? false
    } catch {
      return false
    }
  })()
  if (packaged) return path.join(process.resourcesPath, name)
  return path.join(__dirname, '..', '..', 'resources', name)
}

/** Mirror of the CLI's _sanitize_name. */
export function sanitizeName(s: string): string {
  const lowered = s.toLowerCase()
  let out = ''
  for (const c of lowered) out += /[a-z0-9\-_]/.test(c) ? c : '-'
  out = out.replace(/^-+|-+$/g, '')
  return out || 'orcha'
}

export interface ComposeVars {
  projectName: string
  dbPort: number
  apiPort: number
  bridgePort: number
}

/** Mirror of the CLI's str.replace render of docker-compose.yml.j2. */
export function renderCompose(template: string, vars: ComposeVars): string {
  return template
    .split('{{ project_name }}').join(vars.projectName)
    .split('{{ db_port }}').join(String(vars.dbPort))
    .split('{{ api_port }}').join(String(vars.apiPort))
    .split('{{ bridge_port }}').join(String(vars.bridgePort))
}
