/**
 * Drafting on the page (migration 095, `qa_drafting.py`): the conversation feed built from the
 * shared board, and the evidence behind each draft (its filmstrip, each criterion's badge, its
 * corrections from screen). Pure, so it is unit-tested.
 */
import type {
  BoardEvent,
  CorrectionBody,
  DraftingSession,
  EvidenceStatus,
  ScenarioEvidence,
} from "./types";
import { frameUrl } from "../../../qaApi";

/** A stored frame's id as the URL the portal serves it at. */
export function artifactUrl(path: string | null | undefined): string | null {
  return path ? frameUrl(path) : null;
}

// ---------- the conversation feed ----------

export type FeedActor = "Drafter" | "Explorer" | null;

export interface FeedItem {
  id: string;
  seq: number;
  kind: BoardEvent["kind"];
  /** Who speaks (null for the session's own notes). */
  actor: FeedActor;
  /** Whom a request is addressed to: "Drafter → Explorer: open Routines". */
  to: FeedActor;
  text: string;
  /** A muted second part: a screen's summary, a correction's reason. */
  detail: string | null;
  thumb: string | null;
  at: string;
}

function body(e: BoardEvent): Record<string, unknown> {
  return e.body && typeof e.body === "object" && !Array.isArray(e.body) ? (e.body as Record<string, unknown>) : {};
}

/** "Dialog "New routine" · 3 fields · buttons: …" -> "3 fields" style short detail. */
function shortSummary(summary: unknown): string | null {
  if (typeof summary !== "string" || !summary.trim()) return null;
  const parts = summary.split(" · ");
  const fields = parts.find((p) => /\d+ fields?$/.test(p));
  const buttons = parts.find((p) => p.startsWith("buttons: "));
  const out = [fields, buttons].filter(Boolean).join(" · ");
  return out || summary;
}

/** One line per board event, oldest first, as the feed shows it. */
export function feedItems(events: readonly BoardEvent[], limit = 80): FeedItem[] {
  const items: FeedItem[] = [];
  for (const e of events) {
    const b = body(e);
    const base = { id: e.id, seq: e.seq, kind: e.kind, at: e.created_at, thumb: artifactUrl(e.screenshot_path) };
    switch (e.kind) {
      case "request":
        items.push({ ...base, actor: "Drafter", to: "Explorer", text: e.title, detail: b.look_only ? "look only" : null, thumb: null });
        break;
      case "answer":
        items.push({ ...base, actor: "Explorer", to: null, text: e.title, detail: null });
        break;
      case "screen": {
        const named = Boolean(b.named);
        const name = (typeof b.name === "string" && b.name) || e.title;
        items.push({
          ...base,
          actor: "Explorer",
          to: null,
          text: named ? `found '${name}'` : `reached ${name}`,
          detail: shortSummary(b.summary),
        });
        break;
      }
      case "correction":
        items.push({
          ...base,
          actor: "Drafter",
          to: null,
          text: e.title.replace(/^Revised/, "revised"),
          detail: typeof b.reason === "string" && b.reason ? b.reason : b.from_screen === false ? null : "corrected from screen",
        });
        break;
      case "plan":
        items.push({ ...base, actor: "Drafter", to: null, text: e.title.replace(/^Plan:/, "plan:"), detail: null, thumb: null });
        break;
      case "note":
        items.push({ ...base, actor: "Drafter", to: null, text: e.title, detail: null, thumb: null });
        break;
      // What it read and each draft are the stage's and the log's; a person's feedback is on the card.
      case "read":
      case "search":
      case "draft":
      case "feedback":
        break;
      default:
        items.push({ ...base, actor: null, to: null, text: e.title, detail: null, thumb: null });
    }
  }
  return items.slice(-limit);
}

/** The newest plan's flows, for the plan strip. */
export interface PlanFlow {
  name: string;
  status: string;
  note: string | null;
  code_ref: string | null;
}

export function latestPlan(events: readonly BoardEvent[]): PlanFlow[] {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind !== "plan") continue;
    const flows = body(events[i]).flows;
    return Array.isArray(flows) ? (flows as PlanFlow[]) : [];
  }
  return [];
}

/** What the session line knows about one explorer of the session: its status, the device it
 * runs on and its platform. */
