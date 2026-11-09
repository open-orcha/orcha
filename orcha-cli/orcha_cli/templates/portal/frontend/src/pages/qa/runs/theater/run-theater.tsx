import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, Maximize2, Minimize2, RotateCw } from "../../map/kit/icons";
import { Button, Link, buttonVariants, cn } from "../../map/kit";
import type { QaAuthority } from "../../authority";
import { AbandonedRunBanner } from "../replay/abandoned-run-banner";
import { RunDetail } from "../replay/run-detail";
import { RunDetailHeader } from "../replay/run-detail-header";
import { RerunButton, StopRunButton } from "../replay/run-actions";
import type { RunFindingRow } from "../replay/run-finding";
import type { RunTab } from "../replay/run-tabs";
import { initialTheaterTab, type TheaterVariant } from "./theater-model";
import { TheaterLive } from "./theater-live";
import { TheaterOverview } from "./theater-overview";
import type { TheaterData } from "./types";
import motion from "./theater.module.css";

export interface RunTheaterProps {
  /** The session as last read; null until the first read answers. */
  data: TheaterData | null;
  error?: string | null;
  onRetry: () => void;
  /** Re-read the run: after Stop, a finding's action, or the run settling. */
  onChanged: () => void;
  auth: QaAuthority;
  /** Run check for this run's kind on its platform. */
  onRerun: () => void;
  /** `pane`: beside a list (Overview first, a full-screen toggle). `page`: full width. */
  variant?: TheaterVariant;
  /** The run on its own page, from a pane. */
  pageHref?: string;
  tabParam?: string | null;
  stepParam?: number | null;
  scenarioParam?: string | null;
  /** Filing and dismissing a finding: the session screens' own buttons. */
  renderFinding?: (row: RunFindingRow) => ReactNode;
  /** What the run's state says, above the header. */
  back?: ReactNode;
  /** The way back, first on the header's line. */
  leading?: ReactNode;
  /** The run's Activity, beside the device on every tab. */
  activity?: ReactNode;
}

/**
 * The run theater: one run, played in place. The player (live screen while running, the recorded
 * frames after), the timeline of steps grouped by scenario and criterion or by charter mission,
 * and the tabs (Overview, Scenarios, Steps, Findings, Logs with a live tail, API, Report), with the
 * header's chips and actions.
 */
