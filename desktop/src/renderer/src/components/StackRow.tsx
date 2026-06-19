import type { Stack } from '../../../shared/types'
import useStackActions from './useStackActions'
import { Button } from '../ui/Button'
import { Badge } from '../ui/Badge'
import { cn } from '../ui/cn'

interface Props {
  stack: Stack
  attentionCount?: number
  onChanged: () => void
}

/** Compact single-line row for the list view; same actions as StackCard. */
export default function StackRow({ stack, attentionCount = 0, onChanged }: Props) {
  const { busy, error, portalDisabled, toggleLabel, openPortal, toggleStack } = useStackActions(
    stack,
    onChanged
  )

  return (
    <li
      className="flex flex-col gap-2 rounded-lg border border-border bg-card px-3 py-2"
      data-testid="stack-row"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn('h-2 w-2 rounded-full', stack.running ? 'bg-ok' : 'bg-text/30')}
          aria-hidden="true"
        />
        <span className="font-medium">{stack.projectShort}</span>
        {attentionCount > 0 && <Badge>{attentionCount} pending</Badge>}
        <span className="text-xs text-text/50">
          {stack.running && stack.apiPort !== null
            ? `API :${stack.apiPort} · DB :${stack.dbPort ?? '?'}`
            : stack.portalStatus || 'not running'}
        </span>
        <div className="ml-auto flex gap-2">
          <Button size="sm" disabled={portalDisabled} onClick={openPortal}>
            Open portal
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={toggleStack}>
            {toggleLabel}
          </Button>
        </div>
      </div>
      {error && <div className="text-xs text-danger">{error}</div>}
    </li>
  )
}
