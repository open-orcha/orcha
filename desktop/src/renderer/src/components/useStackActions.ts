import { useState } from 'react'
import type { BridgeError, Stack } from '../../../shared/types'

/** Busy/error/run-action state shared by StackCard (card view) and StackRow
 *  (list view) so both render identical labels and disabled states. */
export interface StackActions {
  busy: boolean
  /** stderr tail (COMPOSE_FAILED) or the bridge error code; null when clean. */
  error: string | null
  /** Open portal is only available for a running stack with a published port. */
  portalDisabled: boolean
  /** 'Stop' / 'Start', or 'Stopping…' / 'Starting…' while an action runs. */
  toggleLabel: string
  openPortal: () => void
  toggleStack: () => void
  /** Destructively delete the stack (down -v + image + on-disk files). Gated by the caller's modal. */
  resetStack: () => void
}

export default function useStackActions(stack: Stack, onChanged: () => void): StackActions {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await action()
      onChanged()
    } catch (err) {
      const bridgeError = err as BridgeError
      setError('stderr' in bridgeError ? bridgeError.stderr : bridgeError.code)
    } finally {
      setBusy(false)
    }
  }

  const api = window.orchaDesktop
  return {
    busy,
    error,
    portalDisabled: !stack.running || stack.apiPort === null || busy,
    toggleLabel: busy
      ? stack.running
        ? 'Stopping…'
        : 'Starting…'
      : stack.running
        ? 'Stop'
        : 'Start',
    openPortal: () => void run(() => api.openPortal(stack.project)),
    toggleStack: () =>
      void run(() => (stack.running ? api.stopStack(stack.project) : api.startStack(stack.project))),
    resetStack: () => void run(() => api.resetStack(stack.project))
  }
}
