import { useMemo, useState } from "react";
import { GitBranch, Moon, Sun } from "../../map/kit/icons";
import { Tabs, type TabDef } from "../../runs/replay/tabs";
import { ReportView } from "../../runs/replay/report-view";
import { Chip } from "../../map/kit";
import { appearanceLabel, crashNotice, partitionByConfidence, revisionLabel } from "./exploration";
import type { FindingFilter, ListSection } from "./exploration-list";
import { fmtDate } from "../../map/kit";
import type { ExplorationReportDetail, ExplorationReportSummary } from "./types";
import { DiffPanel } from "./diff-panel";
import { FindingsExplorer } from "./findings-explorer";
import { JudgedFindings } from "./judged-findings";
import { NotesSection } from "./notes-section";
import { PlatformChip } from "../../map/kit";
import { StatusLine } from "./charts";

type DetailTab = "findings" | "diff" | "notes" | "summary";

function Stat({
  label,
  value,
  hint,
  testId,
}: {
  label: string;
  value: string;
  hint?: string;
  testId: string;
}) {
  return (
    <div
      className="flex min-w-[104px] flex-1 flex-col gap-0.5 rounded-lg border border-border bg-panel px-3 py-2.5"
      data-exploration-stat={testId}
    >
      <span className="text-sm text-muted">{label}</span>
      <span className="text-xl font-semibold leading-7 tabular text-fg">{value}</span>
      {hint ? <span className="text-xs text-muted">{hint}</span> : null}
    </div>
  );
}

/**
 * One exploration in full.
 *
 * The page's structure *is* the argument: measured findings and judged notes are
 * separate tabs with separate visual languages, so nobody can arrive at an opinion
 * believing it is a measurement. Within the findings tab, the confident ones come
 * first grouped by what they check, and the unconfident ones sit below under
 * "Needs a look" — a heading, not a badge, because an estimate presented as a
 * verdict is the failure mode this whole feature exists to avoid.
 */
