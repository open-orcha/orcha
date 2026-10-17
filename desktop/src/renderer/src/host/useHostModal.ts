import { useEffect } from 'react'

/** While a host (renderer DOM) dialog is open, the native portal view would draw ABOVE it
 *  (a DOM modal cannot overlay a WebContentsView). Tell main to hide the active view for the
 *  dialog's lifetime and restore it after (arch §7.4). Safe with no view showing. */
export function useHostModal(open: boolean): void {
  useEffect(() => {
    if (!open) return
    const api = window.orchaDesktop as Partial<typeof window.orchaDesktop> | undefined
    if (!api?.setHostModal) return
    void Promise.resolve(api.setHostModal(true)).catch(() => {})
    return () => {
      void Promise.resolve(api.setHostModal?.(false)).catch(() => {})
    }
  }, [open])
}
