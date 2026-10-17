import { Fragment, forwardRef, type ReactNode } from 'react'
import { AlertTriangle, Info, XCircle } from 'lucide-react'
import { Button, type ButtonProps } from '../ui/Button'
import { cn } from '../ui/cn'
import { avatarColor as identityColor } from '../ui/Avatar'

/** Onboarding building blocks — small, Linear-style primitives shared by every wizard step
 *  so the steps read as one calm system (see onboarding.css for the visual contract). */

type ObVariant = 'primary' | 'secondary' | 'ghost'

/** D2: 28 px, 6 px radius, 13 px label. ONE `primary` per step; everything else is a
 *  subtle secondary (hairline border) or ghost. Wraps the shared Button so focus/disabled
 *  behavior stays identical to the rest of the desktop. */
export const ObButton = forwardRef<HTMLButtonElement, Omit<ButtonProps, 'variant' | 'size'> & { variant?: ObVariant }>(
  ({ variant = 'secondary', className, ...props }, ref) => (
    <Button
      ref={ref}
      variant={variant === 'primary' ? 'default' : variant === 'secondary' ? 'outline' : 'ghost'}
      className={cn(
        'h-7 gap-1.5 rounded-[6px] px-3 text-[13px] font-medium',
        variant === 'secondary' && 'border-border bg-transparent text-text hover:bg-hover',
        variant === 'ghost' && 'px-2 text-text-2 hover:text-text',
        className
      )}
      {...props}
    />
  )
)
ObButton.displayName = 'ObButton'

/** Step title block: optional icon tile (the step's illustration, quiet and monochrome),
 *  Display title, one-line subtitle. */
export function StepHeader({
  title,
  subtitle,
  size,
  icon
}: {
  title: ReactNode
  subtitle?: ReactNode
  size?: 'xl'
  icon?: ReactNode
}) {
  return (
    <header className="ob-header flex flex-col gap-2">
      {icon && (
        <span className="ob-icon-tile" aria-hidden="true">
          {icon}
        </span>
      )}
      <h2 className="ob-display" data-size={size}>
        {title}
      </h2>
      {subtitle && <p className="ob-sub">{subtitle}</p>}
    </header>
  )
}

/** Footer: secondary/back on the left, the step's single primary (plus an optional hint)
 *  on the right. */
export function StepFooter({ left, hint, children }: { left?: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <footer className="ob-footer">
      <div className="flex items-center gap-2">{left}</div>
      <div className="ob-footer-right">
        {hint && <span className="ob-meta truncate">{hint}</span>}
        {children}
      </div>
    </footer>
  )
}

