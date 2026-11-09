import type { Evidence, Finding, Json, Severity, Step } from "../types";
import { sevRank } from "../../map/kit";
import { isFrameWithheld } from "../lib/withheld-frame";

/** One image in the replay: a step frame, or (legacy runs) an evidence PNG. */
export interface Frame {
  /** Storage object path (column value, never derived). */
  path: string;
  /** `steps.seq` for step frames; `evidence.seq` for legacy evidence frames. */
  seq: number;
  atMs: number | null;
  label: string;
  /** The image is the "password was on screen" placeholder (`steps.args.frame_withheld`). */
  withheld?: boolean;
}

export interface Pin {
  frameIndex: number;
  severity: Severity;
  label: string;
}

export interface ReplayModel {
  frames: Frame[];
  pins: Pin[];
  /** True when the run has no step frames and evidence PNGs are shown instead. */
  legacy: boolean;
  /** `seq` of every action step (everything except `screen`), in order. */
  actionSeqs: number[];
}

// Step summaries ---------------------------------------------------------------

type Obj = { [key: string]: Json | undefined };

function isObj(v: Json | undefined): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function q(v: Json | undefined): string {
  return JSON.stringify(String(v ?? ""));
}

/** `{id:"x"}` → `id:"x"`, `{text:"General"}` → `text:"General"`, `{bounds:"…"}` → `bounds:…`. */
export function describeTarget(t: Json | undefined): string {
  if (!isObj(t)) return t == null ? "" : String(t);
  if (t.id != null) return `id:${q(t.id)}`;
  if (t.text != null) return `text:${q(t.text)}`;
  if (t.label != null) return `label:${q(t.label)}`;
  if (t.index != null) return `index:${t.index}`;
  if (t.bounds != null) return `bounds:${t.bounds}`;
  if (t.x != null && t.y != null) return `(${t.x}, ${t.y})`;
  const rest = Object.entries(t).filter(([k]) => k !== "text_index");
  return rest.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
}

/** One-line summary of a step's kind + args, e.g. `tap target=text:"General"`. */
export function summarizeStep(step: Pick<Step, "kind" | "args">): string {
  const a: Obj = isObj(step.args) ? step.args : {};
  switch (step.kind) {
    case "tap":
    case "long_press":
    case "find":
    case "clear": {
      const t = describeTarget(a.target);
      return t ? `${step.kind} target=${t}` : step.kind;
    }
    case "type": {
      const t = describeTarget(a.target);
      // A secret fill is recorded by name only (`args.secret`); the value never reaches the site.
      if (typeof a.secret === "string" && a.secret) return `type secret=${a.secret}${t ? ` into ${t}` : ""}`;
      return `type text=${q(a.text)}${t ? ` into ${t}` : ""}`;
    }
    case "swipe": {
      const dir = a.direction ?? "";
      const pct = a.distance_percent != null ? ` ${a.distance_percent}%` : "";
      return `swipe ${dir}${pct}`.trim();
    }
    case "press":
      return `press ${a.key ?? ""}`.trim();
    case "open_url":
      return `open_url ${a.url ?? ""}`.trim();
    case "launch":
    case "terminate": {
      const id = a.bundle_id ?? a.app ?? a.url ?? "";
      return `${step.kind} ${id}`.trim();
    }
    case "wait":
      return a.ms != null ? `wait ${a.ms}ms` : "wait";
    case "evidence": {
      const n = a.seq != null ? `#${a.seq}` : "";
      const label = a.label != null ? ` ${q(a.label)}` : "";
      const sev = a.severity != null && a.severity !== "info" ? ` (${a.severity})` : "";
      return `evidence ${n}${label}${sev}`.replace(/\s+/g, " ").trim();
    }
    case "screen":
      return "screen";
    case "note": {
      // What `verdict` and `capture_evidence` record beside their rows.
      if (a.finding != null) return `note finding: ${a.finding}`;
      if (a.verdict != null) return `note verdict ${a.verdict}`;
      return "note";
    }
    default: {
      const parts = Object.entries(a).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
      return `${step.kind} ${parts.join(" ")}`.trim();
    }
  }
}

/** Result text contains "error" or "failed" (case-insensitive). */
export function isStepError(step: Pick<Step, "result">): boolean {
  return /error|failed/i.test(step.result ?? "");
}

/** Truncate for a list cell; the full text goes on `title`. */
export function truncate(text: string, max = 100): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

// Frames + pins ---------------------------------------------------------------

