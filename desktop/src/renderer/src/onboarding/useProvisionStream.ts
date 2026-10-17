import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProgressEvent } from '../../../shared/types'

/** Collect provisioning progress for the CURRENT attempt only.
 *
 *  One attempt can span several engine run ids — "From GitHub" streams the clone under a
 *  `clone:` run id and then the provision pipeline under its own — so the filter is not
 *  "first run id wins" (that silently dropped every provision step after a clone). Instead:
 *   - nothing is collected until `begin()` arms the stream (events before any attempt are
 *     noise from elsewhere and are ignored);
 *   - `begin()` (called at the start of every attempt, including Try again) clears the list
 *     and marks every run id seen so far as stale, so late events from a previous failed
 *     attempt can never leak into the retry's checklist or log.
 */
export function useProvisionStream(): {
  events: ProgressEvent[]
  begin: () => void
} {
  const [events, setEvents] = useState<ProgressEvent[]>([])
  const armed = useRef(false)
  const seen = useRef(new Set<string>())
  const stale = useRef(new Set<string>())

  useEffect(() => {
    const unsub = window.orchaDesktop.onProvisionProgress((e) => {
      if (!armed.current || stale.current.has(e.runId)) return
      seen.current.add(e.runId)
      setEvents((prev) => [...prev, e])
    })
    return unsub
  }, [])

  const begin = useCallback(() => {
    for (const id of seen.current) stale.current.add(id)
    seen.current.clear()
    armed.current = true
    setEvents([])
  }, [])

  return { events, begin }
}
