import { FileCode2, FlaskConical, Radio, RefreshCw } from "./kit/icons";
import { useMemo, useRef, useState } from "react";
import type { Platform } from "../qaApi";
import cov from "./coverage.module.css";
import { Button, Chip, cn, fmtDate, fmtRelative, useRouter } from "./kit";
import { perPlatformTitle, perPlatformWords } from "./screen-count";
import { AppMapBuilding, AppMapEmpty, AppMapRebuilding, BuildButton } from "./app-map-scenes";
import { AppMapView } from "./app-map-view";
import { screenCoverage } from "./coverage-model";
import { RunAction } from "./map-actions";
import { DraftGapsLink } from "./map-coverage";
import { CrawlChip, MapTheAppButton } from "./crawl-chip";
import { currentTarget, nextFollow, queueMarks } from "./live-reveal";
import { plural } from "./model";
import { isBuilding, isEmptyMap, SOURCE_LABEL, type AppMap, type EvidenceSource } from "./types";
import { useMapCrawl } from "./use-map-crawl";

const SOURCE_ICON: Record<EvidenceSource, typeof FileCode2> = { code: FileCode2, tests: FlaskConical, live: Radio };

/** One source's "last built" chip: when it was read and what it gave. */
function SourceChip({ source, at, detail }: { source: EvidenceSource; at: string | null | undefined; detail: string | null }) {
  const Icon = SOURCE_ICON[source];
  return (
    <Chip size="sm" title={at ? `${SOURCE_LABEL[source]} read ${fmtDate(at)}` : `${SOURCE_LABEL[source]} not read yet`} data-map-source={source} className={at ? undefined : "text-muted"}>
      <Icon className="size-3" aria-hidden />
      {SOURCE_LABEL[source]}
      <span className="font-normal text-muted">{at ? `${detail ? `${detail} · ` : ""}${fmtRelative(at)}` : "not read"}</span>
    </Chip>
  );
}

function Count({ n, label, dot }: { n: number; label: string; dot?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      {dot ? <span className={cn("size-2 rounded-full", dot)} aria-hidden /> : null}
      <span className="font-medium tabular-nums text-fg">{n}</span>
      {label}
    </span>
  );
}

/** The counts and each source's last read, with "Draft the gaps", Map the app and Rebuild. */
function MapHeader({ map, busy }: { map: AppMap; busy: boolean }) {
  const c = map.counts;
  const cover = screenCoverage(map);
  const { code, tests, live } = map.sources;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2.5 md:px-6" data-map-header>
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-sm text-fg-2" data-map-counts>
        <Count n={c.features} label={c.features === 1 ? "feature" : "features"} />
        <span
          className="inline-flex flex-wrap items-baseline gap-x-1.5"
          title={perPlatformTitle(c.platforms) ?? `${plural(c.screens, "screen")} in all`}
          data-map-screen-count={c.screens}
        >
          <Count n={c.screens} label={c.screens === 1 ? "screen" : "screens"} />
          {perPlatformWords(c.platforms) ? <span className="text-xs text-muted">{perPlatformWords(c.platforms)}</span> : null}
        </span>
        <span className="inline-flex flex-wrap items-center gap-x-2.5 gap-y-1" title={`${plural(c.screens, "screen")} in all`}>
          <Count n={c.seen} label="seen" dot="bg-[var(--cov-strong)]" />
          <Count n={c.declared} label="declared" dot="border border-dashed border-[var(--cov-untested)]" />
          <Count n={c.blocked} label="blocked" dot="bg-warning" />
        </span>
        <Count n={c.endpoints} label={c.endpoints === 1 ? "endpoint" : "endpoints"} />
        <Count n={c.entities} label={c.entities === 1 ? "entity" : "entities"} />
        <Count n={c.flows} label={c.flows === 1 ? "flow" : "flows"} />
        <span
          title={`${cover.covered} of ${plural(cover.total, "screen")} a test or scenario reaches. Coverage › Growth counts a screen as covered only while one passed there recently.`}
          data-map-covered-count
        >
          <Count n={cover.covered} label="reached by tests" dot="bg-[var(--cov-covered)]" />
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 md:ml-auto">
        <SourceChip source="code" at={code?.at} detail={code ? plural(code.screens, "screen") : null} />
        <SourceChip source="tests" at={tests?.at} detail={tests ? plural(tests.tests, "test") : null} />
        <SourceChip source="live" at={live?.at} detail={live ? plural(live.runs, "run") : null} />
        {cover.covered < cover.total ? <DraftGapsLink map={map} /> : null}
        <MapTheAppButton />
        <RunAction kind="map" size="md" disabled={busy} aria-busy={busy || undefined} data-app-map-rebuild>
          <RefreshCw className={busy ? "animate-spin" : undefined} /> Rebuild
        </RunAction>
      </div>
    </div>
  );
}

