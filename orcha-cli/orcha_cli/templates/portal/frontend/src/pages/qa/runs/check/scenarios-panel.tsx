import { useEffect, useMemo, useRef, useState } from "react";
import type { QaAuthority } from "../../authority";
import type { CriterionPin } from "../replay/replay";
import {
  actionToStepSeq,
  frameIndexAtOrBefore,
  reproSteps,
} from "../replay/model";
import type { Frame } from "../replay/model";
import type {
  CriterionFeedback,
  Evidence,
  Finding,
  RunStatus,
  Scenario,
  ScenarioResult,
  Step,
  TargetKind,
} from "../types";
import { fmtMs } from "../../map/kit";
import { parseCriteria, scenarioVerdict } from "../lib/verdict";
import { MiniChip } from "../parts/mini-chip";
import { CriterionCard } from "./criterion-card";
import { RerunCriterionButton } from "./rerun-criterion-button";
import { ScenarioRail, type ScenarioRailItem } from "./scenario-rail";
import { ScenarioRename } from "./scenario-rename";
import { VerdictIcon } from "./verdict-icon";

export interface ScenariosPanelProps {
  runId: string;
  runStatus: RunStatus;
  scenarios: readonly Scenario[];
  results: readonly ScenarioResult[];
  steps: readonly Step[];
  evidence: readonly Evidence[];
  findings: readonly Finding[];
  feedback: readonly CriterionFeedback[];
  actionSeqs: readonly number[];
  /** The run's platform, not the scenario's: a scenario can run on several. */
  kind: TargetKind;
  auth: QaAuthority;
  onRerun: () => void;
  /** Deep-linked scenario id from `?scenario=`: selected first and scrolled into view once. */
  initialScenarioId: string | null;
  /** The run's capture size, so evidence thumbnails take the run's own shape. */
  screenW?: number | null;
  screenH?: number | null;
  /** Ticking elapsed ms while `runStatus === "running"` (from `useElapsedMs`); null otherwise. */
  elapsedMs: number | null;
  onSeekToAction: (actionNumber: number) => void;
  onSeekToStepSeq: (seq: number) => void;
  onCriterionPinsChange?: (pins: readonly CriterionPin[]) => void;
}

/**
 * The Scenarios tab body: left rail (grouped by verdict), middle scenario
 * detail with per-criterion cards, right replay is rendered by the caller
 * (spec §3 scope extension — MiniTest-style per-story report).
 */
