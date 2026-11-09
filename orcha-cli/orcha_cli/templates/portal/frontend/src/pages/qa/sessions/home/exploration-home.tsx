import type { CSSProperties } from "react";
import type { QaNav } from "../../QaPage";
import type { QaAuthority } from "../../authority";
import { isLive, type Exploration, type ExplorationScope } from "../explorations";
import { ExplorationEmptyScene } from "./empty-scene";
import { AppModelEntry } from "../workflows/app-model-entry";
import { ExplorationHistory } from "./exploration-history";
import { ExploreHero, type QuickStart } from "./explore-hero";
import { exploreStats, type ExplorationRoute } from "./home-model";
import { LiveSpotlight } from "./live-expedition";

export interface ExplorationHomeData {
  explorations: Exploration[];
  /** Each exploration's route (its screenshots in order), for the ones that have one. */
  routes: Record<string, ExplorationRoute>;
  /** The feature map, for the header's figure (null while it loads). */
  features: readonly { last_explored_at: string | null }[] | null;
  /** When this was read (ms), so "just finished" is judged against one clock. */
  readAt: number;
}

/** A finished exploration keeps the header's live slot this long, as its landing. */
const LANDING_MS = 15 * 60_000;

/**
 * The Sessions view's home: the header with what exploring has found so far, the New exploration
 * call to action and quick starts, a running exploration live; then the history as a timeline of
 * expeditions. A project never explored gets the teaching scene in the header instead of figures.
 */
export function ExplorationHome({ cid, data, nav, auth, kind, appName = null }: { cid: string; data: ExplorationHomeData; nav: QaNav; auth: QaAuthority; kind: ExplorationScope | null; appName?: string | null }) {
  const rows = data.explorations;
  const empty = rows.length === 0;
  const stats = exploreStats(rows);
  const liveRows = rows.filter((e) => isLive(e.status) && !e.archived_at);
  const landed = rows.find((e) => e.status === "done" && !e.archived_at && e.finished_at && data.readAt - Date.parse(e.finished_at) < LANDING_MS);
  const spotlight = liveRows[0] ?? landed ?? null;

  const starts: QuickStart[] = [
    { recipe: "map", title: "Map the app", promise: "Visits every screen it can reach, tries each action once and charts the dead ends.", onStart: () => nav.runQa("map") },
    { recipe: "explore", title: "Explore", promise: "Briefs a charter, walks the app's flows and reports findings with screenshots.", onStart: () => nav.runQa("explore") },
    { recipe: "draft", title: "Draft scenarios", promise: "Writes test scenarios from the code, the map and walked flows, for you to approve.", onStart: () => nav.runQa("draft") },
  ];

  return (
    <section className="flex flex-col gap-8 px-4.5 py-5 pb-10" style={{ "--d": "0ms" } as CSSProperties} data-exploration-section data-exploration-home>
      <ExploreHero
        features={data.features}
        onNew={() => nav.runQa("explore")}
        can={auth.can}
        reason={auth.reason}
        stats={stats}
        empty={empty}
        starts={starts}
        scene={empty ? <ExplorationEmptyScene /> : null}
        live={spotlight ? <LiveSpotlight key={spotlight.id} exploration={spotlight} route={data.routes[spotlight.id]} more={Math.max(0, liveRows.length - 1)} /> : null}
      />
      {/* The App model: one line, opening the panel; nothing until a model exists. */}
      <AppModelEntry cid={cid} platform={nav.platform} appName={appName ?? "this app"} />

      {empty ? null : <ExplorationHistory explorations={rows} routes={data.routes} kind={kind} onKind={(k) => nav.set({ kind: k, session: null })} actor={auth.human?.id ?? null} canAct={auth.can} />}
    </section>
  );
}
