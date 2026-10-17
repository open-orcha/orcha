import { useEffect, useRef } from 'react'
import type { WizardVariant } from '../../../shared/types'
import { ObButton } from './ui'

/** The one "leave the wizard?" confirmation (Cancel button, Escape). Copy is honest about
 *  what leaving means: before provisioning nothing exists yet; afterwards the project is
 *  already created and stays in the projects list. "Keep going" is the primary. */
export function SkipConfirmDialog({
  variant = 'add-project',
  projectCreated = false,
  onConfirm,
  onCancel
}: {
  variant?: WizardVariant
  projectCreated?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const keepRef = useRef<HTMLButtonElement>(null)
  useEffect(() => keepRef.current?.focus(), [])

  const title = projectCreated
    ? 'Leave setup?'
    : variant === 'add-project'
      ? 'Cancel adding this project?'
      : 'Leave setup?'
  const body = projectCreated
    ? 'Your project is already created — you’ll find it in your projects. You can add agents from its portal later.'
    : 'Nothing has been created yet. You can add the project again any time.'

  return (
    <div className="ob-scrim" role="presentation" onClick={onCancel}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="skip-confirm-title"
        aria-describedby="skip-confirm-body"
        className="ob-dialog ob-enter"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="skip-confirm-title" className="m-0 text-[15px] font-semibold text-text">
          {title}
        </h3>
        <p id="skip-confirm-body" className="m-0 text-[13px] leading-relaxed text-text-2">
          {body}
        </p>
        <div className="mt-2 flex justify-end gap-2">
          <ObButton variant="ghost" onClick={onConfirm}>
            {projectCreated ? 'Leave' : 'Cancel setup'}
          </ObButton>
          <ObButton ref={keepRef} variant="primary" onClick={onCancel}>
            Keep going
          </ObButton>
        </div>
      </div>
    </div>
  )
}
