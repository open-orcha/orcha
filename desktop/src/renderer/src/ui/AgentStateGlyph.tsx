import type { HostLiveAgentState } from '../../../shared/types'

/** D8 status glyph for a live agent session (one glyph set everywhere): working = half-filled
 *  amber circle (in progress), needs review = green ring with a dot, blocked = red ring with a
 *  bar, waiting (on a request/answer) = neutral dashed ring. 14px, decorative (the row's accessible name carries the state in words). */
export function AgentStateGlyph({ state, size = 14 }: { state: HostLiveAgentState; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 14 14', 'aria-hidden': true as const, 'data-state-glyph': state }
  if (state === 'working') {
    return (
      <svg {...common} className="shrink-0">
        <circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--color-warning)" strokeWidth="1.5" />
        <path d="M7 3.5 A3.5 3.5 0 0 1 7 10.5 Z" fill="var(--color-warning)" />
      </svg>
    )
  }
  if (state === 'needs_review') {
    return (
      <svg {...common} className="shrink-0">
        <circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--color-ok)" strokeWidth="1.5" />
        <circle cx="7" cy="7" r="2" fill="var(--color-ok)" />
      </svg>
    )
  }
  if (state === 'waiting') {
    return (
      <svg {...common} className="shrink-0">
        <circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--color-text-3)" strokeWidth="1.5" strokeDasharray="2.2 2" />
      </svg>
    )
  }
  return (
    <svg {...common} className="shrink-0">
      <circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--color-danger)" strokeWidth="1.5" />
      <path d="M4.5 7 H9.5" stroke="var(--color-danger)" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}
