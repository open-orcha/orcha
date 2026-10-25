import { useCallback, useEffect, useRef, useState } from 'react'
import { SCAN_SLOW_MS, SCAN_TIMEOUT, SCAN_TIMEOUT_MS } from './useBoundedScan'
import type { ProjectWorktrees, WorktreeProject } from '../../../shared/types'

const noAnswer = (ms: number): string => `No answer after ${Math.round(ms / 1000)} seconds. Scan again to retry.`

const errorText = (err: unknown): string =>
  err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string'
    ? (err as { message: string }).message
    : 'Couldn’t read this project’s worktrees.'

/** `p`, or a SCAN_TIMEOUT rejection after `ms`. */
function bounded<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject({ code: SCAN_TIMEOUT, message: noAnswer(ms) }), ms)
  })
  return Promise.race([p, late]).finally(() => clearTimeout(timer))
}

/** Settings › Storage › Agent worktrees. Each project's `orcha worktrees list` takes seconds
 *  (9 s for 47 worktrees on a real Mac), and one spinner for all of them read as a frozen
 *  screen. So the projects are listed first, then each project's worktrees show as soon as its
 *  own scan answers (`results`, keyed by folder; progress = how many have landed). A slow scan
 *  is not a failed one: after `slowMs` it is `slow` (Scan works again; main joins a repeat to
 *  the scan already running). Every call is bounded by `timeoutMs`: a project that doesn't answer gets its own error and a late
 *  answer still replaces it; answers to an older scan are dropped. An app without the
 *  per-project bridge falls back to the one-shot scan. */
export function useWorktreeScan(timeoutMs = SCAN_TIMEOUT_MS, slowMs = SCAN_SLOW_MS) {
  const [projects, setProjects] = useState<WorktreeProject[] | null>(null)
  const [results, setResults] = useState<Record<string, ProjectWorktrees>>({})
  const [error, setError] = useState<unknown>(null)
  const [scanning, setScanning] = useState(false)
  const [slow, setSlow] = useState(false)
  const gen = useRef(0)

  const scan = useCallback(async (): Promise<void> => {
    const api = window.orchaDesktop
    const mine = ++gen.current
    const current = (): boolean => mine === gen.current
    const land = (p: ProjectWorktrees): void => {
      if (current()) setResults((r) => ({ ...r, [p.folder]: p }))
    }
    setScanning(true)
    setSlow(false)
    setError(null)
    const slowTimer = setTimeout(() => {
      if (current()) setSlow(true)
    }, slowMs)
    try {
      if (!api.storageWorktreeProjects || !api.storageProjectWorktrees) {
        if (!api.storageWorktrees) return
        // Keep the success handler on the original answer so a current late result
        // still replaces its timeout error, just like the per-project path.
        const answer = api.storageWorktrees().then((all) => {
          if (!current()) return
          setProjects(all.map(({ project, projectShort, folder }) => ({ project, projectShort, folder })))
          setResults(Object.fromEntries(all.map((p) => [p.folder, p])))
          setError(null)
        })
        await bounded(answer, timeoutMs)
        return
      }
      const list = await bounded(api.storageWorktreeProjects(), timeoutMs)
      if (!current()) return
      setResults({})
      setProjects(list)
      const one = api.storageProjectWorktrees
      await Promise.all(
        list.map(async (p) => {
          const answer = one(p.folder)
          try {
            land(await bounded(answer, timeoutMs))
          } catch (err) {
            land({ ...p, items: [], reclaimable_bytes: 0, error: errorText(err) })
            // A late answer still lands.
            answer.then(land, () => {})
          }
        })
      )
    } catch (err) {
      if (current()) setError(err)
    } finally {
      clearTimeout(slowTimer)
      if (current()) {
        setScanning(false)
        setSlow(false)
      }
    }
  }, [timeoutMs, slowMs])

  useEffect(() => {
    void scan()
    return () => {
      gen.current++
    }
  }, [scan])

  return { projects, results, error, scanning, slow, scan }
}
