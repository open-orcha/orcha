/** One run of `fn` at a time: a call while one is running gets that run's promise. Settings ›
 *  Storage's Scan works while a slow scan is still going, so a repeat must join the scan on
 *  its way (its answer is about to arrive) rather than start another `git`+`du` pass. */
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | null = null
  return () => {
    if (!running) {
      running = fn().finally(() => {
        running = null
      })
    }
    return running
  }
}
