import { useCallback, useEffect, useRef, useState } from 'react'
import type { PrereqProbe } from '../../../shared/types'

export interface PreflightChecks {
  probe: PrereqProbe | null
  /** A check round is in flight. */
  checking: boolean
  /** The tool probe (AI CLI / helper) hasn't answered yet. */
  probeLoading: boolean
  /** The check itself failed (rejected), as opposed to reporting a missing tool. */
  checkError: boolean
  /** Start a new round (drops any late answer from the previous one). */
  check: () => void
  /** Let the caller mark the helper as installed after installing it. */
  setProbe: (p: PrereqProbe) => void
  aiOk: boolean
  /** Everything the helper install needs is present (the helper itself may still be missing). */
  ready: boolean
  /** At least one answer is still outstanding in the current round. */
  pending: boolean
}

/** What Embodent needs on this Mac: an AI coding CLI and the Embodent command-line helper
 *  (the `orcha` CLI). Projects run natively (GH #258), so neither Docker nor Homebrew is a
 *  requirement any more; Docker matters only to "Move this project off Docker".
 *
 *  Shared by the visible Setup step (first run) and the silent background check that
 *  "Add a project" runs while the user picks a source. `enabled: false` never probes. */
export function usePreflightChecks(enabled = true): PreflightChecks {
  const [probe, setProbe] = useState<PrereqProbe | null>(null)
  const [checking, setChecking] = useState(enabled)
  const [probeLoading, setProbeLoading] = useState(enabled)
  const [checkError, setCheckError] = useState(false)
  const generation = useRef(0)

  const check = useCallback((): void => {
    const gen = ++generation.current
    setChecking(true)
    setCheckError(false)
    setProbeLoading(true)
    window.orchaDesktop
      .probePrereqs()
      .then((p) => {
        if (gen === generation.current) setProbe(p)
      })
      .catch(() => {
        if (gen === generation.current) setCheckError(true)
      })
      .finally(() => {
        if (gen === generation.current) {
          setChecking(false)
          setProbeLoading(false)
        }
      })
  }, [])

  useEffect(() => {
    if (!enabled) return
    check()
    return () => {
      generation.current += 1
    }
  }, [check, enabled])

  const aiOk = !!probe && (probe.claude || probe.codex)
  const ready = !!probe && aiOk
  const pending = checking && !probe

  return { probe, checking, probeLoading, checkError, check, setProbe, aiOk, ready, pending }
}

export interface SetupIssue {
  key: 'ai' | 'helper' | 'check'
  title: string
  fix: string
}

/** The blocking problems a finished background check found — empty while it is still running
 *  or when everything is present. Plain words + the fix. */
export function setupIssues(c: PreflightChecks): SetupIssue[] {
  if (c.checkError)
    return [{ key: 'check', title: 'Embodent couldn’t check this Mac', fix: 'Wait a moment and check again.' }]
  const out: SetupIssue[] = []
  const p = c.probe
  if (p && !c.probeLoading) {
    if (!p.claude && !p.codex)
      out.push({
        key: 'ai',
        title: 'No AI coding agent found',
        fix: 'Install Claude Code or Codex in Terminal, then check again.'
      })
    if (!p.orcha)
      out.push({
        key: 'helper',
        title: 'The Embodent command-line helper isn’t installed',
        fix: 'Open setup to install it — it takes a few seconds.'
      })
  }
  return out
}
