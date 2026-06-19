import { useEffect, useState } from 'react'
import type { BootstrapStatus } from '../../../../shared/types'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { CheckCircle2, Circle, Loader2 } from 'lucide-react'

/** One row per dependency, in install order. `done` reflects the live status snapshot. */
function depRows(status: BootstrapStatus | null): { label: string; done: boolean }[] {
  if (!status) return []
  return [
    { label: 'Homebrew', done: status.homebrew.installed },
    {
      label: 'Docker',
      done: status.docker.installed && status.docker.running === true
    },
    { label: 'Orcha command-line tool', done: status.cli.installed }
  ]
}

export default function SetupStep({ onContinue }: { onContinue: () => void }) {
  const [status, setStatus] = useState<BootstrapStatus | null>(null)
  const [checking, setChecking] = useState(true)
  const [installing, setInstalling] = useState(false)

  const check = (): void => {
    setChecking(true)
    void window.orchaDesktop.checkDependencies().then((s) => {
      setStatus(s)
      setChecking(false)
    })
  }
  useEffect(() => check(), [])

  const ready = status?.ready === true

  // The guided installer runs entirely in native dialogs (consent + macOS's own password popup),
  // then resolves with the post-run snapshot — we don't re-check separately.
  const runSetup = (): void => {
    setInstalling(true)
    void window.orchaDesktop
      .guidedSetup()
      .then((s) => setStatus(s))
      .finally(() => setInstalling(false))
  }

  const rows = depRows(status)

  return (
    <div className="flex flex-col gap-4 animate-slide-in">
      <h2 className="text-lg font-semibold">Set up what Orcha needs</h2>
      <Card className="flex flex-col gap-2 text-sm">
        {checking && !status ? (
          <span className="flex items-center gap-2 text-text/80">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-accent" />
            Checking what’s installed…
          </span>
        ) : ready ? (
          <span className="flex items-center gap-2 text-text">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-ok" />
            Everything Orcha needs is already installed.
          </span>
        ) : (
          <>
            <p className="text-text/80">
              Orcha installs these for you, one at a time. Before each one you’ll be asked to
              continue, and macOS may show its own password or fingerprint prompt — that’s Apple,
              not Orcha.
            </p>
            <ul className="mt-1 flex flex-col gap-1.5">
              {rows.map((r) => (
                <li key={r.label} className="flex items-center gap-2">
                  {r.done ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-ok" />
                  ) : (
                    <Circle className="h-4 w-4 shrink-0 text-text/30" />
                  )}
                  <span className={r.done ? 'text-text/60 line-through' : 'text-text'}>
                    {r.label}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
      <div className="flex gap-2">
        {status && !ready && (
          <Button disabled={installing} onClick={runSetup}>
            {installing ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Setting up…
              </>
            ) : (
              'Set everything up'
            )}
          </Button>
        )}
        {status && !ready && (
          <Button variant="outline" disabled={checking || installing} onClick={check}>
            Re-check
          </Button>
        )}
        <Button disabled={!ready || installing} onClick={onContinue}>
          Continue
        </Button>
      </div>
    </div>
  )
}
