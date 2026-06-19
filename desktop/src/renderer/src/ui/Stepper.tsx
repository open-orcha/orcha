import { Fragment } from 'react'
import { Check } from 'lucide-react'
import { cn } from './cn'

export interface StepperProps {
  steps: string[]
  /** zero-based index of the active step */
  current: number
}

export function Stepper({ steps, current }: StepperProps) {
  return (
    <ol className="flex items-center gap-2">
      {steps.map((label, i) => {
        const state = i < current ? 'done' : i === current ? 'current' : 'upcoming'
        return (
          <Fragment key={label}>
            <li
              data-state={state}
              aria-current={state === 'current' ? 'step' : undefined}
              className="flex items-center gap-2"
            >
              <span
                className={cn(
                  'flex h-7 w-7 items-center justify-center rounded-full border text-xs font-semibold transition-colors duration-[var(--duration-base)]',
                  state === 'done' && 'border-accent bg-accent text-bg',
                  state === 'current' && 'border-accent text-accent',
                  state === 'upcoming' && 'border-border text-text/40'
                )}
              >
                {state === 'done' ? <Check className="h-4 w-4" /> : i + 1}
              </span>
              <span className={cn('text-sm', state === 'current' ? 'text-text' : 'text-text/50')}>
                {label}
              </span>
            </li>
            {i < steps.length - 1 && (
              <span
                className={cn(
                  'h-px flex-1 transition-colors duration-[var(--duration-base)]',
                  i < current ? 'bg-accent' : 'bg-border'
                )}
              />
            )}
          </Fragment>
        )
      })}
    </ol>
  )
}