/**
 * Map: the header (counts, each source's last read, Rebuild) over the canvas; the teaching empty
 * state before the first build; the building view while one runs. The map comes from the page;
 * agents build it, so Rebuild opens Run check. While a map session runs, the map follows it live
 * (`useMapCrawl`): new screens lift out of the fog as the crawl reaches them, under a chip that
 * says how far it has got. `selected` / `onSelect` hold the URL's `?screen=`.
 */
export function AppMapBoard({
  project,
  map: served,
  error,
  selected = null,
  onSelect,
}: {
  project: { id: string; platform: Platform };
  map: AppMap | null;
  error: string | null;
  selected?: string | null;
  onSelect?: (id: string | null) => void;
}) {
  const router = useRouter();
  const { crawl, map, revealed, newest } = useMapCrawl(project.id, project.platform, served);
  const build = map?.build ?? null;
  const building = isBuilding(build);
  const buildError = build?.status === "failed" ? (build.error ?? "The build failed.") : null;
  const [follow, setFollow] = useState(true);
  // A planned crawl's queue: the target it is on and the next ones, by screen key.
  const queue = crawl?.queue ?? null;
  const marks = useMemo(() => queueMarks(queue), [queue]);
  const nowKey = currentTarget(queue)?.key ?? null;
  const nowId = useMemo(() => (nowKey ? (map?.nodes.find((n) => n.kind === "screen" && n.key === nowKey)?.id ?? null) : null), [map, nowKey]);
  // Follow keeps the camera on whichever moved last: the newest screen reached, or the target the
  // queue moved on to.
  const [followed, setFollowed] = useState<{ newest: string | null; current: string | null; id: string | null }>({ newest: null, current: null, id: null });
  const nextFollowed = nextFollow(followed, newest, nowId);
  if (nextFollowed !== followed) setFollowed(nextFollowed);
  const followId = nextFollowed.id;
  const reveal = useMemo(() => ({ fresh: new Set(revealed.keys()), follow: follow ? followId : null, queue: marks }), [revealed, follow, followId, marks]);
  const empty = !map || isEmptyMap(map);
  // A new build draws the canvas afresh, but never under a session that is still filling it.
  const viewKey = useRef(map?.built_at ?? "map");
  if (!crawl && !building) viewKey.current = map?.built_at ?? "map";
  const chip = crawl ? <CrawlChip crawl={crawl} map={map} follow={follow} onFollow={setFollow} /> : null;

  if (error && !map) {
    return (
      <div className={cn(cov.palette, "flex flex-1 items-start justify-center px-4 py-10")}>
        <div className="w-full max-w-lg rounded-xl border border-border bg-panel p-6" data-app-map-load-error>
          <p className="text-base text-fg">The map could not be loaded.</p>
          <p className="mt-1 text-sm text-muted">{error}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button onClick={() => router.refresh()}>
              <RefreshCw /> Try again
            </Button>
            <RunAction kind="map" variant="ghost" disabled={building}>
              Rebuild the map
            </RunAction>
          </div>
        </div>
      </div>
    );
  }

  if (empty) {
    return (
      <div className={cn(cov.palette, "flex min-h-0 flex-1 flex-col")}>
        {building ? (
          <AppMapBuilding build={build} />
        ) : crawl ? (
          <AppMapEmpty note="Mapping the app now. Each screen the crawl reaches appears here as it is recorded." action={chip} />
        ) : (
          <AppMapEmpty
            error={buildError}
            note={map?.build?.status === "done" ? "The last build found nothing to map yet. Each run adds the screens it reaches, so the map fills in as the app is tested." : null}
            action={
              <>
                <BuildButton busy={false} label={buildError ? "Try again" : map?.build ? "Build again" : "Build the map"} />
                <MapTheAppButton size="lg" />
              </>
            }
          />
        )}
      </div>
    );
  }

  return (
    <div className={cn(cov.palette, "flex min-h-0 flex-1 flex-col")} data-app-map-board>
      <MapHeader map={map} busy={building} />
      {buildError ? (
        <p className="border-b border-border px-4 py-2 text-sm text-danger md:px-6" data-app-map-error>
          The last build failed: {buildError}
        </p>
      ) : null}
      <div className="relative min-h-[520px] flex-1">
        <div className="absolute inset-0">
          <AppMapView
            key={viewKey.current}
            map={map}
            reveal={crawl ? reveal : undefined}
            selected={selected}
            onSelect={onSelect}
            overlay={
              <>
                {building ? <AppMapRebuilding build={build} /> : null}
                {chip ? (
                  <div className="absolute left-1/2 top-14 z-20 max-w-[calc(100%-2rem)] -translate-x-1/2 max-md:top-24" data-map-crawl-overlay>
                    {chip}
                  </div>
                ) : null}
              </>
            }
          />
        </div>
      </div>
    </div>
  );
}
