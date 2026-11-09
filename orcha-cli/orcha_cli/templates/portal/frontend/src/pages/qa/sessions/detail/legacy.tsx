import { useMemo } from "react";
import { listSessions, getSession, type SessionDetail } from "../../qaApi";
import { useLoad } from "../../parts";
import { listDigests, type QaStep, type SessionDigest } from "../api";
import { ExplorationBrowser } from "../reports/exploration-browser";
import { previousOf, reportDetailOf, summaryOfDigest } from "../reports/adapt-report";
import { summarize } from "../reports/exploration";
import { WorkSection } from "../work/work-done";

/**
 * What the audit measured on the session's screens, in the report reader, beside the other
 * sessions of its series: nothing it measured or judged is lost, and the measured and the judged
 * stay apart.
 */
export function LegacyReport({ cid, detail, steps }: { cid: string; detail: SessionDetail; steps: readonly QaStep[] }) {
  const s = detail.session;
  const series = s.series_id ?? s.id;
  const others = useLoad(
    async (signal) => {
      const [rows, digests, prev] = await Promise.all([
        listSessions(cid, { platform: s.platform }, signal),
        listDigests(cid, s.platform, signal).catch(() => ({} as Record<string, SessionDigest>)),
        s.previous_session_id ? getSession(s.previous_session_id, signal).catch(() => null) : Promise.resolve(null),
      ]);
      return { rows: rows.filter((r) => (r.series_id ?? r.id) === series && r.id !== s.id), digests, prev };
    },
    [cid, s.platform, series, s.id, s.previous_session_id],
    0,
  );
  // The series, oldest first: each session is the next revision of it.
  const chain = useMemo(() => [...(others.data?.rows ?? []), s].sort((a, b) => (a.started_at ?? "").localeCompare(b.started_at ?? "")), [others.data, s]);
  const revision = (id: string) => chain.findIndex((r) => r.id === id) + 1;
  const report = useMemo(() => reportDetailOf(detail, steps, chain.findIndex((r) => r.id === s.id) + 1), [detail, steps, chain, s.id]);
  const selected = useMemo(() => summarize(report.report, report.findings, report.notes, report.judged), [report]);
  const summaries = useMemo(() => {
    const rest = (others.data?.rows ?? []).map((r) => summaryOfDigest(r, others.data?.digests[r.id], revision(r.id)));
    return [selected, ...rest].sort((a, b) => b.report.created_at.localeCompare(a.report.created_at));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [others.data, selected, chain]);
  const previous = useMemo(() => (others.data?.prev ? previousOf(others.data.prev) : null), [others.data]);
  if (!report.findings.length && !report.notes.length) return null;
  return (
    <WorkSection title="What was measured" id="measured" count={report.findings.length}>
      <ExplorationBrowser summaries={summaries} selected={selected} detail={report} previous={previous} />
    </WorkSection>
  );
}
