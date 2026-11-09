import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { groupTimeline, resolveTab, type TimelineScenario } from "../theater/theater-model";
import { TimelineGroups } from "../theater/timeline-groups";
import type { CharterItem } from "../../sessions/explorations";
import { RunFinding, type RunFindingRow } from "./run-finding";
import { cn } from "../../map/kit";
import { posterFramePath } from "./media-frame";
import type {
  CriterionFeedback,
  Evidence,
  Finding,
  RunLog,
  RunWithTarget,
  Scenario,
  Step,
  TargetKind,
} from "../types";
import { useElapsedMs, useLiveRun, useStaleMinutes } from "../check/use-live-run";
import { ScenariosPanel } from "../check/scenarios-panel";
import type { QaAuthority } from "../../authority";
import type { Platform, QaFinding } from "../../qaApi";
import { LiveDeviceView } from "../live/LiveDeviceView";
import { ExplorationMap } from "../../sessions/walked/exploration-map";
import type { QaStep } from "../../sessions/api";
import { ResizablePane } from "../parts/resizable-pane";
import {
  actionRangeToStepSeqRange,
  actionToStepSeq,
  buildReplayModel,
  findingReproActions,
  frameIndexAtOrBefore,
  reproSteps,
  summarizeStep,
} from "./model";
import { errorCount, errorCountsByStep, logsInStepRange } from "./logs-model";
import { LogsList } from "./logs-list";
import { ApiRequestsPanel } from "./api-requests-panel";
import { RunPerfPanel } from "../perf/run-perf-panel";
import { Replay, type CriterionPin } from "./replay";
import { withRunTab, type RunTab } from "./run-tabs";
import { ReportView } from "./report-view";
import { RunVideo } from "./run-video";
import type { ScenarioResultRow } from "./scenario-results";
import { StepsList } from "./steps-list";
import { Tabs } from "./tabs";
import { StatusGlyph } from "../../map/kit";
import { runClockStart, stepBreakdown, stepBreakdownLine } from "../lib/run-counters";
import { resolveFormFactor } from "../lib/device-frame";

export interface RunDetailProps {
  run: RunWithTarget;
  kind: TargetKind;
  steps: Step[];
  findings: Finding[];
  evidence: Evidence[];
  logs: readonly RunLog[];
  scenarioResults: ScenarioResultRow[];
  scenarios: Scenario[];
  criterionFeedback: CriterionFeedback[];
  initialTab: RunTab;
  /** The `steps.seq` to open the replay at: the page's `?step=N`, or its `?action=N` mapped to a step (an issue's "Open the replay at action N", #187, #190). */
  initialStep?: number | null;
  /** `?scenario=<id>` deep link: opens the Scenarios tab scrolled to that card. */
  initialScenarioId: string | null;
  /** An exploration's charter of missions: the Steps timeline groups under them (#188). */
  charter?: readonly CharterItem[];
  /** Write the selected tab to the URL (`?tab=`): the run page does, the Runs tab's pane not. */
  syncUrl?: boolean;
  /** The session's stored steps, for the Map tab. */
  mapRows: readonly QaStep[];
  mapFindings: readonly QaFinding[];
  /** The session's platform and device, for its live screen. */
  platform: Platform;
  sessionDevice: string | null;
  auth: QaAuthority;
  onRerun: () => void;
  /** Still running in the database but nothing is running it: no live feed, no clock. */
  abandoned?: boolean;
  /** Filed and dismissed findings: their actions need the stored row. */
  renderFinding?: (row: RunFindingRow) => ReactNode;
  /** The Overview tab's body (the theater builds it); without one there is no Overview tab. */
  renderOverview?: (ctx: RunDetailContext) => ReactNode;
  /** Above the tabs while the run is live: phases, the current step, the last log lines. */
  renderLive?: (ctx: RunDetailContext) => ReactNode;
  /** The run left `running` while this was open: the pane re-reads it (the page refreshes). */
  onSettled?: () => void;
  /** The tab on show changed (the theater keeps it across a reload and hides the header's
   * failure sentence while Overview repeats it). */
  onTabChange?: (tab: RunTab) => void;
}

