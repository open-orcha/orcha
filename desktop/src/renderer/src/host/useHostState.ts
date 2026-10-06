import { useCallback, useEffect, useRef, useState } from 'react'
import type { AttentionSnapshot, PortalActive, Stack } from '../../../shared/types'
import type { EmbedMode, LiveAgent, PortalToHost } from '../../../shared/embed'
import { loadProjectCards, type ProjectCardData } from '../home/loadProjectCards'
import type { PortalAttention } from './projectModel'

/** Host sidebar cadence (arch §4): the project list + host attention poll every 10 s — not
 *  per row, not per 3 s. The selected project's live numbers come from its portal instead. */
export const HOST_POLL_MS = 10_000

type RouteMsg = Extract<PortalToHost, { type: 'route' }>

export interface PortalLive {
  route: RouteMsg | null
  attention: PortalAttention | null
  liveAgents: { cid: string | null; agents: LiveAgent[]; at: number } | null
  ready: boolean
}

export interface HostState {
  loaded: boolean
  dockerDown: boolean
  /** Docker's CLI timed out (wedged) rather than refused — only meaningful with dockerDown. */
  dockerUnresponsive: boolean
  stacks: Stack[]
  cards: ProjectCardData[]
  attention: AttentionSnapshot | null
  /** Main is the source of truth for which view is showing (tray/deep links change it). */
  activeProject: string | null
  embed: EmbedMode | null
  /** Per-stack live data reported by its V2 portal (validated + sender-tagged by main). */
  portal: Record<string, PortalLive>
  refresh: () => Promise<void>
}

const EMPTY_LIVE: PortalLive = { route: null, attention: null, liveAgents: null, ready: false }

export function useHostState(): HostState {
  const [loaded, setLoaded] = useState(false)
  const [dockerDown, setDockerDown] = useState(false)
  const [dockerUnresponsive, setDockerUnresponsive] = useState(false)
  const [stacks, setStacks] = useState<Stack[]>([])
  const [cards, setCards] = useState<ProjectCardData[]>([])
  const [attention, setAttention] = useState<AttentionSnapshot | null>(null)
  const [activeProject, setActiveProject] = useState<string | null>(null)
  const [embed, setEmbed] = useState<EmbedMode | null>(null)
  const [portal, setPortal] = useState<Record<string, PortalLive>>({})
  const seq = useRef(0)

  const refresh = useCallback(async () => {
    const mine = ++seq.current
    const api = window.orchaDesktop
    try {
      const s = await api.listStacks()
      const [c, a] = await Promise.all([
        loadProjectCards(s, api.portalGet),
        api.listAttentionStatus ? api.listAttentionStatus().catch(() => null) : Promise.resolve(null)
      ])
      if (mine !== seq.current) return // a newer refresh won; drop this stale result
      setStacks(s)
      setCards(c)
      setAttention(a)
      setDockerDown(false)
      setDockerUnresponsive(false)
    } catch (err) {
      if (mine !== seq.current) return
      setStacks([])
      setCards([])
      setDockerDown(true)
      setDockerUnresponsive((err as { unresponsive?: boolean } | null)?.unresponsive === true)
    } finally {
      if (mine === seq.current) setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), HOST_POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  useEffect(() => {
    const apply = (active: PortalActive): void => {
      setActiveProject(active.project)
      setEmbed(active.project === null ? null : (active.embed ?? 'pending'))
      const route = active.route
      if (active.project && route) {
        const project = active.project
        setPortal((prev) => ({ ...prev, [project]: { ...(prev[project] ?? EMPTY_LIVE), route } }))
      }
    }
    const off = window.orchaDesktop.onPortalActive(apply)
    // Pull once on mount: after a renderer reload (or a re-created window) main may have
    // pushed before this listener existed (QA).
    let alive = true
    const pull = window.orchaDesktop.getPortalActive?.()
    if (pull) {
      void Promise.resolve(pull)
        .then((active) => { if (alive && active) apply(active) })
        .catch(() => { /* bridge error: the next push re-syncs */ })
    }
    return () => { alive = false; off() }
  }, [])

  useEffect(() => {
    const api = window.orchaDesktop
    if (!api.onEmbedEvent) return
    return api.onEmbedEvent(({ project, msg }) => {
      setPortal((prev) => {
        const cur = prev[project] ?? EMPTY_LIVE
        switch (msg.type) {
          case 'ready':
            // a new full load: the previous load's attention/agents may belong to another
            // container — drop them until this load reports its own (QA: scope)
            return { ...prev, [project]: { ...cur, ready: true, attention: null, liveAgents: null } }
          case 'route':
            return { ...prev, [project]: { ...cur, route: msg } }
          case 'attention':
            return { ...prev, [project]: { ...cur, attention: { cid: msg.cid, count: msg.count, partial: msg.partial } } }
          case 'liveAgents':
            return { ...prev, [project]: { ...cur, liveAgents: { cid: msg.cid, agents: msg.agents, at: Date.now() } } }
          default:
            return prev
        }
      })
    })
  }, [])

  return { loaded, dockerDown, dockerUnresponsive, stacks, cards, attention, activeProject, embed, portal, refresh }
}
