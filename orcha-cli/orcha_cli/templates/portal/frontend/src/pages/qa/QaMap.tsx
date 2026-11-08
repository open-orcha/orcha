/**
 * Map: the app map canvas (`map/app-map-board.tsx`), under `?sub=atlas` the screen atlas, and under
 * `?sub=slowest` the screens ranked by speed (`?sub=budgets`: the budgets they are held to). The
 * selected screen stays in the URL as `?screen=<node id>`, so a link opens its panel; `?state=` (the
 * Overview's counts) opens on the first screen in that state. The canvas lives in `map/`; this file
 * reads the map and hands it over.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { QaAtlas } from "./atlas/QaAtlas";
import { getFullMap } from "./map/api";
import { adaptMap } from "./map/adapt";
import { AppMapBoard } from "./map/app-map-board";
import { PortRoot, Skeleton } from "./map/kit";
import { MapActionsProvider, type MapActions } from "./map/map-actions";
import { PerfBudgets } from "./map/perf/perf-budgets";
import { SlowestScreens } from "./map/perf/slowest-screens";
import type { AppMap } from "./map/types";
import { screenRoute, type QaFeature, type QaMap as MapData, type QaNode } from "./qaApi";
import { blockedKindWord, screenLabel } from "./qaWords";
import { useLoad } from "./parts";
import type { QaNav } from "./QaPage";

const STATE_ORDER: Record<string, number> = { seen: 0, declared: 1, blocked: 2 };
const OTHER = "__other";

/** Mobile: seen → not reached → blocked, then by name. Web (`byRoute`): by route, so a feature reads as its URL tree. */
export function sortScreens(nodes: QaNode[], byRoute = false): QaNode[] {
  if (byRoute) {
    return [...nodes].sort((a, b) => (screenRoute(a) ?? a.key).localeCompare(screenRoute(b) ?? b.key) || screenLabel(a).localeCompare(screenLabel(b)));
  }
  return [...nodes].sort((a, b) => (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9) || screenLabel(a).localeCompare(screenLabel(b)));
}

/** Features in map order, each with its screens; screens of no (or an unknown) feature go last under "Other screens".
 *  On the web each feature's screens follow their routes. */
export function groupByFeature(features: QaFeature[], screens: QaNode[], byRoute = false): { feature: QaFeature | null; key: string; screens: QaNode[] }[] {
  const known = new Set(features.map((f) => f.key));
  const groups = features.map((f) => ({ feature: f as QaFeature | null, key: f.key, screens: sortScreens(screens.filter((n) => n.feature_key === f.key), byRoute) }));
  const rest = sortScreens(screens.filter((n) => !n.feature_key || !known.has(n.feature_key)), byRoute);
  if (rest.length) groups.push({ feature: null, key: OTHER, screens: rest });
  return groups;
}

/** "Needs sign-in: the profile tab asks for an account" — the kind isn't repeated when the reason already says it. */
export function blockedLine(n: Pick<QaNode, "blocked_kind" | "blocked_reason">): string {
  const kind = blockedKindWord(n.blocked_kind || "other");
  const reason = (n.blocked_reason || "").trim();
  if (!reason) return kind;
  return reason.toLowerCase().startsWith(kind.toLowerCase()) ? reason : `${kind}: ${reason}`;
}

/** Features with a screen on this platform (all of them while the platform has no screens yet). */
export function featuresHere(map: Pick<MapData, "features" | "nodes">): number {
  const keys = new Set(map.nodes.filter((n) => n.kind === "screen").map((n) => n.feature_key));
  return keys.size ? map.features.filter((f) => keys.has(f.key)).length : map.features.length;
}

/** The first screen in `state`, in the order the map's features list them; null when none is. */
export function firstInState(map: Pick<MapData, "features" | "nodes">, state: string, byRoute = false): QaNode | null {
  const screens = map.nodes.filter((n) => n.kind === "screen" && n.state === state);
  return groupByFeature(map.features, screens, byRoute).flatMap((g) => g.screens)[0] ?? null;
}

function MapBoard({ cid, nav }: { cid: string; nav: QaNav }) {
  const { platform, nonce, runQa, auth, set } = nav;
  const res = useLoad((s) => getFullMap(cid, platform, s), [cid, platform], nonce);
  // A reread that changed nothing keeps the map, so the canvas does not lay itself out again.
  const held = useRef<{ json: string; map: AppMap } | null>(null);
  const map = useMemo(() => {
    if (!res.data) return null;
    const json = JSON.stringify(res.data);
    if (held.current?.json !== json) held.current = { json, map: adaptMap(res.data, cid, platform) };
    return held.current.map;
  }, [res.data, cid, platform]);
  const actions = useMemo<MapActions>(() => ({ platform, run: runQa, can: auth.can, reason: auth.reason }), [platform, runQa, auth.can, auth.reason]);
  const onSelect = useCallback((id: string | null) => set({ screen: id }), [set]);

  // The source's map has no state filter, so a count on the Overview opens the first screen it
  // counts, the way the map opens any screen; the parameter is used up, so Back and closing the
  // panel leave a plain map.
  const state = nav.get("state");
  useEffect(() => {
    if (!state || !res.data) return;
    set({ state: null, screen: firstInState(res.data, state, platform === "web")?.id ?? null });
  }, [state, res.data, platform, set]);

  if (!map && !res.error) return <div className="qa-pad"><Skeleton className="h-64 w-full" /></div>;
  return (
    <MapActionsProvider value={actions}>
      <div className="v-panel flex min-h-0 flex-1 flex-col" data-project-tabpanel="map">
        <AppMapBoard key={`${cid}:${platform}`} project={{ id: cid, platform }} map={map} error={res.error} selected={nav.get("screen")} onSelect={onSelect} />
      </div>
    </MapActionsProvider>
  );
}

export function QaMap({ cid, nav }: { cid: string; nav: QaNav }) {
  const raw = nav.get("sub");
  const sub = raw === "atlas" ? "atlas" : raw === "slowest" || raw === "budgets" ? "slowest" : "map";
  return (
    <PortRoot refresh={nav.refresh} className="flex min-h-0 flex-1 flex-col">
      {sub === "atlas" ? <QaAtlas cid={cid} nav={nav} /> : sub === "map" ? <MapBoard cid={cid} nav={nav} /> : (
        <div className="v-panel flex min-h-0 flex-1 flex-col overflow-y-auto" data-project-tabpanel={raw === "budgets" ? "map-budgets" : "map-slowest"}>
          {raw === "budgets" ? <PerfBudgets cid={cid} nav={nav} /> : <SlowestScreens cid={cid} nav={nav} />}
        </div>
      )}
    </PortRoot>
  );
}
