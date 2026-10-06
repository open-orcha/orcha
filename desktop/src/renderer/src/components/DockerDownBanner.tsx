import { useState } from 'react'
import { AlertTriangle, CircleSlash, Loader2 } from 'lucide-react'
import { Button } from '../ui/Button'

/** Compact notice row (not a red wall of text): Docker's CLI/daemon is unreachable, so the
 *  project list is UNKNOWN — never "no projects". Offers Open Docker (preflight auto-start)
 *  and Retry; the list also refreshes on its own. `unresponsive` = the CLI timed out (Docker
 *  Desktop wedged): the copy says so instead of claiming it isn't running (desktop r2 review). */
export default function DockerDownBanner({
  onRetry,
  onStartDocker,
  unresponsive = false
}: {
  onRetry?: () => Promise<void> | void
  onStartDocker?: () => Promise<void>
  unresponsive?: boolean
}) {
  const [starting, setStarting] = useState(false)
  const Icon = unresponsive ? AlertTriangle : CircleSlash
  return (
    <div role="status" className="flex min-h-11 items-center gap-2.5 rounded-md border border-border bg-bg/40 px-3 py-2 text-[13px]">
      <Icon className={unresponsive ? 'h-4 w-4 shrink-0 text-warning' : 'h-4 w-4 shrink-0 text-danger'} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <span className="font-medium text-text">{unresponsive ? 'Docker isn’t responding.' : 'Docker isn’t running.'}</span>{' '}
        <span className="text-text-2">
          {starting
            ? unresponsive
              ? 'Opening Docker…'
              : 'Starting Docker…'
            : unresponsive
              ? 'Quit and reopen Docker Desktop (or choose Restart from its menu) — your projects appear once it answers.'
              : 'Start Docker Desktop, OrbStack or Colima — your projects appear as soon as it’s up.'}
        </span>
      </div>
      {onStartDocker && (
        <Button
          variant="secondary"
          disabled={starting}
          onClick={() => {
            setStarting(true)
            void onStartDocker().finally(() => setStarting(false))
          }}
        >
          {starting && <Loader2 className="animate-spin" />}
          Open Docker
        </Button>
      )}
      {onRetry && (
        <Button variant="ghost" disabled={starting} onClick={() => void onRetry()}>
          Retry
        </Button>
      )}
    </div>
  )
}
