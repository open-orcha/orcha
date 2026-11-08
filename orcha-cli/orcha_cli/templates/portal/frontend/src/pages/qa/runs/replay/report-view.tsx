import { Md } from "../../../../components/ui";
import { humanizeAgentProse } from "../lib/humanize-locator";

/** `runs.report_md` rendered as markdown with minimal heading/table/code styling.
 *
 * `remark-gfm` is required, not optional: the agent's report uses GitHub-flavoured
 * markdown — the scenario matrix is a pipe table, and findings use strikethrough and
 * autolinks. Without it react-markdown renders a table as one run-on paragraph of
 * pipes. */
/** Linear report type: 14px body, headings one step up at most, no ruled h2s, no caps. */
const REPORT_TYPE = [
  "max-w-[720px] text-sm leading-6",
  "[&_h1]:mb-3 [&_h1]:mt-0 [&_h1]:text-base [&_h1]:leading-6",
  "[&_h2]:mb-1.5 [&_h2]:mt-6 [&_h2]:border-b-0 [&_h2]:pb-0 [&_h2]:text-sm",
  "[&_h3]:mb-1 [&_h3]:mt-4 [&_h3]:text-sm [&_h3]:font-medium",
  "[&_h4]:text-xs [&_h4]:font-medium [&_h4]:normal-case [&_h4]:tracking-normal",
  "[&_code]:text-xs [&_pre]:text-xs [&_pre]:leading-5 [&_li]:my-1 [&_ol]:pl-6 [&_ul]:pl-6",
  "[&_li::marker]:text-muted [&_a]:text-fg",
].join(" ");

export function ReportView({
  markdown,
  status,
  error,
}: {
  markdown: string | null;
  /** The run's status: a missing report reads differently for a running or aborted run. */
  status?: string | null;
  /** The request's error, when the run did not finish on its own. */
  error?: string | null;
}) {
  if (!markdown?.trim()) {
    const why =
      status === "running"
        ? "The agent writes its report when the run ends. Watch the Steps and Findings tabs meanwhile."
        : status === "failed"
          ? `The run ended before the agent could write a report${error ? ` (${error})` : ""}. The steps, screenshots and scenario verdicts captured up to that point are on the other tabs.`
          : "This run produced no report.";
    return (
      <div
        className="flex flex-col items-center gap-1 py-12 text-center"
        data-report-empty
        data-report-status={status ?? undefined}
      >
        <p className="text-sm font-medium text-fg">No report for this run</p>
        <p className="max-w-md text-sm text-muted">{why}</p>
      </div>
    );
  }
  return (
    <div data-report className={REPORT_TYPE}>
      <Md className="wk-text wk-md qa-report" text={humanizeAgentProse(markdown)} />
    </div>
  );
}
