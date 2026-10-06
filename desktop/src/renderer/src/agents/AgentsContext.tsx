/** Agents settings state in the renderer: one snapshot from main (prefs + detection), kept
 *  current by main's `changed` push. Everything that lists agent launchers (⌘K, the ⋯
 *  "Open" sections, the New-tab menu) reads `useLaunchers()` so they stay in step. */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { launcherIds, type AgentId, type AgentsApi, type AgentsSnapshot, type AgentUpdate } from '../../../shared/agents'

export interface AgentsValue {
  /** null until main answers (or on an older preload without the agents bridge). */
  snapshot: AgentsSnapshot | null
  available: boolean
  refreshing: boolean
  error: string | null
  refresh(): Promise<void>
  update(u: AgentUpdate): Promise<void>
  openDocs(id: AgentId): void
  copyInstall(id: AgentId): Promise<void>
}

const NONE: AgentsValue = {
  snapshot: null,
  available: false,
  refreshing: false,
  error: null,
  refresh: async () => {},
  update: async () => {},
  openDocs: () => {},
  copyInstall: async () => {}
}

const Ctx = createContext<AgentsValue>(NONE)

function msg(err: unknown): string {
  const e = err as { reason?: string; message?: string } | null
  if (e?.reason === 'INVALID') return 'That change isn’t allowed.'
  return e?.message ?? 'Something went wrong — try again.'
}

export function useAgentsController(api: AgentsApi | undefined): AgentsValue {
  const [snapshot, setSnapshot] = useState<AgentsSnapshot | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!api) return
    let alive = true
    const off = api.onChanged((s) => alive && setSnapshot(s))
    void api
      .get()
      .then((s) => alive && setSnapshot(s))
      .catch((err: unknown) => alive && setError(msg(err)))
    return () => {
      alive = false
      off()
    }
  }, [api])

  const refresh = useCallback(async () => {
    if (!api) return
    setRefreshing(true)
    setError(null)
    try {
      setSnapshot(await api.refresh())
    } catch (err) {
      setError(msg(err))
    } finally {
      setRefreshing(false)
    }
  }, [api])

  const update = useCallback(
    async (u: AgentUpdate) => {
      if (!api) return
      setError(null)
      try {
        setSnapshot(await api.update(u))
      } catch (err) {
        setError(msg(err))
      }
    },
    [api]
  )

  const openDocs = useCallback((id: AgentId) => void api?.openDocs(id).catch(() => {}), [api])
  const copyInstall = useCallback(async (id: AgentId) => {
    await api?.copyInstall(id)
  }, [api])

  return useMemo(
    () => ({ snapshot, available: !!api, refreshing, error, refresh, update, openDocs, copyInstall }),
    [snapshot, api, refreshing, error, refresh, update, openDocs, copyInstall]
  )
}

export function AgentsProvider({ value, children }: { value: AgentsValue; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAgents(): AgentsValue {
  return useContext(Ctx)
}

/** Enabled + installed agents, Default first (legacy Claude/Codex until detection is in). */
export function useLaunchers(): AgentId[] {
  const { snapshot } = useAgents()
  return useMemo(() => launcherIds(snapshot), [snapshot])
}
