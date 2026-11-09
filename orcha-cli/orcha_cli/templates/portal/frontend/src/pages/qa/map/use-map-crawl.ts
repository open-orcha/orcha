import { useCallback, useEffect, useRef, useState } from "react";
import { listSessions, type Platform, type QaSession } from "../qaApi";
import { getFullMap } from "./api";
import { adaptMap } from "./adapt";
import { useRouter } from "./kit";
import { applyMapChanges, parseCrawlQueue, type CrawlQueue } from "./live-reveal";
import { isBuilding, type AppMap } from "./types";

/** The running map session, as the chip shows it. */
export interface MapCrawl {
  request_id: string;
  exploration_id: string | null;
  run_id: string | null;
  status: "queued" | "running";
  minutes: number | null;
  started_at: string | null;
  /** When the exploring minutes started; null while queued or studying. */
  clock_started_at: string | null;
  /** A planned crawl's queue, when the session carries one; null otherwise. */
  queue?: CrawlQueue | null;
}

/** How often a map session is looked for while none runs (one started elsewhere). */
const CRAWL_POLL_MS = 20_000;
/** How often the map and the session are read while a session or a build runs. */
const LIVE_POLL_MS = 3000;
/** How long a revealed screen keeps its pulse. */
const REVEAL_MS = 2500;

/** The platform's running map session as a crawl, or null. */
export function crawlOf(sessions: readonly QaSession[], platform: Platform): MapCrawl | null {
  const s = sessions.find((x) => x.kind === "map" && x.status === "running" && x.platform === platform);
  if (!s) return null;
  return {
    request_id: s.id,
    exploration_id: null,
    run_id: s.id,
    status: "running",
    minutes: s.budget_minutes,
    started_at: s.started_at,
    clock_started_at: s.started_at,
    queue: parseCrawlQueue(s.crawl_queue),
  };
}

/**
 * The Map page while a map session or a build runs. The session is looked for on open and every
 * 20 s; while one runs (or the map's last build is running) the map and the session are read every
 * 3 s, `applyMapChanges` decides what to show and which screens it just revealed; those pulse for
 * 2.5 s and `newest` is where the camera may follow. When it ends the page is read again.
 */
export function useMapCrawl(cid: string, platform: Platform, initial: AppMap | null) {
  const router = useRouter();
  const [crawl, setCrawl] = useState<MapCrawl | null>(null);
  // The page's map until a poll brings a newer one. While a session runs the polls own the map, so
  // a screen is never revealed unnoticed by the page's own refresh.
  const [source, setSource] = useState(initial);
  const [map, setMap] = useState(initial);
  if (source !== initial) {
    setSource(initial);
    if (!crawl || !map) setMap(initial);
  }
  const mapRef = useRef(map);
  useEffect(() => {
    mapRef.current = map;
  }, [map]);
  const [revealed, setRevealed] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [newest, setNewest] = useState<string | null>(null);

  const askCrawl = useCallback(async (signal: AbortSignal) => {
    try {
      const sessions = await listSessions(cid, { kind: "map", status: "running", platform }, signal);
      if (!signal.aborted) setCrawl(crawlOf(sessions, platform));
    } catch {
      // A blip: the next poll asks again.
    }
  }, [cid, platform]);

  const readMap = useCallback(async (signal: AbortSignal) => {
    let fresh: AppMap | null = null;
    try {
      fresh = adaptMap(await getFullMap(cid, platform, signal), cid, platform);
    } catch {
      fresh = null;
    }
    if (signal.aborted) return;
    const prev = mapRef.current;
    if (!prev) {
      if (fresh) setMap(fresh);
      return;
    }
    // A read that changed nothing keeps the map, so the canvas does not lay itself out again.
    if (fresh && JSON.stringify(fresh) === JSON.stringify(prev)) return;
    const next = applyMapChanges(prev, [], fresh);
    setMap(next.map);
    if (next.revealed.length > 0) {
      const until = Date.now() + REVEAL_MS;
      setRevealed((old) => new Map([...old, ...next.revealed.map((id) => [id, until] as const)]));
      if (next.newest) setNewest(next.newest);
    }
  }, [cid, platform]);

  const live = crawl !== null || isBuilding(map?.build ?? null);

  useEffect(() => {
    const ctl = new AbortController();
    void askCrawl(ctl.signal);
    const t = window.setInterval(() => void askCrawl(ctl.signal), live ? LIVE_POLL_MS : CRAWL_POLL_MS);
    return () => {
      ctl.abort();
      window.clearInterval(t);
    };
  }, [askCrawl, live]);

  useEffect(() => {
    if (!live) return;
    const ctl = new AbortController();
    const t = window.setInterval(() => void readMap(ctl.signal), LIVE_POLL_MS);
    return () => {
      ctl.abort();
      window.clearInterval(t);
    };
  }, [live, readMap]);

  // A session that was going and is no longer: read the page again for the finished map.
  const wasLive = useRef(false);
  useEffect(() => {
    if (live) wasLive.current = true;
    else if (wasLive.current) {
      wasLive.current = false;
      router.refresh();
    }
  }, [live, router]);

  // Reveal marks expire.
  useEffect(() => {
    if (revealed.size === 0) return;
    const soonest = Math.min(...revealed.values());
    const t = window.setTimeout(() => {
      const now = Date.now();
      setRevealed((old) => new Map([...old].filter(([, until]) => until > now)));
    }, Math.max(50, soonest - Date.now()));
    return () => window.clearTimeout(t);
  }, [revealed]);

  return { crawl, map, revealed, newest };
}
