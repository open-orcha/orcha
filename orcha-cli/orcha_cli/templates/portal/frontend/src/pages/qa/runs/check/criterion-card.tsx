import { useEffect, useState } from "react";
import type { QaAuthority } from "../../authority";
import { ChevronDown, ChevronRight } from "../../map/kit/icons";
import { StatusGlyph } from "../../map/kit";
import { Tabs } from "../replay/tabs";
import { CopyFixPromptButton } from "../parts/copy-fix-prompt";
import { EvidenceThumb } from "../parts/evidence-thumb";
import { fmtMs } from "../../map/kit";
import type { Criterion, CriterionFeedbackStatus, Evidence, Finding, TargetKind } from "../types";
import { criterionTitle, displayCriterionText, isEventsCriterion, isWarningCriterion, judgeDisputed } from "../lib/verdict";
import { cn } from "../../map/kit";
import { CriterionFeedbackActions } from "./criterion-feedback-actions";
import { CriterionStateIcon } from "./verdict-icon";
import { TrackingEventsList } from "./tracking-events-list";
import { CriterionJudgeChip } from "../replay/scenario-results";
import { CriterionChecks, ProofChip } from "../replay/criterion-checks";
import { MiniChip } from "../parts/mini-chip";
import { isReplaySource } from "../lib/provenance";
import { humanizeCheckText } from "../lib/humanize-locator";
import { needsSetupLine, type NeedsSetup } from "../lib/needs-setup";

/** The outcome in words, printed next to its glyph (the glyph carries the colour). */
const OUTCOME_LABEL: Record<string, string> = {
  pass: "Passed",
  fail: "Failed",
  warning: "Warning",
  blocked: "Blocked",
  unprocessable: "Unprocessable",
  inconclusive: "Inconclusive",
  needs_setup: "Needs setup",
  running: "Running",
};

type CriterionTab = "expectations" | "fix" | "activity";

/** Why a criterion could not be tested here, and the one fix: not a failure, never an issue. */
function NeedsSetupNote({ setup }: { setup: NeedsSetup | null }) {
  return (
    <div className="rounded-md border border-border px-3 py-2.5" data-criterion-needs-setup={setup?.code ?? ""}>
      <p className="flex items-center gap-1.5 text-sm font-medium text-fg">
        <StatusGlyph status="needs_setup" decorative className="size-3.5" />
        {needsSetupLine(setup)}
      </p>
      {setup?.fix ? <p className="mt-1 text-sm text-fg-2">{setup.fix}</p> : null}
      {setup?.detail ? <p className="mt-1 text-xs text-muted">{setup.detail}</p> : null}
      <p className="mt-1 text-xs text-muted">
        Not a verdict on the app: it was not counted as a failure and filed no issue
        {setup?.judgedOutcome ? ` (the agent had judged it ${setup.judgedOutcome})` : ""}.
      </p>
    </div>
  );
}

function timeRange(fromMs: number | null, toMs: number | null): string | null {
  if (fromMs == null && toMs == null) return null;
  return `${fmtMs(fromMs ?? toMs)} → ${fmtMs(toMs ?? fromMs)}`;
}

export interface CriterionCardProps {
  criterion: Criterion;
  index: number;
  runId: string;
  scenarioId: string;
  /** ms at `from_step`/`to_step`, resolved by the parent via `steps.at_ms`. */
  fromMs: number | null;
  toMs: number | null;
  evidence: Evidence | null;
  finding: Finding | null;
  feedbackStatus: CriterionFeedbackStatus | null;
  auth: QaAuthority;
  repro: ReadonlyArray<{ seq: number; text: string }>;
  /** Seek the replay to this criterion's `to_step` (an action number, not a raw `steps.seq`). */
  onSeekToAction?: (actionNumber: number) => void;
  /** Seek the replay to one resolved `steps.seq` (from a repro row). */
  onSeekToStepSeq?: (seq: number) => void;
  className?: string;
  /** The scenario's target kind, so the evidence thumbnail takes a browser or phone shape. */
  kind?: TargetKind | null;
  screenW?: number | null;
  screenH?: number | null;
}

