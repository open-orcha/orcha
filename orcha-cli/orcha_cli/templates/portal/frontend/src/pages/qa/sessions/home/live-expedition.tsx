import { Link } from "../../map/kit";
import { useEffect, useState } from "react";
import { ArrowRight, Check, Hourglass } from "../../map/kit/icons";
import { urlFor } from "../frames";
import { isLive, statusWord } from "../explorations";
import { displayVerdict, type Exploration } from "../explorations";
import { cn } from "../../map/kit";
import { liveFrameSrc, useLiveFrame } from "../../runs/live/use-live-frame";
import { RecipeMeta } from "../recipe-meta";
import { PhaseBar } from "./bits";
import { clock, sessionHref, type ExplorationRoute, type RouteFrame } from "./home-model";
import styles from "./explore.module.css";

/** The latest screen of an exploration: its route's last frame, read again while it runs. */
export function useLatestFrame(_e: Pick<Exploration, "status">, route: ExplorationRoute | undefined): RouteFrame | null {
  return route?.frames[route.frames.length - 1] ?? null;
}

/** Seconds since `from`, ticking once a second while `on` (and the tab is visible). */
export function useElapsed(from: string | null, on: boolean): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") setNow(Date.now());
    }, 1000);
    return () => window.clearInterval(id);
  }, [on]);
  if (!from) return null;
  const t = Date.parse(from);
  return Number.isFinite(t) ? Math.max(0, (now - t) / 1000) : null;
}

/** The newest screen in a device or window shape, a scan line passing over it while it runs. */
export function LiveScreen({
  frame,
  kind,
  size = "md",
  still = false,
  sessionId = null,
  className,
}: {
  frame: RouteFrame | null;
  kind: string | null;
  /** A running session: its device's newest pushed frame, over the stored ones. */
  sessionId?: string | null;
  size?: "sm" | "md";
  /** Finished: no scan line. */
  still?: boolean;
  className?: string;
}) {
  const phone = kind === "ios" || kind === "android";
  // A screenshot no longer on disk (a storage cleanup) shows the placeholder, not a broken image.
  const [failed, setFailed] = useState<string | null>(null);
  const shown = frame && failed !== frame.path ? frame : null;
  const { frame: pushed } = useLiveFrame(sessionId ?? "", !still && !!sessionId, null);
  return (
    <span
      className={cn(
        "relative block shrink-0 overflow-hidden border border-border-strong bg-panel-2 shadow-[var(--shadow-sm)]",
        phone ? (size === "md" ? "h-[150px] rounded-[14px]" : "h-[84px] rounded-[9px]") : size === "md" ? "h-[120px] rounded-md" : "h-[64px] rounded-md",
        className,
      )}
      style={{ aspectRatio: phone ? "402 / 874" : "16 / 10" }}
      data-live-screen={frame?.seq ?? "none"}
    >
      {pushed && !still ? (
        <img src={liveFrameSrc(pushed)} alt="Latest screen" className={cn("absolute inset-0 size-full object-cover object-top", styles.liveFrame)} data-live-pushed />
      ) : shown ? (
        <img
          key={shown.path}
          src={urlFor(shown.path)}
          alt={`Latest screen, step ${shown.seq}`}
          onError={() => setFailed(shown.path)}
          className={cn("absolute inset-0 size-full object-cover object-top", styles.liveFrame)}
        />
      ) : (
        <span className="absolute inset-0 flex items-center justify-center text-muted">
          <Hourglass aria-hidden className="size-4" strokeWidth={1.75} />
        </span>
      )}
      {still ? null : (
        <span aria-hidden className={cn("pointer-events-none absolute inset-x-0 top-0 h-1/3 bg-gradient-to-b from-transparent via-fg/10 to-transparent", styles.scan)} />
      )}
    </span>
  );
}

/**
 * The header's live view of a running exploration: its newest screen, the phase it is in, how
 * long it has run and a way into the live page. When it finishes while the page is open it lands
 * in the same place (and stays there for a few minutes after): its verdict and Open the report, so nothing jumps. Everything on it is the run's
 * own state.
 */
export function LiveSpotlight({ exploration: e, route, more }: { exploration: Exploration; route: ExplorationRoute | undefined; more: number }) {
  const live = isLive(e.status);
  const frame = useLatestFrame(e, route);
  const elapsed = useElapsed(e.started_at ?? e.created_at, live);
  const href = sessionHref(e);

  if (!live) {
    const done = e.status === "done";
    return (
      <div
        className={cn(
          "v-rise relative flex items-center gap-4 overflow-hidden rounded-lg border p-3",
          done
            ? "border-success/40 bg-panel"
            : "border-border bg-panel",
        )}
        data-live-spotlight={e.id}
        data-landed={e.status}
      >
        <LiveScreen frame={frame} kind={e.platform} size="md" still />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className={cn("inline-flex items-center gap-1.5 text-sm font-semibold", done ? "text-success" : "text-fg-2")} role="status" aria-live="polite">
              <span className={cn("flex size-4 items-center justify-center rounded-full", done ? "bg-success text-white" : "bg-panel-2 text-muted", styles.landed)} aria-hidden>
                <Check className="size-2.5" strokeWidth={3.5} />
              </span>
              {done ? "Just finished" : `${statusWord(e)}`}
            </span>
            <Link href={href} className="min-w-0 truncate text-base font-medium text-fg hover:underline">
              {e.name}
            </Link>
            <RecipeMeta recipe={e.recipe} minutes={e.minutes} size="sm" />
          </div>
          {e.result?.verdict ? <p className="text-sm text-fg-2">{displayVerdict(e.result)}</p> : null}
        </div>
        <Link
          href={href}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-control px-2.5 py-1 text-sm font-medium text-fg hover:border-border-strong max-sm:hidden"
        >
          Open the report <ArrowRight aria-hidden className="size-3.5" />
        </Link>
      </div>
    );
  }

  return (
    <div
      className="v-rise relative flex items-center gap-4 overflow-hidden rounded-lg border border-progress/40 bg-panel p-3"
      data-live-spotlight={e.id}
    >
      <LiveScreen frame={frame} kind={e.platform} size="md" sessionId={e.status === "queued" ? null : e.id} />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-progress" role="status" aria-live="polite">
            <span className="v-live size-2" aria-hidden />
            {e.status === "queued" ? "Waiting for an agent" : e.status === "checking" ? statusWord(e) : `${statusWord(e)} now`}
          </span>
          <Link href={href} className="min-w-0 truncate text-base font-medium text-fg hover:underline">
            {e.name}
          </Link>
          <RecipeMeta recipe={e.recipe} minutes={e.minutes} size="sm" />
          {elapsed != null ? (
            <time className="font-mono text-xs tabular text-fg-2" suppressHydrationWarning aria-label={e.status === "queued" ? "Waiting for" : "Running for"}>
              {clock(elapsed)}
            </time>
          ) : null}
          {more > 0 ? <span className="text-xs text-muted">and {more} more running</span> : null}
        </div>
        <PhaseBar status={e.status} className="max-w-[520px]" />
        {frame ? <p className="text-xs text-muted">Latest screen at step {frame.seq}</p> : null}
      </div>
      <Link
        href={href}
        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-control px-2.5 py-1 text-sm font-medium text-fg hover:border-border-strong max-sm:hidden"
      >
        Watch live <ArrowRight aria-hidden className="size-3.5" />
      </Link>
    </div>
  );
}
