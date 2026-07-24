/** Registers the validated IPC boundary between the renderer and host services. */
import { dialog, ipcMain, shell } from 'electron'
import os from 'node:os'
import { rmSync } from 'node:fs'
import { dockerExec } from './dockerExec'
import { dockerPublishedPorts, pickFreePort } from './portPicker'
import { engineDeps } from './engineAdapter'
import { inspectFolder } from './folderModes'
import { provision, type EngineDeps } from './initEngine'
import { planInstall, runInstall } from './installers'
import { startStack, stopStack } from './lifecycle'
import { listStacks } from './discovery'
import { preflight } from './preflight'
import {
  persistApiKey,
  probePrereqs,
  promptApiKey,
  runAdminInstall,
  runUserInstall
} from './prerequisites'
import { resetStack } from './resetEngine'
import {
  openPortalWindow,
  sendToManager,
  showManagerWindow
} from './windows'
import type { AttentionPoller } from './attentionPoller'
import type {
  BridgeError,
  FolderMode,
  InstallResult,
  IpcResult,
  ProgressEvent,
  ProvisionOptions,
  Stack
} from '../shared/types'

function asResult<T>(operation: () => Promise<T>): Promise<IpcResult<T>> {
  return operation().then(
    (data) => ({ ok: true as const, data }),
    (error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error) {
        return { ok: false as const, ...(error as BridgeError) }
      }
      console.error('[orcha-desktop] unexpected handler rejection:', error)
      return { ok: false as const, code: 'INTERNAL' as const }
    }
  )
}

async function requireKnownStack(project: string): Promise<Stack> {
  const stack = (await listStacks()).find((candidate) => candidate.project === project)
  if (!stack) throw { code: 'UNKNOWN_STACK' } as const
  return stack
}

async function reserveProvisionPorts(): Promise<Record<number, number>> {
  const taken = await dockerPublishedPorts()
  const database = await pickFreePort(5432, { dockerPorts: taken })
  taken.add(database)
  const api = await pickFreePort(8000, { dockerPorts: taken })
  taken.add(api)
  const bridge = await pickFreePort(8765, { dockerPorts: taken })
  return { 5432: database, 8000: api, 8765: bridge }
}

/** Register every renderer-callable operation once Electron is ready. */
export function registerIpcHandlers(
  getPoller: () => AttentionPoller | null
): void {
  ipcMain.handle('orcha:listStacks', () => asResult(() => listStacks()))
  ipcMain.handle('orcha:startStack', (_event, project: string) =>
    asResult(async () => startStack((await requireKnownStack(project)).project))
  )
  ipcMain.handle('orcha:stopStack', (_event, project: string) =>
    asResult(async () => stopStack((await requireKnownStack(project)).project))
  )
  ipcMain.handle('orcha:resetStack', (_event, project: string) =>
    asResult(async () => {
      const stack = await requireKnownStack(project)
      await resetStack(stack.project, stack.folder, {
        exec: dockerExec,
        rmrf: (target) => rmSync(target, { recursive: true, force: true }),
        rmFile: (target) => rmSync(target, { force: true })
      })
    })
  )
  ipcMain.handle('orcha:openPortal', (_event, project: string, path?: unknown) =>
    asResult(async () => {
      const stack = await requireKnownStack(project)
      if (!stack.running || stack.apiPort === null) {
        throw { code: 'UNKNOWN_STACK' } as const
      }
      const safePath = typeof path === 'string' && /^\/(?![/\\])/.test(path) ? path : '/'
      openPortalWindow(stack, safePath)
    })
  )
  ipcMain.handle('orcha:listAttention', () =>
    asResult(async () => getPoller()?.current() ?? [])
  )
  ipcMain.handle('orcha:openManager', () =>
    asResult(async () => showManagerWindow())
  )
  ipcMain.handle('orcha:quitApp', () =>
    asResult(async () => {
      const { app } = await import('electron')
      app.quit()
    })
  )
  registerOnboardingHandlers()
}

function registerOnboardingHandlers(): void {
  ipcMain.handle('orcha:preflight', () => asResult(() => preflight()))
  ipcMain.handle('orcha:probePrereqs', () => asResult(() => probePrereqs()))
  ipcMain.handle('orcha:installPrereqs', () =>
    asResult(async (): Promise<InstallResult> => {
      const steps = planInstall(await probePrereqs(), {
        arch: os.arch(),
        user: os.userInfo().username || 'operator'
      }).filter((step) => step.id === 'orcha')
      if (steps.length === 0) return { ok: true, completed: [] }
      return runInstall(steps, {
        runUser: runUserInstall,
        runAdmin: runAdminInstall,
        promptSecret: promptApiKey,
        persistApiKey,
        onProgress: (event) => sendToManager('orcha:install:progress', event)
      })
    })
  )
  ipcMain.handle('orcha:pickFolder', (_event, mode: FolderMode) =>
    asResult(async () => {
      const result = await dialog.showOpenDialog({
        properties:
          mode === 'new-blank' ? ['openDirectory', 'createDirectory'] : ['openDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) return null
      return { folder: result.filePaths[0], mode }
    })
  )
  ipcMain.handle('orcha:inspectFolder', (_event, folder: string) =>
    asResult(async () => inspectFolder(folder))
  )
  ipcMain.handle('orcha:provision', (_event, options: ProvisionOptions) =>
    asResult(async () => {
      const reserved = await reserveProvisionPorts()
      const deps: EngineDeps = {
        ...engineDeps(),
        findFreePort: (start) => reserved[start] ?? start
      }
      return provision(
        options,
        (event: ProgressEvent) => sendToManager('orcha:provision:progress', event),
        deps
      )
    })
  )
  ipcMain.handle('orcha:openOnboardingPortal', (_event, project: string) =>
    asResult(async () => {
      const stack = (await listStacks()).find((candidate) => candidate.project === project)
      if (stack?.running && stack.apiPort !== null) openPortalWindow(stack, '/onboarding')
    })
  )
  ipcMain.handle('orcha:openExternal', (_event, url: unknown) =>
    asResult(async () => {
      if (typeof url === 'string' && /^https:\/\//.test(url)) {
        await shell.openExternal(url)
      }
    })
  )
}
