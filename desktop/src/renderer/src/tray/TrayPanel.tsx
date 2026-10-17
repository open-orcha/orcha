import { useCallback, useEffect, useMemo, useState } from 'react'
import { AppWindow, CircleCheck, Inbox, X } from 'lucide-react'
import { isDecisionItem, type AttentionItem, type Stack } from '../../../shared/types'
import { Button } from '../ui/Button'
import { cn } from '../ui/cn'
import { OrchaMark } from '../components/OrchaMark'
import { loadProjectCards, type ProjectCardData } from '../home/loadProjectCards'
import { buildProjectRows, stackBand, type ProjectBand } from '../host/projectModel'
import UsagePopover from '../usage/UsagePopover'
import { peakProvider } from '../usage/UsageIndicator'
import { useUsage } from '../usage/useUsage'
import { barTone } from '../../../shared/usage'
import { TONE_TEXT } from '../usage/parts'

const POLL_MS = 5000
const ITEMS_SHOWN_MAX = 5

/** Exact, distinct labels per kind (V2 arch §3.1). Follow-ups are listed but never counted. */
const KIND_LABELS: Record<AttentionItem['kind'], string> = {
  task_plan: 'plan',
  task_verify: 'verify',
  request_answer: 'request',
  request_close: 'follow-up',
  health: 'health'
}

const DOT: Record<ProjectBand, string> = {
  running: 'bg-ok',
  starting: 'bg-warning',
  paused: 'bg-text-3',
  stopped: 'bg-text-3'
}

