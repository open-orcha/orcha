/** Stats & Usage (Orca-style): Embodent's own agent stats, then Usage Analytics over the
 *  agents' local logs — overview cards, a daily-intensity heatmap, the token mix, models and
 *  providers (Enable / Off, persisted by main) — and the connected Embodent projects' own
 *  spend. Fills the inset content panel like Settings (main hides the portal view under it).
 *  Every cost is an estimate at API list price, and says so. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { BarChart3, ChevronDown, RefreshCw, X } from 'lucide-react'
import {
  activeDays,
  bestDay,
  cacheShare,
  formatDuration,
  formatResetIn,
  formatTokens,
  formatUsd,
  heatmapWeeks,
  sumLocal,
  totalTokens,
  type LocalUsage,
  type ProviderUsage,
  type UsageProviderId
} from '../../../shared/usage'
import { cn } from '../ui/cn'
import { ProviderLogo, WindowRow, providerStatusText } from './parts'
import { useNow, type UsageValue } from './useUsage'

export interface StatsProject {
  key: string
  name: string
  apiPort: number
  cid: string
}

type View = 'overview' | UsageProviderId

function dateLabel(ms: number | null): string {
  if (ms === null) return '—'
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function shortDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function ago(ms: number | null, now: number): string {
  if (ms === null) return 'not yet'
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

function StatCard({ label, value, sub, testId }: { label: string; value: string; sub?: string | null; testId?: string }) {
  return (
    <div data-testid={testId} className="min-w-0 rounded-[10px] border border-border bg-bg/40 px-4 py-3">
      <div className="text-[12px] text-text-3">{label}</div>
      <div className="mt-1 truncate text-[20px] font-semibold tracking-[-0.01em] tabular-nums text-text">{value}</div>
      {sub && <div className="mt-0.5 truncate text-[11.5px] text-text-3">{sub}</div>}
    </div>
  )
}

function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-[14px] font-semibold text-text">{title}</h3>
        <div className="ml-auto flex items-center gap-2">{right}</div>
      </div>
      {children}
    </section>
  )
}

const HEAT = ['bg-hover', 'bg-accent/25', 'bg-accent/45', 'bg-accent/70', 'bg-accent'] as const
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function Heatmap({ local, now, weeks = 6 }: { local: LocalUsage; now: number; weeks?: number }) {
  const cols = useMemo(() => heatmapWeeks(local.days, now, weeks), [local.days, now, weeks])
  const best = bestDay(cols)
  return (
    <div data-testid="usage-heatmap">
      <div className="flex gap-3">
        <div className="flex flex-col justify-between py-[1px] text-[10.5px] leading-[14px] text-text-3" aria-hidden="true">
          {DOW.map((d, i) => (
            <span key={d} className={i % 2 === 1 ? '' : 'invisible'}>
              {d}
            </span>
          ))}
        </div>
        <div role="grid" aria-label={`Daily token intensity, last ${weeks} weeks`} className="flex gap-[3px]">
          {cols.map((col, ci) => (
            <div key={ci} role="row" className="flex flex-col gap-[3px]">
              {col.map((c) => (
                <span
                  key={c.date}
                  role="gridcell"
                  data-level={c.level}
                  aria-label={c.future ? undefined : `${shortDate(c.date)}: ${formatTokens(c.tokens)} tokens, Est. ${formatUsd(c.costUsd)}`}
                  title={c.future ? '' : `${shortDate(c.date)} · ${formatTokens(c.tokens)} tokens · Est. ${formatUsd(c.costUsd)}`}
                  className={cn('h-[14px] w-[14px] rounded-[3px]', c.future ? 'bg-transparent' : HEAT[c.level])}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="mt-2 flex items-center gap-3 text-[11.5px] text-text-3">
        <span data-testid="usage-best-day">{best ? `Best: ${shortDate(best.date)} · ${formatTokens(best.tokens)} tokens` : 'No activity in this range'}</span>
        <span className="ml-auto flex items-center gap-1" aria-hidden="true">
          Less
          {HEAT.map((h, i) => (
            <span key={i} className={cn('h-2.5 w-2.5 rounded-[2px]', h)} />
          ))}
          More
        </span>
      </div>
    </div>
  )
}

const MIX: { key: 'input' | 'output' | 'cacheRead' | 'cacheWrite'; label: string; cls: string }[] = [
  { key: 'input', label: 'New input', cls: 'bg-accent' },
  { key: 'output', label: 'Output', cls: 'bg-info' },
  { key: 'cacheRead', label: 'Cache read', cls: 'bg-text-3' },
  { key: 'cacheWrite', label: 'Cache write', cls: 'bg-border-strong' }
]

export function TokenMix({ local }: { local: LocalUsage }) {
  const total = totalTokens(local.tokens)
  return (
    <div data-testid="usage-token-mix">
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-hover" role="img" aria-label="Token mix">
        {total > 0 &&
          MIX.map((m) => {
            const v = local.tokens[m.key]
            return v > 0 ? <span key={m.key} className={cn('h-full', m.cls)} style={{ width: `${(v / total) * 100}%` }} /> : null
          })}
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px]">
        {MIX.map((m) => {
          const v = local.tokens[m.key]
          return (
            <span key={m.key} className="flex items-center gap-1.5 text-text-2">
              <span className={cn('h-2 w-2 rounded-full', m.cls)} aria-hidden="true" />
              {m.label}
              <span className="tabular-nums text-text">{formatTokens(v)}</span>
              <span className="tabular-nums text-text-3">{total > 0 ? `${((v / total) * 100).toFixed(v / total < 0.01 ? 2 : 0)}%` : ''}</span>
            </span>
          )
        })}
        {local.tokens.reasoning > 0 && (
          <span className="rounded-full border border-border px-2 text-[11.5px] leading-5 text-text-2" data-testid="usage-reasoning-chip">
            Reasoning {formatTokens(local.tokens.reasoning)} <span className="text-text-3">(in output)</span>
          </span>
        )}
      </div>
    </div>
  )
}

function ModelsTable({ local }: { local: LocalUsage }) {
  const max = Math.max(1, ...local.models.map((m) => totalTokens(m.tokens)))
  return (
    <div className="overflow-hidden rounded-[10px] border border-border" data-testid="usage-models">
      <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_72px_84px] gap-3 border-b border-border px-4 py-2 text-[11.5px] text-text-3">
        <span>Model</span>
        <span>Tokens</span>
        <span className="text-right">Responses</span>
        <span className="text-right">Est. cost</span>
      </div>
      {local.models.length === 0 && <div className="px-4 py-3 text-[12px] text-text-3">No model usage yet.</div>}
      {local.models.map((m) => (
        <div key={m.model} className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_72px_84px] items-center gap-3 px-4 py-2 text-[13px]">
          <span className="truncate text-text" title={m.model}>
            {m.model === 'unknown' ? 'Model not logged' : m.label}
          </span>
          <span className="flex items-center gap-2">
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-hover">
              <span className="block h-full rounded-full bg-text-3" style={{ width: `${(totalTokens(m.tokens) / max) * 100}%` }} />
            </span>
            <span className="w-14 text-right tabular-nums text-text-2">{formatTokens(totalTokens(m.tokens))}</span>
          </span>
          <span className="text-right tabular-nums text-text-2">{m.events.toLocaleString('en-US')}</span>
          <span className="text-right tabular-nums text-text-2" title={m.costUsd === null ? 'Not in the price table' : undefined}>
            {m.costUsd === null ? '—' : formatUsd(m.costUsd)}
          </span>
        </div>
      ))}
    </div>
  )
}

function ProviderCard({
  p,
  share,
  onToggle,
  onToggleLimits,
  onSelect,
  now
}: {
  p: ProviderUsage
  share: number
  onToggle(on: boolean): void
  onToggleLimits(on: boolean): void
  onSelect(): void
  now: number
}) {
  const l = p.local
  const top = l?.models[0]
  const on = p.enabled
  const chip = p.state === 'not-installed' ? 'Not installed' : on ? 'Enabled' : 'Off'
  return (
    <div data-testid={`usage-provider-${p.id}`} data-state={p.state} className="flex min-w-0 flex-col gap-3 rounded-[10px] border border-border px-4 py-3">
      <div className="flex items-center gap-2.5">
        <ProviderLogo id={p.id} size={26} dim={!on || p.state === 'not-installed'} />
        <button type="button" onClick={onSelect} disabled={!l} className="min-w-0 text-left disabled:cursor-default">
          <div className="truncate text-[13px] font-medium text-text">{p.label}</div>
          <div className="truncate text-[11.5px] text-text-3">{top ? (top.model === 'unknown' ? 'Model not logged' : top.label) : providerStatusText(p) || '—'}</div>
        </button>
        <span className={cn('ml-auto rounded-full border px-2 text-[11px] leading-5', on && p.state !== 'not-installed' ? 'border-border text-text-2' : 'border-border text-text-3')}>
          {chip}
        </span>
        <button
          type="button"
          data-testid={`usage-provider-toggle-${p.id}`}
          aria-pressed={on}
          onClick={() => onToggle(!on)}
          className="h-6 shrink-0 rounded-md border border-border px-2 text-[12px] text-text hover:bg-hover"
        >
          {on ? 'Off' : 'Enable'}
        </button>
      </div>
      {l && on ? (
        <>
          <div className="grid grid-cols-3 gap-2 text-[12px]">
            <div>
              <div className="text-text-3">Tokens</div>
              <div className="tabular-nums text-text">{formatTokens(totalTokens(l.tokens))}</div>
            </div>
            <div>
              <div className="text-text-3">{p.id === 'claude' ? 'Sessions · turns' : 'Sessions · events'}</div>
              <div className="tabular-nums text-text">
                {l.sessions.toLocaleString('en-US')} · {(p.id === 'claude' ? l.turns : l.events).toLocaleString('en-US')}
              </div>
            </div>
            <div>
              <div className="text-text-3">Est. cost</div>
              <div className="tabular-nums text-text">{formatUsd(l.costUsd)}</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-hover" aria-label={`${Math.round(share * 100)}% of all tokens`}>
              <span className="block h-full rounded-full bg-text-2 transition-[width] duration-500" style={{ width: `${share * 100}%` }} />
            </span>
            <span className="rounded-full border border-border px-2 text-[11px] leading-5 text-text-2">
              {l.sessions.toLocaleString('en-US')} session{l.sessions === 1 ? '' : 's'}
            </span>
          </div>
        </>
      ) : (
        <div className="text-[12px] text-text-3">
          {!on
            ? 'Tracking is off — nothing is read.'
            : p.hasLogAdapter
              ? `No local usage yet${p.logPath ? ` in ${p.logPath}` : ''}.`
              : p.state === 'not-installed'
                ? 'Not installed on this Mac — install it from Settings › Agents.'
                : 'Embodent can’t read this CLI’s usage yet.'}
        </div>
      )}
      {on && p.hasLimits && (
        <div className="flex flex-col gap-1.5 border-t border-border pt-3" data-testid={`usage-limits-${p.id}`}>
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-medium text-text-2">Subscription limits</span>
            {p.limits?.plan && <span className="text-[11.5px] text-text-3">{p.limits.plan}</span>}
            {p.limitsNeedOptIn && (
              <button
                type="button"
                data-testid={`usage-limits-toggle-${p.id}`}
                aria-pressed={p.limitsEnabled}
                onClick={() => onToggleLimits(!p.limitsEnabled)}
                className="ml-auto h-6 rounded-md border border-border px-2 text-[12px] text-text hover:bg-hover"
              >
                {p.limitsEnabled ? 'Off' : 'Enable'}
              </button>
            )}
          </div>
          {p.limits?.status === 'ok' ? (
            <>
              {p.limits.windows.map((w) => (
                <div key={w.key} className="grid grid-cols-[1fr_auto] items-center gap-3">
                  <WindowRow w={w} />
                  <span className="w-[112px] text-right text-[11px] text-text-3">{formatResetIn(w.resetsAt, now) ?? ''}</span>
                </div>
              ))}
              <span className="text-[11px] text-text-3">
                From {p.limits.source}
                {p.limits.fetchedAt ? ` · ${ago(p.limits.fetchedAt, now)}` : ''}
                {p.limits.note ? ` · ${p.limits.note}` : ''}
              </span>
            </>
          ) : (
            <span className={cn('text-[12px]', p.limits?.status === 'expired' ? 'text-warning' : 'text-text-3')}>
              {p.limits?.status === 'expired' ? 'Sign-in expired — run `claude` once to refresh it.' : p.limits?.note}
            </span>
          )}
          {p.limitsNeedOptIn && p.limitsExplainer && <p className="text-[11px] leading-4 text-text-3">{p.limitsExplainer}</p>}
        </div>
      )}
    </div>
  )
}

interface ProjectSpend {
  key: string
  name: string
  runs: number
  cost: number
  tokens: number
  runsWithCost: number
  error: boolean
}

function useProjectSpend(projects: readonly StatsProject[], portalGet?: (apiPort: number, path: string) => Promise<unknown>): ProjectSpend[] | null {
  const [rows, setRows] = useState<ProjectSpend[] | null>(null)
  const key = projects.map((p) => `${p.apiPort}:${p.cid}`).join(',')
  useEffect(() => {
    if (!portalGet || projects.length === 0) {
      setRows([])
      return
    }
    let alive = true
    void Promise.all(
      projects.map(async (p): Promise<ProjectSpend> => {
        try {
          const r = (await portalGet(p.apiPort, `/api/containers/${p.cid}/metrics`)) as {
            totals?: { runs?: number; est_cost_usd?: number; tokens_in?: number; tokens_out?: number; runs_with_cost?: number }
          }
          const t = r?.totals ?? {}
          return {
            key: p.key,
            name: p.name,
            runs: t.runs ?? 0,
            cost: t.est_cost_usd ?? 0,
            tokens: (t.tokens_in ?? 0) + (t.tokens_out ?? 0),
            runsWithCost: t.runs_with_cost ?? 0,
            error: false
          }
        } catch {
          return { key: p.key, name: p.name, runs: 0, cost: 0, tokens: 0, runsWithCost: 0, error: true }
        }
      })
    ).then((r) => alive && setRows(r.sort((a, b) => b.cost - a.cost)))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, portalGet])
  return rows
}

export default function StatsView({
  usage,
  initialView = 'overview',
  projects = [],
  portalGet,
  onClose
}: {
  usage: UsageValue
  initialView?: View
  projects?: readonly StatsProject[]
  portalGet?: (apiPort: number, path: string) => Promise<unknown>
  onClose(): void
}) {
  const now = useNow(60_000)
  const snap = usage.snapshot
  const [view, setView] = useState<View>(initialView)
  useEffect(() => setView(initialView), [initialView])
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  const providers = snap?.providers ?? []
  const tracked = providers.filter((p) => p.enabled && p.local)
  const overview = useMemo(() => sumLocal(tracked.map((p) => p.local)), [tracked])
  const selected = view === 'overview' ? null : (providers.find((p) => p.id === view) ?? null)
  const local: LocalUsage = selected?.local ?? (selected ? sumLocal([]) : overview)
  const allTokens = totalTokens(overview.tokens)
  const share = cacheShare(local.tokens)
  const spend = useProjectSpend(projects, portalGet)
  const app = snap?.app
  const since = [app?.trackingSince ?? null, overview.firstSeen].filter((x): x is number => x !== null)
  const logSessions = overview.sessions
  const viewOptions = providers.filter((p) => p.local && p.enabled)

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="region"
      aria-label="Stats & Usage"
      data-testid="stats-view"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !(e.target instanceof HTMLSelectElement)) {
          e.preventDefault()
          onClose()
        }
      }}
      className="absolute inset-0 z-20 flex flex-col bg-card outline-none animate-fade-in"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
        <BarChart3 className="h-4 w-4 text-text-3" aria-hidden="true" />
        <h1 className="text-[13px] font-medium text-text">Stats &amp; Usage</h1>
        <button
          type="button"
          aria-label="Close Stats & Usage"
          title="Close (Esc)"
          data-testid="stats-close"
          onClick={onClose}
          className="ml-auto flex h-7 w-7 items-center justify-center rounded-full border border-border text-text-3 hover:bg-hover hover:text-text"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[920px] px-8 pb-16 pt-8">
          <h2 className="text-[24px] font-semibold tracking-[-0.01em] text-text">Stats &amp; Usage</h2>
          <p className="mb-6 mt-1 text-[13px] text-text-3">
            Read locally from your agents’ own session logs — nothing leaves this Mac. Costs are estimates at API list price; a subscription bills differently.
          </p>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="stats-cards">
            <StatCard
              testId="stat-spawned"
              label="Agents spawned"
              value={(app?.agentsSpawned ?? 0).toLocaleString('en-US')}
              sub={`from Embodent · ${logSessions.toLocaleString('en-US')} sessions in logs`}
            />
            <StatCard
              testId="stat-time"
              label="Time agents worked"
              value={formatDuration(overview.activeSeconds)}
              sub={`from logs · ${formatDuration(app?.agentSeconds ?? 0)} in Embodent`}
            />
            <StatCard testId="stat-prs" label="PRs created" value={overview.prsCreated.toLocaleString('en-US')} sub="gh pr create by agents" />
            <StatCard
              testId="stat-since"
              label="Tracking since"
              value={since.length ? dateLabel(Math.min(...since)) : '—'}
              sub={`${activeDays(overview)} active days`}
            />
          </div>

          <Section
            title="Usage Analytics"
            right={
              <label className="relative flex items-center">
                <span className="sr-only">View</span>
                <select
                  data-testid="usage-view-select"
                  value={view}
                  onChange={(e) => setView(e.target.value as View)}
                  className="h-7 appearance-none rounded-md border border-border bg-raised pl-2.5 pr-7 text-[13px] text-text outline-none hover:bg-hover"
                >
                  <option value="overview">Overview</option>
                  {viewOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 h-3.5 w-3.5 text-text-3" aria-hidden="true" />
              </label>
            }
          >
            <div className="rounded-[10px] border border-border p-4">
              <div className="mb-3 flex items-center gap-2">
                <span className="text-[13px] font-medium text-text">{selected ? `${selected.label} usage` : 'Usage Overview'}</span>
                <span className="text-[11.5px] text-text-3" data-testid="usage-updated">
                  Updated {ago(snap?.updatedAt ?? null, now)}
                </span>
                <button
                  type="button"
                  aria-label="Refresh usage"
                  data-testid="stats-refresh"
                  onClick={() => void usage.refresh()}
                  className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-text-3 hover:bg-hover hover:text-text"
                >
                  <RefreshCw className={cn('h-3.5 w-3.5', usage.refreshing && 'orcha-spin')} />
                </button>
              </div>
              {snap?.error && <p className="mb-3 text-[12px] text-warning">{snap.error}</p>}
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="usage-overview-cards">
                <StatCard testId="card-tokens" label="Total tokens" value={formatTokens(totalTokens(local.tokens))} sub={`${local.events.toLocaleString('en-US')} responses`} />
                <StatCard
                  testId="card-cost"
                  label="Est. cost"
                  value={formatUsd(local.costUsd)}
                  sub={local.unpricedTokens > 0 ? `${formatTokens(local.unpricedTokens)} tokens unpriced` : 'at API list price'}
                />
                <StatCard testId="card-days" label="Active days" value={String(activeDays(local))} sub={local.firstSeen ? `since ${dateLabel(local.firstSeen)}` : null} />
                <StatCard testId="card-cache" label="Cache share" value={share === null ? '—' : `${Math.round(share * 100)}%`} sub="of input served from cache" />
              </div>
              <div className="mt-6 grid gap-6 md:grid-cols-[auto_1fr]">
                <div>
                  <div className="mb-2 text-[12px] font-medium text-text-2">Daily intensity</div>
                  <Heatmap local={local} now={now} />
                </div>
                <div className="min-w-0">
                  <div className="mb-2 text-[12px] font-medium text-text-2">Token mix</div>
                  <TokenMix local={local} />
                </div>
              </div>
            </div>
          </Section>

          <Section title="Models">
            <ModelsTable local={local} />
          </Section>

          <Section title="Providers">
            <div className="grid gap-3 md:grid-cols-2" data-testid="usage-providers">
              {providers.map((p) => (
                <ProviderCard
                  key={p.id}
                  p={p}
                  now={now}
                  share={allTokens > 0 && p.local ? totalTokens(p.local.tokens) / allTokens : 0}
                  onSelect={() => setView(p.id)}
                  onToggle={(on) => void usage.update({ op: 'provider', id: p.id, enabled: on })}
                  onToggleLimits={(on) => void usage.update({ op: 'limits', id: p.id, enabled: on })}
                />
              ))}
            </div>
          </Section>

          <Section title="Embodent projects">
            {spend === null ? (
              <p className="text-[12px] text-text-3">Loading…</p>
            ) : spend.length === 0 ? (
              <p className="text-[12px] text-text-3">No running Embodent project — start one to see its agents’ spend here.</p>
            ) : (
              <div className="overflow-hidden rounded-[10px] border border-border" data-testid="usage-projects">
                <div className="grid grid-cols-[minmax(0,1fr)_72px_96px_96px] gap-3 border-b border-border px-4 py-2 text-[11.5px] text-text-3">
                  <span>Project · last 7 days</span>
                  <span className="text-right">Runs</span>
                  <span className="text-right">Tokens</span>
                  <span className="text-right">Est. spend</span>
                </div>
                {spend.map((r) => (
                  <div key={r.key} className="grid grid-cols-[minmax(0,1fr)_72px_96px_96px] items-center gap-3 px-4 py-2 text-[13px]">
                    <span className="truncate text-text">{r.name}</span>
                    <span className="text-right tabular-nums text-text-2">{r.error ? '—' : r.runs}</span>
                    <span className="text-right tabular-nums text-text-2">{r.error ? '—' : formatTokens(r.tokens)}</span>
                    <span className="text-right tabular-nums text-text-2" title={r.error ? 'Couldn’t read this project’s metrics' : `${r.runsWithCost} of ${r.runs} runs reported a cost`}>
                      {r.error ? 'unavailable' : formatUsd(r.cost)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Section>

          <p className="mt-8 text-[11px] leading-4 text-text-3">
            Approach adapted from Orca’s usage panel (github.com/stablyai/orca, MIT © Lovecast Inc.). Prices: Anthropic and OpenAI list prices (see
            shared/pricing.ts).
          </p>
        </div>
      </div>
    </div>
  )
}
