/** Pure sender check for portal → host IPC (arch §7.3). index.ts gathers the facts from the
 *  Electron event; this decides. Kept Electron-free so the rule is unit-tested.
 *
 *  A message is accepted only when ALL hold:
 *  - the sending webContents is a registered portal view (so the stack is derived from the
 *    sender, never from the message);
 *  - it came from that view's MAIN frame (no iframes the portal might embed);
 *  - the frame's current origin is exactly that stack's `http://localhost:<apiPort>`. */
export interface PortalSenderFacts {
  /** Stack the sending webContents was registered for, if any. */
  project: string | undefined
  /** The registered view for that stack is this exact webContents. */
  isRegisteredView: boolean
  isMainFrame: boolean
  frameUrl: string | null
  expectedOrigin: string | undefined
}

export function acceptPortalSender(f: PortalSenderFacts): f is PortalSenderFacts & { project: string } {
  if (!f.project || !f.isRegisteredView || !f.isMainFrame || !f.frameUrl || !f.expectedOrigin) return false
  try {
    return new URL(f.frameUrl).origin === f.expectedOrigin
  } catch {
    return false
  }
}
