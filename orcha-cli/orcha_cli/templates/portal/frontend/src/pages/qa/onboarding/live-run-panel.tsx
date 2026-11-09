import { useEffect, useMemo, useState } from "react";
import { getJSON } from "../../../api/client";
import { LiveDeviceView } from "../runs/live/LiveDeviceView";
import { ArrowUpRight, PanelRightClose } from "../map/kit/icons";
import { Button, Link, StatusGlyph, buttonVariants, cn, useWithReturn } from "./ui";
import type { TargetKind } from "./types";
import type { LiveRun } from "./contract";
import { blockedRequestHref, liveStageText, recentSteps, type LiveBuild } from "./live-pass";

const STEPS_POLL_MS = 2500;

interface PanelStep {
  seq: number;
  kind: string;
  args: unknown;
  result?: string | null;
  frame_id?: string | null;
}

/** What a step acted on: a session records a tap's target as `{spec, label, role}`. */
function target(a: Record<string, unknown>): string {
  const t = a.target ?? a.text ?? a.key ?? a.url ?? a.direction;
  if (t && typeof t === "object") {
    const o = t as { label?: unknown; spec?: unknown };
    return typeof o.label === "string" && o.label ? o.label : typeof o.spec === "string" ? o.spec : "";
  }
  return typeof t === "string" ? t : "";
}

/** One step in a line: "tap Sign in", "type text=\u2026". */
export function summarizeStep(step: Pick<PanelStep, "kind" | "args">): string {
  const a = step.args && typeof step.args === "object" ? (step.args as Record<string, unknown>) : {};
  const t = target(a);
  return t ? `${step.kind} ${t}` : step.kind;
}

/** The session's newest steps, newest first, re-read while the panel shows. */
export function useSteps(sessionId: string | undefined): PanelStep[] {
  const [got, setGot] = useState<{ id: string; steps: PanelStep[] } | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    let live = true;
    const read = () =>
      getJSON<{ steps?: PanelStep[] }>(`/api/qa/sessions/${encodeURIComponent(sessionId)}/steps/latest`).then(
        (d) => { if (live) setGot({ id: sessionId, steps: d.steps ?? [] }); },
        () => {},
      );
    void read();
    const t = setInterval(() => void read(), STEPS_POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, [sessionId]);
  return got && got.id === sessionId ? got.steps : [];
}

/** The newest step with a screenshot. */
export function newestFrame(steps: readonly PanelStep[]): string | null {
  return [...steps].sort((a, b) => b.seq - a.seq).find((s) => s.frame_id)?.frame_id ?? null;
}

function StepLine({ step, current }: { step: PanelStep; current: boolean }) {
  const summary = summarizeStep(step);
  const rest = summary.length > step.kind.length ? summary.slice(step.kind.length).trim() : "";
  return (
    <li className={cn("flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1", current && "bg-primary/5")} data-onboarding-live-panel-step={step.seq} aria-current={current ? "step" : undefined}>
      {current ? <StatusGlyph status="running" label="happening now" className="size-3 shrink-0" /> : <StatusGlyph status="pass" decorative className="size-3 shrink-0" />}
      <span className="w-8 shrink-0 text-right font-mono text-2xs tabular-nums text-muted">{step.seq}</span>
      <span className="min-w-0 truncate" title={summary}>
        <span className={cn("text-xs font-medium", step.kind === "screen" ? "text-muted" : "text-fg")}>{step.kind}</span>
        {rest ? <span className="font-mono text-2xs text-muted"> {rest}</span> : null}
      </span>
    </li>
  );
}

