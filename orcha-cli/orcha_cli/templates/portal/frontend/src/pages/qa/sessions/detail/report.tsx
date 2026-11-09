import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowUpRight, Bug, ChevronRight, Compass, FileText, Footprints, Layers, ListPlus, Maximize2, Wrench } from "../../map/kit/icons";
import { WorkOutputs, WorkSection, WorkSummary, type WorkOutput, type WorkTile } from "../work/work-done";
import { ScoreRing } from "../score-ring";
import { Tooltip } from "../../../../components/primitives";
import type { QaRunKind } from "../../runQa";
import { Button, buttonVariants } from "../../map/kit";
import { EXPLORER_STOPPED, missionsPhrase, type BriefingSource, type Exploration, type ExplorationResult, type Lens, type LensGrade, type WalkCounts } from "../explorations";
import { fmtDuration } from "../../map/kit";
import type { Finding, TargetKind } from "../explorations";
import { cn } from "../../map/kit";
import { CharterGlyph } from "./charter-list";
import { featureOutcomeCount, featureOutcomeDetail, featureOutcomeTitle, FeatureOutcomes } from "./feature-outcomes";
import { JourneyPaths } from "./journeys";
import { CHARTER_LABEL, findingsByLens, journeyPaths, lensLabel, pickedLenses, readLine, scoreNote } from "./model";
import { FindingsByLens } from "./report-findings";
import { FindingButtons, type FindingActions } from "./finding-actions";
import { nextStepFinding, nextStepInput } from "./finding-input";
import { CopyFixPromptButton } from "../findings/copy-fix-prompt";
import { FindingScenarioButton } from "../findings/finding-scenario-button";
import { Link } from "../../map/kit";
import { runHref } from "../links";
import { FindingSheet, type SheetFinding } from "./finding-sheet";
import { AppBrief } from "./study-face";
import styles from "./detail.module.css";

const GRADE: Record<LensGrade, { label: string; tone: string; bar: string }> = {
  good: { label: "Good", tone: "text-success", bar: "bg-success" },
  fair: { label: "Fair", tone: "text-warning", bar: "bg-warning" },
  poor: { label: "Poor", tone: "text-danger", bar: "bg-danger" },
  unknown: { label: "Not covered", tone: "text-muted", bar: "bg-border-strong" },
};

const SOURCE_KIND: Record<BriefingSource["kind"], string> = {
  code: "Code",
  test: "Test",
  scenario: "Scenario",
  doc: "Doc",
  context: "Your context",
  memory: "Memory",
  finding: "Earlier finding",
};

/** One bar per picked lens, beside the ring of the done view's summary. */
function LensBars({ result, lenses }: { result: ExplorationResult; lenses: Lens[] }) {
  const rows = lenses.map((l) => result.lenses.find((x) => x.lens === l) ?? { lens: l, score: 0, grade: "unknown" as const, findings: 0 });
  const note = scoreNote(result);
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2.5">
      <ul className="flex min-w-0 flex-1 flex-col gap-2.5" aria-label="Score per lens">
        {rows.map((r, i) => {
          const g = GRADE[r.grade];
          return (
            <li key={r.lens} className="flex flex-col gap-1" data-lens-score={r.lens} data-lens-grade={r.grade}>
              <div className="flex items-baseline gap-2 text-sm">
                <span className="font-medium text-fg">{lensLabel(r.lens)}</span>
                <span className={cn("text-xs font-medium", g.tone)}>{g.label}</span>
                <span className="ml-auto text-xs tabular text-muted">
                  {r.grade === "unknown" ? "–" : r.score} · {r.findings} {r.findings === 1 ? "finding" : "findings"}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-border" aria-hidden>
                <div
                  className={cn("h-full rounded-full", g.bar, styles.bar)}
                  style={{ width: `${r.grade === "unknown" ? 0 : Math.max(2, r.score)}%`, "--i": i, "--d": "300ms" } as CSSProperties}
                />
              </div>
            </li>
          );
        })}
      </ul>
      {note ? (
        <p className="text-xs text-muted" data-score-note>
          {note}
        </p>
      ) : null}
    </div>
  );
}

