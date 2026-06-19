import type { Stack } from '../../../shared/types'
import useStackActions from './useStackActions'
import { Card } from '../ui/Card'
import { Button } from '../ui/Button'
import { Badge } from '../ui/Badge'
import { cn } from '../ui/cn'

interface Props {
  stack: Stack
  attentionCount?: number
  onChanged: () => void
}

export default function StackCard({ stack, attentionCount = 0, onChanged }: Props) {
  const { busy, error, portalDisabled, toggleLabel, openPortal, toggleStack } = useStackActions(
    stack,
    onChanged
  )

  return (
    <Card className="flex flex-col gap-3" data-testid="stack-card">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            'h-2 w-2 rounded-full',
            stack.running ? 'bg-ok' : 'bg-text/30'
          )}
          aria-hidden="true"
        />
        <span className="font-medium">{stack.projectShort}</span>
        <Badge className={stack.running ? 'bg-ok/15 text-ok' : 'bg-text/10 text-text/60'}>
          {stack.running ? 'running' : 'stopped'}
        </Badge>
        {attentionCount > 0 && <Badge>needs attention · {attentionCount}</Badge>}
      </div>
      <div className="text-xs text-text/50">
        {stack.running && stack.apiPort !== null ? (
          <span>
            API :{stack.apiPort} · DB :{stack.dbPort ?? '?'}
          </span>
        ) : (
          <span>{stack.portalStatus || 'not running'}</span>
        )}
      </div>
      <div className="flex gap-2">
        <Button size="sm" disabled={portalDisabled} onClick={openPortal}>
          Open portal
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={toggleStack}>
          {toggleLabel}
        </Button>
      </div>
      {error && <div className="text-xs text-danger">{error}</div>}
    </Card>
  )
}
