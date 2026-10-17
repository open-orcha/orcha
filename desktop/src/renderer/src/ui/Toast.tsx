import { useEffect, type CSSProperties } from 'react'
import { CheckCircle2, X } from 'lucide-react'

/** A small transient confirmation (bottom-left, over host chrome). Announced politely to
 *  screen readers; dismisses itself after `ms` or on ✕. Callers anchor it where no native
 *  portal view can cover it (the sidebar column). */
export default function Toast({
  message,
  details = [],
  onDismiss,
  ms = 7000,
  style
}: {
  message: string
  /** Extra lines (e.g. things that were left, with the reason). */
  details?: string[]
  onDismiss(): void
  ms?: number
  style?: CSSProperties
}) {
  useEffect(() => {
    const t = setTimeout(onDismiss, ms)
    return () => clearTimeout(t)
  }, [message, ms, onDismiss])
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="toast"
      style={style}
      className="fixed z-50 flex items-start gap-2 rounded-lg border border-border-strong bg-raised px-3 py-2 text-[12.5px] leading-snug text-text shadow-[var(--shadow-toast)] animate-fade-in"
    >
      <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0 text-ok" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p>{message}</p>
        {details.map((d) => (
          <p key={d} className="mt-0.5 text-text-3">
            {d}
          </p>
        ))}
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="-my-0.5 -mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-3 hover:bg-hover hover:text-text"
      >
        <X className="h-3 w-3" aria-hidden="true" />
      </button>
    </div>
  )
}
