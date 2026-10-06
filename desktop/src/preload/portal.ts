/** Dedicated, minimal preload for embedded portal WebContentsViews (arch §7.2). Attached
 *  ONLY to portal views — never to the manager window or tray popover (those use
 *  preload/index.ts and its `window.orchaDesktop` bridge, which portals must not see).
 *
 *  Exposes `window.orchaHost` via contextBridge when, and only when, the page origin matches
 *  the stack origin main passed in additionalArguments. See portalBridge.ts. */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { MIC_REQUEST_CHANNEL, createOrchaHost } from './portalBridge'

const host = createOrchaHost({
  argv: process.argv,
  origin: () => window.location.origin,
  send: (channel, payload) => ipcRenderer.send(channel, payload),
  invokeMic: () => ipcRenderer.invoke(MIC_REQUEST_CHANNEL),
  on: (channel, listener) => {
    const wrapped = (_e: IpcRendererEvent, payload: unknown): void => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  }
})

if (host) contextBridge.exposeInMainWorld('orchaHost', host)
