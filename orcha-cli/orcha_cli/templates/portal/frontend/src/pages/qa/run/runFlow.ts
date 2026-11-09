/**
 * The run flow's addresses and words (pure; tested). Everything a run needs to be found again lives
 * in the URL and on the server, so a reload, a tab change or a project switch loses nothing.
 *
 *   ?view=run                          pick what to run
 *   ?view=run&kind=map                 its options (`chose=1`: Back returns to the pick)
 *   ?view=run&pass=live                an onboarding pass whose agent has not started it yet
 *   ?view=sessions&session=<id>&sub=run  the live run, with its device
 *
 * `from` is where Back goes. From onboarding it carries `after=<pass>`: the step moves on once that
 * pass is done.
 */
import { qaHref } from "../parts";
import type { Platform, QaSession, SessionKind } from "../qaApi";
import { sessionKindWord } from "../qaWords";
import { NO_AGENT } from "../setup/setup";

/** The onboarding phases an agent runs. */
export const RUN_PASSES = ["live", "bring_in", "first_run"] as const;
export type RunPass = (typeof RUN_PASSES)[number];

export const parsePass = (v: string | null): RunPass | null => (RUN_PASSES.includes(v as RunPass) ? (v as RunPass) : null);

const PASS_KIND: Record<RunPass, SessionKind> = { live: "map", bring_in: "draft", first_run: "check" };
export const passKind = (p: RunPass): SessionKind => PASS_KIND[p];

/** A run's page. It keeps `from` for its Back. */
export function runHref(s: { id: string; platform?: string | null }, from: string | null): string {
  return qaHref({ view: "sessions", platform: s.platform && s.platform !== "ios" ? s.platform : null, session: s.id, sub: "run", from });
}

/** An onboarding pass that has no session yet. */
export function passHref(pass: RunPass, from: string | null): string {
  return qaHref({ view: "run", pass, from });
}

/** Where a run started from onboarding comes back to: this exact step, and which pass it waited on. */
export function onboardingFrom(search: string, pass: RunPass): string {
  const p = new URLSearchParams(search);
  p.set("after", pass);
  return "?" + p.toString();
}

/** "Mapping", "Exploring", "Drafting", "Checking". */
export function liveWord(kind: SessionKind): string {
  if (kind === "map") return "Mapping";
  if (kind === "explore") return "Exploring";
  if (kind === "draft") return "Drafting";
  if (kind === "check") return "Checking";
  return sessionKindWord(kind);
}

/** "3:12" since it started; empty when the start is unknown. */
export function elapsed(from: string | null | undefined, now: number): string {
  const at = Date.parse(from ?? "");
  if (!Number.isFinite(at)) return "";
  const secs = Math.max(0, Math.floor((now - at) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor(secs / 60) % 60;
  const ss = String(secs % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** The device a queued session is waiting for, when another run holds it. */
export function waitingDevice(s: Pick<QaSession, "result">): string | null {
  const r = s.result;
  if (!r || typeof r !== "object") return null;
  const d = (r as { waiting_device?: unknown }).waiting_device;
  return typeof d === "string" && d ? d : null;
}

export const isQueued = (s: Pick<QaSession, "queued_at" | "claimed_at">): boolean => !!s.queued_at && !s.claimed_at;

/** Whatever runs in the project now: a session, or an onboarding pass no agent has started yet. */
export interface LiveRun {
  key: string;
  sessionId: string | null;
  pass: RunPass | null;
  kind: SessionKind;
  platform: Platform | null;
  device: string | null;
  startedAt: string | null;
  waiting: boolean;
  waitingFor: string | null;
  goal: string | null;
}

export function liveOfSession(s: QaSession): LiveRun {
  const queued = isQueued(s);
  const held = waitingDevice(s);
  return {
    key: s.id,
    sessionId: s.id,
    pass: null,
    kind: s.kind,
    platform: s.platform,
    device: held ?? (s.platform === "web" ? null : s.device_name?.replace(/_/g, " ") ?? null),
    startedAt: s.started_at,
    waiting: queued,
    waitingFor: queued ? held : null,
    goal: s.goal,
  };
}

/** The pass the onboarding row is running, when it has a task: bringing tests in has none, and is no run. */
export function runningPass(phases: Partial<Record<string, { state?: string; task_id?: string | null } | undefined>> | null | undefined): RunPass | null {
  return RUN_PASSES.find((p) => phases?.[p]?.state === "running" && !!phases?.[p]?.task_id) ?? null;
}

export function liveOfPass(pass: RunPass, phase: { task_id?: string | null; started_at?: string | null; blocked_reason?: string | null }): LiveRun {
  const noAgent = phase.blocked_reason === NO_AGENT;
  return { key: `pass:${phase.task_id ?? pass}`, sessionId: null, pass, kind: passKind(pass), platform: null, device: null, startedAt: phase.started_at ?? null, waiting: noAgent, waitingFor: noAgent ? "an agent" : null, goal: null };
}

/** The pill's words: what runs and for how long, or what it waits for. A busy device is never a failure. */
export function pillWords(r: LiveRun, now: number): string {
  if (r.waitingFor) return `Waiting for ${r.waitingFor}`;
  if (r.waiting) return `${liveWord(r.kind)} · waiting to start`;
  const t = elapsed(r.startedAt, now);
  return t ? `${liveWord(r.kind)} · ${t}` : liveWord(r.kind);
}

/** The address that returns to a run from wherever a person is. */
export function liveRunHref(r: LiveRun, search: string): string {
  if (r.sessionId) return runHref({ id: r.sessionId, platform: r.platform }, search);
  return passHref(r.pass ?? "live", search);
}

/** Is this address already showing the run? */
export function showing(r: LiveRun, search: string): boolean {
  const p = new URLSearchParams(search);
  if (r.sessionId) return p.get("session") === r.sessionId && p.get("sub") === "run";
  return p.get("view") === "run" && p.get("pass") === r.pass;
}

/** Did this run start from onboarding? Its `from` then names the pass it waits on. */
export const fromOnboarding = (from: string | null): boolean => !!from && new URLSearchParams(from).has("after");

/** The pick's lines: each fits one row of its card. */
export const KIND_LINE: Record<"map" | "explore" | "draft" | "check", string> = {
  map: "Walk the app and chart every screen.",
  explore: "Find what breaks, like a new user.",
  draft: "Write test scenarios for you to approve.",
  check: "Run your approved scenarios.",
};
