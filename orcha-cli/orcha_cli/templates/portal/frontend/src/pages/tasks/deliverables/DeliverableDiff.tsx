/**
 * Text diff between two versions of one deliverable. The API returns a
 * git-shaped unified diff, so the shared FilesChanged viewer renders it with
 * the same +/- styling as code changes. Binary kinds report changed/unchanged
 * (size + checksum) — never a fake text diff.
 */
import { useEffect, useState } from "react";
import { FilesChanged, parseDiffFiles, type DiffFile } from "../../../components/FilesChanged";
import { fetchDeliverableDiff, formatBytes, type DeliverableDiffResult } from "./api";
import { ImageCompare } from "../../../components/filePreview/BinaryDiff";

type DiffState = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; data: DeliverableDiffResult };

export function DeliverableDiff({ tid, did, from, to }: { tid: string; did: string; from: number; to: number }) {
  const [st, setSt] = useState<DiffState>({ status: "loading" });
  useEffect(() => {
    let live = true;
    setSt({ status: "loading" });
    fetchDeliverableDiff(tid, did, from, to)
      .then((data) => live && setSt({ status: "ok", data }))
      .catch((e: { detail?: string; status?: number }) => live && setSt({ status: "error", message: e?.detail || "HTTP " + (e?.status ?? "error") }));
    return () => {
      live = false;
    };
  }, [tid, did, from, to]);

  if (st.status === "loading") return <p className="dlv-note" aria-busy="true">Loading changes…</p>;
  if (st.status === "error") return <p className="dlv-err" role="alert">Diff unavailable — {st.message}.</p>;
  const d = st.data;
  const label = "v" + d.from.version + " → v" + d.to.version;
  if (d.binary && d.kind === "image" && d.bytes_changed) {
    // two image versions compare GitHub-style (2-up / swipe / onion skin)
    return (
      <div className="dlv-diff" data-testid="dlv-image-diff" aria-label={"Changes " + label}>
        <ImageCompare path={d.path} oldUrl={d.from.raw_url} newUrl={d.to.raw_url} />
      </div>
    );
  }
  if (d.binary) {
    return (
      <p className="dlv-note" data-testid="dlv-binary-diff">
        {label}: {d.bytes_changed ? "file changed" : "no change"} ({formatBytes(d.from.size_bytes)} → {formatBytes(d.to.size_bytes)}). Binary files have no text diff — preview each version to compare.
      </p>
    );
  }
  if (d.identical) return <p className="dlv-note">{label}: no text changes.</p>;
  return (
    <div className="dlv-diff" data-testid="dlv-diff" aria-label={"Changes " + label}>
      <FilesChanged preparsed={documentDiff(d.diff || "", d.path + " · " + label)} hideSummary />
      {d.truncated ? <p className="dlv-note">Diff truncated (large file) — download both versions for the full comparison.</p> : null}
    </div>
  );
}

/** A document diff reads as prose changes: keep the hunks, drop the git
 *  plumbing lines (diff --git / --- / +++) and label the pane "path · v1 → v2"
 *  (the viewer's own header then carries the +/− counts once — D12). */
export function documentDiff(diff: string, title: string): DiffFile[] {
  return parseDiffFiles(diff).map((f) => ({
    ...f,
    path: title,
    // only the file header BEFORE the first hunk is plumbing — a removed line
    // that happens to read "-- a/…" inside a hunk is content and stays
    lines: f.lines.slice(Math.max(0, f.lines.findIndex((l) => l.startsWith("@@")))),
  }));
}
