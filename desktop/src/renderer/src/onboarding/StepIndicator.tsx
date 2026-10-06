import { Fragment, type CSSProperties } from 'react'
import { Check, Minus } from 'lucide-react'

export interface StepItem {
  key: string
  label: string
  /** `skipped`: the step doesn't apply to this path (e.g. Details when reconnecting an
   *  existing Orcha folder) — it stays in place, muted with a dash, so the count never shifts. */
  state: 'done' | 'current' | 'upcoming' | 'skipped'
}

/** Labelled compact stepper ("✓ Source ── ● Details ── 3 Create"). Progress is animated
 *  with transform/opacity only: each connector's fill scales in as the flow reaches it, the
 *  current dot's accent fill grows in with a soft halo, and a finished dot's number cross-
 *  fades into a check with a small spring. Completed steps are buttons (jump back) only
 *  while `onJump` is provided — the wizard withholds it once a project has been created. */
export function StepIndicator({ steps, onJump }: { steps: StepItem[]; onJump?: (key: string) => void }) {
  const current = steps.findIndex((s) => s.state === 'current')
  return (
    <ol className="ob-steps" aria-label={`Step ${current + 1} of ${steps.length}`}>
      {steps.map((s, i) => {
        const body = (
          <>
            <span className="ob-step-dot" aria-hidden="true">
              <span className="ob-step-dot-fill" />
              <span className="ob-step-dot-num">{i + 1}</span>
              <span className="ob-step-dot-icon">
                {s.state === 'skipped' ? (
                  <Minus className="h-2.5 w-2.5" strokeWidth={3} />
                ) : (
                  <Check className="h-2.5 w-2.5" strokeWidth={3} />
                )}
              </span>
            </span>
            <span className="ob-step-label">{s.label}</span>
            {s.state === 'skipped' && <span className="sr-only"> (not needed)</span>}
          </>
        )
        const jumpable = s.state === 'done' && !!onJump
        // The connector INTO step i fills once the flow has reached step i.
        const reached = current >= 0 && i <= current
        return (
          <Fragment key={s.key}>
            {i > 0 && (
              <li className="ob-step-sep" aria-hidden="true" data-filled={reached}>
                <span className="ob-step-sep-fill" style={{ '--d': `${Math.max(0, i - 1) * 40}ms` } as CSSProperties} />
              </li>
            )}
            <li
              aria-current={s.state === 'current' ? 'step' : undefined}
              title={s.state === 'skipped' ? `${s.label} isn’t needed for this project` : undefined}
            >
              {jumpable ? (
                <button type="button" className="ob-step" data-state={s.state} onClick={() => onJump(s.key)}>
                  {body}
                </button>
              ) : (
                <span className="ob-step" data-state={s.state}>
                  {body}
                </span>
              )}
            </li>
          </Fragment>
        )
      })}
    </ol>
  )
}