export default function TrayPanel() {
  const [stacks, setStacks] = useState<Stack[]>([])
  const [items, setItems] = useState<AttentionItem[]>([])
  const [cards, setCards] = useState<ProjectCardData[]>([])
  const [tab, setTab] = useState<'projects' | 'usage'>('projects')
  const usage = useUsage(window.orchaDesktop.usage)
  const peak = peakProvider(usage.snapshot)

  const refresh = useCallback(async () => {
    try {
      const [s, a] = await Promise.all([
        window.orchaDesktop.listStacks(),
        window.orchaDesktop.listAttention()
      ])
      // Same project/container read the manager does, so a stack's word comes from the same
      // rows + band rule (Starting / Paused match the Projects manager exactly).
      const c = window.orchaDesktop.portalGet ? await loadProjectCards(s, window.orchaDesktop.portalGet) : []
      setStacks(s)
      setItems(a)
      setCards(c)
    } catch {
      setStacks([])
      setItems([])
      setCards([])
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  const byProject = useMemo(() => {
    const grouped = new Map<string, AttentionItem[]>()
    for (const i of items) {
      const list = grouped.get(i.project)
      if (list) list.push(i)
      else grouped.set(i.project, [i])
    }
    return grouped
  }, [items])

  const bands = useMemo(() => {
    const rows = buildProjectRows({
      stacks,
      cards,
      attention: null,
      pinned: new Set(),
      order: [],
      active: { project: null, cid: null, portalAttention: null }
    })
    const out = new Map<string, { band: ProjectBand; word: string }>()
    for (const st of stacks) out.set(st.project, stackBand(rows.filter((r) => r.stack.project === st.project)))
    return out
  }, [stacks, cards])

  const decisions = (list: AttentionItem[] | undefined): number => (list ?? []).filter(isDecisionItem).length
  const runningCount = stacks.filter((s) => s.running).length
  const mostUrgent = [...stacks].sort((a, b) => decisions(byProject.get(b.project)) - decisions(byProject.get(a.project)))[0]
  const decisionCount = items.filter(isDecisionItem).length
  const followUpCount = items.length - decisionCount
  const allClear = decisionCount === 0

  return (
    <div className="flex h-full flex-col bg-bg text-text animate-fade-in">
      <header className="flex h-10 shrink-0 items-center gap-2 px-3">
        <OrchaMark size={16} className="shrink-0" />
        <span className="text-[13px] font-semibold">Embodent</span>
        <span className="whitespace-nowrap text-xs tabular-nums text-text-3">
          {runningCount}/{stacks.length} running
        </span>
        {usage.available && (
          <div role="tablist" aria-label="Tray view" className="ml-auto flex h-6 items-center rounded-md border border-border p-0.5">
            {(['projects', 'usage'] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                data-testid={`tray-tab-${t}`}
                onClick={() => setTab(t)}
                className={cn(
                  'flex h-[18px] items-center gap-1 rounded-[4px] px-1.5 text-[11px] font-medium capitalize transition-colors',
                  tab === t ? 'bg-selected text-text' : 'text-text-3 hover:text-text'
                )}
              >
                {t}
                {t === 'usage' && peak && (
                  <span className={cn('tabular-nums', TONE_TEXT[barTone(peak.percent)])}>{Math.round(peak.percent)}%</span>
                )}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          aria-label="Close"
          onClick={() => window.close()}
          className={cn('flex h-6 w-6 items-center justify-center rounded-md text-text-3 hover:bg-hover hover:text-text', !usage.available && 'ml-auto')}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>

      {tab === 'usage' ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          <UsagePopover
            usage={usage}
            className="w-full shadow-none"
            onOpenDetails={() => void window.orchaDesktop.usage?.openStats('stats')}
            onManageAccounts={() => void window.orchaDesktop.usage?.openStats('accounts')}
          />
        </div>
      ) : (
      <>

      <div
        className="flex items-center gap-2 px-3 pb-2 text-[13px]"
        title="Decisions waiting on a human: plan approvals, verifications and requests. Follow-ups are listed but not counted."
      >
        {allClear ? (
          <>
            <CircleCheck className="h-4 w-4 text-ok" aria-hidden="true" />
            <span className="text-text">All clear</span>
          </>
        ) : (
          <>
            <Inbox className="h-4 w-4 text-warning" aria-hidden="true" />
            <span className="text-text">
              Needs you <span className="font-semibold tabular-nums text-warning">{decisionCount}</span>
            </span>
          </>
        )}
        {followUpCount > 0 && (
          <span className="ml-auto text-xs text-text-3">
            {followUpCount} follow-up{followUpCount === 1 ? '' : 's'} (not counted)
          </span>
        )}
      </div>

      <ul className="flex min-h-0 flex-1 flex-col gap-px overflow-auto border-t border-border px-1.5 py-1.5">
        {stacks.map((s) => {
          const stackItems = byProject.get(s.project) ?? []
          const count = stackItems.length
          const waiting = decisions(stackItems)
          const hidden = count - ITEMS_SHOWN_MAX
          const band = bands.get(s.project) ?? stackBand([])
          return (
            <li key={s.project}>
              <button
                className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors hover:bg-hover disabled:pointer-events-none disabled:opacity-50"
                disabled={!s.running || s.apiPort === null}
                onClick={() => void window.orchaDesktop.portalShow(s.project)}
              >
                <span
                  data-band={band.band}
                  className={cn('h-1.5 w-1.5 shrink-0 rounded-full', DOT[band.band])}
                  aria-hidden="true"
                />
                <span className="min-w-0 truncate font-medium" title={s.projectShort}>
                  {s.projectShort}
                </span>
                <span className={cn('ml-auto shrink-0 text-xs tabular-nums', waiting > 0 ? 'text-warning' : 'text-text-3')}>
                  {waiting > 0 ? `${waiting} waiting` : count > 0 ? `${count} follow-up${count === 1 ? '' : 's'}` : band.word}
                </span>
              </button>
              {count > 0 && (
                <ul className="flex flex-col gap-px pb-1 pl-5">
                  {stackItems.slice(0, ITEMS_SHOWN_MAX).map((i) => (
                    <li key={`${i.kind}:${i.id}`}>
                      <button
                        className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors hover:bg-hover"
                        onClick={() => void window.orchaDesktop.portalShow(i.project, i.path)}
                      >
                        <span className="shrink-0 rounded-full border border-border px-1.5 text-[11px] leading-4 text-text-2">
                          {KIND_LABELS[i.kind]}
                        </span>
                        <span className="min-w-0 truncate text-text-2" title={i.title}>
                          {i.title}
                        </span>
                      </button>
                    </li>
                  ))}
                  {hidden > 0 && <li className="px-2 py-1 text-xs text-text-3">+{hidden} more</li>}
                </ul>
              )}
            </li>
          )
        })}
      </ul>

      </>
      )}

      <footer className="flex h-11 shrink-0 items-center gap-1 border-t border-border px-2">
        <Button variant="ghost" aria-label="Open Embodent" onClick={() => void window.orchaDesktop.openManager()}>
          <AppWindow />
          Open Embodent
        </Button>
        {mostUrgent && decisions(byProject.get(mostUrgent.project)) > 0 && (
          <Button
            variant="ghost"
            className="ml-auto min-w-0"
            disabled={!mostUrgent.running || mostUrgent.apiPort === null}
            onClick={() => void window.orchaDesktop.portalShow(mostUrgent.project)}
          >
            <span className="truncate">Open {mostUrgent.projectShort}</span>
          </Button>
        )}
      </footer>
    </div>
  )
}
