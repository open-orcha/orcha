/**
 * Live changes — the client half of run_changes_routes.py: what an agent's run is
 * changing on disk, computed in the run's OWN checkout (its worktree, or the base
 * checkout for conversation runs) while it runs, and the reap-time captured diff once
 * it has finished. Never fabricated: every count comes from the server's git scan.
 *
 *   GET /api/agents/{aid}/runs/{rid}/changes?since=<version>
 *   GET /api/agents/{aid}/runs/{rid}/changes/diff?path=
 *
 * `useRunChanges` is the ONE poller per open workspace: ~1.5 s while the panel is open
 * and the run is live, a slow badge refresh (10 s) while it is closed, a single read
 * for a finished run, and nothing at all while the browser tab is hidden. Unchanged
 * polls ride `?since=` and come back as a tiny `{unchanged:true}`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkerRun } from "../activity/runModel";
import type { WorktreeChangedFile } from "../../cloud/codespace/worktreeApi";

export type RunChangedFile = WorktreeChangedFile;

export interface RunChangesPayload {
  available: boolean;
  reason?: string | null;
  detail?: string | null;
  running: boolean;
  run_status?: string;
  source?: "live" | "captured";
  root?: "worktree" | "base" | null;
  branch?: string | null;
  base?: { kind: "merge_base" | "head" | "captured"; ref: string | null; sha: string | null } | null;
  shared_checkout?: boolean;
  files: RunChangedFile[];
  summary: { files: number; additions: number; deletions: number };
  truncated?: boolean;
  version?: string;
  as_of?: string;
}

interface Unchanged {
  unchanged: true;
  version: string;
  running: boolean;
  as_of: string;
}

export interface RunDiffPayload {
  available: boolean;
  reason?: string | null;
  detail?: string | null;
  path?: string;
  diff?: string;
  binary?: boolean;
  truncated?: boolean;
  source?: "live" | "captured";
}

const base = (aid: string, rid: string) =>
  "/api/agents/" + encodeURIComponent(aid) + "/runs/" + encodeURIComponent(rid) + "/changes";

export async function fetchRunChanges(aid: string, rid: string, since?: string | null): Promise<RunChangesPayload | Unchanged> {
  const r = await fetch(base(aid, rid) + (since ? "?since=" + encodeURIComponent(since) : ""));
  if (!r.ok) throw new Error("changes " + r.status);
  return (await r.json()) as RunChangesPayload | Unchanged;
}

export async function fetchRunDiff(aid: string, rid: string, path: string): Promise<RunDiffPayload> {
  const r = await fetch(base(aid, rid) + "/diff?path=" + encodeURIComponent(path));
  if (!r.ok) {
    let detail = "the diff could not be loaded (" + r.status + ")";
    try {
      const j = await r.json();
      if (j && typeof j.detail === "string") detail = j.detail;
    } catch {
      /* not JSON */
    }
    return { available: false, reason: "http_" + r.status, detail };
  }
  return (await r.json()) as RunDiffPayload;
}

export const LIVE_POLL_MS = 1500;
export const BADGE_POLL_MS = 10000;
const FRESH_MS = 1600;

const runIdOf = (r: WorkerRun) => r.run_id || r.id || "";

/**
 * Which run the workspace's changes button speaks for: the RUNNING run ("Live
 * changes"), else the newest finished run — only when it captured a real, non-empty
 * diff ("View changes"). Anything else shows no button (a button over nothing would lie).
 */
export function changesTarget(runs: WorkerRun[] | null | undefined): { run: WorkerRun; live: boolean } | null {
  const list = runs || [];
  const running = list.find((r) => r.status === "running" && runIdOf(r));
  // L8: a running run with no checkout recorded has nothing on disk to read — no button.
  // (An older backend that never sends the checkout fields keeps the button.)
  if (running && hasCheckout(running)) return { run: running, live: true };
  const latest = list.find((r) => r.status !== "running" && runIdOf(r));
  if (latest && (latest.diff || "").trim()) return { run: latest, live: false };
  return null;
}

