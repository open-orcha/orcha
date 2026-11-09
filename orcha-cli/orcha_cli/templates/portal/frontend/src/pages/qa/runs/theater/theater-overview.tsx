import { useMemo } from "react";
import { Crosshair } from "../../map/kit/icons";
import { ScenarioGraph, type GraphScenario } from "../../scenarios/scenario-graph";
import { FailureExplainer } from "../parts/failure-explainer";
import { RunVerdictGlyph } from "../parts/run-list-item";
import { StatusGlyph } from "../../map/kit";
import { MiniChip } from "../parts/mini-chip";
import { actionToStepSeq, buildReplayModel, summarizeStep } from "../replay/model";
import type { RunDetailContext } from "../replay/run-detail";
import { criterionTitle, parseCriteria } from "../lib/verdict";
import { verdictStyle } from "../lib/run-list";
import { fmtMs } from "../../map/kit";
import { criteriaPassedLabel, stepBreakdown, stepBreakdownLine } from "../lib/run-counters";
import { cn } from "../../map/kit";
import type { TheaterData } from "./types";
import motion from "./theater.module.css";

/** What a charter mission's status says, in a word. */
const MISSION_TEXT: Record<string, string> = {
  planned: "Planned",
  active: "Exploring",
  covered: "Covered",
  partial: "Partly covered",
  blocked: "Blocked",
  bug: "Found a bug",
};

/**
 * The theater's Overview tab (#188): the verdict, the cause of a failure in one sentence with
 * the next action (ck-runs' `FailureExplainer`), and the criteria with their evidence: each
 * criterion that names the steps it was judged on jumps the player there. A run of several
 * scenarios keeps its graph (ck-runs' pane); an exploration lists its charter of missions.
 * While the run is live the top says what it is doing now and findings land below it.
 */
