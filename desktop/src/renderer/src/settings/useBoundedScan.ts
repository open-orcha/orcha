import { useCallback, useEffect, useRef, useState } from 'react'

/** After this long a Settings › Storage scan shows "Still looking…" and Scan works again. A
 *  healthy `orcha worktrees list` takes 8–18 s on a busy project, so this is not an error. */
export const SCAN_SLOW_MS = 10_000

/** How long a scan may run before the screen gives up on it and says so. */
export const SCAN_TIMEOUT_MS = 60_000

export const STILL_LOOKING = 'Still looking. Big projects can take a while.'

export const SCAN_TIMEOUT = 'SCAN_TIMEOUT'

/** One Settings › Storage scan (Docker leftovers, agent worktrees), run on mount and on
 *  "Scan again". A slow scan is not a failed one: after `slowMs` it is `slow` (the screen says
 *  STILL_LOOKING and enables Scan; main answers a repeat with the scan already running, so
 *  pressing it never throws the answer away). A scan that never answers (a hung CLI, a blocked
 *  IPC) must not spin forever: after `timeoutMs` the spinner stops and a SCAN_TIMEOUT error
 *  shows. A late answer to the latest scan still lands (and clears that error); answers to an
 *  older scan are dropped. */
export function useBoundedScan<T>(fetch: (() => Promise<T>) | undefined, timeoutMs = SCAN_TIMEOUT_MS, slowMs = SCAN_SLOW_MS) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [scanning, setScanning] = useState(false)
  const [slow, setSlow] = useState(false)
  const gen = useRef(0)

  const scan = useCallback(async (): Promise<void> => {
    if (!fetch) return
    const mine = ++gen.current
    const current = (): boolean => mine === gen.current
    setScanning(true)
    setSlow(false)
    setError(null)
    await new Promise<void>((resolve) => {
      const slowTimer = setTimeout(() => {
        if (current()) setSlow(true)
      }, slowMs)
      const timer = setTimeout(() => {
        if (current()) {
          setError({ code: SCAN_TIMEOUT, message: `No answer after ${Math.round(timeoutMs / 1000)} seconds. Scan again to retry.` })
          setScanning(false)
          setSlow(false)
        }
        resolve()
      }, timeoutMs)
      Promise.resolve()
        .then(fetch)
        .then(
          (value) => {
            if (!current()) return
            setData(value)
            setError(null)
          },
          (err: unknown) => {
            if (current()) setError(err)
          }
        )
        .finally(() => {
          clearTimeout(timer)
          clearTimeout(slowTimer)
          if (current()) {
            setScanning(false)
            setSlow(false)
          }
          resolve()
        })
    })
  }, [fetch, timeoutMs, slowMs])

  useEffect(() => {
    void scan()
    return () => {
      gen.current++
    }
  }, [scan])

  return { data, error, scanning, slow, scan }
}
