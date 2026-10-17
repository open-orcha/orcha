import { useState } from 'react'
import { AlertCircle, X } from 'lucide-react'
import { detailIsRedundant, readableError } from '../util/errorText'
import { cn } from '../ui/cn'

/** One readable, dismissible error line (D4): a short summary, the raw text only behind
 *  "Details", and an ✕. Used once per stack — never repeated under every project row. */
export default function ErrorNotice({
  error,
  prefix,
  onDismiss,
  compact = false,
  wrap = false,
  className
}: {
  /** Raw error: bridge error object or stderr string. */
  error: unknown
  /** "Couldn’t start acme-web" etc. */
  prefix?: string
  onDismiss?: () => void
  /** Sidebar variant: 12px, single line, details below. */
  compact?: boolean
  /** Let the summary wrap (up to 3 lines) instead of truncating — for narrow hosts such as a
   *  dialog, where one line cuts the actual cause off. */
  wrap?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const readable = readableError(error)
  const line = prefix ? `${prefix}: ${readable.summary}` : readable.summary
  // No "Details" toggle when the raw text is already contained in the visible line — it
  // would only repeat the same sentence (desktop r3 review).
  const detail = detailIsRedundant(line, readable.detail) ? null : readable.detail
  const detailsToggle = detail && (
    <button
      type="button"
      aria-expanded={open}
      onClick={() => setOpen((v) => !v)}
      className="shrink-0 rounded px-1 text-text-3 hover:bg-hover hover:text-text"
    >
      {open ? 'Hide' : 'Details'}
    </button>
  )
  const dismiss = onDismiss && (
    <button
      type="button"
      aria-label="Dismiss error"
      onClick={onDismiss}
      className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-text-3 hover:bg-hover hover:text-text"
    >
      <X className="h-3 w-3" />
    </button>
  )
  return (
    <div role="alert" className={cn('flex min-w-0 flex-col gap-1', compact ? 'text-[12px]' : 'text-[13px]', className)}>
      <div className="flex min-w-0 items-start gap-1.5">
        <AlertCircle className={cn('mt-[3px] shrink-0 text-danger', compact ? 'h-3 w-3' : 'h-3.5 w-3.5')} aria-hidden="true" />
        <span className={cn('min-w-0 flex-1 text-text-2', compact ? 'line-clamp-2 break-words' : wrap ? 'line-clamp-3 break-words' : 'truncate')} title={line}>
          {line}
        </span>
        {compact ? dismiss : (
          <>
            {detailsToggle}
            {dismiss}
          </>
        )}
      </div>
      {compact && detailsToggle && <div className="-ml-1 pl-[18px]">{detailsToggle}</div>}
      {open && detail && (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-bg p-2 font-mono text-[11px] leading-relaxed text-text-3">
          {detail}
        </pre>
      )}
    </div>
  )
}
