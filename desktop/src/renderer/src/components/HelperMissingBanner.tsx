import { useCallback, useEffect, useState } from 'react'
import type { InstallProgress } from '../../../shared/types'
import { Button } from '../ui/Button'
import { AlertCircle, Loader2 } from 'lucide-react'

/** When a Mac already has a workspace, the app skips onboarding and lands straight in the manager
 *  — so a missing Orcha CLI helper (e.g. after a reinstall that removed it, or a first install on
 *  a Mac that already had stacks) would otherwise go unnoticed and agents silently wouldn't
 *  launch. This banner probes for the helper on mount and, when it's gone, offers a one-click
 *  reinstall through the very same install path onboarding uses. It self-hides when the helper is
 *  present, so it never nags a healthy install. */
export default function HelperMissingBanner() {
  const [missing, setMissing] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [lastLine, setLastLine] = useState('')
  const [error, setError] = useState<string | null>(null)

  const probe = useCallback(async () => {
    try {
      const p = await window.orchaDesktop.probePrereqs()
      setMissing(!p.orcha)
    } catch {
      // Can't probe (rare) → stay quiet; the worker-start path still reports a missing helper.
    }
  }, [])

  useEffect(() => void probe(), [probe])

  // Live install output (only the Orcha helper install streams here).
  useEffect(
    () =>
      window.orchaDesktop.onInstallProgress((e: InstallProgress) => {
        if (e.status === 'log') setLastLine(e.line)
      }),
    []
  )

  if (!missing) return null

  const install = async (): Promise<void> => {
    setInstalling(true)
    setError(null)
    setLastLine('')
    try {
      const res = await window.orchaDesktop.installPrereqs()
      if (!res.ok) {
        setError(`Couldn’t install the Orcha helper (${res.detail}). You can try again.`)
        return
      }
      await probe() // hides the banner if the helper is now present
    } catch {
      setError('Couldn’t install the Orcha helper. Please try again.')
    } finally {
      setInstalling(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
        <div className="flex flex-col gap-1">
          <span className="font-medium text-text">The Orcha helper isn’t installed</span>
          <span className="text-text/70">
            Your projects are safe, but agents can’t be launched until the command-line helper is
            installed on this Mac.
          </span>
        </div>
      </div>
      {installing && lastLine && (
        <p className="truncate font-mono text-xs text-text/50" title={lastLine}>
          {lastLine}
        </p>
      )}
      {error && (
        <p className="flex items-start gap-2 text-red-500">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </p>
      )}
      <div>
        <Button disabled={installing} onClick={() => void install()}>
          {installing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {installing ? 'Installing…' : 'Install helper'}
        </Button>
      </div>
    </div>
  )
}
