/** Portal calls for dictation: engine status (cached briefly) and the clean-up pass. */
import type { VoiceStatus } from "./engines";
import { registerTestReset } from "../lib/testResets";

export const VOICE_STATUS_EVENT = "orcha:voice-status";
const TTL_MS = 30_000;
const cache = new Map<string, { at: number; p: Promise<VoiceStatus | null> }>();

export function invalidateVoiceStatus(): void {
  cache.clear();
  try { window.dispatchEvent(new Event(VOICE_STATUS_EVENT)); } catch { /* no window */ }
}

export function fetchVoiceStatus(cid: string, fresh = false): Promise<VoiceStatus | null> {
  const hit = cache.get(cid);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.p;
  const p = fetch(`/api/containers/${encodeURIComponent(cid)}/voice/status`)
    .then((r) => (r.ok ? (r.json() as Promise<VoiceStatus>) : null))
    .catch(() => null);
  cache.set(cid, { at: Date.now(), p });
  return p;
}

export async function cleanupDictation(cid: string, text: string, singleLine: boolean, language: string): Promise<string> {
  const r = await fetch(`/api/containers/${encodeURIComponent(cid)}/voice/cleanup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, single_line: singleLine, language: language || null }),
  });
  if (!r.ok) throw new Error("cleanup " + r.status);
  const d = (await r.json()) as { text?: string };
  return d.text || text;
}

/** Test seam. */
export function _resetVoiceStatusCache(): void {
  cache.clear();
}
registerTestReset(_resetVoiceStatusCache);
