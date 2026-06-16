import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AttentionItem, Stack } from '../../../shared/types'

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

  return (
    <div className="tray-panel">
      <header className="tray-header">
        <span className="tray-title">Orcha</span>
        <span className="tray-chip">
          {runningCount}/{stacks.length} running
        </span>
      </header>

      <div className={`tray-ring ${items.length === 0 ? 'tray-ring-clear' : ''}`}>
        {items.length === 0 ? (
          <span className="tray-ring-label">ALL CLEAR</span>
        ) : (
          <>
            <span className="tray-ring-label">NEEDS ATTENTION</span>
            <span className="tray-ring-count">{items.length}</span>
          </>
        )}
      </div>

      <ul className="tray-stacks">
        {stacks.map((s) => {
          const stackItems = byProject.get(s.project) ?? []
          const count = stackItems.length
          const hidden = count - ITEMS_SHOWN_MAX
          return (
            <li key={s.project}>
              <button
                className={`tray-stack-row ${count > 0 ? 'tray-stack-attention' : ''}`}
                disabled={!s.running || s.apiPort === null}
                onClick={() => void window.orchaDesktop.openPortal(s.project)}
              >
                <span className={`tray-dot ${s.running ? 'tray-dot-up' : ''}`} />
                <span className="tray-stack-name">{s.projectShort}</span>
                <span className="tray-stack-meta">
                  {count > 0 ? `${count} pending` : s.running ? 'running' : 'stopped'}
                </span>
              </button>
              {count > 0 && (
                <ul className="tray-items">
                  {stackItems.slice(0, ITEMS_SHOWN_MAX).map((i) => (
                    <li key={`${i.kind}:${i.id}`}>
                      <button
                        className="tray-item-row"
                        onClick={() => void window.orchaDesktop.openPortal(i.project, i.path)}
                      >
                        <span className="tray-kind-chip">{KIND_LABELS[i.kind]}</span>
                        <span className="tray-item-title">{i.title}</span>
                      </button>
                    </li>
                  ))}
                  {hidden > 0 && <li className="tray-more">+{hidden} more</li>}
                </ul>
              )}
            </li>
          )
        })}
      </ul>

      <footer className="tray-footer">
        <button
          className="tray-icon-button"
          aria-label="Open Orcha"
          onClick={() => void window.orchaDesktop.openManager()}
        >
          ⚙
        </button>
        <button
          className="tray-primary"
          disabled={!mostUrgent || !mostUrgent.running || mostUrgent.apiPort === null}
          onClick={() => mostUrgent && void window.orchaDesktop.openPortal(mostUrgent.project)}
        >
          Open portal
        </button>
        <button className="tray-icon-button" aria-label="Close" onClick={() => window.close()}>
          ✕
        </button>
      </footer>
    </div>
  )
}
