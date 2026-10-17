import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { EmbedEvent, HostToPortal } from '../shared/embed'
import type { TERM_CHANNELS, TermCommand, TermEvent, TermInfo, TermRestoreResult } from '../shared/terminal'
import type { AGENT_CHANNELS, AgentsSnapshot } from '../shared/agents'
import type { PlanUsageDisplay, USAGE_CHANNELS, UsageSnapshot } from '../shared/usage'
import type { THEME_CHANNELS, ThemeState } from '../shared/theme'
import type { PROFILE_CHANNELS, ProfileSaveResult, ProfileState } from '../shared/profile'
import type { MIC_CHANNELS, MicAccess } from '../shared/mic'
import type { PROVIDER_KEYS_CHANNELS, ProviderKeysState } from '../shared/providerKeys'

/** Terminal channel names, inlined: this sandboxed preload imports shared/* for TYPES only
 *  (no shared runtime chunk). `satisfies` keeps them identical to shared/terminal.ts. */
const TERM = {
  create: 'orcha:term:create',
  write: 'orcha:term:write',
  resize: 'orcha:term:resize',
  kill: 'orcha:term:kill',
  list: 'orcha:term:list',
  focus: 'orcha:term:focus',
  data: 'orcha:term:data',
  exit: 'orcha:term:exit',
  meta: 'orcha:term:meta',
  command: 'orcha:term:command',
  layout: 'orcha:term:layout',
  restore: 'orcha:term:restore'
} as const satisfies typeof TERM_CHANNELS
/** Agents settings channels, inlined for the same reason (identical to shared/agents.ts). */
const AGENTS = {
  get: 'orcha:agents:get',
  refresh: 'orcha:agents:refresh',
  update: 'orcha:agents:update',
  openDocs: 'orcha:agents:openDocs',
  copyInstall: 'orcha:agents:copyInstall',
  changed: 'orcha:agents:changed'
} as const satisfies typeof AGENT_CHANNELS
/** Usage channels, inlined for the same reason (identical to shared/usage.ts). */
const USAGE = {
  get: 'orcha:usage:get',
  refresh: 'orcha:usage:refresh',
  update: 'orcha:usage:update',
  changed: 'orcha:usage:changed',
  openStats: 'orcha:usage:openStats',
  displayGet: 'orcha:usage:display:get',
  displaySet: 'orcha:usage:display:set',
  displayChanged: 'orcha:usage:display:changed'
} as const satisfies typeof USAGE_CHANNELS
/** Appearance channels, inlined for the same reason (identical to shared/theme.ts). */
const THEME = {
  get: 'orcha:theme:get',
  set: 'orcha:theme:set',
  changed: 'orcha:theme:changed'
} as const satisfies typeof THEME_CHANNELS
/** Profile channels, inlined for the same reason (identical to shared/profile.ts). */
const PROFILE = {
  get: 'orcha:profile:get',
  set: 'orcha:profile:set'
} as const satisfies typeof PROFILE_CHANNELS
/** API-key channels, inlined for the same reason (identical to shared/providerKeys.ts). */
const PROVIDER_KEYS = {
  get: 'orcha:providerKeys:get',
  refresh: 'orcha:providerKeys:refresh',
  save: 'orcha:providerKeys:save'
} as const satisfies typeof PROVIDER_KEYS_CHANNELS
/** Microphone channels, inlined for the same reason (identical to shared/mic.ts). */
const MIC = {
  status: 'orcha:mic:status',
  request: 'orcha:mic:request',
  openSettings: 'orcha:mic:openSettings'
} as const satisfies typeof MIC_CHANNELS
import type {
  AnalyzeProjectResult,
  AttentionItem,
  AttentionSnapshot,
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
  PortalActive,
  PreflightReport,
  PrereqProbe,
  ProgressEvent,
  ProvisionOptions,
  ProvisionResult,
  RemovePhase,
  RemovePlan,
  RemoveResult,
  Stack,
  StackDiscovery,
  StorageReport,
  ProjectWorktrees,
  AgentWorktreeCleanResult,
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
  listStacksDetailed: () => invoke<StackDiscovery>('orcha:listStacksDetailed'),
  startStack: (project) => invoke<void>('orcha:startStack', project),
  stopStack: (project) => invoke<void>('orcha:stopStack', project),
  portalShow: (project, path) => invoke<void>('orcha:portalShow', project, path),
  portalHide: () => invoke<void>('orcha:portalHide'),
  resetStack: (project) => invoke<void>('orcha:resetStack', project),
  removePlan: (project) => invoke<RemovePlan>('orcha:removePlan', project),
  removeProject: (project, opts) => invoke<RemoveResult>('orcha:removeProject', project, opts),
  onRemoveProgress: (cb) => {
    const listener = (_e: IpcRendererEvent, payload: { project: string; phase: RemovePhase }): void => cb(payload)
    ipcRenderer.on('orcha:removeProject:progress', listener)
    return () => ipcRenderer.removeListener('orcha:removeProject:progress', listener)
  },
  storageScan: () => invoke<StorageReport>('orcha:storage:scan'),
  storageRemove: (item) => invoke<void>('orcha:storage:remove', item),
  storageWorktrees: () => invoke<ProjectWorktrees[]>('orcha:storage:worktrees'),
  storageCleanWorktrees: (req) => invoke<AgentWorktreeCleanResult>('orcha:storage:worktreesClean', req),
  revealWorktree: (folder, p) => invoke<void>('orcha:storage:revealWorktree', folder, p),
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
  getPortalActive: () => invoke<PortalActive | null>('orcha:getPortalActive'),
  onPortalActive: (cb) => {
    const listener = (_e: IpcRendererEvent, active: PortalActive): void => cb(active)
    ipcRenderer.on('orcha:portalActive', listener)
    return () => ipcRenderer.removeListener('orcha:portalActive', listener)
  },
  // V2 host (embedded mode):
  listAttentionStatus: () => invoke<AttentionSnapshot>('orcha:listAttentionStatus'),
  setHostLayout: (layout) => invoke<void>('orcha:setHostLayout', layout),
  setHostModal: (open, opts) => invoke<void>('orcha:setHostModal', open, opts),
  portalSnapshot: () => invoke<Uint8Array | null>('orcha:portalSnapshot'),
  // Terminal tabs: typed channels only — never a generic invoke/send (main re-validates
  // every payload and refuses any sender but this window's main frame).
  term: {
    create: (req) => invoke<TermInfo>(TERM.create, req),
    write: (id, data) => ipcRenderer.send(TERM.write, { id, data }),
    resize: (id, cols, rows) => ipcRenderer.send(TERM.resize, { id, cols, rows }),
    kill: (id) => invoke<void>(TERM.kill, id),
    list: () => invoke<TermInfo[]>(TERM.list),
    setFocus: (focused) => ipcRenderer.send(TERM.focus, focused === true),
    saveLayout: (layout) => ipcRenderer.send(TERM.layout, layout),
    restore: (req) => invoke<TermRestoreResult>(TERM.restore, req ?? {}),
    onEvent: (cb) => {
      const onData = (_e: IpcRendererEvent, ev: TermEvent): void => cb(ev)
      ipcRenderer.on(TERM.data, onData)
      ipcRenderer.on(TERM.exit, onData)
      ipcRenderer.on(TERM.meta, onData)
      return () => {
        ipcRenderer.removeListener(TERM.data, onData)
        ipcRenderer.removeListener(TERM.exit, onData)
        ipcRenderer.removeListener(TERM.meta, onData)
      }
    },
    onCommand: (cb) => {
      const listener = (_e: IpcRendererEvent, command: TermCommand): void => cb(command)
      ipcRenderer.on(TERM.command, listener)
      return () => ipcRenderer.removeListener(TERM.command, listener)
    }
  },
  // Settings › Agents: typed channels; ids only (main looks up paths, URLs and commands).
  agents: {
    get: () => invoke<AgentsSnapshot>(AGENTS.get),
    refresh: () => invoke<AgentsSnapshot>(AGENTS.refresh),
    update: (u) => invoke<AgentsSnapshot>(AGENTS.update, u),
    openDocs: (id) => invoke<void>(AGENTS.openDocs, id),
    copyInstall: (id) => invoke<void>(AGENTS.copyInstall, id),
    onChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, s: AgentsSnapshot): void => cb(s)
      ipcRenderer.on(AGENTS.changed, listener)
      return () => ipcRenderer.removeListener(AGENTS.changed, listener)
    }
  },
  // Usage & spend: typed channels; main validates every update.
  usage: {
    get: () => invoke<UsageSnapshot>(USAGE.get),
    refresh: () => invoke<UsageSnapshot>(USAGE.refresh),
    update: (u) => invoke<UsageSnapshot>(USAGE.update, u),
    openStats: (target) => invoke<void>(USAGE.openStats, target ?? 'stats'),
    onChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, s: UsageSnapshot): void => cb(s)
      ipcRenderer.on(USAGE.changed, listener)
      return () => ipcRenderer.removeListener(USAGE.changed, listener)
    },
    onOpenStats: (cb) => {
      const listener = (_e: IpcRendererEvent, target: 'stats' | 'accounts'): void => cb(target === 'accounts' ? 'accounts' : 'stats')
      ipcRenderer.on(USAGE.openStats, listener)
      return () => ipcRenderer.removeListener(USAGE.openStats, listener)
    },
    getDisplay: () => invoke<PlanUsageDisplay>(USAGE.displayGet),
    setDisplay: (d) => invoke<PlanUsageDisplay>(USAGE.displaySet, d),
    onDisplayChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, d: PlanUsageDisplay): void => cb(d)
      ipcRenderer.on(USAGE.displayChanged, listener)
      return () => ipcRenderer.removeListener(USAGE.displayChanged, listener)
    }
  },
  // Settings › Appearance: main validates the mode and drives nativeTheme.themeSource.
  theme: {
    get: () => invoke<ThemeState>(THEME.get),
    set: (mode) => invoke<ThemeState>(THEME.set, mode),
    onChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, s: ThemeState): void => cb(s)
      ipcRenderer.on(THEME.changed, listener)
      return () => ipcRenderer.removeListener(THEME.changed, listener)
    }
  },
  // Settings › Profile: main validates the name and renames you in running projects.
  profile: {
    get: () => invoke<ProfileState>(PROFILE.get),
    set: (name) => invoke<ProfileSaveResult>(PROFILE.set, name)
  },
  // Settings › API keys: a key goes to main once (save); only masked hints come back.
  providerKeys: {
    get: () => invoke<ProviderKeysState>(PROVIDER_KEYS.get),
    refresh: () => invoke<ProviderKeysState>(PROVIDER_KEYS.refresh),
    save: (input) => invoke<ProviderKeysState>(PROVIDER_KEYS.save, input)
  },
  // Dictation: macOS microphone access (main asks TCC; portal views ask via window.orchaHost).
  mic: {
    status: () => invoke<MicAccess>(MIC.status),
    request: () => invoke<MicAccess>(MIC.request),
    openSettings: () => invoke<boolean>(MIC.openSettings)
  },
  embedSend: (msg: HostToPortal) => invoke<boolean>('orcha:embedSend', msg),
  onEmbedEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, event: EmbedEvent): void => cb(event)
    ipcRenderer.on('orcha:embed:event', listener)
    return () => ipcRenderer.removeListener('orcha:embed:event', listener)
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