export function ReportDetail({
  detail,
  previous,
  filter,
  onFilterChange,
}: {
  detail: ExplorationReportDetail;
  previous: { summary: ExplorationReportSummary; detail: ExplorationReportDetail } | null;
  filter: FindingFilter;
  onFilterChange: (next: FindingFilter) => void;
}) {
  const [tab, setTab] = useState<DetailTab>("findings");
  // Picking a check in the chart above means "show me those findings": bring a
  // reader on the Judged or Summary tab back to the list.
  const [seenKind, setSeenKind] = useState(filter.kind);
  if (seenKind !== filter.kind) {
    setSeenKind(filter.kind);
    if (filter.kind != null && tab !== "findings" && tab !== "diff") setTab("findings");
  }
  const report = detail.report;
  const { crash, summary } = crashNotice(report.summary_md);
  const { confident, needsLook } = useMemo(() => partitionByConfidence(detail.findings), [detail.findings]);
  const sections = useMemo<ListSection[]>(
    () => [
      { key: "measured", title: "Measured", findings: confident },
      {
        key: "needs-look",
        title: "Needs a look",
        tone: "muted",
        description:
          "The measurement is sound. What it means is not: text over a photo or a gradient makes one colour sample unreliable. These are estimates, not failures.",
        findings: needsLook,
      },
    ],
    [confident, needsLook],
  );

  const count = (n: number) =>
    n > 0 ? (
      <span className="text-sm font-normal tabular text-muted">
        {n}
      </span>
    ) : null;

  const tabs: TabDef<DetailTab>[] = [
    {
      key: "findings",
      label: (
        <span className="flex items-center gap-1.5">
          Measured{count(detail.findings.length)}
        </span>
      ),
    },
    {
      key: "diff",
      label: <span className="flex items-center gap-1.5">Compared</span>,
    },
    {
      key: "notes",
      label: (
        <span className="flex items-center gap-1.5">Judged{count(detail.judged.length + detail.notes.length)}</span>
      ),
    },
    { key: "summary", label: <span>Summary</span> },
  ];

  return (
    <div className="flex min-w-0 flex-col gap-3" data-exploration-report={report.id}>
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <h2 className="text-lg font-semibold leading-6 tabular text-fg">
            {revisionLabel(report)}
          </h2>
          <span className="text-sm text-muted">
            explored {fmtDate(report.created_at, { time: false })}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {report.appearances.map((a) => (
            <Chip key={a} title={`Walked in ${a} appearance`}>
              {a === "dark" ? (
                <Moon className="size-2.5" aria-hidden />
              ) : (
                <Sun className="size-2.5" aria-hidden />
              )}
              {appearanceLabel(a)}
            </Chip>
          ))}
          {report.git_branch ? (
            <Chip mono title="Branch">
              <GitBranch className="size-2.5" aria-hidden />
              {report.git_branch}
            </Chip>
          ) : null}
          {report.git_commit ? (
            <Chip mono title="Commit">
              {report.git_commit.slice(0, 7)}
            </Chip>
          ) : null}
          {report.target_kind ? <PlatformChip kind={report.target_kind} /> : null}
        </div>
      </header>

      {crash ? (
        // A crashed run's error screens are never measured: say so before any count.
        <div role="alert" data-exploration-crashed className="rounded-lg border border-border bg-panel px-3 py-2">
          <StatusLine status="fail">{crash}</StatusLine>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Stat
          label="Screens"
          value={String(report.screens_seen)}
          hint={`in ${report.appearances.length || 1} ${report.appearances.length === 1 ? "appearance" : "appearances"}`}
          testId="screens"
        />
        <Stat
          label="Measured"
          value={String(confident.length)}
          hint={confident.length === 1 ? "finding" : "findings"}
          testId="measured"
        />
        <Stat
          label="Needs a look"
          value={String(needsLook.length)}
          hint="measurement sound, reading unclear"
          testId="needs-look"
        />
        <Stat
          label="Judged"
          value={String(detail.judged.length)}
          hint={`${detail.judged.length === 1 ? "finding" : "findings"} · ${detail.notes.length} ${detail.notes.length === 1 ? "note" : "notes"}`}
          testId="judged"
        />
      </div>

      <Tabs tabs={tabs} value={tab} onChange={setTab} />

      <div role="tabpanel" aria-label={tab} data-exploration-panel={tab} className="flex flex-col gap-5">
        {tab === "findings" ? (
          detail.findings.length === 0 ? (
            <div className="rounded-lg border border-border bg-panel px-3 py-8 text-center text-sm text-muted">
              {crash
                ? "Nothing was measured: the app crashed, and its error screen is not the app."
                : "This exploration measured nothing that failed a check."}
            </div>
          ) : (
            // Severity lives inside the measured panel, never above the tabs: a
            // severity roll-up floating over the Judged tab would imply the opinions
            // below it are graded, which is the exact confusion this page prevents.
            <FindingsExplorer
              key={report.id}
              sections={sections}
              filter={filter}
              onFilterChange={onFilterChange}
              severityFindings={confident}
              testId="measured"
            />
          )
        ) : null}

        {tab === "diff" ? (
          <DiffPanel current={detail} previous={previous} filter={filter} onFilterChange={onFilterChange} />
        ) : null}

        {tab === "notes" ? (
          <>
            <section className="flex flex-col gap-2" data-judged-group="findings">
              <div className="flex flex-col gap-0.5">
                <h3 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
                  Findings
                  <span className="font-normal tabular text-muted">{detail.judged.length}</span>
                </h3>
                <p className="max-w-prose text-xs text-muted">
                  What the agent judged to be wrong while walking the app. The severity is the
                  agent&apos;s call on impact, not a measurement. They are kept apart from the measured
                  findings on purpose. Each one opens the run at the step where it was found.
                </p>
              </div>
              <JudgedFindings findings={detail.judged} />
            </section>
            <section className="flex flex-col gap-2" data-judged-group="notes">
              <div className="flex flex-col gap-0.5">
                <h3 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
                  Impressions
                  <span className="font-normal tabular text-muted">{detail.notes.length}</span>
                </h3>
                <p className="max-w-prose text-xs text-muted">
                  Opinions and ideas. Nothing here carries a number or a severity.
                </p>
              </div>
              <NotesSection notes={detail.notes} />
            </section>
          </>
        ) : null}

        {tab === "summary" ? (
          <ReportView markdown={summary} status="completed" />
        ) : null}
      </div>
    </div>
  );
}
