/** The compact "Usage · all agents" panel (Orca-style): one row per provider with its real
 *  logo, reset countdown and limit bars, a Detailed / Compact toggle, refresh, and the two
 *  footer actions. Rendered in the host (from the sidebar status indicator) and in the tray
 *  popover — the same component, so both show the same rows. */
import { BarChart3, ChevronRight, RefreshCw, UserCog } from 'lucide-react'
import {
  clampPercent,
  localDay,
  peakWindow,
  type PopoverMode,
  type ProviderUsage,
  type UsageProviderId
} from '../../../shared/usage'
import { cn } from '../ui/cn'
import { LimitBar, ProviderLogo, WindowRow, headlineReset, providerStatusText, todayLine, TONE_TEXT } from './parts'
import { barTone } from '../../../shared/usage'
import { useNow, type UsageValue } from './useUsage'

/** Rows the popover lists: tracked providers that are installed or have data. */
export function popoverProviders(list: readonly ProviderUsage[]): ProviderUsage[] {
  return list.filter((p) => p.enabled && (p.installed === true || p.state === 'ok' || (p.installed === null && p.hasLogAdapter)))
}

function ModeToggle({ mode, onChange }: { mode: PopoverMode; onChange(m: PopoverMode): void }) {
  return (
    <div role="radiogroup" aria-label="Density" className="flex h-6 items-center rounded-md border border-border p-0.5">
      {(['detailed', 'compact'] as const).map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={mode === m}
          data-testid={`usage-mode-${m}`}
          onClick={() => onChange(m)}
          className={cn(
            'h-[18px] rounded-[4px] px-1.5 text-[11px] font-medium capitalize transition-colors',
            mode === m ? 'bg-selected text-text' : 'text-text-3 hover:text-text'
          )}
        >
          {m}
        </button>
      ))}
    </div>
  )
}

