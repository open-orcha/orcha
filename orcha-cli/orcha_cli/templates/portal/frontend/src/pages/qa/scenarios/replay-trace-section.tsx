import { useCallback, useEffect, useState } from "react";
import { Link } from "../map/kit";
import { Button } from "../map/kit";
import { useConfirm } from "../map/kit";
import { StatusGlyph, type GlyphStatus } from "../map/kit";
import { useToast } from "../map/kit";
import { fmtRelative } from "../map/kit";
import { qaHref } from "../parts";
import { useScenarios } from "./context";
import { forgetTrace, loadTraces } from "./api";
import { replayable, type ReplayTrace, type SegmentState } from "./replay-trace";
import { PanelSection } from "./panel-ui";

/** Each segment state as a status glyph (shape + colour, never colour alone). */
const STATE_GLYPH: Record<SegmentState, GlyphStatus> = {
  verified: "pass",
  evicted: "warning",
  unverified: "pending",
};

const REPLAY_HELP =
  "The path a walk recorded, one segment per criterion. A check run gets it as its known path; the agent still " +
  "judges every criterion, and a criterion that fails since is marked here.";

/** What each way of stopping reads as. */
const STOP_TEXT: Record<string, string> = { criterion_fail: "a check failed here", criterion_blocked: "a check could not get here" };

/**
 * The scenario's recorded path, built from the walk it came from: one segment per criterion with
 * its verification state, the actions under it, how checks went since and where the last one
 * stopped. "Re-record" forgets it, so the next walk records afresh.
 */
