/** Usage snapshot in a renderer (manager or tray popover): one read from main, kept current
 *  by main's `changed` push. */
import { useCallback, useEffect, useState } from 'react'
import type { UsageApi, UsageSnapshot, UsageUpdate } from '../../../shared/usage'

export interface UsageValue {
  snapshot: UsageSnapshot | null
  available: boolean
  refreshing: boolean
  error: string | null
  refresh(): Promise<void>
  update(u: UsageUpdate): Promise<void>
}

export function useUsage(api: UsageApi | undefined): UsageValue {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!api) return
    let alive = true
    const off = api.onChanged((s) => alive && setSnapshot(s))
    void api
      .get()
      .then((s) => alive && setSnapshot(s))
      .catch(() => alive && setError('Couldn’t load usage.'))
    return () => {
      alive = false
      off()
    }
  }, [api])

  const refresh = useCallback(async () => {
    if (!api) return
    setRefreshing(true)
    setError(null)
    try {
      setSnapshot(await api.refresh())
    } catch {
      setError('Refresh failed — try again.')
    } finally {
      setRefreshing(false)
    }
  }, [api])

  const update = useCallback(
    async (u: UsageUpdate) => {
      if (!api) return
      try {
        setSnapshot(await api.update(u))
      } catch {
        setError('That change couldn’t be saved.')
      }
    },
    [api]
  )

  return { snapshot, available: !!api, refreshing: refreshing || !!snapshot?.scanning, error, refresh, update }
}

/** Re-render on an interval (reset countdowns). */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(t)
  }, [everyMs])
  return now
}
