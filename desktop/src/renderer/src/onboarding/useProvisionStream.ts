import { useEffect, useState } from 'react'
import type { ProgressEvent } from '../../../shared/types'

/** Collect progress events for a single run only (drops stale-run noise).
 *
 *  The renderer doesn't know the engine-minted runId until the first event
 *  arrives, so we tag the run by the first event's runId: once we've seen one
 *  event, any subsequent event whose runId differs from `prev[0].runId` is
 *  dropped as stale. `activeRunId` is accepted for an explicit reset between
 *  runs but the in-flight guard needs no external runId.
 */
export function useProvisionStream(activeRunId: string | null): {
  events: ProgressEvent[]
  reset: () => void
} {
  const [events, setEvents] = useState<ProgressEvent[]>([])
  void activeRunId

  useEffect(() => {
    const unsub = window.orchaDesktop.onProvisionProgress((e) => {
      setEvents((prev) => {
        if (prev.length > 0 && prev[0].runId !== e.runId) return prev // stale run
        return [...prev, e]
      })
    })
    return unsub
  }, [])

  return { events, reset: () => setEvents([]) }
}
