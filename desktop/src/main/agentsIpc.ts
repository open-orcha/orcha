/** Agents settings controller: the only way the renderer reads or changes agent prefs,
 *  (re)runs detection, opens a docs link or copies an install command. Electron-free
 *  (index.ts adapts ipcMain + shell + clipboard) so the whole surface is unit-tested in
 *  agentsIpc.test.ts.
 *
 *  - Same sender rule as the terminal channels: the manager window's main frame only.
 *  - Every payload is re-validated (shared/agents.ts parseAgentUpdate); ids, never URLs or
 *    commands, cross the bridge. Docs URLs and install commands are looked up in the registry.
 *  - Prefs here are for terminals the USER launches from the desktop app only. Orcha's
 *    managed agents / notifier run in the stack and never read this. */
import {
  AGENT_IDS,
  agentDef,
  applyAgentUpdate,
  reconcileDefault,
  composeAgentArgs,
  docsUrlFor,
  isAgentId,
  parseAgentUpdate,
  type AgentId,
  type AgentPrefs,
  type AgentsSnapshot
} from '../shared/agents'
import type { AgentDetector } from './agentDetect'
import { acceptTermSender, type SenderFacts } from './terminalIpc'
import type { AgentLaunch } from './terminalLaunch'

export class AgentsRequestError extends Error {
  constructor(readonly code: 'FORBIDDEN' | 'INVALID') {
    super(code)
  }
}

export interface AgentsControllerDeps {
  detector: AgentDetector
  load(): { prefs: AgentPrefs; migrated: boolean }
  save(prefs: AgentPrefs): void
  openExternal(url: string): Promise<void>
  copyText(text: string): void
  /** Prefs or detection changed (push to the renderer, rebuild the app menu). */
  onChange(s: AgentsSnapshot): void
}

export function createAgentsController(deps: AgentsControllerDeps) {
  const loaded = deps.load()
  let prefs = loaded.prefs
  if (loaded.migrated) deps.save(prefs)

  const installedSet = (): ReadonlySet<AgentId> | null => {
    const d = deps.detector.current()
    return d.status === 'ready' ? new Set(AGENT_IDS.filter((id) => d.paths[id])) : null
  }

  const snapshot = (): AgentsSnapshot => {
    const d = deps.detector.current()
    return {
      permissionMode: prefs.permissionMode,
      restoreSessions: prefs.restoreSessions,
      resumeAgents: prefs.resumeAgents,
      defaultAgent: prefs.defaultAgent,
      detection: d.status,
      detectedAt: d.at,
      agents: AGENT_IDS.map((id) => ({
        id,
        enabled: prefs.agents[id].enabled,
        extraArgs: [...prefs.agents[id].extraArgs],
        installed: d.status === 'ready' ? !!d.paths[id] : null,
        path: d.paths[id] ?? null
      }))
    }
  }

  const guard = (f: SenderFacts): void => {
    if (!acceptTermSender(f)) throw new AgentsRequestError('FORBIDDEN')
  }

  const refresh = async (): Promise<AgentsSnapshot> => {
    await deps.detector.refresh()
    const healed = reconcileDefault(prefs, installedSet())
    if (healed !== prefs) {
      prefs = healed
      deps.save(prefs)
    }
    const s = snapshot()
    deps.onChange(s)
    return s
  }

  return {
    snapshot,
    prefs: (): AgentPrefs => prefs,
    /** Kick off the first detection without waiting (app start). */
    warm(): void {
      void refresh().catch(() => {})
    },
    async get(f: SenderFacts): Promise<AgentsSnapshot> {
      guard(f)
      if (deps.detector.current().status === 'pending') return refresh()
      return snapshot()
    },
    async refresh(f: SenderFacts): Promise<AgentsSnapshot> {
      guard(f)
      return refresh()
    },
    update(f: SenderFacts, raw: unknown): AgentsSnapshot {
      guard(f)
      const u = parseAgentUpdate(raw)
      if (!u) throw new AgentsRequestError('INVALID')
      prefs = applyAgentUpdate(prefs, u, installedSet())
      deps.save(prefs)
      const s = snapshot()
      deps.onChange(s)
      return s
    },
    async openDocs(f: SenderFacts, raw: unknown): Promise<void> {
      guard(f)
      const url = docsUrlFor(raw)
      if (!url) throw new AgentsRequestError('INVALID')
      await deps.openExternal(url)
    },
    copyInstall(f: SenderFacts, raw: unknown): void {
      guard(f)
      if (!isAgentId(raw)) throw new AgentsRequestError('INVALID')
      deps.copyText(agentDef(raw).install)
    },
    /** What main runs for an agent tab (terminalIpc): resolved path + composed argv. */
    launchFor(id: AgentId, probe: boolean): AgentLaunch {
      return {
        path: deps.detector.pathFor(id),
        args: composeAgentArgs(id, prefs.permissionMode, prefs.agents[id].extraArgs, probe)
      }
    }
  }
}

export type AgentsController = ReturnType<typeof createAgentsController>
