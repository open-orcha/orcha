/**
 * Task deliverables — the non-code outputs a task produced (reports, tables,
 * charts, PDFs), as Linear-calm rows: kind glyph, mono path, version chip,
 * who produced it, size, age. A row expands in place into the preview for the
 * selected version, its version history, and "Compare" (a text diff against
 * any earlier version). Humans can attach a file (a write: viewers and
 * read-only sessions see no Attach button; the server re-checks).
 *
 * Renders NOTHING when the backend has no deliverables API (404) and, in the
 * narrow inspector, when the task has none (D12 — no empty boilerplate).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, useToast } from "../../../components/ui";
import { Button, IconButton } from "../../../components/primitives";
import { clockTime, relTime } from "../../../lib/format";
import { useActingAuthority, useSnapshot } from "../../../state/SnapshotProvider";
import type { Task } from "../../../types";
import {
  dirOf,
  fetchDeliverable,
  formatBytes,
  sourceLabel,
  uploadDeliverable,
  useDeliverables,
  type Deliverable,
  type DeliverableKind,
  type DeliverableVersion,
} from "./api";
import { DeliverableDiff } from "./DeliverableDiff";
import { DeliverablePreview } from "./DeliverablePreview";
import { deliverablesCss } from "./deliverablesCss";

const CLOSED = new Set(["completed", "cancelled"]);

/* ---- kind glyphs (16px, stroke = currentColor, same grid as the Icon set) ---- */
const KIND_PATHS: Record<DeliverableKind, string> = {
  markdown: '<path d="M5 2.5h6.5L15 6v11.5H5z"/><path d="M11.5 2.5V6H15"/><path d="M7.5 10h5M7.5 12.5h5M7.5 15h3"/>',
  text: '<path d="M5 2.5h6.5L15 6v11.5H5z"/><path d="M11.5 2.5V6H15"/><path d="M7.5 10h5M7.5 12.5h5"/>',
  json: '<path d="M5 2.5h6.5L15 6v11.5H5z"/><path d="M11.5 2.5V6H15"/><path d="M8.5 9.5 7 11.5l1.5 2M11.5 9.5l1.5 2-1.5 2"/>',
  csv: '<rect x="3" y="4" width="14" height="12" rx="1.5"/><path d="M3 8h14M3 12h14M8 4v12"/>',
  pdf: '<path d="M5 2.5h6.5L15 6v11.5H5z"/><path d="M11.5 2.5V6H15"/><path d="M7.5 14.5v-4h1.2a1.2 1.2 0 0 1 0 2.4H7.5"/>',
  image: '<rect x="3" y="4" width="14" height="12" rx="1.5"/><circle cx="7.5" cy="8" r="1.3"/><path d="m3.5 14.5 4-4 3 3 2-2 4 3.5"/>',
};

export function KindGlyph({ kind }: { kind: DeliverableKind }) {
  return (
    <svg
      className="dlv-kind"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-kind={kind}
      dangerouslySetInnerHTML={{ __html: KIND_PATHS[kind] || KIND_PATHS.text }}
    />
  );
}

export const KIND_LABEL: Record<DeliverableKind, string> = {
  markdown: "Markdown document",
  text: "Text file",
  json: "JSON file",
  csv: "Table (CSV)",
  pdf: "PDF document",
  image: "Image",
};

function versionTitle(v: DeliverableVersion): string {
  const parts = ["Version " + v.version, sourceLabel(v)];
  if (v.run_id) parts.push("run " + v.run_id.slice(0, 8));
  if (v.created_at) parts.push(clockTime(v.created_at));
  return parts.filter(Boolean).join(" · ");
}

