import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '../ui/Button'
import { useHostModal } from '../host/useHostModal'
import { closePrompt } from './TabMenu'
import type { Terminals } from './useTerminals'

/** Confirm closing tabs (several with live processes, or a pinned one). Host dialog → the
 *  native portal view is hidden while it is open. Escape / Cancel keep the tabs; focus goes
 *  back to whatever had it before. */
export function CloseTabsDialog({
  title,
  body,
  confirm,
  onCancel,
  onConfirm
}: {
  title: string
  body: string
  confirm: string
  onCancel(): void
  onConfirm(): void
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
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--scrim)]" onClick={onCancel}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="close-tabs-title"
        aria-describedby="close-tabs-body"
        data-testid="close-tabs-dialog"
        className="mx-4 w-full max-w-[400px] rounded-[10px] border border-border-strong bg-raised p-5 shadow-[var(--shadow-dialog)]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="close-tabs-title" className="text-[15px] font-semibold text-text">
          {title}
        </h2>
        <p id="close-tabs-body" className="mt-2 text-[13px] leading-relaxed text-text-2">
          {body}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button ref={confirmRef} onClick={onConfirm}>
            {confirm}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Confirm-aware close for every surface (strip ×, menus, ⌘W, sidebar rows): closes straight
 *  away unless `closePrompt` says to ask, then shows ONE dialog for the whole batch. */
export function useTabCloser(terms: Terminals): { request(keys: string[]): void; dialog: ReactNode } {
  const termsRef = useRef(terms)
  termsRef.current = terms
  const [pending, setPending] = useState<{ keys: string[]; prompt: NonNullable<ReturnType<typeof closePrompt>> } | null>(null)
  const request = useCallback((keys: string[]) => {
    const t = termsRef.current
    const prompt = closePrompt(t.state.tabs, keys)
    if (prompt) setPending({ keys, prompt })
    else for (const k of keys) t.close(k)
  }, [])
  const cancel = useCallback(() => setPending(null), [])
  const dialog = pending ? (
    <CloseTabsDialog
      {...pending.prompt}
      onCancel={cancel}
      onConfirm={() => {
        setPending(null)
        for (const k of pending.keys) termsRef.current.close(k)
      }}
    />
  ) : null
  return { request, dialog }
}
