/**
 * One deliverable version rendered by kind: markdown (the escaped Md renderer),
 * CSV/TSV as a bounded table, JSON pretty-printed, text as-is, images inline,
 * PDFs in the browser's viewer with a download fallback. Text is fetched from
 * the capped /text endpoint; binaries stream from /raw (nosniff, server-side
 * magic-byte checked).
 */
import { useEffect, useState } from "react";
import { Md } from "../../../components/ui";
import { ImageView } from "../../../components/filePreview/FilePreview";
import type { Task } from "../../../types";
import { fetchDeliverableText, formatBytes, TEXT_KINDS, type Deliverable, type DeliverableText, type DeliverableVersion } from "./api";
import { delimiterFor, parseCsv } from "./csv";

const MAX_TABLE_ROWS = 200;
const MAX_TABLE_COLS = 40;

type TextState = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; data: DeliverableText };

function useVersionText(v: DeliverableVersion | null, enabled: boolean): TextState {
  const [st, setSt] = useState<TextState>({ status: "loading" });
  const url = enabled && v?.text_url ? v.text_url : null;
  useEffect(() => {
    if (!url) return;
    let live = true;
    setSt({ status: "loading" });
    fetchDeliverableText(url)
      .then((data) => live && setSt({ status: "ok", data }))
      .catch((e: { detail?: string; status?: number }) => live && setSt({ status: "error", message: e?.detail || "HTTP " + (e?.status ?? "error") }));
    return () => {
      live = false;
    };
  }, [url]);
  return st;
}

export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export function CsvTable({ text, path }: { text: string; path: string }) {
  const t = parseCsv(text, delimiterFor(path), MAX_TABLE_ROWS + 1);
  if (!t.rows.length) return <p className="dlv-note" style={{ padding: 12 }}>Empty table.</p>;
  const [head, ...body] = t.rows;
  const shown = body.slice(0, MAX_TABLE_ROWS);
  const cols = Math.min(t.columns, MAX_TABLE_COLS);
  const more = body.length > MAX_TABLE_ROWS || t.truncated;
  return (
    <>
      <table className="dlv-table" data-testid="dlv-csv">
        <thead>
          <tr>
            {Array.from({ length: cols }, (_, i) => (
              <th key={i} scope="col" title={head[i] ?? ""}>{head[i] ?? ""}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r, ri) => (
            <tr key={ri}>
              {Array.from({ length: cols }, (_, i) => (
                <td key={i} title={r[i] ?? ""}>{r[i] ?? ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {more || t.columns > MAX_TABLE_COLS ? (
        <p className="dlv-note" style={{ padding: "6px 10px" }}>
          Showing the first {shown.length} rows{t.columns > MAX_TABLE_COLS ? " and " + MAX_TABLE_COLS + " of " + t.columns + " columns" : ""} — download for the full file.
        </p>
      ) : null}
    </>
  );
}

export function DeliverablePreview({ d, v, tasks }: { d: Deliverable; v: DeliverableVersion | null; tasks?: Task[] }) {
  const isText = TEXT_KINDS.has(d.kind);
  const st = useVersionText(v, isText);
  if (!v) return <p className="dlv-note">No version recorded.</p>;

  if (d.kind === "image") {
    return (
      // the shared preview: checkerboard transparency, Fit / Actual size, dimensions
      <div className="dlv-preview" data-kind="image">
        <ImageView src={v.raw_url} path={d.path} size={v.size_bytes} url={v.raw_url} alt={d.name + " (version " + v.version + ")"} />
      </div>
    );
  }
  if (d.kind === "pdf") {
    // A browser without a PDF viewer (headless, some mobile) gets a compact
    // download card instead of an empty embed box.
    const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { pdfViewerEnabled?: boolean }) : null;
    if (nav && nav.pdfViewerEnabled === false) {
      return (
        <div className="dlv-preview dlv-file-card" data-kind="pdf">
          <span className="v2-muted">PDF · {formatBytes(v.size_bytes)} — this browser can't preview PDFs.</span>
          <a className="dlv-link" href={v.raw_url} target="_blank" rel="noopener noreferrer">Open</a>
          <a className="dlv-link" href={v.raw_url + "?download=1"} download>Download {d.name}</a>
        </div>
      );
    }
    return (
      <div className="dlv-preview" data-kind="pdf">
        <object className="dlv-pdf" data={v.raw_url} type="application/pdf" aria-label={d.name + " (version " + v.version + ")"}>
          <p className="dlv-note" style={{ padding: 12 }}>
            This browser can't show PDFs inline. <a className="dlv-link" href={v.raw_url + "?download=1"} download>Download {d.name}</a> ({formatBytes(v.size_bytes)}).
          </p>
        </object>
      </div>
    );
  }
  if (st.status === "loading") return <p className="dlv-note" aria-busy="true">Loading preview…</p>;
  if (st.status === "error") return <p className="dlv-err" role="alert">Preview unavailable — {st.message}.</p>;
  const { text, truncated, max_bytes } = st.data;
  const note = truncated ? (
    <p className="dlv-note">Preview shows the first {formatBytes(max_bytes)} of {formatBytes(v.size_bytes)} — download for the full file.</p>
  ) : null;
  if (d.kind === "markdown") {
    return (
      <>
        <div className="dlv-preview is-md" data-kind="markdown">
          <Md className="wk-text wk-md" text={text} tasks={tasks} />
        </div>
        {note}
      </>
    );
  }
  if (d.kind === "csv") {
    return (
      <>
        <div className="dlv-preview" data-kind="csv">
          <CsvTable text={text} path={d.path} />
        </div>
        {note}
      </>
    );
  }
  return (
    <>
      <div className="dlv-preview" data-kind={d.kind}>
        <pre className="dlv-pre">{d.kind === "json" && !truncated ? prettyJson(text) : text}</pre>
      </div>
      {note}
    </>
  );
}