/** One acceptance-criterion card: header, Expectations/Prompt to fix/Activity tabs, repro footer. */
export function CriterionCard({
  criterion,
  index,
  kind,
  screenW = null,
  screenH = null,
  runId,
  scenarioId,
  fromMs,
  toMs,
  evidence,
  finding,
  feedbackStatus,
  auth,
  repro,
  onSeekToAction,
  onSeekToStepSeq,
  className,
}: CriterionCardProps) {
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState<CriterionTab>("expectations");
  const [reproOpen, setReproOpen] = useState(false);

  const outcome = criterion.outcome ?? "blocked";
  const range = timeRange(fromMs, toMs);
  const warn = isWarningCriterion(criterion.text);
  const events = isEventsCriterion(criterion);
  const disputed = judgeDisputed(criterion);

  return (
    <article
      data-criterion-card={index}
      className={cn("rounded-lg border border-border bg-panel", className)}
    >
      <header className="flex items-start gap-2 px-4 py-3">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="mt-[3px] shrink-0 text-muted hover:text-fg"
          aria-label={open ? "Collapse" : "Expand"}
          aria-expanded={open}
        >
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        <CriterionStateIcon outcome={criterion.outcome} className="mt-[3px]" />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {events ? (
            // A tracking-events verdict spans the whole scenario, not one step: nothing to seek to
            // (each matched row below seeks to its own event instead).
            <span className="select-text text-sm font-medium leading-5 text-fg">{criterionTitle(criterion)}</span>
          ) : (
            <button
              type="button"
              onClick={() => {
                if (criterion.to_step != null) onSeekToAction?.(criterion.to_step);
                setOpen(true);
              }}
              className="select-text text-left text-sm font-medium leading-5 text-fg hover:underline"
              title="Seek replay to this criterion"
            >
              {criterionTitle(criterion)}
            </button>
          )}
          {/* One quiet meta row: outcome in words, how it was proven, the time span. */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            <span
              data-criterion-outcome={criterion.not_reported ? "not-reported" : outcome}
              className={outcome === "pass" ? undefined : "text-fg-2"}
            >
              {criterion.not_reported
                ? "Not reported"
                : outcome === "needs_setup" && criterion.setup
                    ? needsSetupLine(criterion.setup)
                    : OUTCOME_LABEL[outcome] ?? outcome}
            </span>
            {warn ? <MiniChip>non-critical</MiniChip> : null}
            {criterion.proof && (criterion.checks?.length ?? 0) > 0 && !isReplaySource(criterion.source) ? <ProofChip proof={criterion.proof} /> : null}
            {disputed && criterion.judge ? (
              // #234: a pass only the agent's word proves, which the judge scored unmet. Still a
              // pass (the judge never changes an outcome), but never shown as a plain one.
              <MiniChip
                dot="bg-sev-major"
                className="text-fg-2"
                data-judge-disputed
                title="Only the agent's judgement proves this pass (no check ran), and the independent judge scored the criterion unmet. Review the evidence before trusting it."
              >
                Judge disagreed · {criterion.judge.criterion_met.toFixed(2)} · review
              </MiniChip>
            ) : criterion.judge && typeof criterion.judge.agrees === "boolean" ? (
              // A replay's own judge record (same screen, criterion met; no verdict to agree with)
              // is shown by the origin chip, never as a second opinion.
              <CriterionJudgeChip judge={criterion.judge} />
            ) : null}
            {range ? <span className="font-mono tabular">{range}</span> : null}
          </div>
        </div>
      </header>

      {open ? (
        <div className="border-t border-border px-4 pb-4 pt-2">
          <Tabs
            tabs={[
              { key: "expectations" as const, label: "Expectations" },
              // No fix prompt is ever written for a tracking-events verdict.
              ...(events ? [] : [{ key: "fix" as const, label: "Prompt to fix" }]),
              { key: "activity" as const, label: "Activity" },
            ]}
            value={tab}
            onChange={setTab}
            className="mb-4"
          />

          {tab === "expectations" && events ? (
            <TrackingEventsList rows={criterion.events ?? []} onSeekToStepSeq={onSeekToStepSeq} />
          ) : null}

          {tab === "expectations" && !events ? (
            <div className="flex flex-col gap-4">
              {outcome === "needs_setup" ? <NeedsSetupNote setup={criterion.setup ?? null} /> : null}
              {!isReplaySource(criterion.source) && outcome !== "running" ? (
                <div data-criterion-explanation>
                  <div className="mb-1 text-xs text-muted">Explanation</div>
                  {criterion.not_run ? (
                    <p className="text-sm text-muted" data-criterion-not-run>
                      Not checked: the run stopped for setup before it reached this criterion.
                    </p>
                  ) : criterion.not_reported ? (
                    <p className="text-sm text-muted" data-criterion-not-reported>
                      No verdict was given for this criterion: the run ended without one. Never counted as a pass.
                    </p>
                  ) : criterion.explanation ? (
                    <p className="select-text text-sm leading-6 text-fg">{criterion.explanation}</p>
                  ) : (
                    <p className="text-sm text-muted">No explanation recorded.</p>
                  )}
                  {outcome === "inconclusive" && !criterion.not_reported ? (
                    <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted">
                      <StatusGlyph status="inconclusive" decorative className="size-3" />
                      Inconclusive: the screen did not show enough to decide. Never counted as a pass.
                    </p>
                  ) : null}
                  {criterion.evidence_frame != null ? (
                    <button
                      type="button"
                      onClick={() => onSeekToStepSeq?.(criterion.evidence_frame as number)}
                      className="mt-1 text-xs text-accent hover:underline"
                    >
                      Judged from step {criterion.evidence_frame}
                    </button>
                  ) : null}
                </div>
              ) : null}
              {criterion.fingerprint ? (
                <SameFailure fingerprint={criterion.fingerprint} runId={runId} />
              ) : null}
              {/* Expected and actual side by side in one hairline box. */}
              <div
                className="grid grid-cols-1 divide-y divide-border rounded-md border border-border sm:grid-cols-2 sm:divide-x sm:divide-y-0"
                data-criterion-expected-actual
              >
                <div className="min-w-0 px-3 py-2.5">
                  <div className="mb-1 text-xs text-muted">Expected</div>
                  <p className="select-text text-sm text-fg">{criterion.expected || displayCriterionText(criterion.shown_text || criterion.text)}</p>
                </div>
                <div className="min-w-0 px-3 py-2.5">
                  <div className="mb-1 text-xs text-muted">Actual</div>
                  {/* An em-dash here means the run recorded no observation. Until 2026-09-16 that
                      was every passing criterion — a verdict with no evidence behind it. */}
                  <p className="select-text text-sm text-fg">{criterion.actual ? humanizeCheckText(criterion.actual) : "—"}</p>
                  {evidence ? (
                    <div className="mt-2">
                      <EvidenceThumb evidence={evidence} kind={kind} screenW={screenW} screenH={screenH} />
                    </div>
                  ) : null}
                </div>
              </div>
              {(criterion.checks?.length ?? 0) > 0 || criterion.agent_disagreed || (criterion.readback?.length ?? 0) > 0 || (outcome === "pass" && (criterion.suggested_checks?.length ?? 0) > 0) ? (
                <div>
                  <div className="mb-1.5 text-xs text-muted">Checks</div>
                  <CriterionChecks
                    checks={criterion.checks ?? []}
                    agentDisagreed={criterion.agent_disagreed ?? false}
                    judgment={criterion.judgment ?? null}
                    suggested={outcome === "pass" ? (criterion.suggested_checks ?? []) : []}
                    scenarioId={scenarioId}
                    criterionIndex={index}
                    readbacks={criterion.readback ?? []}
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          {tab === "fix" && !events ? (
            finding?.fix_prompt ? (
              <div className="flex flex-col gap-2">
                <pre className="whitespace-pre-wrap rounded-md border border-border bg-panel-2 p-3 font-mono text-xs leading-5 text-fg">
                  {finding.fix_prompt}
                </pre>
                <CopyFixPromptButton text={finding.fix_prompt} variant="default" className="self-start">Copy fix prompt</CopyFixPromptButton>
              </div>
            ) : (
              <p className="text-sm text-muted">No fix prompt for this criterion.</p>
            )
          ) : null}

          {tab === "activity" ? (
            <CriterionFeedbackActions
              auth={auth}
              runId={runId}
              scenarioId={scenarioId}
              criterionIndex={index}
              initialStatus={feedbackStatus}
              criterionText={displayCriterionText(criterion.shown_text || criterion.text)}
            />
          ) : null}

          {repro.length > 0 ? (
            <div className="mt-4 border-t border-border pt-3">
              <button
                type="button"
                onClick={() => setReproOpen((o) => !o)}
                className="flex items-center gap-1.5 text-xs font-medium text-muted hover:text-fg"
                aria-expanded={reproOpen}
              >
                {reproOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                Steps to reproduce ({repro.length} {repro.length === 1 ? "step" : "steps"})
              </button>
              {reproOpen ? (
                <ol className="mt-2 flex select-text flex-col gap-0.5 rounded-md border border-border bg-panel-2 px-2.5 py-1.5 font-mono text-xs leading-5">
                  {repro.map((r, i) => (
                    <li key={r.seq} className="flex min-w-0 gap-2">
                      <span className="w-4 shrink-0 text-right text-muted">{i + 1}.</span>
                      <button
                        type="button"
                        onClick={() => onSeekToStepSeq?.(r.seq)}
                        className="min-w-0 truncate text-left text-fg hover:underline"
                      >
                        {r.text}
                      </button>
                    </li>
                  ))}
                </ol>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}


/** "Failed the same way on N earlier runs": runs before this one, on its platform, whose result carries this failure fingerprint (#232). */
function SameFailure({ fingerprint, runId }: { fingerprint: string; runId: string }) {
  const [state, setState] = useState<{ count: number; last_run_id: string | null } | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`/api/scenario-results/same-failure?fingerprint=${encodeURIComponent(fingerprint)}&run=${encodeURIComponent(runId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && d && typeof d.count === "number") setState(d);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [fingerprint, runId]);
  if (!state || state.count === 0) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted" data-same-failure>
      <StatusGlyph status="warning" decorative className="size-3" />
      Failed the same way on {state.count} earlier run{state.count === 1 ? "" : "s"}
      {state.last_run_id ? (
        <>
          {" "}
          (last:{" "}
          <a href={`/runs/${state.last_run_id}`} className="text-fg underline-offset-2 hover:underline">
            run {state.last_run_id.slice(0, 8)}
          </a>
          )
        </>
      ) : null}
    </p>
  );
}
