import { useEffect, useRef } from 'react'
import { Button } from '../ui/Button'
import ErrorNotice from '../components/ErrorNotice'
import { useHostModal } from './useHostModal'

/** Confirm "Stop stack" — shown for a sidebar Stop and for a portal-requested stop
 *  (requestHostAction: stopStack). Precise wording: this is the Docker STACK lifecycle
 *  (`docker compose stop`), distinct from a project/container or a single run (brief §3).
 *  Host dialog → the native portal view is hidden while it is open (useHostModal).
 *  Escape cancels; focus returns to whatever had it before the dialog opened. */
export default function ConfirmStopDialog({
  stackName,
  projects = [],
  busy,
  error,
  onCancel,
  onConfirm
}: {
  stackName: string
  /** Every project in this stack — all of them go offline together. */
  projects?: string[]
  busy: boolean
  /** The last stop attempt's raw failure (bridge error / stderr), or null. Rendered as one
   *  compact notice with a status glyph + Details, and the primary becomes "Try again". */
  error: unknown
  onCancel: () => void
  onConfirm: () => void
}) {
  useHostModal(true)
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    confirmRef.current?.focus()
    return () => previous?.focus?.()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) {
        e.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--scrim)]"
      onClick={busy ? undefined : onCancel}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="stop-stack-title"
        aria-describedby="stop-stack-body"
        className="mx-4 w-full max-w-[440px] rounded-[10px] border border-border-strong bg-raised p-5 shadow-[var(--shadow-dialog)]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="stop-stack-title" className="text-[15px] font-semibold text-text">
          Stop the “{stackName}” stack?
        </h2>
        <div id="stop-stack-body" className="mt-2 flex flex-col gap-2 text-[13px] leading-relaxed text-text-2">
          {projects.length > 1 && (
            <p>
              {projects.length} projects go offline together: <span className="text-text">{projects.join(', ')}</span>.
            </p>
          )}
          <p>
            Stops the stack’s Docker containers (portal and database). Nothing is deleted — every
            project, task and conversation is kept, and you can start it again from the sidebar.
            While it is stopped, its portal is unreachable and agents can’t report back to it.
          </p>
        </div>
        {error != null && (
          <div className="mt-4 rounded-md border border-border bg-bg/40 px-2.5 py-2">
            <ErrorNotice error={error} prefix="Couldn’t stop" wrap />
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button ref={confirmRef} onClick={onConfirm} disabled={busy}>
            {busy ? 'Stopping…' : error != null ? 'Try again' : 'Stop stack'}
          </Button>
        </div>
      </div>
    </div>
  )
}
