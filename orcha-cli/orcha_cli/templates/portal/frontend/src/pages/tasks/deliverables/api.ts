/**
 * Non-code deliverables — typed client for the task-scoped deliverables API
 * (portal_backend/deliverables_routes.py, migration 061). Reads only; the one
 * write (upload) goes through `uploadDeliverable`.
 */
import { useEffect, useRef, useState } from "react";
import { errorDetailText, getJSON } from "../../../api/client";
import { useSnapshot } from "../../../state/SnapshotProvider";

export type DeliverableKind = "markdown" | "text" | "csv" | "json" | "pdf" | "image";

export interface DeliverableVersion {
  version: number;
  source: "run_output" | "attached";
  run_id: string | null;
  author_agent_id: string | null;
  author_alias: string | null;
  author_kind: string | null;
  size_bytes: number;
  sha256: string;
  content_type: string;
  note: string | null;
  created_at: string | null;
  raw_url: string;
  text_url: string | null;
}

export interface Deliverable {
  id: string;
  task_id: string;
  path: string;
  name: string;
  kind: DeliverableKind;
  latest_version: number;
  version_count: number;
  created_at: string | null;
  updated_at: string | null;
  latest: DeliverableVersion | null;
  versions?: DeliverableVersion[];
}

export interface DeliverableLimits {
  max_bytes: number;
  max_deliverables_per_task: number;
  max_versions_per_deliverable: number;
  allowed_extensions: string[];
  outputs_folder: string;
}

export interface DeliverableList {
  task_id: string;
  deliverables: Deliverable[];
  limits: DeliverableLimits;
}

export interface DeliverableText {
  text: string;
  truncated: boolean;
  size_bytes: number;
  max_bytes: number;
  kind: DeliverableKind;
}

export interface DeliverableDiffResult {
  deliverable_id: string;
  path: string;
  kind: DeliverableKind;
  from: DeliverableVersion;
  to: DeliverableVersion;
  binary: boolean;
  bytes_changed: boolean;
  diff?: string;
  added?: number;
  removed?: number;
  identical?: boolean;
  truncated?: boolean;
}

export const TEXT_KINDS: ReadonlySet<DeliverableKind> = new Set(["markdown", "text", "csv", "json"]);

const base = (tid: string) => "/api/tasks/" + encodeURIComponent(tid) + "/deliverables";

export const deliverablesUrl = base;
export const deliverableUrl = (tid: string, did: string) => base(tid) + "/" + encodeURIComponent(did);

export function fetchDeliverables(tid: string, signal?: AbortSignal): Promise<DeliverableList> {
  return getJSON<DeliverableList>(base(tid), signal);
}
export function fetchDeliverable(tid: string, did: string, signal?: AbortSignal): Promise<Deliverable> {
  return getJSON<Deliverable>(deliverableUrl(tid, did), signal);
}
export function fetchDeliverableText(url: string, signal?: AbortSignal): Promise<DeliverableText> {
  return getJSON<DeliverableText>(url, signal);
}
export function fetchDeliverableDiff(tid: string, did: string, from: number, to: number, signal?: AbortSignal): Promise<DeliverableDiffResult> {
  return getJSON<DeliverableDiffResult>(deliverableUrl(tid, did) + "/diff?from=" + from + "&to=" + to, signal);
}

export interface UploadResult {
  created: boolean;
  deduplicated: boolean;
  deliverable: Deliverable;
  version: DeliverableVersion;
}

/** Multipart upload. `actorId` rides as author_agent_id for the header-less
 *  self-host lane; a trusted (proxy) session is attributed server-side. */
export async function uploadDeliverable(tid: string, file: File, opts: { path?: string; actorId?: string | null; note?: string } = {}): Promise<UploadResult> {
  const fd = new FormData();
  fd.append("file", file, file.name);
  if (opts.path) fd.append("path", opts.path);
  if (opts.actorId) fd.append("author_agent_id", opts.actorId);
  if (opts.note) fd.append("note", opts.note);
  const r = await fetch(base(tid), { method: "POST", body: fd });
  if (!r.ok) {
    let detail = "HTTP " + r.status;
    try {
      const j = await r.json();
      detail = errorDetailText(j?.detail) || detail;
    } catch {
      /* non-JSON error body */
    }
    throw Object.assign(new Error(detail), { status: r.status, detail });
  }
  return r.json() as Promise<UploadResult>;
}

/* ---- formatting ------------------------------------------------------------ */

export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10 * 1024 ? 1 : 0) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

export function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i + 1) : "";
}

/** "run · dev" / "attached · root" — who produced a version, never a guess. */
export function sourceLabel(v: DeliverableVersion | null | undefined): string {
  if (!v) return "";
  const who = v.author_alias || (v.source === "run_output" ? "agent run" : "");
  return (v.source === "run_output" ? "Run output" : "Attached") + (who ? " · " + who : "");
}

/* ---- list hook ------------------------------------------------------------- */

export type DeliverablesState =
  | { status: "loading" }
  | { status: "unavailable" } // this backend has no deliverables API (404) — render nothing
  | { status: "error"; message: string }
  | { status: "ok"; data: DeliverableList };

/** The task's deliverables, re-read on every snapshot bump (cheap; the signature
 *  check keeps the DOM stable when nothing changed). `reload` after an upload. */
export function useDeliverables(tid: string | null): { state: DeliverablesState; reload: () => void } {
  const { bump } = useSnapshot();
  const [state, setState] = useState<DeliverablesState>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  const sigRef = useRef<string | null>(null); // null = nothing painted yet
  const tokRef = useRef(0);

  useEffect(() => {
    sigRef.current = null;
    setState({ status: "loading" });
  }, [tid]);

  useEffect(() => {
    if (!tid) return;
    const tok = ++tokRef.current;
    fetchDeliverables(tid)
      .then((data) => {
        if (tok !== tokRef.current) return;
        // a body without a deliverables array is not this API (an old/foreign backend)
        if (!data || !Array.isArray(data.deliverables)) {
          if (sigRef.current === null) setState({ status: "unavailable" });
          return;
        }
        const sig = data.deliverables.map((d) => d.id + ":" + d.latest_version).join("|");
        if (sig === sigRef.current) return;
        sigRef.current = sig;
        setState({ status: "ok", data });
      })
      .catch((e: { status?: number; detail?: string }) => {
        if (tok !== tokRef.current) return;
        // 404 on the LIST = this backend predates the deliverables API (the task
        // itself exists — the detail pane is showing it): render nothing.
        if (e && e.status === 404 && sigRef.current === null) setState({ status: "unavailable" });
        else if (sigRef.current === null) setState({ status: "error", message: (e && (e.detail || (e.status ? "HTTP " + e.status : ""))) || "could not load deliverables" });
      });
  }, [tid, bump, nonce]);

  return { state, reload: () => setNonce((n) => n + 1) };
}