/** The done view's tiles: the same four on every exploration. */
function statTiles(result: ExplorationResult, steps: number): WorkTile[] {
  return [
    { label: "Screens", value: String(result.screens) },
    { label: "Steps", value: String(result.steps || steps) },
    { label: "Studied", value: fmtDuration(result.study_s) },
    { label: "Explored", value: fmtDuration(Math.max(0, result.duration_s - result.study_s)) },
  ];
}

/** A next step that starts work: a person's call, so anyone else sees why they cannot. */
function RunButton({ label, actions, onClick, ...rest }: { label: string; actions: FindingActions; onClick: () => void } & Record<`data-${string}`, boolean | undefined>) {
  const btn = (
    <Button size="sm" className="w-fit" disabled={!actions.auth.can} onClick={onClick} {...rest}>
      {label} <ArrowUpRight />
    </Button>
  );
  return actions.auth.can ? btn : <Tooltip label={actions.auth.reason || "Only a person can start QA work"} placement="bottom">{btn}</Tooltip>;
}

/** "What it produced"'s line for the walks: "5 of 30 flows walked", "3 passed, 2 failed · 25 still queued". */
export function walksOutput(c: WalkCounts): { title: string; detail: string } {
  const outcomes = (["passed", "failed", "unreachable"] as const).filter((k) => c[k] > 0).map((k) => `${c[k]} ${k}`);
  const detail = [outcomes.join(", "), c.left ? `${c.left} still queued` : ""].filter(Boolean).join(" · ");
  return {
    title: `${c.walked} of ${c.total} ${c.total === 1 ? "flow" : "flows"} walked`,
    detail: detail || "None walked to an outcome yet.",
  };
}

