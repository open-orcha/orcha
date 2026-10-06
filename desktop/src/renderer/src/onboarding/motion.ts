import { useCallback, useEffect, useState } from 'react'
import { flushSync } from 'react-dom'

/** Onboarding motion helpers — CSS does the animating (transform + opacity only); these
 *  hooks only decide WHETHER to animate and in which direction.
 *
 *  Motion is opt-in: it runs only when the platform positively reports
 *  `prefers-reduced-motion: no-preference`. Anywhere that can't say (no matchMedia, e.g. a
 *  test DOM) gets the instant, reduced path — so nothing ever depends on an animation
 *  finishing. */

const NO_PREF = '(prefers-reduced-motion: no-preference)'

export function motionAllowed(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia(NO_PREF).matches
  } catch {
    return false
  }
}

/** Live `true` when motion should be skipped; follows the OS setting while mounted. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => !motionAllowed())
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(NO_PREF)
    const on = (): void => setReduced(!mq.matches)
    on()
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, [])
  return reduced
}

export type StageDirection = 'forward' | 'back'

type ViewTransitionDoc = Document & {
  startViewTransition?: (cb: () => void) => { finished: Promise<void> }
}

/** Swap the wizard's stage with a direction-aware transition. Uses the View Transitions API
 *  (Chromium/Electron): the outgoing step is a GPU snapshot that slides out while the new
 *  one slides in — the old React tree is never re-mounted, so no step re-runs its effects.
 *  Falls back to an instant swap when motion is reduced or the API is missing. */
export function useStageTransition(): (direction: StageDirection, update: () => void) => void {
  return useCallback((direction, update) => {
    const doc = document as ViewTransitionDoc
    if (!motionAllowed() || typeof doc.startViewTransition !== 'function') {
      update()
      return
    }
    const root = document.documentElement
    root.dataset.obDir = direction
    try {
      const t = doc.startViewTransition(() => {
        flushSync(update)
      })
      void t.finished.finally(() => {
        if (root.dataset.obDir === direction) delete root.dataset.obDir
      })
    } catch {
      update()
    }
  }, [])
}

/** Seconds since `startedAt` (ms epoch), ticking once a second while `running`. */
export function useElapsed(startedAt: number | null, running: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running || startedAt === null) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [running, startedAt])
  if (startedAt === null) return 0
  return Math.max(0, Math.floor((now - startedAt) / 1000))
}

/** 75 → "1:15", 9 → "0:09". */
export function formatElapsed(s: number): string {
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}
