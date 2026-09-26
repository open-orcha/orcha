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
  analysisAgents: { alias: string; role: string; focus: string; rationale: string }[]
): MergedSuggestion[] {
  const seen = new Set(heuristic.map((s) => s.alias.toLowerCase()))
  const merged: MergedSuggestion[] = heuristic.map((s) => ({ ...s, source: 'heuristic' as const }))
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

export type AnalysisState =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'done'; result: AnalyzeProjectResult }

/** Kick off `analyzeProject(folder)` in the background as soon as it mounts with a folder,
 *  never blocking the step it's used from — FleetStep renders fully usable immediately and
 *  appends the analysis card whenever (if ever) this resolves. Cancels its effect on unmount
 *  so a fast step-skip never sets state on an unmounted component. */
export function useProjectAnalysis(folder: string | null): AnalysisState {
  const [state, setState] = useState<AnalysisState>(folder ? { kind: 'pending' } : { kind: 'idle' })
  const startedFor = useRef<string | null>(null)

  useEffect(() => {
    if (!folder || startedFor.current === folder) return
    startedFor.current = folder
    let cancelled = false
    setState({ kind: 'pending' })
    void window.orchaDesktop
      .analyzeProject(folder)
      .then((result) => {
        if (!cancelled) setState({ kind: 'done', result })
      })
      .catch((err: unknown) => {
        // analyzeProject's IPC handler never rejects in practice (it collapses failures to
        // ok:false), but a stale/killed IPC channel could still reject the promise itself —
        // treat that identically to an ok:false result rather than leaving `pending` forever.
        if (!cancelled) {
          const reason = (err as { code?: string })?.code ?? 'analysis unavailable'
          setState({ kind: 'done', result: { ok: false, reason } })
        }
      })
    return () => {
      cancelled = true
    }
  }, [folder])

  return state
}