/** Quiet notice row — the icon carries the tone, the text stays readable and muted. */
export function Notice({
  tone = 'info',
  title,
  children,
  action
}: {
  tone?: 'info' | 'warning' | 'danger'
  title?: ReactNode
  children?: ReactNode
  action?: ReactNode
}) {
  const Icon = tone === 'danger' ? XCircle : tone === 'warning' ? AlertTriangle : Info
  const color = tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : 'text-text-3'
  return (
    <div className="ob-notice" role={tone === 'danger' ? 'alert' : 'status'} data-tone={tone}>
      <Icon className={cn('h-3.5 w-3.5', color)} aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {title && <span className="ob-notice-title">{title}</span>}
        {children && <div className="min-w-0 break-words">{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

export type GlyphState = 'todo' | 'running' | 'done' | 'failed' | 'skipped' | 'warning'

/** D8 status glyphs (one set for the whole wizard): todo = empty circle, running = spinning
 *  arc, done = filled green circle + check, failed = red circle + x, skipped = grey circle +
 *  slash, warning = amber ring + dot. 14 px, drawn inline so colors follow the tokens. */
export function StatusGlyph({ state, label }: { state: GlyphState; label?: string }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: '0 0 14 14',
    'aria-label': label,
    role: label ? 'img' : undefined,
    'aria-hidden': label ? undefined : true
  } as const
  switch (state) {
    case 'done':
      return (
        <svg {...common} data-glyph="done" className="ob-pop">
          <circle cx="7" cy="7" r="7" fill="var(--color-ok)" />
          <path
            d="M4.2 7.2 6.1 9 9.8 5.2"
            stroke="var(--color-bg)"
            strokeWidth="1.6"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )
    case 'failed':
      return (
        <svg {...common} data-glyph="failed" className="ob-pop">
          <circle cx="7" cy="7" r="7" fill="var(--color-danger)" />
          <path d="M4.8 4.8 9.2 9.2M9.2 4.8 4.8 9.2" stroke="var(--color-bg)" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      )
    case 'skipped':
      return (
        <svg {...common} data-glyph="skipped">
          <circle cx="7" cy="7" r="6" stroke="var(--color-text-3)" strokeWidth="1.5" fill="none" />
          <path d="M4 10 10 4" stroke="var(--color-text-3)" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )
    case 'warning':
      return (
        <svg {...common} data-glyph="warning" className="ob-pop">
          <circle cx="7" cy="7" r="6" stroke="var(--color-warning)" strokeWidth="1.5" fill="none" />
          <circle cx="7" cy="7" r="2.2" fill="var(--color-warning)" />
        </svg>
      )
    case 'running':
      return (
        <svg {...common} data-glyph="running" className="ob-rotate">
          <circle cx="7" cy="7" r="6" stroke="var(--color-border-strong)" strokeWidth="1.5" fill="none" />
          <path
            d="M7 1a6 6 0 0 1 6 6"
            stroke="var(--color-accent)"
            strokeWidth="1.5"
            fill="none"
            strokeLinecap="round"
          />
        </svg>
      )
    default:
      return (
        <svg {...common} data-glyph="todo">
          <circle cx="7" cy="7" r="6" stroke="var(--color-text-3)" strokeWidth="1.5" fill="none" opacity="0.7" />
        </svg>
      )
  }
}

/** Identity colour from the desktop's fixed, well-separated avatar palette (ui/Avatar) — the
 *  same slot the host sidebar gives this alias. */
export function avatarColor(name: string): string {
  return identityColor(name).background
}

/** D7: circular avatar (one initial on the portal's per-alias colour); optional corner badge. */
export function Avatar({ name, size = 24, badge }: { name: string; size?: 16 | 20 | 24 | 32; badge?: ReactNode }) {
  const initial = (name.trim().replace(/^@/, '').charAt(0) || '?').toUpperCase()
  return (
    <span
      className="ob-avatar"
      aria-hidden="true"
      data-color={avatarColor(name)}
      style={{
        width: size,
        height: size,
        background: avatarColor(name),
        color: identityColor(name).color,
        fontSize: size >= 32 ? 13.5 : size >= 24 ? 11 : size >= 20 ? 9.5 : 8.5
      }}
    >
      {initial}
      {badge && <span className="ob-avatar-badge">{badge}</span>}
    </span>
  )
}

/** The Embodent mark — shared with the sidebar / tray headers (components/BrandMark; OrchaMark is its compat alias). */
export { OrchaMark } from '../components/OrchaMark'

/** Render `backtick` spans as inline code — CLI warnings arrive as plain strings that use
 *  markdown-ish backticks, which used to show up literally. Text only: never HTML. */
export function InlineText({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g)
  return (
    <>
      {parts.map((p, i) =>
        p.length > 2 && p.startsWith('`') && p.endsWith('`') ? (
          <code key={i} className="ob-code">
            {p.slice(1, -1)}
          </code>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        )
      )}
    </>
  )
}

/** Shorten an absolute path for display: /Users/<me>/x → ~/x. Display only. */
export function tildify(p: string): string {
  return p.replace(/^\/Users\/[^/]+(?=\/|$)/, '~')
}
