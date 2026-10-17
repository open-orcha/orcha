import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { RemoveOptions, RemovePhase, RemoveResult } from '../../../shared/types'
import type { ProjectRow } from './projectModel'
import type { TermTab } from '../terminal/termTabs'
import RemoveProjectDialog from './RemoveProjectDialog'
import Toast from '../ui/Toast'
import { fallbackAfterRemoval, forgetLocalPrefs, projectKeys, projectTerminals, removedToast, type PrefsStore } from './removeProject'

export interface RemovalDeps {
  rows: ProjectRow[]
  tabs: TermTab[]
  /** The compose project whose portal is open (null = home). */
  activeProject: string | null
  /** Close one terminal tab (the user already confirmed in the dialog). */
  closeTab(key: string): void
  storage: PrefsStore
  /** Forget this Mac's cached icons for these containers. */
  forgetIcons(cids: string[]): void
  /** Push the pruned prefs into the host's in-memory state. */
  applyPrefs(p: { favorites: Set<string>; order: string[]; expanded: Record<string, boolean> }): void
  openRow(row: ProjectRow): void
  showHome(): void
  refresh(): Promise<void> | void
  /** Where the toast sits (inside the sidebar column, clear of the native portal view). */
  toastStyle?: CSSProperties
}

interface Target {
  row: ProjectRow
  siblings: string[]
}

/** "Remove project…" flow for every surface (sidebar ⋯, All projects ⋯, ⌘K): the dialog,
 *  progress / error / retry, the app-state cleanup and fallback navigation on success, and
 *  the toast. */
export function useProjectRemoval(deps: RemovalDeps): { request(row: ProjectRow): void; open: boolean; ui: ReactNode } {
  const depsRef = useRef(deps)
  depsRef.current = deps
  const [target, setTarget] = useState<Target | null>(null)
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<RemovePhase | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [toast, setToast] = useState<{ message: string; details: string[] } | null>(null)

  const project = target?.row.stack.project ?? null
  useEffect(() => {
    const api = window.orchaDesktop
    if (!project || !api.onRemoveProgress) return
    return api.onRemoveProgress((e) => {
      if (e.project === project) setPhase(e.phase)
    })
  }, [project])

  const request = useCallback((row: ProjectRow) => {
    const siblings = depsRef.current.rows
      .filter((r) => r.stack.project === row.stack.project && r.key !== row.key && r.container)
      .map((r) => r.name)
    setError(null)
    setPhase(null)
    setTarget({ row, siblings })
  }, [])

  const cancel = useCallback(() => {
    if (!busy) setTarget(null)
  }, [busy])

  const confirm = useCallback(
    async (opts: RemoveOptions) => {
      const t = target
      const api = window.orchaDesktop
      if (!t || !api.removeProject) return
      const proj = t.row.stack.project
      setBusy(true)
      setError(null)
      setPhase('stopping')
      let result: RemoveResult
      try {
        result = await api.removeProject(proj, opts)
      } catch (err) {
        setError(err)
        setBusy(false)
        setPhase(null)
        void depsRef.current.refresh()
        return
      }
      const d = depsRef.current
      // Terminals opened for it (the dialog named the running ones).
      for (const key of projectTerminals(d.tabs, proj).keys) d.closeTab(key)
      // This Mac's prefs and caches for it.
      const { cids } = projectKeys(d.rows, proj)
      d.forgetIcons(cids)
      d.applyPrefs(forgetLocalPrefs(d.storage, proj, cids))
      // The open project went away: land on another project, or home.
      if (d.activeProject === proj) {
        const next = fallbackAfterRemoval(d.rows, proj)
        if (next) d.openRow(next)
        else d.showHome()
      }
      setBusy(false)
      setPhase(null)
      setTarget(null)
      setToast({ message: removedToast(t.row.name, result), details: result.warnings.slice(0, 3) })
      await d.refresh()
    },
    [target]
  )

  const dismissToast = useCallback(() => setToast(null), [])
  // Stable per project: the dialog loads the plan once, not on every re-render.
  const loadPlan = useMemo(() => {
    const api = window.orchaDesktop
    return project && api?.removePlan ? () => api.removePlan!(project) : undefined
  }, [project])
  const ui = (
    <>
      {target && (
        <RemoveProjectDialog
          name={target.row.name}
          project={target.row.stack.project}
          projectShort={target.row.stack.projectShort}
          siblings={target.siblings}
          liveTerminals={projectTerminals(deps.tabs, target.row.stack.project).live}
          loadPlan={loadPlan}
          busy={busy}
          phase={phase}
          error={error}
          onCancel={cancel}
          onConfirm={(opts) => void confirm(opts)}
        />
      )}
      {toast && <Toast message={toast.message} details={toast.details} onDismiss={dismissToast} style={deps.toastStyle} />}
    </>
  )
  return { request, open: target !== null, ui }
}
