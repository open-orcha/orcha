import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  AttentionItem,
  FolderChoice,
  FolderMode,
  FolderState,
  IpcResult,
  OrchaDesktopApi,
  PreflightReport,
  ProgressEvent,
  ProvisionOptions,
  ProvisionResult,
  Stack
} from '../shared/types'

/** Unwrap IpcResult: ok:false becomes a typed rejection (the BridgeError object). */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>
  if (!result.ok) {
    const { ok: _ok, ...error } = result
    throw error
  }
  return result.data
}

const api: OrchaDesktopApi = {
  listStacks: () => invoke<Stack[]>('orcha:listStacks'),
  startStack: (project) => invoke<void>('orcha:startStack', project),
  stopStack: (project) => invoke<void>('orcha:stopStack', project),
  openPortal: (project, path) => invoke<void>('orcha:openPortal', project, path),
  listAttention: () => invoke<AttentionItem[]>('orcha:listAttention'),
  openManager: () => invoke<void>('orcha:openManager'),
  quitApp: () => invoke<void>('orcha:quitApp'),
  // onboarding:
  preflight: () => invoke<PreflightReport>('orcha:preflight'),
  pickFolder: (mode: FolderMode) => invoke<FolderChoice | null>('orcha:pickFolder', mode),
  inspectFolder: (folder: string) => invoke<FolderState>('orcha:inspectFolder', folder),
  provision: (opts: ProvisionOptions) => invoke<ProvisionResult>('orcha:provision', opts),
  openOnboardingPortal: (project: string) => invoke<void>('orcha:openOnboardingPortal', project),
  onProvisionProgress: (cb) => {
    const listener = (_e: IpcRendererEvent, payload: ProgressEvent): void => cb(payload)
    ipcRenderer.on('orcha:provision:progress', listener)
    return () => ipcRenderer.removeListener('orcha:provision:progress', listener)
  },
  onNavigate: (cb) => {
    const listener = (_e: IpcRendererEvent, target: 'onboarding' | 'manager'): void => cb(target)
    ipcRenderer.on('orcha:navigate', listener)
    return () => ipcRenderer.removeListener('orcha:navigate', listener)
  }
}

contextBridge.exposeInMainWorld('orchaDesktop', api)