/** What the theater's Overview and live strip read from the merged, live state of the run. */
export interface RunDetailContext {
  isLive: boolean;
  /** The run clock: from the session's first step (`runClockStart`, #200). */
  elapsedMs: number | null;
  steps: readonly Step[];
  findings: readonly Finding[];
  evidence: readonly Evidence[];
  logs: readonly RunLog[];
  scenarioResults: readonly ScenarioResultRow[];
  jumpToStepSeq: (seq: number) => void;
  setTab: (tab: RunTab) => void;
}

/**
 * Run screen: replay pane + Steps / Findings / Scenarios / Report tabs.
 * The Scenarios tab replaces the replay pane with a 3-column layout (rail +
 * criteria detail + replay) and goes live while the run is `running` (spec
 * §2, §3).
 */
export function RunDetail({
  run,
  kind,
  steps: initialSteps,
  findings,
  evidence,
  logs,
  scenarioResults: initialScenarioResults,
  scenarios,
  criterionFeedback,
  initialTab,
  initialStep = null,
  initialScenarioId,
  abandoned = false,
  mapRows,
  mapFindings,
  platform,
  sessionDevice,
  auth,
  onRerun,
  renderFinding,
  charter = [],
  syncUrl = true,
  renderOverview,
  renderLive,
  onSettled,
  onTabChange,
}: RunDetailProps) {
  // The page polls the run's document, so its rows arrive here as props.
  const { liveSteps, liveResults, isLive, lastActivityAt } = useLiveRun(
    abandoned ? "failed" : run.status,
    initialSteps.length + initialScenarioResults.length,
  );
  const wasLive = useRef(isLive);
  useEffect(() => {
    if (wasLive.current && !isLive) onSettled?.();
    wasLive.current = isLive;
  }, [isLive, onSettled]);
  // Ticks on its own between steps, rather than freezing at the last step's `at_ms`.
  const elapsedMs = useElapsedMs(run.started_at, isLive);
  // "No activity for N min" banner (stall-detection §2): ticks on its own too.
  const staleMinutes = useStaleMinutes(lastActivityAt, isLive);

  // Merge live-streamed steps into the server-rendered list (dedupe by seq; live wins on conflict).
  const steps = useMemo(() => {
    if (liveSteps.length === 0) return initialSteps;
    const bySeq = new Map(initialSteps.map((s) => [s.seq, s]));
    for (const s of liveSteps) bySeq.set(s.seq, s);
    return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  }, [initialSteps, liveSteps]);
  // The run clock the page shows (the running band, Overview, Scenarios): from the session's
  // first step, as the run header and the Live wall count it (#200). `elapsedMs` above stays the
  // replay's position, which is measured from the run's start like the steps' `at_ms`.
  const clockMs = useElapsedMs(runClockStart(run.started_at, steps[0]?.at_ms), isLive);

  // Merge live scenario_results updates into the joined rows the server sent.
  const scenarioResults = useMemo(() => {
    if (liveResults.size === 0) return initialScenarioResults;
    const byId = new Map(initialScenarioResults.map((r) => [r.scenario_id, r]));
    for (const [id, r] of liveResults) {
      const existing = byId.get(id);
      byId.set(id, { ...r, scenarios: existing?.scenarios ?? null });
    }
    return [...byId.values()];
  }, [initialScenarioResults, liveResults]);

  // Step seq -> when it happened: the Logs tab's time for an older row written without one.
  const stepAtMs = useMemo(() => new Map(steps.map((s) => [s.seq, s.at_ms])), [steps]);

  const model = useMemo(
    () => buildReplayModel(steps, evidence, findings),
    [steps, evidence, findings],
  );
  const { frames, pins, legacy, actionSeqs } = model;

  // The Steps timeline's groups: scenario and criterion windows, or the charter's missions.
  const timeline = useMemo(() => {
    const nameById = new Map(scenarios.map((s) => [s.id, s.name]));
    const timelineScenarios: TimelineScenario[] = scenarioResults.map((r) => ({
      scenario_id: r.scenario_id,
      name: r.scenarios?.name ?? nameById.get(r.scenario_id) ?? "Scenario",
      outcome: r.outcome,
      criteria: r.criteria,
    }));
    return groupTimeline({ steps, actionSeqs, scenarios: timelineScenarios, charter });
  }, [steps, actionSeqs, scenarioResults, scenarios, charter]);

  const [index, setIndex] = useState(() =>
    initialStep != null && !legacy && frames.length > 0 ? frameIndexAtOrBefore(frames, initialStep) : 0,
  );
  // Highlighted step row: the current frame's step, or a clicked frameless step.
  const [selectedSeq, setSelectedSeq] = useState<number | null>(
    initialStep ?? frames[0]?.seq ?? null,
  );
  // The player's two modes: step by step, or the frames played through at their real times.
  const [requestedTab, setTabState] = useState<RunTab>(initialTab === "video" ? "steps" : initialTab);
  const [playerMode, setPlayerMode] = useState<"frames" | "video">(initialTab === "video" ? "video" : "frames");
  const [criterionPins, setCriterionPins] = useState<readonly CriterionPin[]>(
    [],
  );

  const setTab = useCallback(
    (next: RunTab) => {
      setTabState(next);
      // `null` state, so Next's router learns the URL and a later refresh keeps it (see
      // ScenariosPanel's selectScenario).
      if (syncUrl) window.history.replaceState(window.history.state, "", withRunTab(window.location.href, next));
    },
    [syncUrl],
  );

  const onIndexChange = useCallback(
    (i: number) => {
      const clamped = Math.min(Math.max(0, i), Math.max(0, frames.length - 1));
      setIndex(clamped);
      if (!legacy) setSelectedSeq(frames[clamped]?.seq ?? null);
    },
    [frames, legacy],
  );

  const jumpToStepSeq = useCallback(
    (seq: number) => {
      if (!legacy && frames.length > 0)
        setIndex(frameIndexAtOrBefore(frames, seq));
      setSelectedSeq(seq);
    },
    [frames, legacy],
  );

  const jumpToAction = useCallback(
    (n: number) => {
      const seq = actionToStepSeq(actionSeqs, n);
      if (seq != null) jumpToStepSeq(seq);
    },
    [actionSeqs, jumpToStepSeq],
  );

  // Two-way log/step correlation (runtime-logs spec §5): a step's red count badge and a
  // finding's "Logs during this" section both key off step_seq -> error logs.
  const errorLogCountsByStep = useMemo(() => errorCountsByStep(logs), [logs]);
  const logErrorCount = useMemo(() => errorCount(logs), [logs]);

  const jumpToLog = useCallback(
    (log: RunLog) => {
      if (log.step_seq != null) jumpToStepSeq(log.step_seq);
    },
    [jumpToStepSeq],
  );

  const currentFrame = frames[Math.min(index, Math.max(0, frames.length - 1))];
  const currentStep = currentFrame
    ? steps.find((s) => s.seq === currentFrame.seq)
    : undefined;

  const liveFramePath = [...steps].reverse().find((s) => s.frame_path)?.frame_path ?? null;
  const liveAtMs = elapsedMs ?? steps[steps.length - 1]?.at_ms ?? 0;
  // An exploration has no scenarios by design: no Scenarios tab, unless it somehow has results.
  const hasScenarioContent = scenarioResults.length > 0;
  const offerScenarios = hasScenarioContent || run.mode !== "exploratory";
  const tabs = [
    // The verdict, its cause and the criteria first (#188): the theater's opening tab in the pane.
    ...(renderOverview ? [{ key: "overview" as const, label: "Overview" }] : []),
    ...(offerScenarios ? [{ key: "scenarios" as const, label: "Scenarios", count: scenarioResults.length }] : []),
    // Every step, screen reads included: the header's "actions" and the replay's frames are parts of it.
    { key: "steps" as const, label: "Steps", count: steps.length, title: stepBreakdownLine(stepBreakdown(steps)) },
    { key: "findings" as const, label: "Findings", count: findings.length },
    {
      key: "logs" as const,
      label: (
        <span className="inline-flex items-center">
          Logs
          <span className="ml-1.5 font-normal tabular text-muted">{logs.length}</span>
          {logErrorCount > 0 ? (
            // Colour lives in the glyph: a fail glyph and the error count, no tinted pill.
            <span
              data-logs-tab-error-badge
              title={`${logErrorCount} error log${logErrorCount === 1 ? "" : "s"}`}
              className="ml-2 inline-flex items-center gap-1 font-normal tabular text-muted"
            >
              <StatusGlyph status="fail" decorative className="size-3" />
              {logErrorCount}
            </span>
          ) : null}
        </span>
      ),
    },
    // Every fetch/XHR the app sent and the request checks (`run_api_requests`, migration 066).
    { key: "api" as const, label: "API" },
    // Each screen's timing against its usual, from the session's timed steps.
    { key: "performance" as const, label: "Performance" },
    { key: "report" as const, label: "Report" },
    // The exploration map: the screens the agent reached as a tree. Needs recorded frames.
    ...(!legacy && frames.length > 1 ? [{ key: "map" as const, label: "Map" }] : []),
  ];

  // The Scenarios tab swaps the layout deliberately: the scenario graph needs the width, so it
  // takes the main area and the device preview moves to a right-hand pane.
  //
  // That only makes sense when there are scenarios. An exploratory run has none by design, so
  // the panel collapsed to a single line of text while still claiming the whole main area —
  // a wall of empty space with the phone shoved against the right edge. Fall back to the
  // standard layout in that case, which puts the preview back on the left where every other
  // tab has it.
  const tab = resolveTab(requestedTab, tabs.map((t) => t.key));
  useEffect(() => {
    onTabChange?.(tab);
  }, [tab, onTabChange]);
  const ctx: RunDetailContext = {
    isLive,
    elapsedMs: clockMs,
    steps,
    findings,
    evidence,
    logs,
    scenarioResults,
    jumpToStepSeq,
    setTab,
  };
  const liveBand = isLive && renderLive ? renderLive(ctx) : null;
  // After the run, the player offers its recording beside the frame replay (#188).
  // The browser frame's address bar: the live step's page while running, else the target URL.
  const pageAddress = (isLive ? [...steps].reverse().find((s) => s.foreground)?.foreground : null) ?? run.targets?.locator ?? null;
  const posterPath = posterFramePath(frames);
  const canVideo = !isLive && frames.length > 1 && !legacy;
  const liveView = (
    <div className="flex min-w-0 flex-1 flex-col items-center gap-3 overflow-y-auto bg-panel-2 p-4.5" data-replay-mode="live">
      <LiveDeviceView
        sessionId={run.id}
        platform={platform}
        deviceName={sessionDevice}
        status={isLive ? "running" : run.status}
        fallbackFrameId={liveFramePath}
        address={pageAddress}
        auth={auth}
        onEnded={onSettled}
      />
    </div>
  );
  const playerWith = (replay: ReactNode): ReactNode =>
    isLive ? liveView : canVideo ? (
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto" data-player-modes={playerMode}>
        <div className="flex justify-center px-4 pt-3" role="group" aria-label="Player">
          <div className="inline-flex rounded-md border border-border p-0.5 text-xs">
            {(["frames", "video"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={playerMode === m}
                onClick={() => setPlayerMode(m)}
                data-player-mode={m}
                className={cn(
                  "rounded px-2.5 py-1 transition-colors",
                  playerMode === m ? "bg-selected text-fg" : "text-muted hover:text-fg",
                )}
              >
                {m === "frames" ? "Steps" : "Video"}
              </button>
            ))}
          </div>
        </div>
        {playerMode === "video" ? (
          <div className="p-4">
            <RunVideo
              frames={frames}
              posterPath={posterPath}
              address={pageAddress}
              kind={kind}
              deviceName={run.device_name}
              device={run.device}
              screenW={run.screen_w}
              screenH={run.screen_h}
            />
          </div>
        ) : (
          replay
        )}
      </div>
    ) : (
      replay
    );
  const tabBar = (
    <>
      {liveBand}
      <div className="px-4.5 pt-3 max-md:px-4">
        <Tabs tabs={tabs} value={tab} onChange={setTab} />
      </div>
    </>
  );
  // An iPad / Android tablet run gets a wider preview pane: its frame is near-square.
  const previewTablet =
    (kind === "ios" || kind === "android") &&
    resolveFormFactor({ deviceName: run.device_name, device: run.device, screenW: run.screen_w, screenH: run.screen_h }) ===
      "tablet";

  // The map takes the whole area: it is a canvas, and the screenshots are the content.
  if (tab === "map" && !legacy && frames.length > 1) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {tabBar}
        <ExplorationMap
          steps={mapRows}
          findings={mapFindings}
          kind={kind}
        />
      </div>
    );
  }

  if (tab === "scenarios" && hasScenarioContent) {
    return (
      <div className="flex min-h-0 flex-1 flex-col max-md:overflow-y-auto">
        {tabBar}
        {/* Below md the panes stack: criteria first, then the device preview, one page scroll. */}
        <div className="flex min-h-0 flex-1 max-md:flex-none max-md:flex-col">
          <ScenariosPanel
            runId={run.id}
            runStatus={isLive ? "running" : run.status}
            screenW={run.screen_w}
            screenH={run.screen_h}
            scenarios={scenarios}
            results={scenarioResults}
            steps={steps}
            evidence={evidence}
            findings={findings}
            feedback={criterionFeedback}
            actionSeqs={actionSeqs}
            kind={kind}
            auth={auth}
            onRerun={onRerun}
            initialScenarioId={initialScenarioId}
            elapsedMs={clockMs}
            onSeekToAction={jumpToAction}
            onSeekToStepSeq={jumpToStepSeq}
            onCriterionPinsChange={setCriterionPins}
          />
          <ResizablePane
            id={`run-preview-${previewPaneKind(kind, previewTablet)}`}
            side="right"
            defaultWidth={previewPaneWidth(kind, previewTablet)}
            minWidth={260}
            maxWidth={1400}
            className="border-l border-border max-md:w-full! max-md:border-l-0 max-md:border-t"
          >
            {playerWith(<Replay
              address={pageAddress}
              frames={frames}
              pins={pins}
              criterionPins={criterionPins}
              index={index}
              onIndexChange={onIndexChange}
              kind={kind}
              screenW={run.screen_w}
              screenH={run.screen_h}
              deviceName={run.device_name}
              device={run.device}
              legacy={legacy}
              placeholderText={
                currentStep ? summarizeStep(currentStep) : undefined
              }
              live={
                isLive
                  ? {
                      framePath: liveFramePath,
                      atMs: liveAtMs,
                      stepCount: steps.length,
                      staleMinutes,
                    }
                  : undefined
              }
              className="min-w-0 flex-1 overflow-y-auto"
            />)}
          </ResizablePane>
        </div>
      </div>
    );
  }

  return (
    // Same frame as the Scenarios tab on every tab: the tab bar across the top, the tab body
    // on the left and the device on the right (one resizable pane, so its width carries over
    // between tabs). Below md they stack: the tab body first, then the device.
    <div className="flex min-h-0 flex-1 flex-col max-md:overflow-y-auto">
      {tabBar}
      <div className="flex min-h-0 flex-1 max-md:flex-none max-md:flex-col">
      <section className="flex min-w-0 flex-1 flex-col px-4.5 max-md:flex-none max-md:px-4">
        <div
          key={tab}
          className="v-panel min-h-0 flex-1 overflow-y-auto py-4 max-md:overflow-visible"
          data-tab-panel={tab}
        >
          {tab === "overview" && renderOverview ? renderOverview(ctx) : null}
          {tab === "steps" ? (
            <>
              {timeline ? (
                // Grouped by scenario and criterion, or by charter mission (#188).
                <TimelineGroups
                  groups={timeline}
                      currentSeq={selectedSeq}
                  onSelect={(s) => jumpToStepSeq(s.seq)}
                  errorLogCounts={errorLogCountsByStep}
                  live={isLive}
                />
              ) : (
                <StepsList
                  steps={steps}
                      currentSeq={selectedSeq}
                  onSelect={(s) => jumpToStepSeq(s.seq)}
                  errorLogCounts={errorLogCountsByStep}
                  live={isLive}
                />
              )}
            </>
          ) : null}
          {/* Reached only when the run has no scenarios (an exploratory run): the wide
              graph layout above is skipped, so say so here rather than render an empty pane. */}
          {tab === "scenarios" ? (
            <p className="py-6 text-center text-sm text-muted">
              {run.mode === "exploratory"
                ? "This was an exploratory run, so it has no scenarios. See Steps and Findings for what it covered."
                : "No scenario results for this run."}
            </p>
          ) : null}
          {tab === "findings" ? (
            findings.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted">
                No findings in this run.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {findings.map((f) => {
                  const repro = findingReproActions(steps, actionSeqs, evidence, f);
                  const range = actionRangeToStepSeqRange(actionSeqs, repro.from, repro.to);
                  const row: RunFindingRow = {
                    finding: f,
                    repro: reproSteps(steps, actionSeqs, repro.from, repro.to),
                    logs: range ? logsInStepRange(logs.filter((l) => l.level === "error"), range[0], range[1]) : [],
                    onJumpToStep: legacy
                      ? undefined
                      : (seq: number) => {
                          jumpToStepSeq(seq);
                          setTab("steps");
                        },
                  };
                  return renderFinding ? <Fragment key={f.seq}>{renderFinding(row)}</Fragment> : <RunFinding key={f.seq} {...row} />;
                })}
              </div>
            )
          ) : null}
          {tab === "report" ? (
            <ReportView
              markdown={run.report_md}
              status={isLive ? "running" : run.status}
            />
          ) : null}
          {tab === "logs" ? (
            <LogsList
              logs={logs}
              currentSeq={selectedSeq}
              onSelectLog={jumpToLog}
              stepAtMs={stepAtMs}
              live={isLive}
              className="h-full"
            />
          ) : null}
          {tab === "api" ? <ApiRequestsPanel runId={run.id} className="h-full" live={isLive} /> : null}
          {tab === "performance" ? <RunPerfPanel runId={run.id} className="h-full" live={isLive} /> : null}
        </div>
      </section>
        <ResizablePane
          id={`run-preview-${previewPaneKind(kind, previewTablet)}`}
          side="right"
          defaultWidth={previewPaneWidth(kind, previewTablet)}
          minWidth={260}
          maxWidth={1400}
          className="border-l border-border max-md:w-full! max-md:border-l-0 max-md:border-t"
        >
          {playerWith(<Replay
              address={pageAddress}
            frames={frames}
            pins={pins}
            index={index}
            onIndexChange={onIndexChange}
            kind={kind}
            screenW={run.screen_w}
            screenH={run.screen_h}
            deviceName={run.device_name}
            device={run.device}
            legacy={legacy}
            placeholderText={currentStep ? summarizeStep(currentStep) : undefined}
            live={
              isLive
                ? {
                    framePath: liveFramePath,
                    atMs: liveAtMs,
                    stepCount: steps.length,
                    staleMinutes,
                  }
                : undefined
            }
            className="min-w-0 flex-1 overflow-y-auto"
          />)}
        </ResizablePane>
      </div>
    </div>
  );
}

/** The preview pane's shape, remembered per shape: a browser and a desktop window are wide,
 * a phone narrow. */
/** The preview pane's shape, which also keys its remembered width: a tablet gets its own key so
 * widening the pane for an iPad run never leaves phone runs in a too-wide column (or the reverse). */
function previewPaneKind(kind: TargetKind, tablet = false): "web" | "desktop" | "phone" | "tablet" {
  if (kind === "web") return "web";
  if (kind === "desktop") return "desktop";
  return tablet ? "tablet" : "phone";
}

function previewPaneWidth(kind: TargetKind, tablet = false): number {
  if (kind === "web") return 520;
  if (kind === "desktop") return 600;
  return tablet ? 560 : 360;
}
