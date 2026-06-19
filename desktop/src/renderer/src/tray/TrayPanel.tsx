import { useCallback, useEffect, useMemo, useState } from 'react'
import { Settings, X } from 'lucide-react'
import type { AttentionItem, Stack } from '../../../shared/types'
import { Button } from '../ui/Button'
import { Badge } from '../ui/Badge'
import { cn } from '../ui/cn'

const POLL_MS = 5000
const ITEMS_SHOWN_MAX = 5

const KIND_LABELS: Record<AttentionItem['kind'], string> = {
  request_answer: 'escalation',
  request_close: 'close',
  task_verify: 'verify',
  health: 'health'
}

export default function TrayPanel() {
  const [stacks, setStacks] = useState<Stack[]>([])
  const [items, setItems] = useState<AttentionItem[]>([])

  const refresh = useCallback(async () => {
    try {
      const [s, a] = await Promise.all([
        window.orchaDesktop.listStacks(),
        window.orchaDesktop.listAttention()
      ])
      setStacks(s)
      setItems(a)
    } catch {
      setStacks([])
      setItems([])
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

  const runningCount = stacks.filter((s) => s.running).length
  const mostUrgent = [...stacks].sort(
    (a, b) => (byProject.get(b.project)?.length ?? 0) - (byProject.get(a.project)?.length ?? 0)
  )[0]
  const allClear = items.length === 0

  return (
    <div className="flex h-full flex-col gap-3 bg-bg p-3 text-text animate-fade-in">
      <header className="flex items-center justify-between">
        <span className="text-sm font-semibold">Orcha</span>
        <Badge>
          {runningCount}/{stacks.length} running
        </Badge>
      </header>

      <div
        className={cn(
          'flex items-center justify-center gap-2 rounded-xl border px-3 py-4 text-center',
          allClear ? 'border-ok/40 text-ok' : 'border-accent/40 text-accent'
        )}
      >
        {allClear ? (
          <span className="text-xs font-semibold tracking-wide">ALL CLEAR</span>
        ) : (
          <>
            <span className="text-xs font-semibold tracking-wide">NEEDS ATTENTION</span>
            <span className="text-lg font-bold leading-none">{items.length}</span>
          </>
        )}
      </div>

      <ul className="flex flex-1 flex-col gap-1 overflow-auto">
        {stacks.map((s) => {
          const stackItems = byProject.get(s.project) ?? []
          const count = stackItems.length
          const hidden = count - ITEMS_SHOWN_MAX
          return (
            <li key={s.project}>
              <button
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition-colors hover:bg-card disabled:pointer-events-none disabled:opacity-50',
                  count > 0 && 'bg-card'
                )}
                disabled={!s.running || s.apiPort === null}
                onClick={() => void window.orchaDesktop.openPortal(s.project)}
              >
                <span
                  className={cn(
                    'h-2 w-2 shrink-0 rounded-full',
                    s.running ? 'bg-ok' : 'bg-border'
                  )}
                />
                <span className="font-medium">{s.projectShort}</span>
                <span className="ml-auto text-xs text-text/50">
                  {count > 0 ? `${count} pending` : s.running ? 'running' : 'stopped'}
                </span>
              </button>
              {count > 0 && (
                <ul className="mt-1 flex flex-col gap-1 pl-4">
                  {stackItems.slice(0, ITEMS_SHOWN_MAX).map((i) => (
                    <li key={`${i.kind}:${i.id}`}>
                      <button
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-card"
                        onClick={() => void window.orchaDesktop.openPortal(i.project, i.path)}
                      >
                        <Badge>{KIND_LABELS[i.kind]}</Badge>
                        <span className="truncate text-text/80">{i.title}</span>
                      </button>
                    </li>
                  ))}
                  {hidden > 0 && (
                    <li className="px-2 py-1 text-xs text-text/40">+{hidden} more</li>
                  )}
                </ul>
              )}
            </li>
          )
        })}
      </ul>

      <footer className="flex items-center gap-2 border-t border-border pt-3">
        <Button
          variant="ghost"
          size="sm"
          aria-label="Open Orcha"
          onClick={() => void window.orchaDesktop.openManager()}
        >
          <Settings className="h-4 w-4" />
        </Button>
        <Button
          size="sm"
          className="flex-1"
          disabled={!mostUrgent || !mostUrgent.running || mostUrgent.apiPort === null}
          onClick={() => mostUrgent && void window.orchaDesktop.openPortal(mostUrgent.project)}
        >
          Open portal
        </Button>
        <Button variant="ghost" size="sm" aria-label="Close" onClick={() => window.close()}>
          <X className="h-4 w-4" />
        </Button>
      </footer>
    </div>
  )
}