function RunSteps({ steps: all }: { steps: PanelStep[] }) {
  const steps = useMemo(() => recentSteps<PanelStep>(all, [], 6), [all]);
  if (steps.length === 0) {
    return <p className="px-1.5 text-xs text-muted">The first step shows here as soon as the device takes it.</p>;
  }
  const [now, ...before] = steps;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <p className="px-1.5 text-2xs font-medium uppercase tracking-wide text-muted">Now</p>
      <ul aria-label="The step happening now">
        <StepLine step={now} current />
      </ul>
      {before.length ? (
        <>
          <p className="px-1.5 pt-1 text-2xs font-medium uppercase tracking-wide text-muted">Before that</p>
          <ul aria-label="Recent steps" className="flex flex-col">
            {before.map((s) => (
              <StepLine key={s.seq} step={s} current={false} />
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

/**
 * The live pass beside the map: the device as it streams (the run page's own live view), the
 * step happening now and the ones before it, and a link to the full run. Before a device picks
 * the pass up it says so. Collapse gives the map its full width back.
 */
export function LiveRunPanel({
  id,
  run,
  kind,
  device,
  building = null,
  blocked = null,
  onCollapse,
}: {
  id: string;
  run: LiveRun | null;
  kind?: TargetKind;
  device: string;
  /** Embodent builds the app for the pass (in the local checkout, or from a clone). */
  building?: LiveBuild;
  /** Why the pass cannot go on, and the request that says so: it replaces the waiting words. */
  blocked?: { reason: string; requestId?: string } | null;
  onCollapse: () => void;
}) {
  const withReturn = useWithReturn();
  // Before the device shows the app: waiting, building, installing (#454).
  const prep = liveStageText(run, device, building);
  const waiting = Boolean(prep) || !run?.run_id;
  const runId = run?.run_id;
  const steps = useSteps(runId);
  // The newest stored frame, so the device shows the current screen before the first live one.
  const frame = useMemo(() => newestFrame(steps), [steps]);
  return (
    <section
      id={id}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-panel p-3"
      aria-label="The live pass, on the device"
      data-onboarding-live-panel={waiting ? "waiting" : "running"}
    >
      <header className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-fg">The run, live</h2>
        <Button size="sm" variant="ghost" onClick={onCollapse} aria-expanded aria-controls={id} data-onboarding-live-panel-collapse>
          <PanelRightClose aria-hidden /> Collapse
        </Button>
      </header>
      {waiting || !runId ? (
        <div
          className="flex min-h-[320px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-bg px-4 text-center"
          role="status"
          data-onboarding-live-panel-stage={run?.stage ?? "queued"}
        >
          {blocked ? (
            <>
              <StatusGlyph status="warning" decorative className="size-4" />
              <p className="max-w-[320px] text-sm font-medium text-fg" data-onboarding-live-blocked>{blocked.reason}</p>
              {blocked.requestId ? <Link href={blockedRequestHref(blocked.requestId)} className="text-xs text-fg-2 underline underline-offset-2 hover:text-fg">Open the request</Link> : null}
            </>
          ) : (
            <>
              <span className="size-4 animate-spin rounded-full border-2 border-primary border-t-transparent motion-reduce:animate-none" aria-hidden />
              <p className="text-sm font-medium text-fg">{prep?.title ?? "Waiting for a device"}…</p>
              <p className="text-xs text-muted">{prep?.detail ?? `The pass starts as soon as ${device} is free.`}</p>
            </>
          )}
          {run?.stage === "building" && run.stage_note ? <p className="max-w-[260px] truncate font-mono text-2xs text-muted" title={run.stage_note}>{run.stage_note}</p> : null}
        </div>
      ) : (
        <>
          <div className="flex h-[300px] min-h-0 flex-col">
            <LiveDeviceView sessionId={runId} platform={kind ?? run?.platform ?? "web"} deviceName={device} fallbackFrameId={frame} fit />
          </div>
          <RunSteps steps={steps} />
          <Link href={withReturn(`/qa?view=sessions&session=${encodeURIComponent(runId)}`)} className={cn(buttonVariants({ size: "sm" }), "self-start")} data-onboarding-live-panel-open>
            Open the run <ArrowUpRight aria-hidden />
          </Link>
        </>
      )}
    </section>
  );
}