/** Index of the last frame whose `seq` ≤ `stepSeq` (0 when none). */
export function frameIndexAtOrBefore(frames: readonly Frame[], stepSeq: number): number {
  let idx = 0;
  for (let i = 0; i < frames.length; i++) {
    if (frames[i].seq <= stepSeq) idx = i;
    else break;
  }
  return idx;
}

/**
 * Findings' `repro_*_step`, evidence `step_seq` and scenario criteria steps are
 * *action* numbers (1-based, `screen` steps excluded — see `StepRecorder`).
 * Map an action number to the `steps.seq` it refers to.
 */
export function actionToStepSeq(actionSeqs: readonly number[], n: number | null | undefined): number | null {
  if (n == null || actionSeqs.length === 0) return null;
  if (n <= 0) return actionSeqs[0];
  return actionSeqs[Math.min(n, actionSeqs.length) - 1] ?? null;
}

/**
 * The `steps.seq` a run page deep link opens at: `?step=N` names a recorded step as it is;
 * `?action=N` names the Nth action (a finding's repro step, #190) and is mapped through the
 * run's actions, so interleaved `screen` steps don't shift it onto an unrelated tap.
 */
export function deepLinkStepSeq(
  steps: readonly LinkStep[],
  { step, action, finding }: { step?: number | null; action?: number | null; finding?: number | null },
  context: { findings?: readonly FindingReproLike[]; evidence?: readonly Pick<Evidence, "seq" | "step_seq">[] } = {},
): number | null {
  if (step != null) return step;
  const actionSeqs = [...steps].sort((a, b) => a.seq - b.seq).filter((s) => s.kind !== "screen").map((s) => s.seq);
  // `?finding=N` opens at the step the run's Findings tab names for that finding, whichever
  // numbering its repro used (#190); `?action=` stays the fallback for a finding not found.
  const f = finding != null ? context.findings?.find((x) => x.seq === finding) : undefined;
  if (f) {
    const repro = findingReproActions(steps, actionSeqs, context.evidence ?? [], f);
    const seq = actionToStepSeq(actionSeqs, repro.to ?? repro.from);
    if (seq != null) return seq;
    const captured = f.evidence_seqs?.length ? evidenceStepSeq(steps, actionSeqs, context.evidence ?? [], f.evidence_seqs[0]) : null;
    if (captured != null) return captured;
  }
  if (action == null) return null;
  return actionToStepSeq(actionSeqs, action);
}

/** The step fields the deep link and repro mapping read (`args` names an evidence step's seq). */
export type LinkStep = Pick<Step, "seq" | "kind"> & { args?: Step["args"] };

/** The finding fields its repro mapping reads. */
export type FindingReproLike = Pick<Finding, "seq" | "repro_from_step" | "repro_to_step"> & { evidence_seqs?: readonly number[] | null };

/** The `steps.seq` where evidence `evSeq` was captured: its own `evidence` step, else the action
 * after the `step_seq` actions its row says came before it. Null when the run has neither. */
export function evidenceStepSeq(
  steps: readonly LinkStep[],
  actionSeqs: readonly number[],
  evidence: readonly Pick<Evidence, "seq" | "step_seq">[],
  evSeq: number,
): number | null {
  const own = steps.find((s) => s.kind === "evidence" && isObj(s.args) && s.args.seq === evSeq);
  if (own) return own.seq;
  const row = evidence.find((e) => e.seq === evSeq);
  if (row?.step_seq == null) return null;
  return actionToStepSeq(actionSeqs, row.step_seq + 1);
}

/**
 * A finding's repro range in action numbers (#190). `repro_*_step` should count actions, but some
 * agents write the raw step number (the screen right after the bug) instead. A repro step comes
 * before the evidence that shows the bug, so when the number read as an action lands after the
 * finding's capture while read as a step it lands at or before it, it is a step number: it maps
 * to the action at or before that step. Without evidence to compare with, the numbers stay as
 * they are.
 */
export function findingReproActions(
  steps: readonly LinkStep[],
  actionSeqs: readonly number[],
  evidence: readonly Pick<Evidence, "seq" | "step_seq">[],
  f: FindingReproLike,
): { from: number | null; to: number | null } {
  const from = f.repro_from_step ?? null;
  const to = f.repro_to_step ?? null;
  const last = to ?? from;
  if (last == null || !f.evidence_seqs?.length) return { from, to };
  const captures = f.evidence_seqs
    .map((n) => evidenceStepSeq(steps, actionSeqs, evidence, n))
    .filter((s): s is number => s != null);
  if (captures.length === 0) return { from, to };
  const capture = Math.max(...captures);
  const asAction = actionToStepSeq(actionSeqs, last);
  if (asAction == null || asAction <= capture || last > capture) return { from, to };
  const toAction = (raw: number | null) => (raw == null ? null : Math.max(1, actionSeqs.filter((s) => s <= raw).length));
  return { from: toAction(from), to: toAction(to) };
}

