/** One run of `fn` at a time: a call while one is running gets that run's promise. Settings ›
 *  Storage's Scan works while a slow scan is still going, so a repeat must join the scan on
 *  its way (its answer is about to arrive) rather than start another `git`+`du` pass. */
export function singleFlight<T>(fn: () => Promise<T>): (() => Promise<T>) & { invalidate(): void } {
  let running: Promise<T> | null = null
  const scan = () => {
    if (!running) {
      const answer = fn().finally(() => {
        // An invalidated scan may finish after its replacement has started.
        if (running === answer) running = null
      })
      running = answer
    }
    return running
  }
  // Changes to the inventory require a new scan; ordinary retries still share one.
  scan.invalidate = (): void => { running = null }
  return scan
}

/** `singleFlight` per key (one `orcha worktrees list` per project folder at a time). */
export function singleFlightBy<A, T>(key: (a: A) => string, fn: (a: A) => Promise<T>): ((a: A) => Promise<T>) & { invalidate(key: string): void } {
  const running = new Map<string, Promise<T>>()
  const scan = (a: A) => {
    const k = key(a)
    let p = running.get(k)
    if (!p) {
      const answer = fn(a).finally(() => {
        if (running.get(k) === answer) running.delete(k)
      })
      running.set(k, answer)
      p = answer
    }
    return p
  }
  scan.invalidate = (k: string): void => { running.delete(k) }
  return scan
}
