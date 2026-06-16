import type { Stack } from '../../../shared/types'
import useStackActions from './useStackActions'

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
    <li className="stack-row" data-testid="stack-row">
      <div className="stack-row-main">
        <span className={`status-dot ${stack.running ? 'status-dot-up' : ''}`} aria-hidden="true" />
        <span className="stack-name">{stack.projectShort}</span>
        {attentionCount > 0 && <span className="chip-attention">{attentionCount} pending</span>}
        <span className="stack-row-meta muted">
          {stack.running && stack.apiPort !== null
            ? `API :${stack.apiPort} · DB :${stack.dbPort ?? '?'}`
            : stack.portalStatus || 'not running'}
        </span>
        <div className="stack-row-actions">
          <button className="btn-small" disabled={portalDisabled} onClick={openPortal}>
            Open portal
          </button>
          <button className="btn-small" disabled={busy} onClick={toggleStack}>
            {toggleLabel}
          </button>
        </div>
      </div>
      {error && <div className="stack-error">{error}</div>}
    </li>
  )
}