export interface SessionExplorer {
  id: string;
  status: string;
  /** The device it runs on, by name ("iPhone 17 Pro"), when the session names one. */
  device: string | null;
  target_kind: string | null;
}

const KIND_DEVICE: Record<string, string> = { ios: "an iOS device", android: "an Android device", web: "a browser", desktop: "the desktop" };

/** The device an explorer waits for or runs on, by name, else its kind ("an iOS device"). */
export function explorerDevice(e: Pick<SessionExplorer, "device" | "target_kind"> | null | undefined): string {
  const name = e?.device?.trim();
  if (name) return name;
  return KIND_DEVICE[e?.target_kind ?? ""] ?? "a device";
}

/** The explorer still waiting in the queue (for a busy device or a worker): none joined yet. */
export function waitingExplorer(session: DraftingSession, explorers: readonly SessionExplorer[]): SessionExplorer | null {
  if (session.explorer_joined_at) return null;
  return explorers.find((e) => e.status === "queued") ?? null;
}

/** Whether an explorer of the session is still going (queued, or running). */
export function explorerGoing(explorers: readonly SessionExplorer[]): boolean {
  return explorers.some((e) => e.status === "queued" || e.status === "running");
}

function clockLeft(deadline: string | null, now: number): string {
  const left = deadline ? Math.max(0, Math.round((Date.parse(deadline) - now) / 1000)) : null;
  return left == null || Number.isNaN(left) ? "" : ` · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} left`;
}

/**
 * The one line that says how the two agents are doing. An explorer still waiting for its device
 * is named with that device, and its clock is not shown: the session's clock starts with it, so
 * the wait costs it no walk time. "Drafted together" only once an explorer really joined:
 * a drafter that finished while the explorer waited says the explorer waits, not that the
 * session is over.
 */
export function sessionLine(session: DraftingSession | null, now: number, explorers: readonly SessionExplorer[] = []): string | null {
  if (!session) return null;
  if (session.status === "code_only") return session.note ?? "The explorer stopped: drafting from the code only.";
  if (session.status === "stopped") return "Stopped.";
  const waiting = waitingExplorer(session, explorers);
  // Started on its device (preparing it, or about to join), not joined yet.
  const starting = !waiting && !session.explorer_joined_at ? (explorers.find((e) => e.status === "running") ?? null) : null;
  const workflow = session.pairing === "workflow";
  if (session.status === "finished") {
    if (session.explorer_status === "running") return `Drafter done · explorer ${workflow ? "walking the flow queue" : "exploring"}${clockLeft(session.deadline_at, now)}`;
    if (waiting) return `Drafter done · the explorer is waiting for ${explorerDevice(waiting)}`;
    if (session.explorer_joined_at) return "Explored and drafted.";
    // A late explorer still joins a workflow pairing's queue (#462); a classic one explores on its own.
    if (starting) return workflow ? `Drafter done · the explorer is starting on ${explorerDevice(starting)}` : "Drafter done · the explorer explores on its own";
    return "Drafted from the code: the explorer did not join the session.";
  }
  if (session.explorer_status === "running") return `Exploring the app${session.status === "waiting" ? "" : clockLeft(session.deadline_at, now)}`;
  const head = session.status === "waiting" ? "Waiting for the drafter to start" : "Drafter reading the code";
  if (session.explorer_status === "queued") {
    // Without the explorers' rows, "queued" is all the session says about where it is.
    return starting ? `${head} · explorer starting on ${explorerDevice(starting)}` : `${head} · explorer waiting for ${explorerDevice(waiting)}`;
  }
  return `${head} · explorer ${session.explorer_status}${session.status === "waiting" ? "" : clockLeft(session.deadline_at, now)}`;
}

// ---------- evidence ----------

export interface FilmFrame {
  path: string;
  url: string;
  label: string;
  step: number | null;
  runId: string | null;
  /** The criteria (0-based) this screen backs, verified ones first. */
  criteria: number[];
  verified: boolean;
}

