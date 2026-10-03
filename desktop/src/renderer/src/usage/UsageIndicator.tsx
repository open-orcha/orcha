/** The compact usage indicator in the host sidebar's footer (the app's status area): the
 *  busiest subscription window across providers — its provider's logo, the percent and a
 *  thin bar. Click opens the Usage popover. */
import { Gauge } from 'lucide-react'
import { barTone, clampPercent, peakWindow, type ProviderUsage, type UsageSnapshot } from '../../../shared/usage'
import { cn } from '../ui/cn'
import { LimitBar, ProviderLogo, TONE_TEXT } from './parts'

export function peakProvider(s: UsageSnapshot | null): { p: ProviderUsage; percent: number } | null {
  if (!s) return null
  let best: { p: ProviderUsage; percent: number } | null = null
  for (const p of s.providers) {
    const w = peakWindow(p)
    if (w && (!best || w.usedPercent > best.percent)) best = { p, percent: clampPercent(w.usedPercent) }
  }
  return best
}

export default function UsageIndicator({
  snapshot,
  open,
  collapsed,
  onToggle
}: {
  snapshot: UsageSnapshot | null
  open: boolean
  collapsed: boolean
  onToggle(): void
}) {
  const peak = peakProvider(snapshot)
  const pct = peak ? Math.round(peak.percent) : null
  const tone = pct === null ? 'neutral' : barTone(pct)
  const label = peak ? `Usage: ${peak.p.label} at ${pct}% of its busiest window` : 'Usage'
  if (collapsed) {
    return (
      <button
        type="button"
        data-nav-item
        data-testid="usage-indicator"
        aria-label={label}
        aria-expanded={open}
        title={label}
        onClick={onToggle}
        className={cn(
          'relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-3 hover:bg-hover hover:text-text',
          open && 'bg-selected text-text'
        )}
      >
        <Gauge className="h-4 w-4" />
        {pct !== null && (
          <span className={cn('absolute -bottom-0.5 right-0 text-[9px] font-semibold tabular-nums', TONE_TEXT[tone])}>{pct}</span>
        )}
      </button>
    )
  }
  return (
    <button
      type="button"
      data-nav-item
      data-testid="usage-indicator"
      aria-label={label}
      aria-expanded={open}
      onClick={onToggle}
      className={cn(
        'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-text-2 transition-colors hover:bg-hover hover:text-text',
        open && 'bg-selected text-text'
      )}
    >
      {peak ? <ProviderLogo id={peak.p.id} size={16} /> : <Gauge className="h-4 w-4 shrink-0 text-text-3" aria-hidden="true" />}
      <span className="min-w-0 flex-1 truncate">Usage</span>
      {pct !== null && (
        <>
          <LimitBar percent={pct} className="w-10" thin />
          <span className={cn('w-8 text-right text-[11.5px] tabular-nums', TONE_TEXT[tone])}>{pct}%</span>
        </>
      )}
    </button>
  )
}
