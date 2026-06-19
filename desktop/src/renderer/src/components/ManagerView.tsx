import { useCallback, useEffect, useState } from 'react'
import type { AttentionItem, Stack } from '../../../shared/types'
import StackList from './StackList'
import DockerDownBanner from './DockerDownBanner'
import EmptyState from './EmptyState'
import ViewToggle, { type ViewMode } from './ViewToggle'

const POLL_MS = 5000
const VIEW_MODE_KEY = 'orcha.viewMode'

type ViewState =
  | { kind: 'loading' }
  | { kind: 'dockerDown' }
  | { kind: 'ready'; stacks: Stack[]; attention: AttentionItem[] }

function countsByProject(items: AttentionItem[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(item.project, (counts.get(item.project) ?? 0) + 1)
  return counts
}

function loadViewMode(): ViewMode {
  return localStorage.getItem(VIEW_MODE_KEY) === 'list' ? 'list' : 'cards'
}

export default function ManagerView({ onCreate }: { onCreate: () => void }) {
  const [view, setView] = useState<ViewState>({ kind: 'loading' })
  const [viewMode, setViewMode] = useState<ViewMode>(loadViewMode)

  const changeViewMode = useCallback((mode: ViewMode) => {
    setViewMode(mode)
    localStorage.setItem(VIEW_MODE_KEY, mode)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const [stacks, attention] = await Promise.all([
        window.orchaDesktop.listStacks(),
        window.orchaDesktop.listAttention().catch((): AttentionItem[] => [])
      ])
      setView({ kind: 'ready', stacks, attention })
    } catch {
      setView({ kind: 'dockerDown' })
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  return (
    <main className="mx-auto flex h-full max-w-3xl flex-col gap-4 p-6 animate-fade-in">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Orcha stacks</h1>
        <ViewToggle view={viewMode} onChange={changeViewMode} />
      </header>
      {view.kind === 'loading' && (
        <div className="rounded-xl border border-border bg-card p-4 text-sm text-text/60">Loading…</div>
      )}
      {view.kind === 'dockerDown' && <DockerDownBanner />}
      {view.kind === 'ready' &&
        (view.stacks.length === 0 ? (
          <EmptyState onCreate={onCreate} />
        ) : (
          <StackList
            stacks={view.stacks}
            attentionCounts={countsByProject(view.attention)}
            view={viewMode}
            onChanged={() => void refresh()}
          />
        ))}
    </main>
  )
}