/** The screens a draft is based on, each once: verified ones first, in criterion order. */
export function filmstrip(rows: readonly ScenarioEvidence[], max = 8): FilmFrame[] {
  const byPath = new Map<string, FilmFrame>();
  const ordered = [...rows].sort(
    (a, b) => Number(b.status === "verified") - Number(a.status === "verified") || a.criterion_index - b.criterion_index,
  );
  for (const r of ordered) {
    if (!r.screenshot_path) continue;
    const cur = byPath.get(r.screenshot_path);
    if (cur) {
      if (!cur.criteria.includes(r.criterion_index)) cur.criteria.push(r.criterion_index);
      cur.verified ||= r.status === "verified";
      continue;
    }
    byPath.set(r.screenshot_path, {
      path: r.screenshot_path,
      url: artifactUrl(r.screenshot_path) as string,
      label: r.screen_name || r.route || "Screen",
      step: r.step,
      runId: r.run_id,
      criteria: [r.criterion_index],
      verified: r.status === "verified",
    });
  }
  return [...byPath.values()].slice(0, max);
}

export interface EvidenceCounts {
  verified: number;
  unconfirmed: number;
  code_only: number;
}

export function evidenceCounts(rows: readonly ScenarioEvidence[]): EvidenceCounts {
  const out: EvidenceCounts = { verified: 0, unconfirmed: 0, code_only: 0 };
  for (const r of rows) out[r.status] += 1;
  return out;
}

export const EVIDENCE_LABEL: Record<EvidenceStatus, string> = {
  verified: "verified on screen",
  unconfirmed: "unconfirmed",
  code_only: "code only",
};

/** What a badge's tooltip says. */
export function evidenceTitle(r: ScenarioEvidence): string {
  const where = r.screen_name ? ` on ${r.screen_name}${r.step != null ? ` (step ${r.step})` : ""}` : "";
  const code = r.code_ref ? ` · from ${r.code_ref}` : "";
  if (r.status === "verified") {
    return `Seen${where}${r.matched ? `: ${r.matched}` : ""}${r.source === "drafter" ? " · checked by the drafter with the explorer" : ""}${code}`;
  }
  if (r.status === "unconfirmed") return `Not confirmed on any screen yet${where ? ` (closest${where})` : ""}${code}`;
  return `No screen to check it against${code}`;
}

export interface CriterionCorrection {
  index: number;
  before: string | null;
  after: string | null;
  screenName: string | null;
  reason: string | null;
  thumb: string | null;
}

/** The newest "corrected from screen" change of each criterion. */
export function correctionsByIndex(events: readonly BoardEvent[]): Map<number, CriterionCorrection> {
  const out = new Map<number, CriterionCorrection>();
  const newestFirst = [...events].filter((e) => e.kind === "correction").sort((a, b) => b.seq - a.seq);
  for (const e of newestFirst) {
    const b = body(e) as CorrectionBody;
    if (b.from_screen === false) continue;
    for (const ch of b.changes ?? []) {
      if (out.has(ch.index)) continue;
      out.set(ch.index, {
        index: ch.index,
        before: ch.before,
        after: ch.after,
        screenName: b.screen_name ?? null,
        reason: b.reason ?? null,
        thumb: artifactUrl(e.screenshot_path),
      });
    }
  }
  return out;
}

/** Evidence and corrections for one draft, as the review card takes them. */
export interface DraftEvidence {
  rows: ScenarioEvidence[];
  corrections: Map<number, CriterionCorrection>;
}

export function evidenceByDraft(
  rows: readonly ScenarioEvidence[],
  corrections: readonly BoardEvent[],
): Map<string, DraftEvidence> {
  const out = new Map<string, DraftEvidence>();
  for (const r of rows) {
    const cur: DraftEvidence = out.get(r.scenario_id) ?? { rows: [], corrections: new Map() };
    cur.rows.push(r);
    out.set(r.scenario_id, cur);
  }
  const byScenario = new Map<string, BoardEvent[]>();
  for (const e of corrections) {
    if (!e.scenario_id) continue;
    byScenario.set(e.scenario_id, [...(byScenario.get(e.scenario_id) ?? []), e]);
  }
  for (const [id, events] of byScenario) {
    const cur: DraftEvidence = out.get(id) ?? { rows: [], corrections: new Map() };
    cur.corrections = correctionsByIndex(events);
    out.set(id, cur);
  }
  for (const v of out.values()) v.rows.sort((a, b) => a.criterion_index - b.criterion_index);
  return out;
}
