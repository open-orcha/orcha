/**
 * Runs › Reports: the Quality reports imported here, and Import. A report is someone else's run as
 * they reported it: it opens as a run-like page (`ImportedReportView`) that says so, and can be
 * re-run here to prove it.
 */
import { useRef, useState } from "react";
import { Button, EmptyState } from "../../../components/primitives";
import { relTime } from "../../../lib/format";
import type { QaAuthority } from "../authority";
import { QaStatus, errText, useLoad } from "../parts";
import type { QaNav } from "../QaPage";
import { platformWord, verdictGlyph, verdictWord } from "../qaWords";
import { importReport, listReports, tallyWords } from "./api";
import { ImportedReportView } from "./ImportedReportView";
import "./report.css";

export function ReportsView({ cid, nav, auth }: { cid: string; nav: QaNav; auth: QaAuthority }) {
  const rid = nav.get("report");
  if (rid) return <ImportedReportView key={rid} rid={rid} nav={nav} auth={auth} />;
  return <ReportsList cid={cid} nav={nav} auth={auth} />;
}

export function ImportReportButton({ cid, auth, onDone }: { cid: string; auth: QaAuthority; onDone: (id: string) => void }) {
  const input = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setErr(null);
    try {
      onDone((await importReport(cid, file, auth.human?.id ?? null)).id);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  return (
    <span className="qa-report-import">
      <input ref={input} type="file" accept=".md,.zip,text/markdown,application/zip" hidden aria-hidden="true" tabIndex={-1}
        onChange={(e) => void pick(e.target.files?.[0])} data-qa-report-file />
      <Button size="sm" icon="upload" busy={busy} disabled={!auth.human} onClick={() => input.current?.click()} data-qa-report-import>Import report</Button>
      {err ? <span className="qa-error" role="alert">{err}</span> : null}
    </span>
  );
}

function ReportsList({ cid, nav, auth }: { cid: string; nav: QaNav; auth: QaAuthority }) {
  const res = useLoad((s) => listReports(cid, s), [cid], nav.nonce);
  const open = (id: string) => nav.set({ report: id });
  const head = (
    <header className="qa-report-listhead">
      <div>
        <h2 className="qa-report-h">Reports</h2>
        <p className="qa-muted">Quality reports from other people's runs. Import the .md from a Jira ticket, or its .zip bundle to see the screenshots too.</p>
      </div>
      <ImportReportButton cid={cid} auth={auth} onDone={open} />
    </header>
  );
  if (res.error && !res.data) return <section className="qa-report-page">{head}<EmptyState tone="danger" title="Couldn't load the reports" body={res.error} /></section>;
  const rows = res.data ?? [];
  return (
    <section className="qa-report-page" data-qa-reports>
      {head}
      {res.data && !rows.length ? <EmptyState title="No reports imported yet" body="Download one from a task's Quality section, then import it here." /> : null}
      {rows.length ? (
        <ul className="qa-plain qa-report-rows" aria-label="Imported reports">
          {rows.map((r) => (
            <li key={r.id}>
              <button type="button" className="qa-row" onClick={() => open(r.id)} data-qa-report-row={r.id}>
                <QaStatus glyph={r.result ? verdictGlyph(r.result) : "pending"} word={r.result ? verdictWord(r.result) : "Not judged"} />
                <span className="qa-row-title">{r.title}</span>
                <span className="qa-row-who">{tallyWords(r.tally)}</span>
                <span className="qa-row-meta">{[r.platforms.map(platformWord).join(", "), r.project, `imported ${relTime(r.created_at)}`].filter(Boolean).join(" · ")}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
