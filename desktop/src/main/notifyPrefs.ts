/**
 * Desktop OS notifications honour the person's Embodent notification settings (portal mig 063).
 *
 * The decision is NOT re-implemented here: before showing an OS notification for a new
 * attention item, the host asks the item's own local stack —
 *   POST http://localhost:{apiPort}/api/containers/{cid}/notification-prefs/check
 *        { channel: "desktop", items: [{ kind, ref_id }] }
 * — and the portal answers with its should_notify decision (category scope, "only mine",
 * pause/snooze, project mute, quiet hours). The desktop carries no identity of its own;
 * the local (trust-off) stack resolves its operator.
 *
 * Fail OPEN: an older portal without the route (404/405), a network hiccup or a malformed
 * answer shows the notification exactly as before — a settings outage must never silence
 * alerts. Health items (stack up/down) are host events, not project events: always shown.
 *
 * The Needs-you counts (tray badge, popover, widgets) are untouched — muting only
 * suppresses the ALERT.
 */
import type { AttentionItem, Stack } from '../shared/types'

export interface CheckResponse {
  status: number
  body: unknown
}
export type PostJson = (url: string, body: unknown) => Promise<CheckResponse>

export const defaultPostJson: PostJson = async (url, body) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(4000)
  })
  let parsed: unknown = null
  try {
    parsed = await res.json()
  } catch {
    parsed = null
  }
  return { status: res.status, body: parsed }
}

/** The check URL for an item on a stack (pure). */
export function checkUrl(apiPort: number, cid: string): string {
  return `http://localhost:${apiPort}/api/containers/${encodeURIComponent(cid)}/notification-prefs/check`
}

/** Pure: read the portal's decision for the first item; null = no usable answer (fail open). */
export function decisionOf(res: CheckResponse): boolean | null {
  if (res.status < 200 || res.status >= 300) return null
  const d = (res.body as { decisions?: unknown } | null)?.decisions
  if (!Array.isArray(d) || d.length === 0) return null
  const first = d[0] as { notify?: unknown }
  return typeof first.notify === 'boolean' ? first.notify : null
}

/** Should the host show an OS notification for this item? (see module doc) */
export async function shouldShowAttention(
  item: AttentionItem,
  stacks: Stack[],
  post: PostJson = defaultPostJson
): Promise<boolean> {
  if (item.kind === 'health' || !item.cid) return true
  const stack = stacks.find((s) => s.project === item.project)
  if (!stack || !stack.running || stack.apiPort === null) return true
  try {
    const res = await post(checkUrl(stack.apiPort, item.cid), {
      channel: 'desktop',
      items: [{ kind: item.kind, ref_id: item.id }]
    })
    const ok = decisionOf(res)
    return ok === null ? true : ok
  } catch {
    return true
  }
}
