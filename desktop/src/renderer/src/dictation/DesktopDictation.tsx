/** Dictation for the desktop app's OWN text fields (onboarding, settings, rename, search…).
 *
 *  Same engine, HUD and shortcut as the portal (the files next to this one are verbatim
 *  copies of the portal's src/dictation — see dictationParity.test.ts). The difference is
 *  where the speech provider lives: the desktop has no backend of its own, so it dictates
 *  through a RUNNING project's portal (status/clean-up over the existing portalGet/Post
 *  IPC, audio over a direct WebSocket to http://localhost:<apiPort>). The provider key stays
 *  in that portal. With no running project, the HUD says so plainly.
 *
 *  On-device (in-browser) recognition is off here: the manager window's CSP doesn't load
 *  remote model code, by design. Inside a project (the embedded portal) it is available. */
import { useMemo, type ReactNode } from 'react'
import { DictationProvider, type DictationHostDeps } from './DictationHost'
import type { VoiceStatus } from './engines'
import './dictation-desktop.css'

export const NO_PROJECT_MESSAGE =
  'Start a project to dictate here — the desktop app uses that project’s speech provider (its Settings › Voice).'

interface Bridge {
  portalGet?(apiPort: number, path: string): Promise<unknown>
  portalPost?(apiPort: number, path: string, body: unknown): Promise<unknown>
}

/** The first container id in a GET /api/containers answer (list or {containers:[…]}). */
export function firstContainerId(raw: unknown): string | null {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? (raw as { containers?: unknown }).containers : null
  if (!Array.isArray(list)) return null
  for (const c of list) {
    const id = c && typeof c === 'object' ? ((c as { id?: unknown; container_id?: unknown }).id ?? (c as { container_id?: unknown }).container_id) : null
    if (typeof id === 'string' && id) return id
  }
  return null
}

export function desktopDictationDeps(apiPort: number | null, cid: string | null, bridge: Bridge | undefined): DictationHostDeps {
  let cidP: Promise<string | null> | null = cid ? Promise.resolve(cid) : null
  const ok = apiPort !== null && !!bridge?.portalGet
  return {
    getCid: () => {
      if (!ok) return null
      cidP ??= bridge!.portalGet!(apiPort!, '/api/containers').then(firstContainerId, () => null)
      return cidP
    },
    getBaseUrl: () => (apiPort !== null ? `http://localhost:${apiPort}` : undefined),
    getStatus: async (cid) =>
      ok ? ((await bridge!.portalGet!(apiPort!, `/api/containers/${encodeURIComponent(cid)}/voice/status`)) as VoiceStatus) : null,
    cleanup: async (cid, text, singleLine, language) => {
      if (!ok || !bridge?.portalPost) return text
      const r = (await bridge.portalPost(apiPort!, `/api/containers/${encodeURIComponent(cid)}/voice/cleanup`, {
        text,
        single_line: singleLine,
        language: language || null
      })) as { text?: string } | null
      return r?.text || text
    },
    deviceSupported: () => false,
    noEngineMessage: () => (ok ? undefined : NO_PROJECT_MESSAGE)
  }
}

export default function DesktopDictation({
  apiPort,
  cid = null,
  onOpenSettings,
  children
}: {
  /** the running project to dictate through (null: none running) */
  apiPort: number | null
  /** its container id when known (otherwise the first container on that portal) */
  cid?: string | null
  /** open that project's Settings › Voice */
  onOpenSettings?: () => void
  children: ReactNode
}) {
  const deps = useMemo(() => desktopDictationDeps(apiPort, cid, window.orchaDesktop as Bridge | undefined), [apiPort, cid])
  return (
    <DictationProvider cid={null} deps={deps} onOpenSettings={onOpenSettings}>
      {children}
    </DictationProvider>
  )
}
