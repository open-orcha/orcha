/** Small shared pieces for the usage surfaces: the round provider logo, the limit bar, and
 *  the one-line status of a provider. */
import type { AgentId } from '../../../shared/agents'
import {
  barTone,
  clampPercent,
  formatResetIn,
  formatTokens,
  formatUsd,
  type LimitWindow,
  type ProviderUsage
} from '../../../shared/usage'
import { AgentMark } from '../terminal/KindIcon'
import { cn } from '../ui/cn'

/** The provider's real mark (brandMarks.tsx) in a round tile. */
export function ProviderLogo({ id, size = 22, dim = false }: { id: AgentId; size?: number; dim?: boolean }) {
  return (
    <span
      aria-hidden="true"
      data-logo={id}
      className={cn('flex shrink-0 items-center justify-center rounded-full border border-border bg-raised', dim && 'opacity-50')}
      style={{ width: size, height: size }}
    >
      <AgentMark id={id} className="h-[58%] w-[58%]" />
    </span>
  )
}

export const TONE_FILL = { neutral: 'bg-text-2', warn: 'bg-warning', danger: 'bg-danger' } as const
export const TONE_TEXT = { neutral: 'text-text-2', warn: 'text-warning', danger: 'text-danger' } as const

/** A limit bar: neutral, amber above 75 %, red above 90 %. */
export function LimitBar({ percent, className, thin = false }: { percent: number; className?: string; thin?: boolean }) {
  const p = clampPercent(percent)
  const tone = barTone(p)
  return (
    <span
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(p)}
      data-tone={tone}
      className={cn('relative block overflow-hidden rounded-full bg-hover', thin ? 'h-1' : 'h-1.5', className)}
    >
      <span
        className={cn('absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out', TONE_FILL[tone])}
        style={{ width: `${p}%` }}
      />
    </span>
  )
}

/** `Fri 3:00 PM` for a reset later this week; `Oct 7, 3:00 PM` further out. */
export function formatResetAt(resetsAt: number, now: number): string {
  const d = new Date(resetsAt)
  const days = (resetsAt - now) / 86_400_000
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (days < 1 && d.getDate() === new Date(now).getDate()) return `today ${time}`
  if (days < 6) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`
}

/** `21% left · resets Fri 3:00 PM · in 2d 4h` — what remains in a window and when it refills. */
export function windowRemainText(w: LimitWindow, now: number): string {
  const left = Math.max(0, 100 - Math.round(clampPercent(w.usedPercent)))
  const parts = [`${left}% left`]
  if (w.resetsAt !== null && Number.isFinite(w.resetsAt)) {
    const rel = formatResetIn(w.resetsAt, now)
    if (rel === 'Resets now') parts.push('resets now')
    else parts.push(`resets ${formatResetAt(w.resetsAt, now)}`, (rel ?? '').replace(/^Resets /, ''))
  }
  return parts.filter(Boolean).join(' · ')
}

/** `5h ▓▓░ 10%` — one window as label, bar and percent, with what is left and when it resets. */
export function WindowRow({ w, now = Date.now() }: { w: LimitWindow; now?: number }) {
  const p = Math.round(clampPercent(w.usedPercent))
  const tone = barTone(p)
  return (
    <div className="grid grid-cols-[44px_1fr_36px] items-center gap-x-2" data-window={w.key}>
      <span className="truncate text-[11.5px] text-text-3" title={w.label}>
        {w.label}
      </span>
      <LimitBar percent={p} />
      <span className={cn('text-right text-[11.5px] tabular-nums', TONE_TEXT[tone])}>{p}%</span>
      <span className="col-start-2 col-end-4 mt-0.5 truncate text-[10.5px] tabular-nums text-text-3" data-window-remain={w.key}>
        {windowRemainText(w, now)}
      </span>
    </div>
  )
}

/** The reset countdown a provider's row leads with: the 5-hour window when there is one,
 *  else the busiest window. */
export function headlineReset(p: ProviderUsage, now: number): string | null {
  if (!p.limits || p.limits.status !== 'ok') return null
  const ws = p.limits.windows
  const primary = ws.find((w) => w.key === '5h' || w.key === 'primary') ?? ws[0]
  const withReset = primary?.resetsAt ? primary : ws.find((w) => w.resetsAt)
  const text = withReset ? formatResetIn(withReset.resetsAt, now) : null
  // name the window so "Resets in 37m" can't be read as the weekly limit
  return text && withReset ? `${withReset.label} ${text.charAt(0).toLowerCase()}${text.slice(1)}` : text
}

/** One muted line saying where a provider stands when there is no bar to show. */
export function providerStatusText(p: ProviderUsage): string {
  if (p.state === 'off') return 'Tracking off'
  if (p.state === 'not-installed') return 'Not installed'
  const l = p.limits
  if (l?.status === 'expired') return 'Sign-in expired'
  if (l?.status === 'signed-out') return 'Not signed in'
  if (!p.hasLogAdapter && !p.hasLimits) return 'Usage not tracked yet'
  if (p.state === 'no-data') return 'No local usage yet'
  if (l?.status === 'off') return 'Limits off'
  if (l?.status === 'error') return 'Couldn’t refresh limits'
  return ''
}

/** Today's local usage (`1.2M tokens · Est. $3.40`), or null. */
export function todayLine(p: ProviderUsage, today: string): string | null {
  const d = p.local?.days.find((x) => x.date === today)
  if (!d || d.tokens <= 0) return null
  return `Today ${formatTokens(d.tokens)} tokens · Est. ${formatUsd(d.costUsd)}`
}