/** The run recorded a checkout to scan (its worktree or base checkout). Runs from a
 *  backend that predates those fields (neither key present) are given the benefit. */
export function hasCheckout(r: Pick<WorkerRun, "worktree" | "base_cwd">): boolean {
  if (!("worktree" in r) && !("base_cwd" in r)) return true;
  return !!((r.worktree || "").trim() || (r.base_cwd || "").trim());
}

const sig = (f: RunChangedFile) => f.status + ":" + (f.additions ?? "-") + ":" + (f.deletions ?? "-");

/** Paths that are new, or whose status/counts moved, between two scans. */
export function changedPaths(prev: RunChangedFile[] | null, next: RunChangedFile[]): string[] {
  if (!prev) return [];
  const before = new Map(prev.map((f) => [f.path, sig(f)]));
  return next.filter((f) => before.get(f.path) !== sig(f)).map((f) => f.path);
}

const hidden = () => typeof document !== "undefined" && document.hidden;

export interface RunChangesState {
  payload: RunChangesPayload | null;
  error: string | null;
  /** when the server last confirmed this payload (ms epoch) */
  checkedAt: number | null;
  /** paths that just appeared or changed — flashed briefly */
  fresh: Set<string>;
  refresh: () => void;
}

/**
 * Poll one run's changes. `aid`/`rid` null = idle (no requests). `active` = the panel
 * is open (fast cadence). `live` = the run is running (finished runs are read once).
 */
export function useRunChanges(aid: string | null, rid: string | null, { live, active }: { live: boolean; active: boolean }): RunChangesState {
  const [payload, setPayload] = useState<RunChangesPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const payloadRef = useRef<RunChangesPayload | null>(null);
  const token = useRef(0);
  const inFlight = useRef(false);
  const freshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const key = aid && rid ? aid + "/" + rid : null;

  // a new run starts from nothing (never show another run's files)
  useEffect(() => {
    token.current++;
    payloadRef.current = null;
    inFlight.current = false;
    setPayload(null);
    setError(null);
    setCheckedAt(null);
    setFresh(new Set());
  }, [key]);

  useEffect(() => () => {
    if (freshTimer.current) clearTimeout(freshTimer.current);
  }, []);

  const tick = useCallback(() => {
    if (!aid || !rid || inFlight.current) return;
    const my = token.current;
    inFlight.current = true;
    const prev = payloadRef.current;
    fetchRunChanges(aid, rid, prev?.version)
      .then((d) => {
        if (my !== token.current) return;
        setError(null);
        setCheckedAt(Date.now());
        if ("unchanged" in d && d.unchanged) return;
        const next = d as RunChangesPayload;
        const moved = changedPaths(prev ? prev.files : null, next.files || []);
        payloadRef.current = next;
        setPayload(next);
        if (moved.length) {
          setFresh(new Set(moved));
          if (freshTimer.current) clearTimeout(freshTimer.current);
          freshTimer.current = setTimeout(() => setFresh(new Set()), FRESH_MS);
        }
      })
      .catch((e: unknown) => {
        if (my !== token.current) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (my === token.current) inFlight.current = false;
      });
  }, [aid, rid]);

  useEffect(() => {
    if (!key) return;
    if (!hidden()) tick();
    if (!live) return; // a finished run's captured diff never changes: one read
    const every = active ? LIVE_POLL_MS : BADGE_POLL_MS;
    const id = setInterval(() => {
      if (!hidden()) tick();
    }, every);
    const onVis = () => {
      if (!hidden()) tick();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [key, live, active, tick]);

  return { payload, error, checkedAt, fresh, refresh: tick };
}

/** "3 files +42 −7" — the compact count the button badge and panel header share. */
export function summaryText(s: { files: number; additions: number; deletions: number } | null | undefined): string {
  if (!s || !s.files) return "";
  return s.files + (s.files === 1 ? " file" : " files") + " +" + s.additions + " −" + s.deletions;
}