export function ReplayTraceSection({ scenarioId }: { scenarioId: string }) {
  const [traces, setTraces] = useState<ReplayTrace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();
  const { toast } = useToast();
  const { auth } = useScenarios();

  const load = useCallback(() => {
    loadTraces(scenarioId).then(setTraces, () => setError("Could not load the path."));
  }, [scenarioId]);

  useEffect(load, [load]);

  async function rerecord(t: ReplayTrace) {
    const ok = await confirm({
      title: "Re-record this path?",
      description: "The scenario forgets this walk; the walk stays in its session. The next walk of it records a fresh path. Nothing else changes.",
      confirmLabel: "Forget the recorded path",
      destructive: true,
    });
    if (!ok) return;
    try {
      await forgetTrace(scenarioId, t.targetKind, auth.human?.id ?? null);
      toast({ title: "Recorded path forgotten", description: "The next walk records a fresh one.", variant: "success" });
      load();
    } catch {
      toast({ title: "Could not forget the path", variant: "error" });
    }
  }

  return (
    <PanelSection title="Recorded path" help={REPLAY_HELP} data-replay-trace>
      {error ? (
        <p className="flex items-center gap-1.5 text-xs text-muted">
          <StatusGlyph status="fail" decorative className="size-3" />
          {error}
        </p>
      ) : null}
      {traces === null && !error ? <p className="text-xs text-muted">Loading…</p> : null}
      {traces && traces.length === 0 ? (
        <p className="text-xs text-muted" data-replay-trace-empty>
          No recorded path yet: a walk records one.
        </p>
      ) : null}
      {(traces ?? []).map((t) => {
        const status = replayable(t);
        return (
          <div key={t.id} className="flex flex-col rounded-md border border-border" data-trace={t.targetKind}>
            <div className="flex flex-col gap-1 px-2.5 py-2">
              <div className="flex min-h-6 items-center gap-2 text-sm">
                <StatusGlyph status={status.ok ? "pass" : "pending"} decorative />
                <span className="font-mono text-xs text-fg">{t.targetKind}</span>
                <span
                  data-trace-status={status.ok ? "replayable" : "not-replayable"}
                  className="min-w-0 truncate text-fg-2"
                  title={status.why}
                >
                  {status.ok ? "Given to the next check run" : "Next run finds its own way"}
                </span>
                <span className="flex-1" />
                <Button size="sm" variant="ghost" disabled={!auth.can} onClick={() => rerecord(t)} data-trace-rerecord>
                  Re-record
                </Button>
              </div>
              <p className="text-xs text-muted">
                <span className="tabular">
                  {t.okCount} passed · {t.failCount} failed since
                </span>
                {t.lastReplayedAt ? ` · last ${fmtRelative(t.lastReplayedAt)}` : ""}
                {t.runId ? (
                  <>
                    {" · "}recorded {t.recordedAt ? `${fmtRelative(t.recordedAt)} ` : ""}from{" "}
                    <Link href={qaHref({ view: "sessions", session: t.runId })} className="text-fg-2 underline-offset-2 hover:text-fg hover:underline">
                      this session
                    </Link>
                  </>
                ) : null}
                {t.viewport ? ` · ${t.viewport[0]}x${t.viewport[1]}` : ""}
              </p>
              {!status.ok ? (
                <p className="text-xs text-muted">{status.why.charAt(0).toUpperCase() + status.why.slice(1)}.</p>
              ) : null}
              {t.lastStop ? (
                <p className="flex items-start gap-1.5 text-xs text-fg-2" data-trace-last-stop>
                  <StatusGlyph status="warning" decorative className="mt-px size-3" />
                  <span className="min-w-0">
                    Last stop: {STOP_TEXT[t.lastStop.reason] ?? t.lastStop.reason}
                    {t.lastStop.criterion != null ? ` (criterion ${t.lastStop.criterion + 1})` : ""}
                    {t.lastStop.detail ? <span className="font-mono text-muted"> {t.lastStop.detail}</span> : null}
                  </span>
                </p>
              ) : null}
            </div>
            <ol className="flex flex-col divide-y divide-border border-t border-border">
              {t.segments.map((seg) => {
                const acts = t.actions.filter((a) => (seg.fromAction == null || a.index >= seg.fromAction) && (seg.toAction == null || a.index <= seg.toAction));
                return (
                  <li key={seg.index} className="px-2.5 py-2" data-trace-segment={seg.state}>
                    <div className="flex items-start gap-2">
                      <StatusGlyph status={STATE_GLYPH[seg.state]} label={seg.state} className="mt-[3px] size-3" />
                      <span className="min-w-0 flex-1 text-sm text-fg">
                        <span className="tabular text-muted">{seg.index + 1}.</span> {seg.text}
                      </span>
                      <span className="shrink-0 font-mono text-[11px] tabular text-muted" title="passed / failed at this criterion since">
                        {seg.okCount}/{seg.failCount}
                      </span>
                    </div>
                    {seg.checks.length ? (
                      <p className="ml-5 mt-0.5 font-mono text-[11px] text-fg-2" title="Proven by these checks">
                        {seg.checks.join(" · ")}
                      </p>
                    ) : seg.expectTexts.length ? (
                      <p className="ml-5 mt-0.5 text-[11px] text-muted" title="Proven by this text on screen">
                        expects: {seg.expectTexts.join(" · ")}
                      </p>
                    ) : null}
                    {acts.length ? (
                      <ul className="ml-5 mt-1 flex flex-col gap-0.5 border-l border-border pl-2">
                        {acts.map((a) => (
                          <li key={a.index} className="flex items-start gap-1.5 font-mono text-[11px] text-muted">
                            <span className="w-5 shrink-0 text-right tabular text-muted/70">{a.index + 1}.</span>
                            <span className="min-w-0 flex-1 break-words">
                              <span className="text-fg">{a.label}</span>{" "}
                              {a.secret ? <Tag title="Filled from the environment's secret at replay; never stored">secret</Tag> : null}
                              {a.valueKind === "template" ? <Tag title="This run's value is filled in at replay">template</Tag> : null}
                              {a.valueKind === "derived" ? <Tag warn title="Read from the screen live: replay stops here and the agent types it">read live</Tag> : null}
                              {a.templated ? <Tag title="Its target or URL carries the run's value, refilled at replay">templated</Tag> : null}
                              {a.twin ? <Tag title="One of several identical elements: replay picks it by position, never by guessing">twin {a.twin[0] + 1}/{a.twin[1]}</Tag> : null}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </div>
        );
      })}
    </PanelSection>
  );
}

/** Small neutral tag; a replay gap ("read live") leads with the warning glyph instead of a tint. */
function Tag({ children, warn = false, title }: { children: React.ReactNode; warn?: boolean; title: string }) {
  return (
    <span title={title} className="inline-flex items-center gap-1 rounded border border-border px-1 font-sans text-[10px] text-fg-2">
      {warn ? <StatusGlyph status="warning" decorative className="size-2.5" /> : null}
      {children}
    </span>
  );
}