export function TheaterOverview({ data, ctx, onRerun }: { data: TheaterData; ctx: RunDetailContext; onRerun: (() => void) | null }) {
  const { header, detail, charter } = data;
  const style = verdictStyle(header.verdict);
  const actionSeqs = useMemo(() => buildReplayModel(ctx.steps, [], []).actionSeqs, [ctx.steps]);
  const lastStep = ctx.steps[ctx.steps.length - 1];
  const results = ctx.scenarioResults;
  const nameById = useMemo(() => new Map(detail.scenarios.map((s) => [s.id, s.name])), [detail.scenarios]);
  // Each scenario's own criteria count: "N of M criteria passed" while verdicts stream (#170).
  const criteriaCountById = useMemo(() => new Map(detail.scenarios.map((s) => [s.id, s.criteria?.length ?? 0])), [detail.scenarios]);
  const graphScenarios: GraphScenario[] = useMemo(() => {
    const outcome = new Map(results.map((r) => [r.scenario_id, r.outcome]));
    return detail.scenarios.map((s) => ({
      id: s.id,
      name: s.name,
      category: s.category,
      status: s.status as GraphScenario["status"],
      criteria: s.criteria,
      depends_on: s.depends_on,
      position: s.position,
      target_kind: s.target_kind ?? null,
      outcome: (outcome.get(s.id) ?? null) as GraphScenario["outcome"],
    }));
  }, [detail.scenarios, results]);
  const exploration = detail.run.mode === "exploratory";

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5 px-2" data-theater-overview>
      <section className="flex flex-col gap-2" aria-label="Verdict">
        <div className="flex items-center gap-2.5">
          {ctx.isLive ? (
            <StatusGlyph status="running" size={20} label="running now" />
          ) : (
            <RunVerdictGlyph verdict={header.verdict} size={20} />
          )}
          <span className={cn("text-lg font-semibold leading-tight", ctx.isLive ? "text-fg" : style.color)} data-overview-verdict>
            {ctx.isLive ? "Running now" : (header.verdictResult ?? style.label.split(":")[0])}
          </span>
        </div>
        {/* "N so far" ticks from the client's clock: the server rendered an earlier second (#250). */}
        <p className="text-sm text-muted" suppressHydrationWarning>
          <span data-overview-steps>{stepBreakdownLine(stepBreakdown(ctx.steps))}</span>
          {" · "}
          {ctx.findings.length} {ctx.findings.length === 1 ? "finding" : "findings"}
          {ctx.elapsedMs != null ? ` · ${fmtMs(ctx.elapsedMs)} so far` : ""}
        </p>
        {ctx.isLive && lastStep ? (
          <button
            type="button"
            onClick={() => ctx.jumpToStepSeq(lastStep.seq)}
            className={cn("flex min-w-0 items-center gap-2 rounded-md border border-border bg-panel px-3 py-2 text-left text-sm hover:bg-hover", motion.fadeIn)}
            key={lastStep.seq}
            data-overview-current-step
          >
            <span className="shrink-0 text-xs text-muted">Now</span>
            <span className="min-w-0 truncate font-mono text-xs text-fg">{summarizeStep(lastStep)}</span>
          </button>
        ) : null}
        {header.failure && !ctx.isLive ? (
          <FailureExplainer failure={header.failure} onRetry={onRerun} className="mt-1" />
        ) : null}
      </section>

      {results.length > 1 && graphScenarios.length > 1 ? (
        <section className="flex flex-col gap-2" aria-label="Scenarios">
          <h3 className="text-xs font-medium text-muted">Scenarios</h3>
          <div className="h-[320px] overflow-hidden rounded-md border border-border">
            <ScenarioGraph scenarios={graphScenarios} editable={false} showMiniMap={false} />
          </div>
        </section>
      ) : null}

      {results.length > 0 ? (
        <section className="flex flex-col gap-3" aria-label="Criteria" data-run-scenario-summary>
          {results.map((r) => {
            const items = parseCriteria(r.criteria);
            const name = r.scenarios?.name ?? nameById.get(r.scenario_id) ?? "Scenario";
            return (
              <div key={r.scenario_id} className="flex flex-col gap-2" data-overview-scenario={r.scenario_id}>
                <div className="flex min-w-0 items-center gap-2">
                  <StatusGlyph status={r.outcome} size={14} />
                  <span className="min-w-0 truncate text-sm font-medium text-fg">{name}</span>
                  {items.length > 0 ? (
                    <span className="shrink-0 text-xs tabular text-muted">
                      {criteriaPassedLabel(items, criteriaCountById.get(r.scenario_id))}
                    </span>
                  ) : null}
                </div>
                {r.reason ? <p className="rounded-md border border-border bg-panel-2 px-3 py-2 text-sm text-fg">{r.reason}</p> : null}
                {items.length > 0 ? (
                  <ol className="flex flex-col gap-px overflow-hidden rounded-md border border-border">
                    {items.map((c, i) => {
                      const seq = actionToStepSeq(actionSeqs, c.from_step ?? c.to_step);
                      return (
                        <li key={i} className="flex items-start gap-2.5 bg-panel px-3 py-2" data-summary-criterion={i}>
                          <StatusGlyph status={c.outcome ?? "pending"} size={14} className="mt-0.5 shrink-0" />
                          <span className="min-w-0 flex-1 text-sm leading-snug text-fg">{criterionTitle(c)}</span>
                          {seq != null ? (
                            <button
                              type="button"
                              onClick={() => ctx.jumpToStepSeq(seq)}
                              className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted hover:bg-hover hover:text-fg"
                              data-criterion-evidence={seq}
                              title="Show the screen this was judged on"
                            >
                              <Crosshair aria-hidden className="size-3" />
                              Step {seq}
                            </button>
                          ) : null}
                        </li>
                      );
                    })}
                  </ol>
                ) : null}
              </div>
            );
          })}
        </section>
      ) : exploration ? (
        <section className="flex flex-col gap-2" aria-label="Missions">
          <h3 className="text-xs font-medium text-muted">
            Exploratory run{charter.length > 0 ? ` · ${charter.length} ${charter.length === 1 ? "mission" : "missions"}` : ""}
          </h3>
          {charter.length > 0 ? (
            <ol className="flex flex-col gap-px overflow-hidden rounded-md border border-border">
              {charter.map((m) => (
                <li key={m.id} className="flex items-start gap-2.5 bg-panel px-3 py-2" data-overview-mission={m.status}>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-fg">{m.title}</span>
                    {m.note ? <span className="block text-xs text-muted">{m.note}</span> : null}
                  </span>
                  <MiniChip size="xs">{MISSION_TEXT[m.status] ?? m.status}</MiniChip>
                  {typeof m.step_seq === "number" ? (
                    <button
                      type="button"
                      onClick={() => ctx.jumpToStepSeq(m.step_seq as number)}
                      className="shrink-0 rounded px-1.5 py-0.5 text-xs text-muted hover:bg-hover hover:text-fg"
                    >
                      Step {m.step_seq}
                    </button>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-muted">It explored without a charter. Steps and Findings show what it covered.</p>
          )}
        </section>
      ) : null}

      <section className="flex flex-col gap-2" aria-label="Findings">
        <h3 className="text-xs font-medium text-muted">Findings</h3>
        {ctx.findings.length === 0 ? (
          <p className="text-sm text-muted" data-overview-no-findings>
            {ctx.isLive ? "None yet. They appear here as the agent reports them." : "No findings in this run."}
          </p>
        ) : (
          <ul className="flex flex-col gap-px overflow-hidden rounded-md border border-border">
            {ctx.findings.map((f) => (
              <li key={f.seq} className={cn("flex items-center gap-2.5 bg-panel px-3 py-2", motion.lineIn)} data-overview-finding={f.seq}>
                <MiniChip size="xs">{f.severity}</MiniChip>
                <button type="button" onClick={() => ctx.setTab("findings")} className="min-w-0 flex-1 truncate text-left text-sm text-fg hover:underline">
                  {f.title}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
