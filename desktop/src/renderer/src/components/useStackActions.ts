import { useState } from 'react'
import type { BridgeError, Stack } from '../../../shared/types'

/** Busy/error/run-action state for a stack-level Start/Stop/Remove control — used by the
 *  home screen's StoppedStackRow (a running stack's actions live per-project on its card
 *  instead; a stopped stack has no containers to show cards for). */
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
  /** Destructively delete the stack (down -v + image + on-disk files). Gated by the caller's
   *  modal, which stays open (progress state) for the duration and only closes on success —
   *  resolves true iff the delete succeeded, so the caller knows whether to dismiss the dialog
   *  or leave it open with `error` showing for a retry. */
  resetStack: () => Promise<boolean>
}

export default function useStackActions(stack: Stack, onChanged: () => void): StackActions {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run(action: () => Promise<void>): Promise<boolean> {
    setBusy(true)
    setError(null)
    try {
      await action()
      onChanged()
      return true
    } catch (err) {
      const bridgeError = err as BridgeError
      setError('stderr' in bridgeError ? bridgeError.stderr : bridgeError.code)
      return false
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
    openPortal: () => void run(() => api.portalShow(stack.project)),
    toggleStack: () =>
      void run(() => (stack.running ? api.stopStack(stack.project) : api.startStack(stack.project))),
    resetStack: () => run(() => api.resetStack(stack.project))
  }
}