export function ScenariosPanel({
  runId,
  runStatus,
  scenarios,
  results,
  steps,
  evidence,
  findings,
  feedback,
  actionSeqs,
  kind,
  auth,
  onRerun,
  initialScenarioId,
  elapsedMs,
  screenW = null,
  screenH = null,
  onSeekToAction,
  onSeekToStepSeq,
  onCriterionPinsChange,
}: ScenariosPanelProps) {
  const scenarioById = useMemo(() => new Map(scenarios.map((s) => [s.id, s])), [scenarios]);
  const resultByScenario = useMemo(
    () => new Map(results.map((r) => [r.scenario_id, r])),
    [results],
  );
  const evidenceBySeq = useMemo(
    () => new Map(evidence.map((e) => [e.seq, e])),
    [evidence],
  );
  const findingBySeq = useMemo(
    () => new Map(findings.map((f) => [f.seq, f])),
    [findings],
  );
  const stepsBySeq = useMemo(
    () => new Map(steps.map((s) => [s.seq, s])),
    [steps],
  );
  const latestFeedback = useMemo(() => {
    const m = new Map<string, CriterionFeedback>();
    for (const f of feedback) m.set(`${f.scenario_id}:${f.criterion_index}`, f);
    return m;
  }, [feedback]);

  const rows: ScenarioRailItem[] = useMemo(
    () =>
      results.map((r) => {
        const scenario = scenarioById.get(r.scenario_id);
        const criteria = parseCriteria(r.criteria);
        const v = scenarioVerdict(criteria, r.outcome);
        return {
          scenarioId: r.scenario_id,
          name: scenario?.name ?? r.scenario_id,
          targetKind: scenario?.target_kind ?? null,
          verdict: v.verdict,
          passed: v.passed,
          total: v.total,
        };
      }),
    [results, scenarioById],
  );

  // `null` = "no pick in the list yet"; the effective selection below falls
  // back to the deep link then the first row, so we never need an effect to
  // sync selection state (that pattern trips react-hooks/set-state-in-effect).
  const [explicitSelection, setExplicitSelection] = useState<string | null>(
    null,
  );
  const cardRef = useRef<HTMLDivElement>(null);
  const scrolledInitial = useRef(false);

  // A pick in the list wins, then the `?scenario=` deep link, then the first result.
  const selectedId = useMemo(() => {
    if (
      explicitSelection &&
      rows.some((r) => r.scenarioId === explicitSelection)
    ) {
      return explicitSelection;
    }
    if (
      initialScenarioId &&
      rows.some((r) => r.scenarioId === initialScenarioId)
    ) {
      return initialScenarioId;
    }
    return rows[0]?.scenarioId ?? null;
  }, [explicitSelection, initialScenarioId, rows]);

  // A pick also rewrites `?scenario=` in place, so a copied link or a reload opens the same
  // card. replaceState, not a navigation: the run page is already showing everything. The state
  // is `null`, not `window.history.state`: Next's patched replaceState only syncs a URL into the
  // router when the state lacks its own `__NA` marker, and an unsynced URL is put back the next
  // time the router commits (a `router.refresh()`, e.g. the first visit's time-zone sync).
  const selectScenario = (id: string) => {
    setExplicitSelection(id);
    const url = new URL(window.location.href);
    url.searchParams.set("scenario", id);
    window.history.replaceState(window.history.state, "", url);
    cardRef.current?.scrollTo({ top: 0 });
  };

  // Scroll the deep-linked card into view once, when it first becomes selectable.
  useEffect(() => {
    if (scrolledInitial.current) return;
    if (!initialScenarioId || selectedId !== initialScenarioId) return;
    scrolledInitial.current = true;
    cardRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [initialScenarioId, selectedId]);

  const selectedResult = selectedId
    ? resultByScenario.get(selectedId)
    : undefined;
  const selectedScenario = selectedId
    ? scenarioById.get(selectedId)
    : undefined;
  const criteria = useMemo(
    () => (selectedResult ? parseCriteria(selectedResult.criteria) : []),
    [selectedResult],
  );
  const verdict = useMemo(
    () => scenarioVerdict(criteria, selectedResult?.outcome),
    [criteria, selectedResult],
  );

  // Criterion markers for the replay timeline, across ALL scenarios (coloured by outcome).
  useEffect(() => {
    if (!onCriterionPinsChange) return;
    const pins: CriterionPin[] = [];
    for (const r of results) {
      for (const c of parseCriteria(r.criteria)) {
        if (c.to_step == null || c.outcome == null) continue;
        const seq = actionToStepSeq(actionSeqs, c.to_step);
        if (seq == null) continue;
        const frames: Frame[] = steps
          .filter((s) => s.frame_path)
          .map((s) => ({
            path: s.frame_path as string,
            seq: s.seq,
            atMs: s.at_ms,
            label: "",
          }));
        const frameIndex = frameIndexAtOrBefore(frames, seq);
        pins.push({
          frameIndex,
          outcome: c.outcome,
          label: displayLabel(c.text),
        });
      }
    }
    onCriterionPinsChange(pins);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recompute only when results/steps change
  }, [results, steps, actionSeqs]);

  if (rows.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center gap-3 py-6">
        <p className="text-center text-sm text-muted">No scenario results for this run.</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 max-md:flex-none max-md:flex-col">
      {/* A run with several scenario results gets a navigator beside the card (#158); with a
          single one it would only repeat the card's heading, so the card takes the width. A
          fan-out batch runs one scenario per run and navigates with the batch bar instead.
          Scenarios that passed in an earlier run of this batch are listed below the header. */}
      {rows.length > 1 ? (
        <ScenarioRail
          items={rows}
          selectedId={selectedId}
          onSelect={selectScenario}
        />
      ) : null}
      <div
        ref={cardRef}
        className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto px-4.5 py-4 max-md:overflow-visible max-md:px-4"
      >
        {selectedResult && selectedScenario ? (
          <>
            <header className="flex flex-col gap-2.5 border-b border-border pb-4">
              <div className="flex items-start gap-2">
                <VerdictIcon verdict={verdict.verdict} className="mt-[7px]" />
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                  <ScenarioRename
                    scenarioId={selectedScenario.id}
                    name={selectedScenario.name}
                    actor={auth.can ? (auth.human?.id ?? null) : null}
                    className="-ml-1"
                  />
                  {selectedScenario.category ? (
                    <MiniChip>{selectedScenario.category}</MiniChip>
                  ) : null}
                </div>
                <RerunCriterionButton
                  scenarioId={selectedScenario.id}
                  onRerun={onRerun}
                  disabled={!auth.can}
                />
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                <span data-scenario-progress>
                  {/* A scenario that stopped for setup checked nothing: not "0 of 4 passed" (#280). */}
                  {verdict.verdict === "needs_setup" && verdict.passed === 0 ? "Not checked: needs setup" : `${verdict.passed} of ${verdict.total} passed`}
                </span>
                {verdict.notReported > 0 ? (
                  <span data-scenario-not-reported className="text-fg-2">
                    {verdict.notReported} not reported
                  </span>
                ) : null}
                {verdict.disputed > 0 ? (
                  // #234: passes only the agent's word proves while the judge scored them unmet.
                  <span data-scenario-disputed className="text-fg-2" title="Passed on the agent's judgement alone while the independent judge scored the criterion unmet: review them.">
                    {verdict.disputed} {verdict.disputed === 1 ? "pass" : "passes"} the judge disputes
                  </span>
                ) : null}
                {runStatus === "running" ? (
                  <MiniChip glyph="running">
                    {/* Server and client each start the clock from Date.now(): a one-second
                        difference at hydration is expected and the next tick corrects it. */}
                    <span suppressHydrationWarning>elapsed {fmtMs(elapsedMs ?? lastStepAtMs(steps))}</span>
                  </MiniChip>
                ) : null}
              </div>
              {selectedScenario.description ? (
                <p className="select-text text-sm leading-6 text-fg-2">
                  {selectedScenario.description}
                </p>
              ) : null}
            </header>

            <div className="flex flex-col gap-3">
              {criteria.map((c, i) => {
                const key = `${selectedScenario.id}:${i}`;
                const fb = latestFeedback.get(key);
                const fromSeq = actionToStepSeq(
                  actionSeqs,
                  c.from_step ?? c.to_step,
                );
                const toSeq = actionToStepSeq(
                  actionSeqs,
                  c.to_step ?? c.from_step,
                );
                return (
                  <CriterionCard
                    key={i}
                    index={i}
                    criterion={c}
                    // The run's platform, not the scenario's: a scenario can run on several.
                    kind={kind}
                    auth={auth}
                    screenW={screenW}
                    screenH={screenH}
                    runId={runId}
                    scenarioId={selectedScenario.id}
                    fromMs={
                      fromSeq != null
                        ? (stepsBySeq.get(fromSeq)?.at_ms ?? null)
                        : null
                    }
                    toMs={
                      toSeq != null
                        ? (stepsBySeq.get(toSeq)?.at_ms ?? null)
                        : null
                    }
                    evidence={
                      c.evidence_seq != null
                        ? (evidenceBySeq.get(c.evidence_seq) ?? null)
                        : null
                    }
                    finding={
                      c.finding_seq != null
                        ? (findingBySeq.get(c.finding_seq) ?? null)
                        : null
                    }
                    feedbackStatus={fb?.status ?? null}
                    repro={reproSteps(
                      steps,
                      actionSeqs,
                      c.from_step,
                      c.to_step,
                    )}
                    onSeekToAction={onSeekToAction}
                    onSeekToStepSeq={onSeekToStepSeq}
                  />
                );
              })}
              {criteria.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted">
                  No acceptance criteria recorded.
                </p>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

function displayLabel(text: string): string {
  return text.replace(/\s*\[warning\]\s*$/i, "").trim();
}

/** Fallback when no ticking `elapsedMs` is available yet (e.g. `started_at` unknown). */
function lastStepAtMs(steps: readonly Step[]): number {
  if (steps.length === 0) return 0;
  return Math.max(...steps.map((s) => s.at_ms));
}
