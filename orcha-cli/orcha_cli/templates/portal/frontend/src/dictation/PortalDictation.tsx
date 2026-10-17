/** The portal's dictation provider: DictationProvider wired to this portal's own API. */
import type { ReactNode } from "react";
import { cleanupDictation, fetchVoiceStatus } from "./api";
import { DictationProvider, type DictationHostDeps } from "./DictationHost";

const PORTAL_DEPS: DictationHostDeps = { getStatus: (cid) => fetchVoiceStatus(cid), cleanup: cleanupDictation };

export function PortalDictationProvider({ cid, children }: { cid: string | null; children: ReactNode }) {
  return <DictationProvider cid={cid} deps={PORTAL_DEPS}>{children}</DictationProvider>;
}
