import { Crosshair, Waypoints } from "./kit/icons";
import { useEffect, useState } from "react";
import { cn, Link } from "./kit";
import styles from "./app-map.module.css";
import { queueProgress, screensSeenIn, timeLeft } from "./live-reveal";
import { RunAction, useMapHrefs } from "./map-actions";
import { plural } from "./model";
import type { AppMap } from "./types";
import type { MapCrawl } from "./use-map-crawl";

/** The **Map the app** button (the header and the empty state): opens Run check on a map session. */
export function MapTheAppButton({ size = "md" }: { size?: "md" | "lg" }) {
  return (
    <RunAction kind="map" variant="secondary" size={size} title="Crawl the app on purpose: every screen it can reach, each action once" data-map-the-app>
      <Waypoints /> Map the app
    </RunAction>
  );
}

/** A clock that ticks every second while `on`. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [on]);
  return now;
}

/** What the chip says, in the words of the job's own page: its name, then a planned
 * crawl's progress through its queue ("Map the app · 14 of 40 targets · 6:12 left"), else the
 * screens seen ("Map the app · 14 screens seen · 6:12 left"), "Reading" before the device or
 * "Waiting for a worker". */
export function crawlLine(crawl: MapCrawl, map: AppMap | null, now: number): string {
  if (crawl.status === "queued") return "Map the app · Waiting for a worker";
  const left = timeLeft(crawl.minutes, crawl.clock_started_at, now);
  if (crawl.queue && crawl.queue.total > 0) {
    const progress = queueProgress(crawl.queue);
    return left ? `Map the app · ${progress} · ${left} left` : `Map the app · ${progress}`;
  }
  const seen = map ? screensSeenIn(map, crawl.run_id) : 0;
  if (!left) return seen ? `Map the app · ${plural(seen, "screen")} seen` : "Map the app · Reading";
  return `Map the app · ${plural(seen, "screen")} seen · ${left} left`;
}

/**
 * The live chip over the map while a Map the app crawl is queued or running: what it has seen and
 * the time left, linking to the session, and Follow, which
 * keeps the camera on the newest screen the crawl reveals.
 */
export function CrawlChip({ crawl, map, follow, onFollow }: { crawl: MapCrawl; map: AppMap | null; follow: boolean; onFollow: (on: boolean) => void }) {
  const now = useNow(crawl.status === "running");
  const hrefs = useMapHrefs();
  const href = crawl.run_id ? hrefs.session(crawl.run_id) : null;
  const line = crawlLine(crawl, map, now);
  const label = (
    <span className="inline-flex min-w-0 items-center gap-2">
      <span className={cn("size-2 shrink-0 rounded-full bg-[var(--cov-strong)]", crawl.status === "running" && styles.liveDot)} aria-hidden />
      <span className="truncate tabular-nums">{line}</span>
    </span>
  );
  return (
    <div
      className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-raised/95 py-0.5 pl-3 pr-0.5 text-sm text-fg shadow-md backdrop-blur"
      data-map-crawl-chip
      data-crawl-status={crawl.status}
    >
      {href ? (
        <Link href={href} className="min-w-0 hover:underline" data-map-crawl-link>
          {label}
        </Link>
      ) : (
        label
      )}
      <button
        type="button"
        aria-pressed={follow}
        onClick={() => onFollow(!follow)}
        title={follow ? "Stop following the newest screen" : "Follow the newest screen the crawl reaches"}
        className={cn(
          "ml-1 inline-flex h-6 items-center gap-1 rounded-full px-2 text-xs transition-colors",
          follow ? "bg-selected text-fg" : "text-muted hover:bg-hover hover:text-fg",
        )}
        data-map-follow
      >
        <Crosshair className="size-3.5" aria-hidden /> Follow
      </button>
    </div>
  );
}