function SourceList({ sources }: { sources: readonly BriefingSource[] }) {
  if (!sources.length) return null;
  return (
    <details className="group" data-source-list>
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-sm font-medium text-fg-2 hover:text-fg">
        <ChevronRight aria-hidden className="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
        Sources it read <span className="font-normal tabular text-muted">{sources.length}</span>
      </summary>
      <ul className="mt-2 flex flex-col rounded-lg border border-border bg-panel p-1">
        {sources.map((s, i) => (
          <li key={`${s.kind}-${s.ref}-${i}`} className="flex min-w-0 items-baseline gap-2 rounded-md px-2.5 py-1.5 text-sm">
            <span className="w-24 shrink-0 text-xs text-muted">{SOURCE_KIND[s.kind] ?? s.kind}</span>
            <span className="min-w-0 truncate font-mono text-xs text-fg">{s.ref}</span>
            {s.note ? <span className="hidden min-w-0 truncate text-xs text-muted sm:inline">{s.note}</span> : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

function CharterOutcomes({ exploration }: { exploration: Exploration }) {
  return (
    <ol className="flex flex-col gap-1.5" data-charter-outcomes>
      {exploration.charter.map((m, i) => {
        return (
          <li
            key={m.id}
            className={cn("flex items-start gap-2.5 rounded-lg border border-border bg-panel px-3 py-2.5", styles.cascade)}
            style={{ "--i": i } as CSSProperties}
            data-charter-outcome={m.status}
          >
            <CharterGlyph status={m.status} className="mt-0.5" />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="select-text text-sm font-medium text-fg">{m.title}</span>
                <span className="text-xs text-muted">{CHARTER_LABEL[m.status]}</span>
                {m.step_seq != null ? (
                  <Link href={runHref(exploration.id, m.step_seq)} className="inline-flex shrink-0 items-center gap-0.5 text-xs text-muted hover:text-fg" data-charter-jump>
                    Step {m.step_seq}
                    <ArrowUpRight aria-hidden className="size-3" />
                  </Link>
                ) : null}
              </div>
              <span className="select-text text-xs text-fg-2">
                <span className="text-muted">Why: </span>
                {m.why}
              </span>
              {m.note ? <span className="select-text text-xs text-fg-2">{m.note}</span> : null}
              {m.sources?.length ? (
                <span className="flex flex-wrap gap-1 pt-0.5">
                  {m.sources.map((s, si) => (
                    <span key={si} className="inline-flex items-center gap-1 rounded border border-border px-1.5 font-mono text-2xs text-muted" title={s.note}>
                      <FileText aria-hidden className="size-2.5" />
                      {s.ref}
                    </span>
                  ))}
                </span>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function NextSteps({
  exploration,
  result,
  runFindings,
  repro,
  actions,
  onRun,
}: {
  exploration: Exploration;
  result: ExplorationResult;
  runFindings: readonly Finding[];
  repro: Record<string, string[]>;
  actions: FindingActions;
  onRun: (kind: QaRunKind) => void;
}) {
  const byId = useMemo(() => new Map(runFindings.map((f) => [f.id, f])), [runFindings]);
  const items = useMemo(
    () => (result.next.length ? result.next : [{ kind: "exploration" as const, title: "Run a follow-up exploration", detail: "Same app, a fresh look." }]),
    [result.next],
  );
  // A Fix card's finding: Open finding shows it in the same sheet as the findings list,
  // with its fix prompt and issue actions on the card too.
  const fixes = useMemo<SheetFinding[]>(() => {
    const out: SheetFinding[] = [];
    for (const n of items) {
      if (n.kind !== "fix") continue;
      const f = nextStepFinding(n, result);
      if (!f || out.some((x) => x.f.fingerprint === f.fingerprint)) continue;
      const run = f.ref_id ? (byId.get(f.ref_id) ?? null) : null;
      out.push({ f, run, repro: run ? (repro[run.id] ?? []) : [] });
    }
    return out;
  }, [items, result, byId, repro]);
  const [openAt, setOpenAt] = useState<number | null>(null);
  const outputs: WorkOutput[] = items.map((n, i) => {
    const Icon = n.kind === "scenario" ? ListPlus : n.kind === "fix" ? Wrench : Compass;
    const fixAt = n.kind === "fix" ? fixes.findIndex((x) => x.f === nextStepFinding(n, result)) : -1;
    const fix = fixAt >= 0 ? fixes[fixAt] : null;
    return {
      key: `${n.kind}-${i}`,
      icon: <Icon strokeWidth={1.75} />,
      title: n.title,
      detail: n.detail,
      data: { "data-next-step": n.kind },
      action:
        n.kind === "scenario" ? (
          <FindingScenarioButton input={nextStepInput(n, result, byId, repro, exploration.id, exploration.platform)} scenarios={actions.scenarios} className="w-fit" />
        ) : fix ? (
          <>
            <Button size="sm" onClick={() => setOpenAt(fixAt)} data-open-finding={fix.f.fingerprint}>
              <Maximize2 /> Open finding
            </Button>
            <CopyFixPromptButton text={fix.run?.fix_prompt ?? null} variant="ghost" />
            {fix.run ? <FindingButtons finding={fix.run.qa} actions={actions} /> : null}
          </>
        ) : n.kind === "exploration" ? (
          <RunButton label="Plan it" actions={actions} onClick={() => onRun("explore")} data-follow-up />
        ) : null,
    };
  });
  return (
    <div data-next-steps>
      <WorkOutputs items={outputs} />
      {fixes.length ? (
        <FindingSheet
          items={fixes}
          index={openAt}
          onIndex={setOpenAt}
          onClose={() => setOpenAt(null)}
          kind={asTargetKind(exploration.platform)}
          actions={actions}
        />
      ) : null}
    </div>
  );
}

/**
 * The report of a finished exploration: the verdict and scores, what Orcha learned, the
 * charter's outcome, the journeys (when they were walked), findings by lens, and next
 * steps. Score rings count up, findings cascade in and journeys draw as paths; under reduced
 * motion they fade.
 */
export function ExplorationReport({
  exploration,
  runFindings,
  repro,
  steps,
  actions,
  onRun,
  drafts,
  walks,
  checks,
  walked,
  dismissed = [],
  full,
  checked = null,
}: {
  /** A check run's scenarios, passed of total. */
  checked?: { passed: number; total: number } | null;
  exploration: Exploration;
  runFindings: readonly Finding[];
  repro: Record<string, string[]>;
  steps: number;
  actions: FindingActions;
  /** Next steps start work: the Run check dialog, preset. */
  onRun: (kind: QaRunKind) => void;
  /** A session's drafts (the debrief line with Review drafts): one of its outputs. */
  drafts?: ReactNode;
  /** The session's walks: outputs too, right after the drafts. */
  walks?: ReactNode;
  /** A check run's verdicts. */
  checks?: ReactNode;
  /** The walked-screens map. */
  walked?: ReactNode;
  /** Findings a person set aside, kept with Reopen. */
  dismissed?: readonly Finding[];
  /** The session's written report. */
  full?: ReactNode;
}) {
  const result = exploration.result as ExplorationResult;
  const lenses = useMemo(() => pickedLenses(exploration.lenses, result), [exploration.lenses, result]);
  const journeys = useMemo(() => journeyPaths(exploration.briefing?.journeys, result.journeys), [exploration.briefing, result.journeys]);
  const briefing = exploration.briefing;
  const read = briefing ? readLine(exploration.study, briefing.sources_read, Boolean(exploration.context?.trim())) : null;
  const showJourneys = journeys.length > 0 && ((result.journeys?.length ?? 0) > 0);
  // The same unit as the lens tabs: one row per measured check, not per screen it was seen on.
  const findingCount = useMemo(() => findingsByLens(result, lenses).reduce((n, g) => n + g.total, 0), [result, lenses]);

  const stoppedNote = result.stopped_early ? (
          <div
            role="note"
            className="flex flex-col gap-1 rounded-lg border border-info/40 bg-info/10 px-4 py-3 text-sm text-fg"
            data-stopped-early={result.stopped_early.code}
          >
            {/* The site limited the run: needs setup. The explorer left early: Orcha kept what it recorded. */}
            <p className="font-semibold">
              {result.stopped_early.code === EXPLORER_STOPPED ? result.stopped_early.title : `Needs setup · ${result.stopped_early.title}`}
            </p>
            {result.stopped_early.reason ? (
              <p className="text-fg-2">
                {result.stopped_early.code === EXPLORER_STOPPED ? result.stopped_early.reason : `What Embodent saw: ${result.stopped_early.reason}`}
              </p>
            ) : null}
            {result.stopped_early.fix ? <p className="text-xs text-muted">{result.stopped_early.fix}</p> : null}
          </div>
  ) : null;
  return (
    <div className="flex flex-col gap-8" data-face="report">
      <WorkSummary
        note={stoppedNote}
        ring={
          // A check passes or fails on its scenarios: a score beside a failure reads as fine.
          checked ? null : (
            <span title={scoreNote(result) ?? undefined} className="shrink-0">
              <ScoreRing score={result.score} size={96} label="Overall score" />
            </span>
          )
        }
        verdict={checked ? `${checked.passed} of ${checked.total} scenario${checked.total === 1 ? "" : "s"} passed${result.verdict ? ` · ${result.verdict}` : ""}` : result.verdict}
        aside={<LensBars result={result} lenses={lenses} />}
        tiles={statTiles(result, steps)}
      />

      {briefing ? (
        <WorkSection title="What Embodent learned" id="learned">
          <AppBrief briefing={briefing} />
          {read ? (
            <p className="text-xs text-muted" data-sources-read>
              {read}
            </p>
          ) : null}
          <SourceList sources={briefing.sources ?? []} />
        </WorkSection>
      ) : null}

      <WorkSection title="What it produced" id="outputs">
        <WorkOutputs
          items={[
            {
              key: "findings",
              icon: <Bug strokeWidth={1.75} />,
              title: findingCount === 0 ? "No findings" : `${findingCount} ${findingCount === 1 ? "finding" : "findings"}`,
              detail: findingCount === 0 ? "Nothing filed against the lenses picked." : "By lens, each with the step that shows it.",
              action:
                findingCount > 0 ? (
                  <a href="#sec-findings" onClick={jump("sec-findings")} className={cn(buttonVariants({ size: "sm" }), "w-fit")} data-open-findings>
                    Open findings
                  </a>
                ) : null,
            },
            ...(result.walks?.total
              ? [
                  {
                    key: "walks",
                    icon: <Footprints strokeWidth={1.75} />,
                    ...walksOutput(result.walks),
                    data: { "data-walks-output": String(result.walks.walked) },
                    action: walks ? (
                      <a href="#sec-walks" onClick={jump("sec-walks")} className={cn(buttonVariants({ size: "sm" }), "w-fit")} data-open-walks>
                        See the walks
                      </a>
                    ) : null,
                  },
                ]
              : []),
            ...(result.features?.length
              ? [{ key: "features", icon: <Layers strokeWidth={1.75} />, title: featureOutcomeTitle(result.features), detail: featureOutcomeDetail(result.features) }]
              : []),
          ]}
        />
        {drafts}
      </WorkSection>

      {walks}

      {checks}

      {exploration.charter.length ? (
        <WorkSection
          title="The charter"
          id="charter"
          count={missionsPhrase(result.charter)}
        >
          {result.walks?.total && !(result.charter.covered + result.charter.partial + result.charter.bug + result.charter.blocked) ? (
            <p className="text-xs text-muted" data-charter-after-walks>
              Workflow pairing walks the flow queue first; these missions fill the time it leaves.
              {result.walks.left ? ` ${result.walks.left} ${result.walks.left === 1 ? "flow was" : "flows were"} still queued, so none was started.` : ""}
            </p>
          ) : null}
          <CharterOutcomes exploration={exploration} />
        </WorkSection>
      ) : null}

      {result.features?.length ? (
        <WorkSection title={result.features.length === 1 ? "The feature" : "Feature by feature"} id="features" count={featureOutcomeCount(result.features)}>
          <FeatureOutcomes features={result.features} />
        </WorkSection>
      ) : null}

      {showJourneys ? (
        <WorkSection title="Journeys" id="journeys" count={`${journeys.filter((j) => j.outcome === "passed").length} of ${journeys.length} passed`}>
          <JourneyPaths journeys={journeys} />
        </WorkSection>
      ) : null}

      <WorkSection title="Findings by lens" id="findings" count={findingCount}>
        <FindingsByLens
          result={result}
          lenses={lenses}
          runFindings={runFindings}
          repro={repro}
          kind={asTargetKind(exploration.platform)}
          actions={actions}
        />
        <DismissedFindings findings={dismissed} actions={actions} />
      </WorkSection>

      {walked}

      {full}

      <WorkSection title="Next steps" id="next">
        <NextSteps exploration={exploration} result={result} runFindings={runFindings} repro={repro} actions={actions} onRun={onRun} />
      </WorkSection>
    </div>
  );
}

/** An in-page link: scrolls there without touching the page's own URL hash or params. */
function jump(id: string) {
  return (e: { preventDefault: () => void }) => {
    e.preventDefault();
    document.getElementById(id)?.scrollIntoView({ block: "start" });
  };
}

/** What a person dismissed: out of the score, kept here so it can be reopened. */
function DismissedFindings({ findings, actions }: { findings: readonly Finding[]; actions: FindingActions }) {
  if (!findings.length) return null;
  return (
    <details className="group" data-findings-dismissed>
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-sm font-medium text-fg-2 hover:text-fg">
        <ChevronRight aria-hidden className="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
        Dismissed <span className="font-normal tabular text-muted">{findings.length}</span>
      </summary>
      <ul className="mt-2 flex flex-col rounded-lg border border-border bg-panel p-1">
        {findings.map((f) => (
          <li key={f.id} className="flex min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-sm">
            <span className="min-w-0 flex-1 truncate text-fg-2">{f.title}</span>
            <FindingButtons finding={f.qa} actions={actions} />
          </li>
        ))}
      </ul>
    </details>
  );
}

function asTargetKind(platform: string | null): TargetKind | null {
  return platform === "ios" || platform === "android" || platform === "web" || platform === "desktop" ? platform : null;
}
