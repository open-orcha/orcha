import type { Stack } from '../../../shared/types'
import useStackActions from './useStackActions'

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
    <div className="stack-card" data-testid="stack-card">
      <div className="stack-card-header">
        <span className={`status-dot ${stack.running ? 'status-dot-up' : ''}`} aria-hidden="true" />
        <span className="stack-name">{stack.projectShort}</span>
        <span className={`pill ${stack.running ? 'pill-running' : 'pill-stopped'}`}>
          {stack.running ? 'running' : 'stopped'}
        </span>
        {attentionCount > 0 && (
          <span className="pill pill-attention">needs attention · {attentionCount}</span>
        )}
      </div>
      <div className="stack-meta">
        {stack.running && stack.apiPort !== null ? (
          <span className="muted">
            API :{stack.apiPort} · DB :{stack.dbPort ?? '?'}
          </span>
        ) : (
          <span className="muted">{stack.portalStatus || 'not running'}</span>
        )}
      </div>
      <div className="stack-actions">
        <button disabled={portalDisabled} onClick={openPortal}>
          Open portal
        </button>
        <button disabled={busy} onClick={toggleStack}>
          {toggleLabel}
        </button>
      </div>
      {error && <div className="stack-error">{error}</div>}
    </div>
  )
}
