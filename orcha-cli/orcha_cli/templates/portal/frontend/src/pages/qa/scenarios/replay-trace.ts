/** A scenario's recorded path, built from its walk (`GET /api/qa/scenarios/{id}/trace`). */

export type SegmentState = "verified" | "evicted" | "unverified";

export interface TraceAction {
  index: number;
  kind: string;
  label: string;
  criterion: number | null;
  /** `literal` | `template` | `derived` (typed values only). */
  valueKind: string | null;
  secret: boolean;
  twin: [number, number] | null;
  templated: boolean;
}

export interface TraceSegment {
  index: number;
  text: string;
  fromAction: number | null;
  toAction: number | null;
  state: SegmentState;
  checks: string[];
  expectTexts: string[];
  okCount: number;
  failCount: number;
  verifiedRunId: string | null;
}

export interface ReplayTrace {
  id: string;
  targetKind: string;
  runId: string | null;
  recordedAt: string | null;
  lastReplayedAt: string | null;
  okCount: number;
  failCount: number;
  lastStop: { reason: string; detail: string | null; criterion: number | null } | null;
  policy: number | null;
  startUrl: string | null;
  viewport: [number, number] | null;
  actions: TraceAction[];
  segments: TraceSegment[];
}

/** Whether a check run gets this path: every segment holds, and there are criteria to prove. */
export function replayable(t: ReplayTrace): { ok: boolean; why: string } {
  if (t.actions.length === 0) return { ok: false, why: "the walk recorded no actions" };
  if (t.segments.some((s) => s.state === "evicted")) return { ok: false, why: "a criterion failed since it was walked: the agent finds the way again" };
  if (t.segments.length === 0) return { ok: false, why: "no criteria to prove" };
  return { ok: true, why: "every criterion holds: the check run gets this path to start from" };
}
