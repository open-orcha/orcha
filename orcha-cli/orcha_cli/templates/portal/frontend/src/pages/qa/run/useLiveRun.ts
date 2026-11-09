/**
 * What runs in this project right now, for the pill and the offer: a session, or an onboarding pass
 * whose agent has not started its session yet. The server holds the state; this only reads it.
 *
 * Sessions come from `useQaLive`, the read the project tab's dot already makes. The onboarding row
 * is a bigger read, so it is taken once per view, and repeated only while a pass has no session.
 */
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { useQaLive } from "../live/useQaLive";
import { getOnboardingRow } from "../onboarding/use-onboarding-map";
import { liveOfPass, liveOfSession, runningPass, type LiveRun, type RunPass } from "./runFlow";

const PASS_POLL_MS = 8_000;

type Phases = Record<string, { state?: string; task_id?: string | null; started_at?: string | null } | undefined>;
interface Pending { pass: RunPass; phase: { task_id?: string | null; started_at?: string | null } }

interface Store { pending: Pending | null; subs: Set<(p: Pending | null) => void>; timer: ReturnType<typeof setInterval> | null; readingAt?: number }
const stores = new Map<string, Store>();

/** One read at a time: a slow portal must not pile them up. One that never settles stops holding the turn. */
const READ_GIVES_WAY_MS = 30_000;

async function read(cid: string, s: Store) {
  if (typeof document !== "undefined" && document.hidden) return;
  if (s.readingAt && Date.now() - s.readingAt < READ_GIVES_WAY_MS) return;
  s.readingAt = Date.now();
  let next: Pending | null = null;
  try {
    const phases = ((await getOnboardingRow(cid)).phases ?? null) as Phases | null;
    const pass = runningPass(phases);
    next = pass ? { pass, phase: phases?.[pass] ?? {} } : null;
  } catch {
    return; // no onboarding on this portal, or a blip: keep what is known
  } finally {
    s.readingAt = undefined;
  }
  s.pending = next;
  if (next && !s.timer) s.timer = setInterval(() => void read(cid, s), PASS_POLL_MS);
  if (!next && s.timer) { clearInterval(s.timer); s.timer = null; }
  s.subs.forEach((f) => f(next));
}

export function useLiveRun(cid: string | null): LiveRun | null {
  const session = useQaLive(cid);
  const view = new URLSearchParams(useLocation().search).get("view");
  const [pending, setPending] = useState<Pending | null>(null);
  useEffect(() => {
    if (!cid) return;
    const s = stores.get(cid) ?? { pending: null, subs: new Set(), timer: null };
    stores.set(cid, s);
    s.subs.add(setPending);
    setPending(s.pending);
    return () => {
      s.subs.delete(setPending);
      if (!s.subs.size && s.timer) { clearInterval(s.timer); s.timer = null; }
    };
  }, [cid]);
  // A session says it all; otherwise look each time the person moves, since a pass may have just started.
  const hasSession = !!session;
  useEffect(() => {
    const s = cid ? stores.get(cid) : null;
    if (cid && s && !hasSession) void read(cid, s);
  }, [cid, hasSession, view]);
  return useMemo(() => (session ? liveOfSession(session) : pending ? liveOfPass(pending.pass, pending.phase) : null), [session, pending]);
}
