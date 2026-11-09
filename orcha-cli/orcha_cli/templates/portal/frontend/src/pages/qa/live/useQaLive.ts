/**
 * What runs in this project right now, for the header pill, the project tab's dot and the offer on
 * Overview. One light read per project, shared by every view; it pauses while the tab is hidden and
 * is rung at once when a request changes. The server holds the state: a reload loses nothing.
 */
import { useEffect, useState } from "react";
import { useRequestsChanged } from "../../../state/qaRequestBus";
import { listSessions, type QaSession } from "../qaApi";

const POLL_MS = 8_000;

interface Store { rows: QaSession[]; subs: Set<(rows: QaSession[]) => void>; timer: ReturnType<typeof setInterval> | null; readingAt?: number }
const stores = new Map<string, Store>();

/** One read at a time: a slow portal must not pile them up. One that never settles stops holding the turn. */
const READ_GIVES_WAY_MS = 30_000;

async function read(cid: string, s: Store) {
  if (typeof document !== "undefined" && document.hidden) return;
  if (s.readingAt && Date.now() - s.readingAt < READ_GIVES_WAY_MS) return;
  s.readingAt = Date.now();
  try {
    s.rows = await listSessions(cid, { status: "running", limit: 10 });
  } catch {
    return; // an older server, or a blip: keep what is known
  } finally {
    s.readingAt = undefined;
  }
  s.subs.forEach((f) => f(s.rows));
}

/** Claimed runs first: a queued one only counts when nothing is running. */
export function liveFirst(rows: readonly QaSession[]): QaSession | null {
  const started = (s: QaSession) => !s.queued_at || !!s.claimed_at;
  return [...rows].sort((a, b) => Number(started(b)) - Number(started(a)) || (b.started_at ?? "").localeCompare(a.started_at ?? ""))[0] ?? null;
}

/** Every run going now: the tab's count, from the same read as the pill. */
export function useQaLiveRuns(cid: string | null): QaSession[] {
  const [rows, setRows] = useState<QaSession[]>([]);
  const changed = useRequestsChanged();
  useEffect(() => {
    if (!cid) return;
    const s = stores.get(cid) ?? { rows: [], subs: new Set(), timer: null };
    stores.set(cid, s);
    s.subs.add(setRows);
    setRows(s.rows);
    if (!s.timer) {
      s.timer = setInterval(() => void read(cid, s), POLL_MS);
      void read(cid, s);
    }
    return () => {
      s.subs.delete(setRows);
      if (!s.subs.size && s.timer) { clearInterval(s.timer); s.timer = null; }
    };
  }, [cid]);
  useEffect(() => {
    const s = cid ? stores.get(cid) : null;
    if (cid && s && changed) void read(cid, s);
  }, [cid, changed]);
  return rows;
}

export function useQaLive(cid: string | null): QaSession | null {
  return liveFirst(useQaLiveRuns(cid));
}