export function buildReplayModel(
  steps: readonly Step[],
  evidence: readonly Evidence[],
  findings: readonly Finding[],
): ReplayModel {
  const ordered = [...steps].sort((a, b) => a.seq - b.seq);
  const actionSeqs = ordered.filter((s) => s.kind !== "screen").map((s) => s.seq);

  const stepFrames: Frame[] = ordered
    .filter((s): s is Step & { frame_path: string } => Boolean(s.frame_path))
    .map((s) => ({
      path: s.frame_path,
      seq: s.seq,
      atMs: s.at_ms,
      label: s.foreground ?? `step ${s.seq}`,
      ...(isFrameWithheld(s.args) ? { withheld: true } : {}),
    }));

  const evOrdered = [...evidence].sort((a, b) => a.seq - b.seq);

  if (stepFrames.length > 0) {
    const pins: Pin[] = [];
    const seen = new Set<string>();
    const push = (frameIndex: number, severity: Severity, label: string) => {
      const key = `${frameIndex}:${severity}`;
      if (seen.has(key)) return;
      seen.add(key);
      pins.push({ frameIndex, severity, label });
    };
    for (const f of findings) {
      const repro = findingReproActions(ordered, actionSeqs, evOrdered, f);
      const seq = actionToStepSeq(actionSeqs, repro.to ?? repro.from);
      if (seq == null) continue;
      push(frameIndexAtOrBefore(stepFrames, seq), f.severity, `F${f.seq} · ${f.title}`);
    }
    for (const e of evOrdered) {
      if (e.step_seq == null || e.severity === "info") continue;
      // step_seq = actions completed before the capture; the capture is the next action.
      const seq = actionToStepSeq(actionSeqs, e.step_seq + 1) ?? actionToStepSeq(actionSeqs, e.step_seq);
      if (seq == null) continue;
      push(frameIndexAtOrBefore(stepFrames, seq), e.severity, e.label ?? `evidence ${e.seq}`);
    }
    pins.sort((a, b) => a.frameIndex - b.frameIndex || sevRank(a.severity) - sevRank(b.severity));
    return { frames: stepFrames, pins, legacy: false, actionSeqs };
  }

  // Legacy run: no frames; the evidence PNGs form the sequence.
  const frames: Frame[] = evOrdered
    .filter((e): e is Evidence & { png_path: string } => Boolean(e.png_path))
    .map((e) => ({
      path: e.png_path,
      seq: e.seq,
      atMs: null,
      label: e.label ?? `evidence ${e.seq}`,
    }));
  const pins: Pin[] = [];
  frames.forEach((f, i) => {
    const e = evOrdered.find((x) => x.seq === f.seq);
    if (e && e.severity !== "info") {
      pins.push({ frameIndex: i, severity: e.severity, label: f.label });
    }
  });
  return { frames, pins, legacy: true, actionSeqs };
}

/** A finding/criterion's `repro_from_step..repro_to_step` (action numbers) as a raw
 * `steps.seq` range `[lo, hi]`, for matching against `run_logs.step_seq` (also a raw seq).
 * Null when both bounds are null. */
export function actionRangeToStepSeqRange(
  actionSeqs: readonly number[],
  from: number | null | undefined,
  to: number | null | undefined,
): [number, number] | null {
  if (from == null && to == null) return null;
  const lo = actionToStepSeq(actionSeqs, from ?? to);
  const hi = actionToStepSeq(actionSeqs, to ?? from);
  if (lo == null || hi == null) return null;
  return lo <= hi ? [lo, hi] : [hi, lo];
}

/** Steps (action numbers `from..to`) as one-line summaries, for repro lists. */
export function reproSteps(
  steps: readonly Step[],
  actionSeqs: readonly number[],
  from: number | null,
  to: number | null,
): Array<{ seq: number; text: string }> {
  if (from == null && to == null) return [];
  const a = Math.max(1, from ?? to ?? 1);
  const b = Math.max(a, to ?? from ?? a);
  const bySeq = new Map(steps.map((s) => [s.seq, s]));
  const out: Array<{ seq: number; text: string }> = [];
  for (let n = a; n <= b; n++) {
    const seq = actionSeqs[n - 1];
    const s = seq != null ? bySeq.get(seq) : undefined;
    if (!s || s.kind === "evidence" || s.kind === "note") continue;
    out.push({ seq: s.seq, text: summarizeStep(s) });
  }
  return out;
}
