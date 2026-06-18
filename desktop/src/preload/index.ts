import { contextBridge, ipcRenderer } from 'electron'
import type {
  AttentionItem,
  BootstrapStatus,
  IpcResult,
  OrchaDesktopApi,
  Stack,
  WorkspaceResult
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
  checkDependencies: () => invoke<BootstrapStatus>('orcha:checkDependencies'),
  newWorkspace: () => invoke<WorkspaceResult>('orcha:newWorkspace')
}

contextBridge.exposeInMainWorld('orchaDesktop', api)
