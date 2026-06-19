import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { Stack } from '../../../shared/types'
import useStackActions from './useStackActions'
import ConfirmResetModal from './ConfirmResetModal'
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
  const { busy, error, portalDisabled, toggleLabel, openPortal, toggleStack, resetStack } =
    useStackActions(stack, onChanged)
  const [confirming, setConfirming] = useState(false)

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
          <Button
            size="sm"
            variant="ghost"
            className="text-text/50 hover:text-danger"
            disabled={busy}
            aria-label={`Delete and reset ${stack.projectShort}`}
            title="Delete & reset"
            onClick={() => setConfirming(true)}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {error && <div className="text-xs text-danger">{error}</div>}
      {confirming && (
        <ConfirmResetModal
          project={stack.project}
          busy={busy}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false)
            resetStack()
          }}
        />
      )}
    </li>
  )
}
