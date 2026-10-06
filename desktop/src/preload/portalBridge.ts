/** Pure core of the embedded-portal preload (src/preload/portal.ts wires it to Electron).
 *  Kept free of Electron imports so it is unit-testable and so the sandboxed preload bundle
 *  stays self-contained.
 *
 *  Security model (arch §7.2):
 *  - `window.orchaHost` is exposed ONLY when the page's origin equals the origin main passed
 *    for this view (`http://localhost:<that stack's apiPort>`). Any other origin — an external
 *    page that somehow loaded, about:blank, a different stack — gets nothing.
 *  - The API is two fixed channels plus ONE fixed request (microphone access for
 *    dictation). No generic invoke, no Node, no access to `orcha:*` manager channels.
 *    Every outgoing message is validated here and AGAIN in main. */
import {
  EMBED_TO_HOST_CHANNEL,
  EMBED_TO_PORTAL_CHANNEL,
  EMBED_VERSION,
  HOST_CAPABILITIES,
  parseHostMessage,
  parsePortalMessage,
  readPortalPreloadArgs,
  type HostToPortal,
  type OrchaHostApi
} from '../shared/embed'

export interface PortalBridgeDeps {
  argv: readonly string[]
  /** Current page origin, read lazily (the preload re-runs per navigation, but guard anyway). */
  origin(): string
  send(channel: string, payload: unknown): void
  on(channel: string, listener: (payload: unknown) => void): () => void
  /** One fixed request/response channel: MIC_REQUEST_CHANNEL only (main checks the sender). */
  invokeMic?(): Promise<unknown>
}

/** Same string as shared/mic.ts MIC_CHANNELS.request (inlined: this preload stays self-contained). */
export const MIC_REQUEST_CHANNEL = 'orcha:mic:request'
const MIC_STATES = new Set(['granted', 'denied', 'restricted', 'not-determined', 'unknown'])

/** Returns the host API object to expose, or null when this page must not get one. */
export function createOrchaHost(deps: PortalBridgeDeps): OrchaHostApi | null {
  const expected = readPortalPreloadArgs(deps.argv)
  if (!expected || deps.origin() !== expected.origin) return null

  const onOrigin = (): boolean => deps.origin() === expected.origin

  return Object.freeze({
    version: EMBED_VERSION,
    capabilities: [...HOST_CAPABILITIES],
    project: expected.project,
    send(msg: unknown): void {
      if (!onOrigin()) return
      const parsed = parsePortalMessage(msg)
      if (parsed) deps.send(EMBED_TO_HOST_CHANNEL, parsed)
    },
    /** Dictation: ask macOS for the microphone before the page calls getUserMedia (the TCC
     *  prompt names this app). Resolves to the access state; never rejects. */
    async requestMicAccess(): Promise<string> {
      if (!onOrigin() || !deps.invokeMic) return 'unknown'
      try {
        const r = (await deps.invokeMic()) as { ok?: boolean; data?: unknown } | null
        const v = r && r.ok ? r.data : null
        return typeof v === 'string' && MIC_STATES.has(v) ? v : 'unknown'
      } catch {
        return 'unknown'
      }
    },
    on(cb: (msg: HostToPortal) => void): () => void {
      if (typeof cb !== 'function') return () => {}
      return deps.on(EMBED_TO_PORTAL_CHANNEL, (payload) => {
        if (!onOrigin()) return
        const parsed = parseHostMessage(payload)
        if (parsed) cb(parsed)
      })
    }
  }) as OrchaHostApi
}
