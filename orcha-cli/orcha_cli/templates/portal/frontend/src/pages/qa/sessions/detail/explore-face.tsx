import { ArrowUpRight } from "../../map/kit/icons";
import { Link } from "../../map/kit";
import { FrameView } from "../frames";
import { LiveDeviceView } from "../../runs/live/LiveDeviceView";
import type { QaAuthority } from "../../authority";
import type { QaSession } from "../../qaApi";
import { runHref } from "../links";
import { LensChip } from "../lens-chip";
import { severityDot } from "../../map/kit";
import { isLens, type Exploration, type Lens } from "../explorations";
import type { Placement } from "../frames";
import type { Finding } from "../explorations";
import { cn } from "../../map/kit";
import { CharterChecklist } from "./charter-list";
import { charterPhrase, charterProgress, fmtClock, phaseClock, railFindings, type LiveState } from "./model";
import { useNow } from "./phase-timeline";
import { WorkEmpty, WorkHeading } from "../work/work-live";
import styles from "./detail.module.css";

/** Exploring time used against the recipe's minutes. */
function BudgetBar({ exploration }: { exploration: Exploration }) {
  const now = useNow(true);
  const clock = phaseClock(exploration, now);
  if (clock.capS == null) return null;
  const pct = Math.round((clock.fraction ?? 0) * 100);
  return (
    <div className="flex flex-col gap-1" data-budget-bar>
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted">Time box</span>
        <span className="font-mono text-2xs tabular text-fg-2" suppressHydrationWarning>
          {fmtClock(clock.elapsedS)} of {fmtClock(clock.capS)}
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-border"
        role="progressbar"
        aria-label="Time box used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        suppressHydrationWarning
      >
        <div
          className={cn("h-full rounded-full", pct >= 90 ? "bg-warning" : "bg-primary", styles.phaseFill)}
          style={{ transform: `scaleX(${(clock.fraction ?? 0).toFixed(3)})` }}
          suppressHydrationWarning
        />
      </div>
    </div>
  );
}

/** The lens of a run finding: the lens of the mission that filed it, else Works right. */
function findingLens(exploration: Exploration, f: Finding): Lens {
  return isLens(f.qa.lens) ? f.qa.lens : (exploration.charter.find((m) => m.finding_ids?.includes(f.id))?.lens ?? "works");
}

export function FindingsRail({ exploration, findings, runId, live = true }: { exploration: Exploration; findings: readonly Finding[]; runId: string | null; live?: boolean }) {
  const rows = railFindings(findings);
  return (
    <section className="flex min-w-0 flex-col gap-2" aria-label="Findings so far" data-findings-rail>
      <WorkHeading title="Findings" count={rows.length} />
      {rows.length === 0 ? (
        <WorkEmpty live={live} skeletons={2}>
          Nothing filed yet. Findings land here the moment Embodent finds them.
        </WorkEmpty>
      ) : (
        <ul className="flex flex-col gap-1.5" aria-live="polite">
          {rows.map((f) => {
            const step = f.repro_to_step ?? f.repro_from_step;
            return (
              <li key={f.id} className={cn("rounded-lg border border-border bg-panel px-3 py-2", styles.land)} data-rail-finding={f.id} data-severity={f.severity}>
                <div className="flex items-start gap-2">
                  <i aria-hidden className={cn("mt-1.5 inline-block size-2 shrink-0 rounded-full", severityDot[f.severity])} />
                  <span className="sr-only">{f.severity}</span>
                  <span className="min-w-0 flex-1 text-sm font-medium leading-5 text-fg">{f.title}</span>
                </div>
                <div className="mt-1 flex items-center gap-2 pl-4">
                  <LensChip lens={findingLens(exploration, f)} size="sm" />
                  {runId ? (
                    <Link href={runHref(runId, step)} className="ml-auto inline-flex items-center gap-0.5 text-xs text-muted hover:text-fg">
                      {step != null ? `Step ${step}` : "Run"}
                      <ArrowUpRight aria-hidden className="size-3" />
                    </Link>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** The newest screen, in the bezel of the run's platform.
 * `frameClassName` gives the frame a definite height, which it then fills (`FrameView fit`):
 * a phone as tall as the column allows, a browser as wide. */
export function LiveScreen({
  live,
  placement,
  device,
  runId,
  session,
  auth,
  frameClassName,
  className,
}: {
  live: LiveState;
  placement: Placement | null;
  device?: unknown;
  runId: string | null;
  /** The session this screen is of: the device itself shows while it runs. */
  session?: QaSession;
  auth?: QaAuthority;
  frameClassName?: string;
  className?: string;
}) {
  const latest = live.frames[live.frames.length - 1] ?? null;
  return (
    <aside className={cn("flex min-w-0 flex-col gap-2", className)} data-live-screen>
      <div className="flex items-center gap-2 text-xs">
        <span className="flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 font-medium text-fg">
          <span className="v-live size-1.5 text-danger" aria-hidden />
          LIVE
        </span>
        <span className="font-mono text-2xs tabular text-muted">{live.steps} steps</span>
        {runId ? (
          <Link href={runHref(runId)} className="ml-auto inline-flex items-center gap-0.5 text-xs text-muted hover:text-fg" data-open-run>
            Open run <ArrowUpRight aria-hidden className="size-3" />
          </Link>
        ) : null}
      </div>
      {session ? (
        <div className={cn("flex min-h-0 w-full flex-col", frameClassName)} data-live-frame-box>
          <LiveDeviceView sessionId={session.id} platform={session.platform} deviceName={session.device_name} status={session.status} fallbackFrameId={latest?.frame_path ?? null} address={session.platform === "web" ? session.app_id : null} fit={!!frameClassName} auth={auth} />
        </div>
      ) : placement && frameClassName ? (
        <div className={cn("flex min-h-0 w-full flex-col", frameClassName)} data-live-frame-box>
          <FrameView placement={placement} path={latest?.frame_path ?? null} device={device} fit />
        </div>
      ) : placement ? (
        <FrameView placement={placement} path={latest?.frame_path ?? null} device={device} />
      ) : (
        <div className="v-skeleton mx-auto aspect-[9/19.5] w-[200px] rounded-2xl" />
      )}
    </aside>
  );
}

/** The charter while it explores: progress, the time box, each mission with its state. */
export function ExploreCharter({ exploration }: { exploration: Exploration }) {
  const progress = charterProgress(exploration.charter, true);
  return (
    <section className="flex min-w-0 flex-col gap-3" aria-label="The charter" data-explore-charter>
      <div className="flex flex-col gap-2">
        <h3 className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm font-semibold text-fg">
          The charter
          <span className="font-normal tabular text-muted" data-charter-progress>
            {charterPhrase(progress)}
          </span>
        </h3>
        <BudgetBar exploration={exploration} />
      </div>
      <CharterChecklist items={exploration.charter} activeId={progress.activeId} runId={exploration.run_id} />
    </section>
  );
}

/** The frame box of the live screen in the "what Orcha sees" column: a phone as tall as the
 * column allows, a browser or desktop window as wide. */
export function liveFrameClass(placement: Placement | null): string {
  const phone = placement ? placement.kind === "ios" || placement.kind === "android" : false;
  return phone ? "h-[min(64vh,720px)]" : "h-[min(42vh,420px)] sm:h-[min(48vh,520px)]";
}
