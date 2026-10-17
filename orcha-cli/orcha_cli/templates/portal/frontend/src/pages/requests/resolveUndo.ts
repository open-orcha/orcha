/**
 * One-click Resolve with Undo for an answered question (owner request).
 *
 * Resolving = the requester closing its own answered request (POST
 * /api/requests/{id}/close, no reason — request_close_routes). The backend has
 * no "reopen", and a close publishes `request_closed` to the answering agent,
 * so Undo can't be a second write. Instead the close is DEFERRED: the item
 * leaves every queue at once (optimistic), a toast + the card offer Undo for
 * RESOLVE_UNDO_MS, and only then is the close sent. Leaving the page inside
 * the window flushes pending closes with `fetch(keepalive)` so a resolve is
 * never silently lost.
 *
 * Module-level (not component state): the Needs-you queue advances past the
 * item right away, so the component that scheduled it is usually gone.
 */
import { useSyncExternalStore } from "react";

export const RESOLVE_UNDO_MS = 5000;

interface Pending {
  timer: ReturnType<typeof setTimeout>;
  url: string;
  body: unknown;
  onDone?: () => void;
  onFail?: (msg: string) => void;
}

const pending = new Map<string, Pending>();
const listeners = new Set<() => void>();
let version = 0;
const emit = () => { version++; listeners.forEach((l) => l()); };

async function send(p: Pending, keepalive = false): Promise<void> {
  try {
    const r = await fetch(p.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(p.body),
      keepalive,
    });
    if (!r.ok) {
      let detail = "";
      try { const j = await r.json(); detail = typeof j?.detail === "string" ? j.detail : ""; } catch { /* not JSON */ }
      p.onFail?.("(" + r.status + ")" + (detail ? " " + detail : ""));
      return;
    }
    p.onDone?.();
  } catch {
    p.onFail?.("the portal could not be reached");
  }
}

/** Schedule the close of request `id`; it is sent after `delayMs` unless undone. */
export function scheduleResolve(
  id: string,
  requesterId: string,
  opts: { onDone?: () => void; onFail?: (msg: string) => void; delayMs?: number } = {},
): void {
  const prev = pending.get(id);
  if (prev) clearTimeout(prev.timer);
  const p: Pending = {
    url: "/api/requests/" + encodeURIComponent(id) + "/close",
    body: { requester_agent_id: requesterId },
    onDone: opts.onDone,
    onFail: opts.onFail,
    timer: setTimeout(() => {
      pending.delete(id);
      emit();
      void send(p);
    }, opts.delayMs ?? RESOLVE_UNDO_MS),
  };
  pending.set(id, p);
  emit();
}

/** Cancel a scheduled resolve. True when there was one to cancel. */
export function undoResolve(id: string): boolean {
  const p = pending.get(id);
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(id);
  emit();
  return true;
}

export function isResolving(id: string): boolean {
  return pending.has(id);
}

/** Send every pending close now (page hide / unload). */
export function flushResolves(): void {
  const all = [...pending.values()];
  pending.clear();
  all.forEach((p) => { clearTimeout(p.timer); void send(p, true); });
  if (all.length) emit();
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** Re-renders when request `id` enters/leaves the undo window. */
export function useResolving(id: string): boolean {
  useSyncExternalStore(subscribe, () => version, () => version);
  return pending.has(id);
}

if (typeof window !== "undefined") window.addEventListener("pagehide", flushResolves);

/** Test reset: drop every pending resolve without sending. */
export function _resetResolves(): void {
  pending.forEach((p) => clearTimeout(p.timer));
  pending.clear();
  emit();
}