export function RunTheater({ data, error = null, onRetry, onChanged, auth, onRerun, variant = "page", pageHref, tabParam = null, stepParam = null, scenarioParam = null, renderFinding, back, leading, activity }: RunTheaterProps) {
  const [tab, setTab] = useState<RunTab | null>(null);
  const [full, setFull] = useState(false);

  // The pane's portal host (see the render below).
  const [host] = useState<HTMLDivElement | null>(() => {
    if (typeof document === "undefined") return null;
    const el = document.createElement("div");
    el.style.display = "contents";
    el.className = "qa-port";
    return el;
  });
  const slot = useRef<HTMLDivElement>(null);
  const hasData = data != null;
  useLayoutEffect(() => {
    if (!host || !hasData || variant !== "pane") return;
    (full ? document.body : slot.current)?.appendChild(host);
    return () => host.remove();
  }, [host, hasData, full, variant]);

  // Escape leaves full screen.
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFull(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full]);

  const onTabChange = useCallback((t: RunTab) => setTab(t), []);

  if (!data) {
    return error ? (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center" data-run-theater data-theater-error>
        <p className="text-sm text-muted">{error}</p>
        <Button size="sm" onClick={onRetry}>
          <RotateCw /> Try again
        </Button>
      </div>
    ) : (
      <TheaterSkeleton />
    );
  }

  const pane = variant === "pane";
  const d = data.detail;
  const toolbar = (
    <>
      {data.live ? <StopRunButton runId={data.runId} auth={auth} onStopped={onChanged} /> : null}
      {data.abandonedReason ? null : <RerunButton auth={auth} onRerun={onRerun} />}
      {pane ? (
        <>
          {pageHref ? (
            <Link
              href={pageHref}
              className={buttonVariants({ size: "sm", variant: "ghost" })}
              title="Open the run on its own page"
              aria-label="Open the run on its own page"
              data-open-run
            >
              <ArrowUpRight />
            </Link>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setFull((f) => !f)}
            aria-pressed={full}
            aria-label={full ? "Leave full screen" : "Full screen"}
            title={full ? "Leave full screen (Esc)" : "Full screen"}
            data-theater-fullscreen={full ? "on" : "off"}
          >
            {full ? <Minimize2 /> : <Maximize2 />}
          </Button>
        </>
      ) : null}
    </>
  );

  const detail = (
    <RunDetail
      // A run that settled is a new document: remount on its status, keeping the tab.
      key={`${data.runId}:${d.run.status}`}
      {...d}
      auth={auth}
      onRerun={onRerun}
      charter={data.charter}
      initialTab={tab ?? initialTheaterTab({ variant, tabParam, stepParam, defaultTab: data.defaultTab, live: d.run.status === "running" })}
      initialStep={stepParam}
      initialScenarioId={scenarioParam}
      syncUrl={!pane}
      onSettled={onChanged}
      onTabChange={onTabChange}
      renderFinding={renderFinding}
      renderOverview={(ctx) => <TheaterOverview data={data} ctx={ctx} onRerun={auth.can ? onRerun : null} />}
      // The header and Activity already say all this on the run page: the device gets the room.
      renderLive={activity ? undefined : (ctx) => <TheaterLive data={data} ctx={ctx} />}
    />
  );

  const theater = (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-bg",
        pane && motion.slideIn,
        full && cn("fixed inset-0 z-50", motion.fullscreen),
      )}
      data-run-theater={data.runId}
      data-theater-variant={variant}
      data-theater-ready
      role={full ? "dialog" : undefined}
      aria-modal={full ? true : undefined}
      aria-label={full ? "Run, full screen" : undefined}
    >
      {back}
      <RunDetailHeader
        {...data.header}
        leading={leading}
        onRetry={auth.can ? onRerun : null}
        toolbar={toolbar}
        hideFailure={tab === "overview"}
        headingLevel={pane ? "h2" : "h1"}
      />
      {data.abandonedReason ? <AbandonedRunBanner reason={data.abandonedReason} onRerun={auth.can ? onRerun : null} /> : null}
      {activity ? (
        <div className="qa-run-body">
          <div className="qa-run-main">{detail}</div>
          <aside className="qa-run-rail" aria-label="Activity">{activity}</aside>
        </div>
      ) : (
        detail
      )}
    </div>
  );

  if (!pane || !host) return theater;
  // The pane renders through a portal into `host`, a node that sits in the pane and moves to
  // <body> in full screen: an ancestor's entrance animation (a transform) would otherwise pin a
  // `position: fixed` theater inside the pane, and moving the node keeps every bit of state.
  return (
    <div ref={slot} className="flex min-h-0 min-w-0 flex-1">
      {createPortal(theater, host)}
    </div>
  );
}

/** While the pane reads the run: the theater's shape, shimmering. */
function TheaterSkeleton() {
  return (
    <div className={cn("flex min-w-0 flex-1 flex-col", motion.fadeIn)} data-run-theater data-theater-loading aria-busy="true" aria-label="Loading the run">
      <div className="flex flex-col gap-2 border-b border-border px-4.5 py-3">
        <div className="v-skeleton h-5 w-64 rounded" />
        <div className="v-skeleton h-4 w-96 max-w-full rounded" />
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex flex-1 flex-col gap-2 px-4.5 py-4">
          <div className="v-skeleton h-6 w-80 max-w-full rounded" />
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="v-skeleton h-7 rounded" style={{ opacity: 1 - i * 0.12 }} />
          ))}
        </div>
        <div className="flex w-[320px] items-center justify-center border-l border-border max-lg:hidden">
          <div className="v-skeleton h-[420px] w-[200px] rounded-[24px]" />
        </div>
      </div>
    </div>
  );
}
