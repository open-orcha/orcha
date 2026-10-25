import { useCallback, useEffect, useRef, useState } from 'react'

/** How long a Settings › Storage scan may run before the screen stops waiting on it. */
export const SCAN_TIMEOUT_MS = 10_000

export const SCAN_TIMEOUT = 'SCAN_TIMEOUT'

/** One Settings › Storage scan (Docker leftovers, agent worktrees), run on mount and on
 *  "Scan again". A scan that never answers (a hung CLI, a blocked IPC) must not spin forever
 *  with every control disabled: after `timeoutMs` the spinner stops and a SCAN_TIMEOUT error
 *  shows, so "Scan again" is usable. A late answer to the latest scan still lands (and clears
 *  that error); answers to an older scan are dropped. */
export function useBoundedScan<T>(fetch: (() => Promise<T>) | undefined, timeoutMs = SCAN_TIMEOUT_MS) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [scanning, setScanning] = useState(false)
  const gen = useRef(0)

  const scan = useCallback(async (): Promise<void> => {
    if (!fetch) return
    const mine = ++gen.current
    const current = (): boolean => mine === gen.current
    setScanning(true)
    setError(null)
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (current()) {
          setError({ code: SCAN_TIMEOUT, message: `No answer after ${Math.round(timeoutMs / 1000)} seconds. Scan again to retry.` })
          setScanning(false)
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
          if (current()) setScanning(false)
          resolve()
        })
    })
  }, [fetch, timeoutMs])

  useEffect(() => {
    void scan()
    return () => {
      gen.current++
    }
  }, [scan])

  return { data, error, scanning, scan }
}
