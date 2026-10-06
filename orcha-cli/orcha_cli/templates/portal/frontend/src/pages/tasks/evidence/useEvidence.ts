/**
 * Data hooks for the proof-of-work evidence pack.
 *
 *  useEvidence(taskId, bump?)        GET /api/tasks/{tid}/evidence — re-fetched when
 *                                    `bump` changes (pass the snapshot bump), polled every
 *                                    4 s while a Verdikt run is open and every 15 s while
 *                                    one of the task's runs is still going. A stale answer
 *                                    for a previous task is dropped.
 *  useEvidenceSummaries(cid, bump?)  GET /api/containers/{cid}/evidence-summaries — the
 *                                    one-line summaries for Needs-you rows.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { VERDIKT_OPEN, type EvidencePack, type EvidenceSummary } from "./evidenceTypes";

export const VERDIKT_POLL_MS = 4000;
export const RUN_POLL_MS = 15000;

export interface EvidenceState {
  pack: EvidencePack | null;
  /** null = fine; otherwise a user-facing reason the pack could not be loaded */
  error: string | null;
  loading: boolean;
  reload: () => void;
  rebuild: () => Promise<void>;
  /** replace the pack's Verdikt run optimistically after a trigger/cancel answer */
  setPack: (p: EvidencePack) => void;
  /** the server has no evidence route (older backend) or answered something that is not a
   *  pack — the gate then shows no Proof row rather than a broken one */
  unsupported: boolean;
}

/** Shape check: only a real pack is rendered (a proxy / older server can answer 200 with
 *  something else). */
export function isEvidencePack(d: unknown): d is EvidencePack {
  const p = d as Partial<EvidencePack> | null;
  return !!p && typeof p === "object" && !!p.dod && Array.isArray(p.dod.items)
    && !!p.tests && typeof p.tests === "object" && !!p.changes && typeof p.changes === "object"
    && !!p.summary && typeof p.summary === "object" && Array.isArray(p.runs);
}

/** FastAPI's default 404 body for a route that does not exist (vs "Task not found"). */
async function isMissingRoute(r: Response): Promise<boolean> {
  if (r.status !== 404 && r.status !== 405) return false;
  try {
    const d = await r.clone().json();
    return d?.detail === "Not Found" || d?.detail === "Method Not Allowed";
  } catch {
    return false;
  }
}

async function detailOf(r: Response): Promise<string> {
  try {
    const d = await r.json();
    const x = d && d.detail;
    if (typeof x === "string") return x;
    if (Array.isArray(x) && x[0] && x[0].msg) return String(x[0].msg);
  } catch {
    /* non-JSON */
  }
  return "HTTP " + r.status;
}

export function useEvidence(taskId: string | null | undefined, bump?: unknown): EvidenceState {
  const [pack, setPackState] = useState<EvidencePack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const [tick, setTick] = useState(0);
  const tok = useRef(0);

  useEffect(() => {
    setPackState(null);
    setError(null);
    setUnsupported(false);
  }, [taskId]);

  useEffect(() => {
    if (!taskId) return;
    const my = ++tok.current;
    setLoading(true);
    fetch("/api/tasks/" + encodeURIComponent(taskId) + "/evidence")
      .then(async (r) => {
        if (my !== tok.current) return;
        if (!r.ok) {
          if (await isMissingRoute(r)) {
            if (my === tok.current) setUnsupported(true);
            return;
          }
          setError("Evidence unavailable — " + (await detailOf(r)));
          return;
        }
        let d: unknown = null;
        try {
          d = await r.json();
        } catch {
          d = null;
        }
        if (my !== tok.current) return;
        if (!isEvidencePack(d)) {
          setUnsupported(true);
          return;
        }
        setUnsupported(false);
        setPackState(d);
        setError(null);
      })
      .catch(() => {
        if (my === tok.current) setError("Evidence unavailable — the portal could not be reached");
      })
      .finally(() => {
        if (my === tok.current) setLoading(false);
      });
  }, [taskId, bump, tick]);

  // poll while something is still moving
  const vOpen = !!pack?.verdikt && VERDIKT_OPEN.indexOf(pack.verdikt.status) >= 0;
  const runLive = !!pack?.runs?.some((r) => r.status === "running");
  useEffect(() => {
    if (!taskId || (!vOpen && !runLive)) return;
    const h = setTimeout(() => setTick((n) => n + 1), vOpen ? VERDIKT_POLL_MS : RUN_POLL_MS);
    return () => clearTimeout(h);
  }, [taskId, vOpen, runLive, pack]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  const rebuild = useCallback(async () => {
    if (!taskId) return;
    const my = ++tok.current;
    setLoading(true);
    try {
      const r = await fetch("/api/tasks/" + encodeURIComponent(taskId) + "/evidence/rebuild", { method: "POST" });
      if (my !== tok.current) return;
      if (r.ok) {
        const d: unknown = await r.json().catch(() => null);
        if (isEvidencePack(d)) {
          setPackState(d);
          setError(null);
        } else setError("Evidence unavailable — unexpected answer from the portal");
      } else setError("Evidence unavailable — " + (await detailOf(r)));
    } catch {
      if (my === tok.current) setError("Evidence unavailable — the portal could not be reached");
    } finally {
      if (my === tok.current) setLoading(false);
    }
  }, [taskId]);
  const setPack = useCallback((p: EvidencePack) => setPackState(p), []);
  return { pack, error, loading, reload, rebuild, setPack, unsupported };
}

export function useEvidenceSummaries(cid: string | null | undefined, bump?: unknown): Record<string, EvidenceSummary> | null {
  const [map, setMap] = useState<Record<string, EvidenceSummary> | null>(null);
  const tok = useRef(0);
  useEffect(() => {
    if (!cid) return;
    const my = ++tok.current;
    fetch("/api/containers/" + encodeURIComponent(cid) + "/evidence-summaries")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d: { summaries?: Record<string, EvidenceSummary> } | null) => {
        const s = d && d.summaries && typeof d.summaries === "object" ? d.summaries : {};
        if (my === tok.current) setMap(s);
      })
      .catch(() => {
        if (my === tok.current) setMap(null);
      });
  }, [cid, bump]);
  return map;
}

/** POST helper returning ok/status/parsed body (never throws). */
export async function postJSON<T = unknown>(url: string, body?: unknown): Promise<{ ok: boolean; status: number; d: T & { detail?: unknown } }> {
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
    let d: unknown = {};
    try {
      d = await r.json();
    } catch {
      /* empty */
    }
    return { ok: r.ok, status: r.status, d: d as T & { detail?: unknown } };
  } catch {
    return { ok: false, status: 0, d: { detail: "the portal could not be reached" } as T & { detail?: unknown } };
  }
}

export function detailText(d: { detail?: unknown } | null | undefined): string {
  const x = d?.detail;
  if (typeof x === "string") return x;
  if (Array.isArray(x) && x[0] && typeof x[0] === "object" && "msg" in x[0]) return String((x[0] as { msg: unknown }).msg);
  return "";
}
