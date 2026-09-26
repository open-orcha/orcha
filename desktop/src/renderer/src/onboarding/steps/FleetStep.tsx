import { useEffect, useState } from 'react'
import { Crown, Loader2, Sparkles } from 'lucide-react'
import type { RosterSuggestResponse } from '../../../../shared/types'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { resolveContainerId, resolveHumanAgentId } from '../portalIdentity'
import ProjectAnalysisCard from './ProjectAnalysisCard'
import { useProjectAnalysis, mergeSuggestions, type MergedSuggestion } from './useProjectAnalysis'

type LoadState =
  | { kind: 'loading' }
  | { kind: 'unavailable' } // feature-detect: non-200/404 on the suggest GET → auto-skip
  | { kind: 'ready'; cid: string; humanAgentId: string | null; data: RosterSuggestResponse }
  | { kind: 'creating'; cid: string; humanAgentId: string | null; data: RosterSuggestResponse }
  | { kind: 'done'; created: string[] }

/** "Meet your suggested fleet" — shown after a successful provision (first-run AND
 *  add-project). Feature-detects the roster/suggest endpoint: any non-200 (older/open CLI
 *  portals without it, most commonly 404) skips this step entirely and silently via
 *  `onUnavailable`, so the wizard's walker treats it like it was never there.
 *
 *  Alongside the instant heuristic suggestions, a deep analysis of the project via the
 *  user's own local Claude Code subscription runs in the background (see
 *  onboarding/steps/useProjectAnalysis.ts) — its suggested agents get merged into the same
 *  card grid (badged "Claude"), and its summary appears in a card above them once it
 *  resolves. The step is fully usable before/without it: accept is enabled immediately, and
 *  a late analysis result just appends more cards. */
