import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { AlertTriangle, CircleHelp, Map as MapIcon, RefreshCw, Target } from "../../../map/kit/icons";
import { Button } from "../../../map/kit";
import { useToast } from "../../../map/kit";
import { errText } from "../../../parts";
import { coverageGrowth, growthVariations, takeBaseline as postBaseline } from "../../api";
import { HumanGate, useScenarios } from "../../context";
import { cn } from "../../../map/kit";
import { AddedTiles } from "./added-tiles";
import { BaselineShutter, SubjectBars, type ShutterPhase, type Snapshot } from "./baseline-shutter";
import { AreaChart } from "./growth-charts";
import { GrowthHero } from "./growth-hero";
import { depthGrew, growthMode, growthSteps, longDate, pctWords, shortDate } from "./growth-model";
import { GrowthLoading, GrowthTeach } from "./growth-states";
import { OverTime } from "./growth-timelapse";
import styles from "./growth.module.css";
import { reducedMotion } from "./motion";
import { parseGrowth, TRIGGER_WORDS, type CoverageGrowth } from "./types";
import { VariationsPanel } from "./variations-panel";

async function fetchGrowth(cid: string): Promise<{ report?: CoverageGrowth; error?: string }> {
  try {
    return { report: parseGrowth(await coverageGrowth(cid)) };
  } catch (err) {
    return { error: errText(err) };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Shutter {
  phase: ShutterPhase;
  again: boolean;
  snap: Snapshot | null;
}

/**
 * Scenarios › Coverage › Growth (#413): coverage at the baseline against now, per area and over
 * time, what Orcha added, what is at risk or unknown and why, the data depth of each flow
 * with suggestions waiting for approval, and the
 * baseline's history with Re-baseline. Live: it follows the change feed, so a baseline
 * onboarding takes or a run that just passed shows here.
 *
 * Every action tells its story while it runs (modernize pass): taking a baseline is a shutter
 * that freezes coverage, Measure again sweeps the meter with its steps and lands on what
 * changed, approved rows go into their table and light the flow's new partitions.
 */
export function GrowthView({ project, nonce, onMapApp }: { project: { id: string; slug: string; name: string }; nonce: number; onMapApp: () => void }) {
  const { toast } = useToast();
  const { auth } = useScenarios();
  const actor = auth.human?.id ?? null;
  const [report, setReport] = useState<CoverageGrowth | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [landed, setLanded] = useState<{ before: number | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rebase, setRebase] = useState(false);
  const [reason, setReason] = useState("");
  const [shutter, setShutter] = useState<Shutter | null>(null);
  const [grew, setGrew] = useState<Record<string, number>>({});
  const [freshBaseline, setFreshBaseline] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const apply = useCallback((r: { report?: CoverageGrowth; error?: string }) => {
    setNow(Date.now());
    if (r.report) {
      setReport(r.report);
      setPhase("ready");
      setError(null);
    } else {
      setError(r.error ?? "Could not measure coverage growth.");
      setPhase((p) => (p === "ready" ? p : "error"));
    }
  }, []);

  const load = useCallback(async (_fresh: boolean) => {
    const r = await fetchGrowth(project.id);
    apply(r);
    return r;
  }, [project.id, apply]);

  useEffect(() => {
    let alive = true;
    void fetchGrowth(project.id).then((r) => {
      if (alive) apply(r);
    });
    return () => {
      alive = false;
    };
    // Follows the page's own re-reads (a check that just passed shows here).
  }, [project.id, apply, nonce]);

  // Figures answered from today's stored point while a measurement runs: ask again until it lands.
  useEffect(() => {
    if (!report?.refreshing) return;
    const t = setTimeout(() => void load(false), 2500);
    return () => clearTimeout(t);
  }, [report, load]);

  // Landing notes fade back to the page's resting state.
  useEffect(() => {
    if (!landed) return;
    const t = setTimeout(() => setLanded(null), 6000);
    return () => clearTimeout(t);
  }, [landed]);
  useEffect(() => {
    if (!Object.keys(grew).length) return;
    const t = setTimeout(() => setGrew({}), 9000);
    return () => clearTimeout(t);
  }, [grew]);

  async function measureAgain() {
    const before = report?.growth?.overall.now.pct ?? report?.now.totals.pct ?? null;
    setMeasuring(true);
    setLanded(null);
    const r = await load(true);
    setMeasuring(false);
    if (r.report) setLanded({ before });
    else toast({ title: "Could not measure again", description: r.error ?? "" });
  }

  async function takeBaseline(again: boolean) {
    const previous = report?.baseline ?? null;
    setShutter({ phase: "measuring", again, snap: null });
    try {
      await postBaseline(project.id, actor, again ? { action: "rebaseline", reason } : { action: "baseline" });
    } catch (err) {
      setShutter(null);
      toast({ title: again ? "Could not re-baseline" : "Could not take the baseline", description: errText(err) });
      return;
    }
    const r = await fetchGrowth(project.id);
    const rep = r.report;
    if (!rep?.baseline || !rep.growth) {
      setShutter(null);
      apply(r);
      return;
    }
    // The print shows the stored baseline's own figure, not the one measured before the click.
    const b = rep.growth.overall.before;
    const snap: Snapshot = { pct: b.pct, screens: b.screens, covered: b.covered, day: longDate(rep.baseline.taken_at), replaced: again && previous ? shortDate(previous.taken_at) : null };
    const still = reducedMotion();
    if (!still) {
      setShutter({ phase: "shoot", again, snap });
      await sleep(420);
    }
    setShutter({ phase: "print", again, snap });
    await sleep(still ? 1600 : 2300);
    setRebase(false);
    setReason("");
    setFreshBaseline(rep.baseline.id);
    apply(r);
    setShutter(null);
    toast({ title: again ? "Re-baselined: growth counts from today" : "Baseline taken: growth counts from today" });
  }

  async function variations(body: Record<string, unknown>, key: string, done: (json: Record<string, unknown>) => string) {
    setBusy(key);
    const before = report?.now.flows ?? [];
    try {
      let json: Record<string, unknown>;
      try {
        json = await growthVariations(project.id, actor, body);
      } catch (err) {
        toast({ title: "Could not do that", description: errText(err) });
        return;
      }
      toast({ title: done(json) });
      const r = await load(true);
      if (body.action === "apply" && r.report) setGrew(depthGrew(before, r.report.now.flows));
    } finally {
      setBusy(null);
    }
  }

  if (phase === "loading" || (!report && phase !== "error")) return <GrowthLoading />;
  if (phase === "error" || !report) {
    return (
      <div className="rounded-xl border border-border bg-panel p-6" data-growth-error>
        <p className="text-base text-fg">Coverage growth could not be measured.</p>
        <p className="mt-1 text-sm text-muted">{error}</p>
        <Button className="mt-3" onClick={() => void load(true)}>
          <RefreshCw /> Try again
        </Button>
      </div>
    );
  }

  const mode = growthMode(report);
  const t = report.now.totals;
  const steps = growthSteps({ screens: t.screens, flows: report.now.flows.length }, "freeze");
  const subject = (
    <div className="flex h-full items-center justify-center rounded-xl border border-border bg-panel/70 p-6">
      <SubjectBars areas={report.now.areas} />
    </div>
  );
  const nowLine = (
    <p className="text-sm text-fg-2" data-growth-now>
      Today: <span className="font-semibold tabular-nums text-fg">{pctWords(t.pct)}</span> of {t.screens} {t.screens === 1 ? "screen" : "screens"} covered, {t.by_your_tests} by your tests and {t.by_orcha} by Embodent
      {t.at_risk ? <span className={styles.risk}>, {t.at_risk} at risk</span> : null}.
    </p>
  );

  if (mode === "no_map") {
    return (
      <GrowthTeach
        kind="no_map"
        freshDays={report.fresh_days}
        actions={
          <Button variant="primary" size="lg" onClick={onMapApp} data-growth-map>
            <MapIcon /> Map the app
          </Button>
        }
      />
    );
  }
  if (mode === "no_baseline" || (shutter && !shutter.again)) {
    if (shutter) return <BaselineShutter phase={shutter.phase} again={false} steps={steps} snapshot={shutter.snap}>{subject}</BaselineShutter>;
    return (
      <GrowthTeach
        kind="no_baseline"
        freshDays={report.fresh_days}
        now={nowLine}
        actions={
          <HumanGate>
            <Button variant="primary" size="lg" disabled={!auth.can} onClick={() => void takeBaseline(false)} data-growth-take>
              <Target /> Take the baseline now
            </Button>
          </HumanGate>
        }
      />
    );
  }

  const g = report.growth!;
  const atRisk = report.now.screens.filter((s) => s.state === "at_risk");
  const unknownAreas = report.now.areas.filter((a) => a.evidence === "unknown");
  const unknownScreens = report.now.screens.filter((s) => s.state === "unknown");

  return (
    <div className="flex flex-col gap-4" data-growth-view>
      {shutter ? (
        <BaselineShutter phase={shutter.phase} again steps={steps} snapshot={shutter.snap}>
          {subject}
        </BaselineShutter>
      ) : (
        <GrowthHero
          key={report.baseline?.id}
          report={report}
          now={now}
          measuring={measuring}
          landed={landed}
          rebaseOpen={rebase}
          onMeasure={() => void measureAgain()}
          onRebaseline={() => setRebase((v) => !v)}
        />
      )}

      {rebase && !shutter ? (
        <form
          className="v-rise rounded-xl border border-border bg-panel p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void takeBaseline(true);
          }}
          data-growth-rebaseline-form
        >
          <label htmlFor="growth-reason" className="text-sm font-medium text-fg">
            Why re-baseline?
          </label>
          <p className="mb-2 text-xs text-muted">For a big change, such as a rewrite or a new app. Coverage is frozen again as it is now and growth counts from today; the {shortDate(report.baseline?.taken_at)} baseline stays in the history below.</p>
          <textarea
            id="growth-reason"
            className="min-h-16 w-full rounded-md border border-border-strong bg-transparent px-2.5 py-1.5 text-sm text-fg placeholder:text-muted"
            placeholder="The checkout was rewritten in October"
            value={reason}
            maxLength={300}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="mt-2 flex gap-2">
            <Button type="submit" variant="primary" disabled={reason.trim().length < 3 || !auth.can} data-growth-rebaseline-submit>
              Freeze a new baseline
            </Button>
            <Button type="button" variant="ghost" onClick={() => setRebase(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      <AddedTiles key={`added-${report.baseline?.id}`} report={report} />
      <AreaChart key={`areas-${report.baseline?.id}`} report={report} />
      <OverTime report={report} />

      {atRisk.length > 0 || unknownAreas.length > 0 || unknownScreens.length > 0 ? (
        <section aria-labelledby="growth-honest" className="rounded-xl border border-border bg-panel p-4" data-growth-honesty>
          <h2 id="growth-honest" className="text-sm font-semibold text-fg">
            Not counted as covered
          </h2>
          <p className="mb-2 text-xs text-muted">Screens reached only by failing, stale, flaky or paused scenarios are at risk; ones whose scenarios never ran are unknown.</p>
          <ul className="flex flex-col gap-1.5">
            {atRisk.slice(0, 8).map((s) => (
              <li key={s.id} className="flex items-start gap-2 text-sm" data-growth-risk={s.id}>
                <AlertTriangle className={cn("mt-0.5 size-4 shrink-0", styles.risk)} aria-hidden />
                <span>
                  <span className="font-medium text-fg">{s.name}</span> <span className={styles.risk}>at risk</span>
                  <span className="text-fg-2">: {s.reason}</span>
                </span>
              </li>
            ))}
            {unknownScreens.slice(0, 4).map((s) => (
              <li key={s.id} className="flex items-start gap-2 text-sm" data-growth-unknown={s.id}>
                <CircleHelp className={cn("mt-0.5 size-4 shrink-0", styles.unknown)} aria-hidden />
                <span>
                  <span className="font-medium text-fg">{s.name}</span> <span className="text-muted">unknown</span>
                  <span className="text-fg-2">: {s.reason}</span>
                </span>
              </li>
            ))}
            {unknownAreas.length > 0 ? (
              <li className="flex items-start gap-2 text-sm">
                <CircleHelp className={cn("mt-0.5 size-4 shrink-0", styles.unknown)} aria-hidden />
                <span className="text-fg-2">Evidence unknown for {unknownAreas.map((a) => a.name).join(", ")}: no screen there is mapped or measured yet.</span>
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}

      <VariationsPanel
        variations={report.variations}
        flows={report.now.flows}
        busy={busy}
        grew={grew}
        onSuggest={(id) => void variations({ action: "suggest", scenario: id }, id, () => "Suggested rows are below, waiting for your approval")}
        onApply={(ids) => {
          const group = report.variations.pending.find((p) => p.rows.some((r) => r.id === ids[0]));
          return variations({ action: "apply", ids }, group?.scenario_id ?? "apply", (j) => `Added ${String(j.added ?? ids.length)} rows to ${String(j.scenario_name ?? "the scenario")}`);
        }}
        onDismiss={(ids) => {
          const group = report.variations.pending.find((p) => p.rows.some((r) => r.id === ids[0]));
          void variations({ action: "dismiss", ids }, group?.scenario_id ?? "dismiss", () => "Dismissed");
        }}
      />

      <section aria-labelledby="growth-history" className="rounded-xl border border-border bg-panel p-4" data-growth-history>
        <h2 id="growth-history" className="mb-3 text-sm font-semibold text-fg">
          Baselines
        </h2>
        <ol className="relative flex flex-col gap-3 pl-5 before:absolute before:bottom-1.5 before:left-[5px] before:top-1.5 before:w-px before:bg-border">
          {report.history.map((b, i) => (
            <li key={b.id} className={cn("relative", b.id === freshBaseline && "v-rise")} style={{ "--i": i } as CSSProperties} data-growth-baseline={b.id}>
              <span
                aria-hidden
                className={cn(
                  "absolute -left-5 top-1 size-[11px] rounded-full border-2",
                  b.superseded_at ? "border-border-strong bg-panel" : "border-[var(--g-orcha)] bg-[var(--g-orcha)] shadow-[0_0_0_3px_color-mix(in_oklab,var(--g-orcha)_18%,transparent)]",
                )}
              />
              <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className={cn("tabular-nums", b.superseded_at ? "text-fg-2" : "font-semibold text-fg")}>{longDate(b.taken_at, now)}</span>
                <span className="text-fg-2">{TRIGGER_WORDS[b.trigger]}</span>
                {b.superseded_at ? <span className="text-xs text-muted">replaced {shortDate(b.superseded_at)}</span> : <span className={cn(styles.pill, styles.pillUp, "px-2 py-0 text-2xs")}>current</span>}
              </p>
              {b.reason || b.app_build ? (
                <p className="mt-0.5 text-xs text-muted">
                  {b.reason ? <span className="text-fg-2">“{b.reason}”</span> : null}
                  {b.reason && b.app_build ? " · " : null}
                  {b.app_build ? `build ${b.app_build}` : null}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
        <p className="mt-3 text-xs text-muted">Growth counts from the current baseline: {g.overall.before.pct === null ? "evidence unknown" : `${g.overall.before.pct}%`} of {g.overall.before.screens} screens on {shortDate(report.baseline?.taken_at)}.</p>
      </section>
    </div>
  );
}
