import { useCallback, useEffect, useRef, useState } from 'react'
import type { PreflightReport, PrereqProbe } from '../../../shared/types'

/** After this long, a still-pending check explains itself (preflight may be starting
 *  Docker, which can take up to a minute). */
export const SLOW_MS = 6000

/** After this long without an answer, Docker is treated as not responding: callers say so,
 *  count the wait honestly and offer what to do. Preflight keeps waiting in the background
 *  (it may be starting Docker, up to about a minute), so the state still turns green by
 *  itself if Docker comes up. */
export const STUCK_MS = 15000

export interface PreflightChecks {
  report: PreflightReport | null
  probe: PrereqProbe | null
  /** A check round is in flight. */
  checking: boolean
  /** The tool probe (Homebrew / AI CLI / helper) hasn't answered yet. */
  probeLoading: boolean
  slow: boolean
  stuck: boolean
  waitedS: number
  /** The check itself failed (rejected), as opposed to reporting a missing tool. */
  checkError: boolean
  /** Start a new round (drops any late answer from the previous one). */
  check: () => void
  /** Let the caller mark the helper as installed after installing it. */
  setProbe: (p: PrereqProbe) => void
  dockerOk: boolean
  aiOk: boolean
  brewOk: boolean
  /** Everything the helper install needs is present (the helper itself may still be missing). */
  ready: boolean
  /** At least one answer is still outstanding in the current round. */
  pending: boolean
}

/** What Embodent needs on this Mac: Docker running, Homebrew, an AI coding CLI and the
 *  Embodent command-line helper (the `orcha` CLI). Two independent probes: the tool probe is
 *  instant, while preflight may spend up to a minute starting Docker — each answer lands as
 *  soon as it arrives.
 *
 *  Shared by the visible Setup step (first run) and the silent background check that
 *  "Add a project" runs while the user picks a source. `enabled: false` never probes. */
export function usePreflightChecks(enabled = true): PreflightChecks {
  const [report, setReport] = useState<PreflightReport | null>(null)
  const [probe, setProbe] = useState<PrereqProbe | null>(null)
  const [checking, setChecking] = useState(enabled)
  const [probeLoading, setProbeLoading] = useState(enabled)
  const [slow, setSlow] = useState(false)
  const [stuck, setStuck] = useState(false)
  const [waitedS, setWaitedS] = useState(0)
  const [checkError, setCheckError] = useState(false)
  const generation = useRef(0)

  const check = useCallback((): void => {
    const gen = ++generation.current
    setChecking(true)
    setSlow(false)
    setStuck(false)
    setWaitedS(0)
    setCheckError(false)
    const started = Date.now()
    const slowTimer = setTimeout(() => gen === generation.current && setSlow(true), SLOW_MS)
    const tick = setInterval(() => {
      if (gen !== generation.current) return clearInterval(tick)
      const ms = Date.now() - started
      setWaitedS(Math.floor(ms / 1000))
      if (ms >= STUCK_MS) setStuck(true)
    }, 1000)
    setProbeLoading(true)
    setReport(null)
    const probeP = window.orchaDesktop.probePrereqs().then((p) => {
      if (gen === generation.current) {
        setProbe(p)
        setProbeLoading(false)
      }
    })
    const reportP = window.orchaDesktop
      .preflight()
      .then((r) => {
        if (gen === generation.current) setReport(r)
      })
      .finally(() => clearInterval(tick))
    Promise.all([probeP, reportP])
      .catch(() => {
        if (gen === generation.current) setCheckError(true)
      })
      .finally(() => {
        clearTimeout(slowTimer)
        clearInterval(tick)
        if (gen === generation.current) {
          setChecking(false)
          setProbeLoading(false)
          setSlow(false)
          setStuck(false)
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

  const dockerOk = report?.docker === 'ok'
  const aiOk = !!probe && (probe.claude || probe.codex)
  const brewOk = !!probe?.homebrew
  const ready = !!probe && !!report && dockerOk && aiOk && brewOk
  const pending = checking && (!probe || !report)

  return {
    report,
    probe,
    checking,
    probeLoading,
    slow,
    stuck,
    waitedS,
    checkError,
    check,
    setProbe,
    dockerOk,
    aiOk,
    brewOk,
    ready,
    pending
  }
}

export interface SetupIssue {
  key: 'docker' | 'homebrew' | 'ai' | 'helper' | 'check'
  title: string
  fix: string
}

/** The blocking problems a finished (or stuck) background check found — empty while it is
 *  still running normally or when everything is present. Plain words + the fix. */
export function setupIssues(c: PreflightChecks): SetupIssue[] {
  if (c.checkError)
    return [
      {
        key: 'check',
        title: 'Embodent couldn’t check this Mac',
        fix: 'If Docker is starting or busy, wait a moment and check again.'
      }
    ]
  const out: SetupIssue[] = []
  const r = c.report
  if (!r && c.stuck)
    out.push({
      key: 'docker',
      title: 'Docker isn’t responding',
      fix: 'If Docker Desktop looks frozen, quit it from the menu bar and open it again.'
    })
  else if (r && r.docker !== 'ok')
    out.push(
      r.docker === 'not-installed'
        ? {
            key: 'docker',
            title: 'Docker isn’t installed',
            fix: 'Install Docker Desktop, OrbStack or Colima, start it, then check again.'
          }
        : r.unresponsive
          ? {
              key: 'docker',
              title: 'Docker isn’t responding',
              fix: r.hint ?? 'Quit and reopen Docker Desktop (or choose Restart from its menu), then check again.'
            }
          : {
              key: 'docker',
              title: 'Docker isn’t running',
              fix: r.hint ?? 'Open Docker Desktop, wait for it to start, then check again.'
            }
    )
  const p = c.probe
  if (p && !c.probeLoading) {
    if (!p.homebrew)
      out.push({ key: 'homebrew', title: 'Homebrew isn’t installed', fix: 'Get it from brew.sh, then check again.' })
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
