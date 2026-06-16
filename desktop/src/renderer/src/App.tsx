import { useCallback, useEffect, useState } from 'react'
import type { AttentionItem, Stack } from '../../shared/types'
import StackList from './components/StackList'
import DockerDownBanner from './components/DockerDownBanner'
import EmptyState from './components/EmptyState'
import ViewToggle, { type ViewMode } from './components/ViewToggle'

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

export default function App() {
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
        // Attention is best-effort: an attention hiccup must not flip the
        // manager into the Docker-down state — only listStacks decides that.
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
    <main>
      <header className="app-header">
        <h1>Orcha stacks</h1>
        <ViewToggle view={viewMode} onChange={changeViewMode} />
      </header>
      {view.kind === 'loading' && <div className="banner">Loading…</div>}
      {view.kind === 'dockerDown' && <DockerDownBanner />}
      {view.kind === 'ready' &&
        (view.stacks.length === 0 ? (
          <EmptyState />
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
