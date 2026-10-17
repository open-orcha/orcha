import { useId, useState, type ReactElement, type ReactNode, type SyntheticEvent } from 'react'

/** Small Linear-style tooltip for icon-only controls (the collapsed rail).
 *
 *  The bubble is `position: fixed` from the trigger's rect, so a scrolling rail never clips
 *  it. Host constraint (arch §7.4): the embedded portal is a NATIVE view drawn above this
 *  renderer, so a DOM bubble extending right of the rail would be hidden under it. When a
 *  view covers the content area (`overView`), fall back to the native `title` tooltip, which
 *  macOS draws above every view; otherwise render the DOM bubble. */
export interface TooltipTriggerProps {
  title?: string
  'aria-describedby'?: string
  onMouseEnter: (e: SyntheticEvent<HTMLElement>) => void
  onMouseLeave: () => void
  onFocus: (e: SyntheticEvent<HTMLElement>) => void
  onBlur: () => void
}

export function Tooltip({
  content,
  text,
  overView,
  children
}: {
  content?: ReactNode
  /** Plain-text version: the native fallback and the default bubble content. */
  text: string
  overView: boolean
  children: (trigger: TooltipTriggerProps) => ReactElement
}) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const id = useId()
  const show = (e: SyntheticEvent<HTMLElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    setAt({ x: r.right + 8, y: r.top + r.height / 2 })
  }
  const hide = (): void => setAt(null)
  const visible = at !== null && !overView
  return (
    <>
      {children({
        onMouseEnter: show,
        onMouseLeave: hide,
        onFocus: show,
        onBlur: hide,
        title: overView ? text : undefined,
        'aria-describedby': visible ? id : undefined
      })}
      {visible && (
        <span
          role="tooltip"
          id={id}
          style={{ left: at.x, top: at.y }}
          className="pointer-events-none fixed z-50 -translate-y-1/2 whitespace-nowrap rounded-md border border-border-strong bg-raised px-2 py-1 text-xs text-text shadow-[var(--shadow-pop)]"
        >
          {content ?? text}
        </span>
      )}
    </>
  )
}