export default function FleetStep({
  apiPort,
  folder = null,
  onDone,
  onUnavailable
}: {
  apiPort: number
  /** The just-provisioned project's folder — kicks off the background analysis. null/absent
   *  skips the analysis entirely (no shimmer), e.g. if the wizard never resolved a folder. */
  folder?: string | null
  onDone: () => void
  onUnavailable: () => void
}) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const analysis = useProjectAnalysis(folder)
  const [persisted, setPersisted] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      try {
        const cid = await resolveContainerId(apiPort)
        if (!cid) {
          if (!cancelled) onUnavailable()
          return
        }
        const data = (await window.orchaDesktop.portalGet(
          apiPort,
          `/api/containers/${cid}/roster/suggest`
        )) as RosterSuggestResponse
        if (cancelled) return
        if (!data.available || data.suggestions.length === 0) {
          onUnavailable()
          return
        }
        const humanAgentId = await resolveHumanAgentId(apiPort, cid).catch(() => null)
        if (cancelled) return
        setSelected(new Set(data.suggestions.map((s) => s.alias)))
        setState({ kind: 'ready', cid, humanAgentId, data })
      } catch {
        // Any failure (404 from an older portal, network hiccup, malformed body) — skip
        // rather than block the wizard on a step that isn't load-bearing.
        if (!cancelled) onUnavailable()
      }
    }
    void load()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiPort])

  // Once BOTH the container id and a successful analysis are known, persist it to the
  // portal (feature-detected: a 404 — older/open CLI portal without the route — is silently
  // swallowed). Fires once per mount via the `persisted` guard.
  useEffect(() => {
    if (persisted) return
    if (state.kind !== 'ready' && state.kind !== 'creating') return
    if (analysis.kind !== 'done' || !analysis.result.ok) return
    setPersisted(true)
    const { cid, humanAgentId } = state
    const { summary, agents } = analysis.result
    void window.orchaDesktop
      .portalPut(apiPort, `/api/containers/${cid}/roster/analysis`, {
        summary,
        suggestions: agents,
        source: 'claude-local',
        actor_agent_id: humanAgentId
      })
      .catch(() => {
        // Feature-detect: no such route (older/open portal) or any other failure — this is
        // a nice-to-have persist, never worth surfacing to the user.
      })
  }, [analysis, state, apiPort, persisted])

  // Once the analysis resolves, default its NEW (non-duplicate) aliases to selected too —
  // same as the heuristic list's initial seed — without touching any selection the user
  // already toggled. Written into real `selected` state (not just a render-time display
  // default) so accept — which filters by `selected` — actually includes them.
  useEffect(() => {
    if (state.kind !== 'ready') return
    if (analysis.kind !== 'done' || !analysis.result.ok) return
    const heuristicAliases = new Set(state.data.suggestions.map((s) => s.alias.toLowerCase()))
    const newAliases = analysis.result.agents
      .map((a) => a.alias)
      .filter((alias) => !heuristicAliases.has(alias.toLowerCase()))
    if (newAliases.length === 0) return
    setSelected((prev) => {
      const next = new Set(prev)
      let changed = false
      for (const alias of newAliases) {
        if (!next.has(alias)) {
          next.add(alias)
          changed = true
        }
      }
      return changed ? next : prev
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis, state])

  function toggle(alias: string): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(alias)) next.delete(alias)
      else next.add(alias)
      return next
    })
  }

  async function createFleet(): Promise<void> {
    if (state.kind !== 'ready') return
    const { cid, humanAgentId, data } = state
    setState({ kind: 'creating', cid, humanAgentId, data })
    try {
      const analysisAgents = analysis.kind === 'done' && analysis.result.ok ? analysis.result.agents : []
      const merged = mergeSuggestions(data.suggestions, analysisAgents)
      const chosen = merged.filter((s) => selected.has(s.alias)).map(({ source: _source, ...s }) => s)
      const res = (await window.orchaDesktop.portalPost(apiPort, `/api/containers/${cid}/roster/suggest/accept`, {
        suggestions: chosen,
        actor_agent_id: humanAgentId
      })) as { created?: Array<string | { alias?: string }> }
      // The accept API returns [{agent_id, alias}] rows — surface ALIASES, never
      // stringified objects ("[object Object]" bug).
      const createdAliases = (res.created ?? chosen).map((c) =>
        typeof c === 'string' ? c : (c.alias ?? '')
      ).filter(Boolean)
      setState({ kind: 'done', created: createdAliases.length ? createdAliases : chosen.map((s) => s.alias) })
    } catch {
      // Accept failing isn't fatal to onboarding — fall through to Finish without a fleet
      // rather than stranding the user on an error screen for a non-essential step.
      onDone()
    }
  }

  if (state.kind === 'loading') {
    return (
      <div className="mx-auto flex w-full max-w-[720px] flex-col items-center gap-3 py-16 text-text/60">
        <span className="onb-spin flex h-5 w-5 items-center justify-center">
          <Loader2 className="h-5 w-5 text-accent" />
        </span>
        <span className="text-sm">Looking at your project…</span>
      </div>
    )
  }

  if (state.kind === 'unavailable') return null

  if (state.kind === 'done') {
    return (
      <div className="mx-auto flex w-full max-w-[680px] flex-col gap-4 animate-slide-in">
        <div className="flex flex-col gap-1">
          <span className="onb-eyebrow">Fleet</span>
          <h2 className="onb-title text-2xl">Fleet created</h2>
          <p className="onb-body">
            {state.created.length > 0
              ? `${state.created.join(', ')} — ready to go.`
              : 'No agents were added.'}
          </p>
        </div>
        <div className="flex justify-end">
          <Button data-onb-primary="true" onClick={onDone}>
            Continue
          </Button>
        </div>
      </div>
    )
  }

  const { data } = state
  const analysisAgents = analysis.kind === 'done' && analysis.result.ok ? analysis.result.agents : []
  const merged = mergeSuggestions(data.suggestions, analysisAgents)
  const sorted = [...merged].sort((a, b) => Number(b.is_main) - Number(a.is_main))
  const creating = state.kind === 'creating'

  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4 animate-slide-in">
      <div className="flex flex-col gap-1">
        <span className="onb-eyebrow">Fleet</span>
        <h2 className="onb-title text-2xl">Meet your suggested fleet</h2>
        <p className="onb-body">
          Based on {data.signals.join(', ') || 'your project'}, here's who we'd bring on.
        </p>
      </div>

      {analysis.kind === 'pending' && (
        <p className="onb-shimmer text-xs text-text/40">Analyzing your project with Claude…</p>
      )}
      {analysis.kind === 'done' && analysis.result.ok && <ProjectAnalysisCard summary={analysis.result.summary} />}

      <div className="onb-stagger flex flex-col gap-2">
        {sorted.map((s, i) => (
          <FleetCard
            key={s.alias}
            suggestion={s}
            index={i}
            checked={selected.has(s.alias)}
            onToggle={() => toggle(s.alias)}
          />
        ))}
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone} disabled={creating}>
          Skip
        </Button>
        <Button
          data-onb-primary="true"
          onClick={() => void createFleet()}
          disabled={creating || selected.size === 0}
        >
          {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Create fleet
        </Button>
      </div>
    </div>
  )
}

function FleetCard({
  suggestion,
  index,
  checked,
  onToggle
}: {
  suggestion: MergedSuggestion
  index: number
  checked: boolean
  onToggle: () => void
}) {
  return (
    <Card
      data-selected={checked}
      className="onb-select-card flex items-start gap-3"
      style={{ '--onb-stagger-i': index } as React.CSSProperties}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        aria-label={`Include ${suggestion.alias}`}
        className="mt-1 h-4 w-4 accent-accent"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-2">
          {suggestion.is_main && <Crown className="h-3.5 w-3.5 text-accent" aria-label="Lead agent" />}
          <span className="font-medium text-text">{suggestion.alias}</span>
          <span className="text-xs text-text/50">{suggestion.role}</span>
          {suggestion.source === 'claude' && (
            <span className="inline-flex items-center gap-1 rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">
              <Sparkles className="h-2.5 w-2.5" aria-hidden="true" />
              Claude
            </span>
          )}
        </div>
        <span className="text-xs text-text/70">{suggestion.focus}</span>
        <span className="text-[11px] text-text/40">{suggestion.rationale}</span>
      </div>
    </Card>
  )
}