function ProviderRow({
  p,
  mode,
  now,
  today,
  onOpen,
  onEnableLimits
}: {
  p: ProviderUsage
  mode: PopoverMode
  now: number
  today: string
  onOpen(): void
  onEnableLimits?(): void
}) {
  const ok = p.limits?.status === 'ok' ? p.limits : null
  const reset = headlineReset(p, now)
  const status = providerStatusText(p)
  const peak = peakWindow(p)
  const plan = ok?.plan ?? p.limits?.plan ?? null
  const today1 = todayLine(p, today)
  return (
    <li data-testid={`usage-row-${p.id}`} data-state={p.state}>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${p.label} usage details`}
        className="group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-hover"
      >
        <ProviderLogo id={p.id} size={22} dim={p.state === 'not-installed'} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-1.5">
            <span className="truncate text-[13px] font-medium text-text">{p.label}</span>
            {plan && <span className="shrink-0 text-[11px] text-text-3">{plan}</span>}
          </span>
          {mode === 'compact' ? null : (
            <span className="block truncate text-[11.5px] text-text-3">{reset ?? status ?? ''}</span>
          )}
        </span>
        {mode === 'compact' && (
          <span className="flex shrink-0 items-center gap-2">
            {ok && peak ? (
              <>
                <span className="text-[11.5px] tabular-nums text-text-3">
                  {ok.windows.map((w) => `${w.label} ${Math.round(clampPercent(w.usedPercent))}%`).slice(0, 2).join(' · ')}
                </span>
                <LimitBar percent={peak.usedPercent} className="w-12" thin />
              </>
            ) : (
              <span className="text-[11.5px] text-text-3">{status || reset}</span>
            )}
          </span>
        )}
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-3 opacity-60 group-hover:opacity-100" aria-hidden="true" />
      </button>
      {mode === 'detailed' && (
        <div className="flex flex-col gap-1 pb-2 pl-[42px] pr-7">
          {ok && ok.windows.map((w) => <WindowRow key={w.key} w={w} now={now} />)}
          {!ok && status && p.limits?.status === 'off' && onEnableLimits && (
            <div className="flex items-center gap-2 text-[11.5px] text-text-3">
              <span className="min-w-0 truncate">5h / weekly limits are off</span>
              <button
                type="button"
                data-testid={`usage-enable-limits-${p.id}`}
                onClick={onEnableLimits}
                className="ml-auto h-5 shrink-0 rounded border border-border px-1.5 text-[11px] text-text hover:bg-hover"
              >
                Enable
              </button>
            </div>
          )}
          {!ok && p.limits?.note && p.limits.status !== 'off' && (
            <span className={cn('text-[11.5px]', p.limits.status === 'expired' ? 'text-warning' : 'text-text-3')}>{p.limits.note}</span>
          )}
          {today1 && <span className="text-[11.5px] text-text-3 tabular-nums">{today1}</span>}
        </div>
      )}
    </li>
  )
}

export default function UsagePopover({
  usage,
  onOpenDetails,
  onManageAccounts,
  className
}: {
  usage: UsageValue
  onOpenDetails(id?: UsageProviderId): void
  onManageAccounts(): void
  className?: string
}) {
  const now = useNow()
  const snap = usage.snapshot
  const mode: PopoverMode = snap?.prefs.popoverMode ?? 'detailed'
  const rows = snap ? popoverProviders(snap.providers) : []
  const today = localDay(now)
  const peak = rows.map((p) => peakWindow(p)?.usedPercent ?? -1).reduce((a, b) => Math.max(a, b), -1)
  return (
    <div
      role="dialog"
      aria-label="Usage"
      data-testid="usage-popover"
      className={cn('flex w-[340px] flex-col overflow-hidden rounded-[10px] border border-border bg-card text-text shadow-2xl', className)}
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-3 pr-2">
        <span className="text-[13px] font-medium">Usage</span>
        <span className="text-[13px] text-text-3">· all agents</span>
        {peak >= 0 && (
          <span className={cn('text-[11.5px] tabular-nums', TONE_TEXT[barTone(peak)])} aria-label={`Highest window ${Math.round(peak)} percent`}>
            {Math.round(peak)}%
          </span>
        )}
        <button
          type="button"
          aria-label="Refresh usage"
          title="Refresh"
          data-testid="usage-refresh"
          disabled={!usage.available}
          onClick={() => void usage.refresh()}
          className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-text-3 hover:bg-hover hover:text-text"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', usage.refreshing && 'orcha-spin')} />
        </button>
        <ModeToggle mode={mode} onChange={(m) => void usage.update({ op: 'popoverMode', mode: m })} />
      </header>

      <ul className="flex max-h-[380px] flex-col gap-px overflow-y-auto p-1.5" aria-label="Providers">
        {!snap && <li className="px-2 py-3 text-[12px] text-text-3">{usage.available ? 'Reading usage…' : 'Usage isn’t available in this build.'}</li>}
        {snap && rows.length === 0 && <li className="px-2 py-3 text-[12px] text-text-3">No agent CLIs with usage found on this Mac.</li>}
        {rows.map((p) => (
          <ProviderRow
            key={p.id}
            p={p}
            mode={mode}
            now={now}
            today={today}
            onOpen={() => onOpenDetails(p.id)}
            onEnableLimits={p.limitsNeedOptIn ? () => onOpenDetails(p.id) : () => void usage.update({ op: 'limits', id: p.id, enabled: true })}
          />
        ))}
      </ul>

      {usage.error && <p className="px-3 pb-1 text-[11.5px] text-warning">{usage.error}</p>}

      <footer className="flex flex-col gap-px border-t border-border p-1.5">
        <button
          type="button"
          data-testid="usage-open-details"
          onClick={() => onOpenDetails()}
          className="flex h-7 items-center gap-2 rounded-md px-2 text-left text-[13px] text-text-2 hover:bg-hover hover:text-text"
        >
          <BarChart3 className="h-3.5 w-3.5 text-text-3" aria-hidden="true" /> Usage details &amp; history
        </button>
        <button
          type="button"
          data-testid="usage-manage-accounts"
          onClick={onManageAccounts}
          className="flex h-7 items-center gap-2 rounded-md px-2 text-left text-[13px] text-text-2 hover:bg-hover hover:text-text"
        >
          <UserCog className="h-3.5 w-3.5 text-text-3" aria-hidden="true" /> Manage Accounts…
        </button>
      </footer>
    </div>
  )
}
