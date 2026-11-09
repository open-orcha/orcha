import { useEffect, useState } from "react";
import { mergeWall, type ShownTile, type WallPayload } from "../lib/live-wall";
import { getLive, type LiveTile } from "../api";
import { runLink } from "../links";
import { describeAction } from "../../sessions/walked/tree-model";
import { sessionName } from "../../sessions/adapt";
import { viewportWord, type Platform } from "../../qaApi";
import { LIVE_POLL_MS } from "../../sessions/detail/use-session-live";

export interface LiveWallState {
  tiles: ShownTile[];
  /** The first answer has arrived. */
  loaded: boolean;
}

/** One session as a wall tile, its run clock from its start. */
function tileOf(t: LiveTile, pathname: string, search: string): WallPayload["tiles"][number] {
  const s = t.session;
  const qs = new URLSearchParams(search);
  for (const [k, v] of Object.entries(runLink(s.id))) {
    if (v == null) qs.delete(k);
    else qs.set(k, v);
  }
  const last = t.last_step;
  return {
    key: s.id,
    runId: s.id,
    href: `${pathname}?${qs}`,
    status: "running",
    name: sessionName(s),
    project: null,
    kind: s.platform,
    device: s.platform === "web" ? viewportWord(s.device_name) : (s.device_name ?? "Device"),
    deviceIsDefault: !s.device_name,
    since: s.started_at,
    actions: t.steps_count,
    action: last ? describeAction({ kind: last.kind, args: last.args as never, result: last.result }) : null,
    framePath: t.frame_id,
    frameSeq: null,
    phase: null,
  };
}

function payloadOf(rows: readonly LiveTile[], pathname: string, search: string): WallPayload {
  const running = rows.filter((t) => t.session.status === "running");
  const ended = rows.filter((t) => t.session.status !== "running");
  return {
    tiles: running.map((t) => tileOf(t, pathname, search)),
    ended: ended.map((t) => ({ key: t.session.id, result: t.session.status === "done" ? (t.findings.length || t.verdicts.includes("fail") ? "failed" : "passed") : t.session.status === "cancelled" ? "stopped" : "failed" })),
    at: new Date().toISOString(),
  };
}

/**
 * The live wall's one poll, every `intervalMs` while the tab is visible, merged into the tiles on
 * screen (`mergeWall`: ended runs linger with their result, then leave). A hidden tab stops asking
 * and asks again the moment it is shown.
 */
export function useLiveWall({ cid, platform, pathname, search, intervalMs = LIVE_POLL_MS }: { cid: string; platform: Platform | null; pathname: string; search: string; intervalMs?: number }): LiveWallState {
  const [state, setState] = useState<LiveWallState>({ tiles: [], loaded: false });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    const hidden = () => document.visibilityState === "hidden";

    const tick = async () => {
      timer = null;
      if (cancelled || inFlight) return;
      if (hidden()) return;
      inFlight = true;
      try {
        const rows = await getLive(cid, platform);
        const payload = payloadOf(rows, pathname, search);
        if (!cancelled) setState((prev) => ({ tiles: mergeWall(prev.tiles, payload, Date.now()), loaded: true }));
      } catch {
        // A dropped request: the next tick asks again.
      } finally {
        inFlight = false;
        if (!cancelled && !hidden()) timer = setTimeout(() => void tick(), intervalMs);
      }
    };

    const onVisible = () => {
      if (!hidden() && timer == null && !inFlight) void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    void tick();
    return () => {
      cancelled = true;
      if (timer != null) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [cid, platform, pathname, search, intervalMs]);

  return state;
}
