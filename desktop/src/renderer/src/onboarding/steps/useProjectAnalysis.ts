import { useEffect, useRef, useState } from 'react'
import type { AnalyzeProjectResult, RosterSuggestion } from '../../../../shared/types'

/** A roster suggestion tagged with where it came from — the heuristic roster/suggest
 *  endpoint, or the local Claude analysis. Merged into one list for FleetStep's card grid;
 *  the badge is the only UI difference, so is_main / rationale / role / focus all still read
 *  the same regardless of source. */
export interface MergedSuggestion extends RosterSuggestion {
  source: 'heuristic' | 'claude'
}

/** Merge the analysis's suggested agents into the heuristic roster/suggest list, de-duped by
 *  alias (heuristic wins the slot on a collision — it already carries an `is_main`/rationale
 *  shape tuned for this project; the analysis entry for that alias is just dropped rather
 *  than overwriting it). Every analysis-only entry is tagged source:'claude', every
 *  heuristic entry source:'heuristic'. Pure. */
export function mergeSuggestions(
  heuristic: RosterSuggestion[],
  analysisAgents: {
    alias: string
    role: string
    focus: string
    rationale: string
  }[]
): MergedSuggestion[] {
  const seen = new Set(heuristic.map((s) => s.alias.toLowerCase()))
  const merged: MergedSuggestion[] = heuristic.map((s) => ({
    ...s,
    source: 'heuristic' as const
  }))
  for (const a of analysisAgents) {
    const key = a.alias.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    merged.push({
      alias: a.alias,
      role: a.role,
      focus: a.focus,
      rationale: a.rationale,
      is_main: false,
      source: 'claude'
    })
  }
  return merged
}

export type AnalysisState = { kind: 'idle' } | { kind: 'pending' } | { kind: 'done'; result: AnalyzeProjectResult }

/** Kick off `analyzeProject(folder)` in the background as soon as it mounts with a folder,
 *  never blocking the step it's used from — FleetStep renders fully usable immediately and
 *  appends the analysis card whenever (if ever) this resolves.
 *
 *  The analysis is expensive (a real Claude run), so it starts at most ONCE per folder per
 *  mount: the in-flight promise is kept in a ref and every effect run (React StrictMode runs
 *  effects twice in dev) subscribes to that same promise with its own cancel flag. The old
 *  "startedFor" guard returned early on the second run, whose cleanup had already cancelled
 *  the first — so the result was never applied and the shimmer spun forever. */
export function useProjectAnalysis(folder: string | null): AnalysisState {
  const [state, setState] = useState<AnalysisState>(folder ? { kind: 'pending' } : { kind: 'idle' })
  const inflight = useRef<{
    folder: string
    promise: Promise<AnalyzeProjectResult>
  } | null>(null)

  useEffect(() => {
    if (!folder) return
    if (!inflight.current || inflight.current.folder !== folder) {
      const promise = window.orchaDesktop.analyzeProject(folder).catch((err: unknown): AnalyzeProjectResult => ({
        // The IPC handler collapses failures to ok:false, but a stale/killed channel can
        // still reject — treat that like any other unavailable analysis.
        ok: false,
        reason: (err as { code?: string })?.code ?? 'analysis unavailable'
      }))
      inflight.current = { folder, promise }
      setState({ kind: 'pending' })
    }
    let cancelled = false
    void inflight.current.promise.then((result) => {
      if (!cancelled) setState({ kind: 'done', result })
    })
    return () => {
      cancelled = true
    }
  }, [folder])

  return state
}
