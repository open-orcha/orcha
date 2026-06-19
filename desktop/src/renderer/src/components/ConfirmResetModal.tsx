import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'

/** Destructive type-to-confirm dialog for Delete & reset. The confirm button is disabled
 *  until the user types the exact project name, so a reset can never be a single misclick. */
export default function ConfirmResetModal({
  project,
  busy,
  onCancel,
  onConfirm
}: {
  project: string
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const [typed, setTyped] = useState('')
  const matches = typed.trim() === project

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label={`Delete ${project}`}
      onClick={onCancel}
    >
      <div
        className="mx-4 w-full max-w-md rounded-xl border border-danger/40 bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-danger" />
          <div className="flex flex-col gap-3">
            <h2 className="text-base font-semibold">Delete “{project}” and all its data?</h2>
            <p className="text-sm text-text/70">
              This permanently removes this Orcha project’s containers, database (all agents,
              tasks, requests, and conversations), and its on-disk Orcha files. Your own code in the
              folder is left untouched.
            </p>
            <p className="text-sm font-medium text-danger">This cannot be undone.</p>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-text/70">
                Type <span className="font-mono text-text">{project}</span> to confirm:
              </span>
              <Input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={project}
                autoFocus
                aria-label="confirm project name"
              />
            </label>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={!matches || busy} onClick={onConfirm}>
            {busy ? 'Deleting…' : 'Delete everything'}
          </Button>
        </div>
      </div>
    </div>
  )
}
