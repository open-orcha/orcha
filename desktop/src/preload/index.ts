import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  AnalyzeProjectResult,
  AttentionItem,
  CloneAndProvisionOptions,
  CloneDestSuggestion,
  FolderChoice,
  FolderMode,
  FolderState,
  GhRepo,
  GithubStatus,
  InstallProgress,
  InstallResult,
  IpcResult,
  OrchaDesktopApi,
  PreflightReport,
  PrereqProbe,
  ProgressEvent,
  ProvisionOptions,
  ProvisionResult,
  Stack,
  WizardVariant
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
  portalShow: (project, path) => invoke<void>('orcha:portalShow', project, path),
  portalHide: () => invoke<void>('orcha:portalHide'),
  resetStack: (project) => invoke<void>('orcha:resetStack', project),
  listAttention: () => invoke<AttentionItem[]>('orcha:listAttention'),
  openManager: () => invoke<void>('orcha:openManager'),
  quitApp: () => invoke<void>('orcha:quitApp'),
  // onboarding:
  preflight: () => invoke<PreflightReport>('orcha:preflight'),
  probePrereqs: () => invoke<PrereqProbe>('orcha:probePrereqs'),
  installPrereqs: () => invoke<InstallResult>('orcha:installPrereqs'),
  onInstallProgress: (cb) => {
    const listener = (_e: IpcRendererEvent, payload: InstallProgress): void => cb(payload)
    ipcRenderer.on('orcha:install:progress', listener)
    return () => ipcRenderer.removeListener('orcha:install:progress', listener)
  },
  pickFolder: (mode: FolderMode) => invoke<FolderChoice | null>('orcha:pickFolder', mode),
  inspectFolder: (folder: string) => invoke<FolderState>('orcha:inspectFolder', folder),
  provision: (opts: ProvisionOptions) => invoke<ProvisionResult>('orcha:provision', opts),
  // add project / from GitHub:
  githubStatus: () => invoke<GithubStatus>('orcha:githubStatus'),
  githubRepos: () => invoke<GhRepo[]>('orcha:githubRepos'),
  suggestCloneDest: (repoUrl: string) => invoke<CloneDestSuggestion>('orcha:suggestCloneDest', repoUrl),
  pickCloneDest: (repoName: string) => invoke<string | null>('orcha:pickCloneDest', repoName),
  cloneAndProvision: (opts: CloneAndProvisionOptions) =>
    invoke<ProvisionResult>('orcha:cloneAndProvision', opts),
  openOnboardingPortal: (project: string) => invoke<void>('orcha:openOnboardingPortal', project),
  openExternal: (url: string) => invoke<void>('orcha:openExternal', url),
  onProvisionProgress: (cb) => {
    const listener = (_e: IpcRendererEvent, payload: ProgressEvent): void => cb(payload)
    ipcRenderer.on('orcha:provision:progress', listener)
    return () => ipcRenderer.removeListener('orcha:provision:progress', listener)
  },
  onNavigate: (cb) => {
    const listener = (
      _e: IpcRendererEvent,
      nav: { target: 'onboarding' | 'manager'; variant?: WizardVariant }
    ): void => cb(nav)
    ipcRenderer.on('orcha:navigate', listener)
    return () => ipcRenderer.removeListener('orcha:navigate', listener)
  },
  onPortalActive: (cb) => {
    const listener = (_e: IpcRendererEvent, active: { project: string | null }): void => cb(active)
    ipcRenderer.on('orcha:portalActive', listener)
    return () => ipcRenderer.removeListener('orcha:portalActive', listener)
  },
  // fleet:
  portalGet: (apiPort: number, path: string) => invoke<unknown>('orcha:portalGet', apiPort, path),
  portalPost: (apiPort: number, path: string, body: unknown) =>
    invoke<unknown>('orcha:portalPost', apiPort, path, body),
  portalPut: (apiPort: number, path: string, body: unknown) =>
    invoke<unknown>('orcha:portalPut', apiPort, path, body),
  analyzeProject: (folder: string) => invoke<AnalyzeProjectResult>('orcha:analyzeProject', folder)
}

contextBridge.exposeInMainWorld('orchaDesktop', api)
