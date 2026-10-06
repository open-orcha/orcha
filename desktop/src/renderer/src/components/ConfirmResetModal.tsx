import { useEffect, useState } from 'react'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { useHostModal } from '../host/useHostModal'

/** Destructive type-to-confirm dialog for deleting a whole project stack (its database, its
 *  background service or Docker containers, and its on-disk Orcha files). A stack can hold several projects, and every one of them
 *  goes with it — so the dialog names the stack AND lists each project that will be removed
 *  (desktop audit MAJOR: "Delete project…" silently took sibling projects with it).
 *  The confirm button stays disabled until the exact compose project name is typed. Stays
 *  open (Cancel disabled, "Deleting…") for the whole delete; a failure re-enables the form
 *  with `error` shown in place and the typed text preserved. */
export default function ConfirmResetModal({
  project,
  stackName,
  projects = [],
  busy,
  error,
  onCancel,
  onConfirm
}: {
  /** Compose project (orcha-*) — what the user types to confirm. */
  project: string
  /** Short stack name for the title; defaults to the compose project. */
  stackName?: string
  /** Names of every project in this stack (all of them are deleted). */
  projects?: string[]
  busy: boolean
  /** Readable failure summary from a failed attempt; null when clean. */
  error?: string | null
  onCancel: () => void
  onConfirm: () => void
}) {
  const [typed, setTyped] = useState('')
  const matches = typed.trim() === project
  const name = stackName ?? project
  // Host dialog: hide any native portal view under it while open (arch §7.4).
  useHostModal(true)

  // Escape cancels (unless a delete is running); focus returns to the opener on close.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    return () => previous?.focus?.()
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--scrim)] animate-fade-in"
      onClick={busy ? undefined : onCancel}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-stack-title"
        aria-describedby="delete-stack-body"
        className="mx-4 w-full max-w-[440px] rounded-[10px] border border-border-strong bg-raised p-5 shadow-[var(--shadow-dialog)]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="delete-stack-title" className="text-[15px] font-semibold text-text">
          Delete the “{name}” stack?
        </h2>
        <div id="delete-stack-body" className="mt-2 flex flex-col gap-3 text-[13px] leading-relaxed text-text-2">
          {projects.length > 1 ? (
            <div>
              <p>
                This stack holds {projects.length} projects. <span className="text-text">All of them</span> are
                deleted:
              </p>
              <ul className="mt-1.5 flex flex-col gap-0.5 rounded-md border border-border bg-bg/60 px-3 py-2">
                {projects.map((p) => (
                  <li key={p} className="truncate text-text">
                    {p}
                  </li>
                ))}
              </ul>
            </div>
          ) : projects.length === 1 ? (
            <p>
              Deletes the project <span className="text-text">{projects[0]}</span>.
            </p>
          ) : null}
          <p>
            Stops the project and removes its database (all agents, tasks, requests and
            conversations) and its on-disk Orcha files. Your own code in the folder is left
            untouched. <span className="font-medium text-danger">This cannot be undone.</span>
          </p>
          <label className="flex flex-col gap-1.5">
            <span>
              Type <span className="font-mono text-[12px] text-text">{project}</span> to confirm
            </span>
            <Input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={project}
              autoFocus
              disabled={busy}
              aria-label="confirm stack name"
            />
          </label>
          {error && (
            <p role="alert" className="text-danger">
              Couldn’t delete: {error}
            </p>
          )}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={!matches || busy} onClick={onConfirm}>
            {busy ? 'Deleting…' : 'Delete stack'}
          </Button>
        </div>
      </div>
    </div>
  )
}