/* ---- one expanded deliverable ------------------------------------------------ */
function DeliverableDetail({ tid, d, tasks }: { tid: string; d: Deliverable; tasks?: Task[] }) {
  const [versions, setVersions] = useState<DeliverableVersion[] | null>(d.versions || null);
  const [sel, setSel] = useState<number>(d.latest_version);
  const [compare, setCompare] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchDeliverable(tid, d.id)
      .then((full) => {
        if (!live) return;
        setVersions(full.versions || []);
        setSel((s) => (s === d.latest_version ? full.latest_version : s));
      })
      .catch((e: { detail?: string; status?: number }) => live && setErr(e?.detail || "HTTP " + (e?.status ?? "error")));
    return () => {
      live = false;
    };
    // re-read history whenever a new version lands
  }, [tid, d.id, d.latest_version]);

  const current = (versions || []).find((v) => v.version === sel) || (sel === d.latest_version ? d.latest : null);
  const older = (versions || []).filter((v) => v.version < sel);
  const canCompare = older.length > 0;
  const cmpFrom = compare != null && compare < sel ? compare : null;

  return (
    <div className="dlv-open" id={"dlv-open-" + d.id}>
      <div className="dlv-bar">
        {versions && versions.length > 1 ? (
          <label>
            <span className="v2-sr">Version</span>
            <select
              className="dlv-select"
              value={sel}
              aria-label={"Version of " + d.name}
              onChange={(e) => {
                const v = Number(e.target.value);
                setSel(v);
                if (compare != null && compare >= v) setCompare(null);
              }}
            >
              {versions.map((v) => (
                <option key={v.version} value={v.version}>
                  v{v.version}
                  {v.version === d.latest_version ? " (latest)" : ""}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span>v{sel}</span>
        )}
        {current ? <span title={versionTitle(current)}>{sourceLabel(current)}</span> : null}
        {current?.created_at ? <span title={clockTime(current.created_at)}>· {relTime(current.created_at)}</span> : null}
        <span className="v2-grow" />
        {canCompare ? (
          cmpFrom == null ? (
            <Button variant="ghost" size="sm" data-act="compare" onClick={() => setCompare(older[0].version)}>
              Compare with v{older[0].version}
            </Button>
          ) : (
            <>
              <label>
                <span className="v2-sr">Compare against</span>
                <select className="dlv-select" value={cmpFrom} aria-label="Compare against version" onChange={(e) => setCompare(Number(e.target.value))}>
                  {older.map((v) => (
                    <option key={v.version} value={v.version}>
                      against v{v.version}
                    </option>
                  ))}
                </select>
              </label>
              <Button variant="ghost" size="sm" data-act="preview" onClick={() => setCompare(null)}>
                Preview
              </Button>
            </>
          )
        ) : null}
        {current ? (
          <a className="dlv-link" href={current.raw_url + "?download=1"} download title={"Download v" + current.version + " (" + formatBytes(current.size_bytes) + ")"}>
            Download
          </a>
        ) : null}
      </div>
      {err ? <p className="dlv-err" role="alert">History unavailable — {err}.</p> : null}
      {cmpFrom != null ? (
        <DeliverableDiff tid={tid} did={d.id} from={cmpFrom} to={sel} />
      ) : (
        <DeliverablePreview d={d} v={current} tasks={tasks} />
      )}
      {current?.note ? <p className="dlv-note">Note: {current.note}</p> : null}
      {versions && versions.length > 1 ? (
        <div className="dlv-hist" role="list" aria-label={"Version history of " + d.name}>
          {versions.map((v) => (
            <button
              key={v.version}
              type="button"
              role="listitem"
              className="dlv-hist-row"
              aria-current={v.version === sel ? "true" : undefined}
              title={versionTitle(v)}
              onClick={() => {
                setSel(v.version);
                if (compare != null && compare >= v.version) setCompare(null);
              }}
            >
              <span className="dlv-hist-v">v{v.version}</span>
              <span>{sourceLabel(v)}</span>
              <span className="dlv-hist-note">{v.note || (v.run_id ? "run " + v.run_id.slice(0, 8) : "")}</span>
              <span>{formatBytes(v.size_bytes)}</span>
              <span title={v.created_at ? clockTime(v.created_at) : undefined}>{relTime(v.created_at)}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ---- the section ----------------------------------------------------------------- */
export function DeliverablesSection({ task, full = true }: { task: Pick<Task, "id" | "status"> & Partial<Task>; full?: boolean }) {
  const tid = task.id;
  const { state, reload } = useDeliverables(tid);
  const { snap } = useSnapshot();
  const auth = useActingAuthority();
  const toast = useToast();
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => setOpen(null), [tid]);

  if (state.status === "unavailable" || task.is_root) return null;
  const list = state.status === "ok" ? state.data.deliverables : [];
  const limits = state.status === "ok" ? state.data.limits : null;
  const closed = CLOSED.has(task.status);
  const canAttach = !!auth.human && !closed;
  if (!full && state.status !== "error" && !list.length) return null;

  const attachTitle = closed
    ? "Deliverables are frozen once a task is " + task.status
    : !auth.human
      ? auth.reason || "Read-only"
      : "Attach a document, table, image or PDF" + (limits ? " (max " + formatBytes(limits.max_bytes) + ")" : "");

  const onFiles = async (files: FileList | null) => {
    if (!files || !files.length) return;
    setBusy(true);
    let added = 0;
    let same = 0;
    for (const f of Array.from(files)) {
      try {
        const r = await uploadDeliverable(tid, f, { actorId: auth.human?.id });
        if (r.deduplicated) same++;
        else added++;
      } catch (e) {
        toast("Couldn't attach " + f.name + " — " + ((e as Error).message || "upload failed"), "danger", { sticky: true });
      }
    }
    setBusy(false);
    if (fileRef.current) fileRef.current.value = "";
    if (added || same) {
      toast(added ? "Attached " + added + " file" + (added === 1 ? "" : "s") + (same ? " · " + same + " unchanged" : "") : "No changes — identical to the latest version", added ? "ok" : "");
      reload();
    }
  };

  let body: ReactNode;
  if (state.status === "loading") body = <p className="dlv-note" aria-busy="true">Loading deliverables…</p>;
  else if (state.status === "error") body = <p className="dlv-err" role="alert">Deliverables unavailable — {state.message}.</p>;
  else if (!list.length)
    body = (
      <p className="dlv-note" data-testid="dlv-empty">
        None yet. Agents publish files by writing to <code>{limits?.outputs_folder || ".orcha/outputs"}</code>
        {canAttach ? "; you can also attach one." : "."}
      </p>
    );
  else
    body = (
      <div className="dlv-list" role="list" aria-label="Deliverables">
        {list.map((d) => {
          const isOpen = open === d.id;
          const v = d.latest;
          return (
            <div key={d.id} className="dlv-item" role="listitem" data-deliverable={d.path}>
              <button
                type="button"
                className="dlv-row"
                aria-expanded={isOpen}
                aria-controls={"dlv-open-" + d.id}
                title={KIND_LABEL[d.kind] + " · " + d.path}
                onClick={() => setOpen(isOpen ? null : d.id)}
              >
                <Icon name="chev" cls="v2-ico dlv-chev" />
                <KindGlyph kind={d.kind} />
                <span className="dlv-name">
                  <span className="dlv-dir">{dirOf(d.path)}</span>
                  {d.name}
                </span>
                <span className="dlv-meta">
                  {d.version_count > 1 ? (
                    <span className="dlv-ver" title={d.version_count + " versions"}>
                      v{d.latest_version}
                    </span>
                  ) : null}
                  <span className="dlv-src">{sourceLabel(v)}</span>
                  <span className="dlv-size">{formatBytes(v?.size_bytes)}</span>
                  <span title={d.updated_at ? clockTime(d.updated_at) : undefined}>{relTime(d.updated_at)}</span>
                </span>
              </button>
              {isOpen ? <DeliverableDetail tid={tid} d={d} tasks={snap?.tasks} /> : null}
            </div>
          );
        })}
      </div>
    );

  return (
    <section className="td-block dlv" aria-label="Deliverables" data-testid="deliverables">
      <style>{deliverablesCss}</style>
      <div className="dlv-h">
        <div className="td-block-k">
          Deliverables
          {list.length ? <span className="dlv-count">{list.length}</span> : null}
        </div>
        {canAttach || full ? (
          <>
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              data-testid="dlv-file"
              accept={limits ? limits.allowed_extensions.map((e) => "." + e).join(",") : undefined}
              onChange={(e) => void onFiles(e.target.files)}
            />
            <IconButton
              icon="plus"
              size="sm"
              label="Attach deliverable"
              title={attachTitle}
              disabled={!canAttach}
              busy={busy}
              data-act="attach-deliverable"
              onClick={() => fileRef.current?.click()}
            />
          </>
        ) : null}
      </div>
      {body}
    </section>
  );
}
