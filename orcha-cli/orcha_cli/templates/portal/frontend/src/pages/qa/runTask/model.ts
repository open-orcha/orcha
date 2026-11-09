/**
 * A run task: a task created for Quality work, seen as one clean task. Pure (tested). `GET
 * /api/tasks/{tid}/qa` computes `run_result` from the run records; this turns it into what the Run
 * result card says. Nothing here is ever an id on screen.
 */
import type { Task } from "../../../types";
import { viewportWord, type Platform, type QaFinding, type TaskQa, type Verdict } from "../qaApi";
import { platformWord, sessionKindWord, verdictGlyph, verdictWord } from "../qaWords";
import { requestKindWord } from "../requests/words";
import { qualityName, readFinishDecision, type FinishDecision } from "./finishing";
import { isObj, listOf, numberOf, text } from "./read";

const SKILL_LINE = /^\s*Run \/orcha-qa-(map|explore|draft|check|triage)\b/;

/**
 * Is this task a Quality run? The project's list of run tasks says; a task started by a skill line is
 * one before that list has been read.
 */
export function isRunTaskRow(t: Pick<Task, "id" | "description">, runIds?: ReadonlySet<string>): boolean {
  return !!runIds?.has(t.id) || SKILL_LINE.test(t.description ?? "");
}

export type RunPhase = "waiting" | "running" | "finished" | "stopped";
export type Tone = "ok" | "danger" | "warn" | "neutral";

export interface RunRow { key: string; name: string; word: string; glyph: string; note: string | null; scenarioId: string | null }
export interface RunDraft { id: string; name: string; toReview: boolean }

export interface RunTaskModel {
  phase: RunPhase;
  /** "Check scenarios on iOS". */
  what: string;
  /** Drafting uses no device: nothing to watch or replay. */
  drafting: boolean;
  outcome: { word: string; glyph: string; tone: Tone };
  summary: string | null;
  /** Why it stopped, or why it could not say. */
  reason: string | null;
  scenarios: RunRow[];
  lines: RunRow[];
  findings: QaFinding[];
  drafts: RunDraft[];
  agent: string | null;
  device: string | null;
  build: string | null;
  screens: number | null;
  minutes: number | null;
  cost: number | null;
  session: string | null;
  platform: Platform | null;
  /** Where "What the agent did" goes. */
  workerRun: string | null;
  finish: FinishDecision | null;
}

const OUTCOME: Record<string, RunTaskModel["outcome"]> = {
  passed: { word: "Passed", glyph: "completed", tone: "ok" },
  failed: { word: "Failed", glyph: "failed", tone: "danger" },
  blocked: { word: "Blocked", glyph: "blocked", tone: "warn" },
  stopped: { word: "Could not finish", glyph: "blocked", tone: "warn" },
  running: { word: "Running", glyph: "in_progress", tone: "warn" },
};
const WAITING: RunTaskModel["outcome"] = { word: "Waiting", glyph: "pending", tone: "neutral" };
/** Only a check fails: findings are what the other runs are there to bring back. */
const FOUND: RunTaskModel["outcome"] = { word: "Found problems", glyph: "blocked", tone: "warn" };

const row = (raw: unknown, i: number): RunRow | null => {
  if (!isObj(raw)) return null;
  const v = text(raw.verdict) as Verdict | null;
  return {
    key: text(raw.scenario_id) ?? String(raw.index ?? i),
    name: text(raw.name) ?? text(raw.text) ?? "Scenario",
    word: v ? verdictWord(v) : "No verdict",
    glyph: verdictGlyph(v),
    note: text(raw.note),
    scenarioId: text(raw.scenario_id),
  };
};
const rows = (v: unknown) => listOf<unknown>(v).map(row).filter((r): r is RunRow => !!r);

/** What the card shows, or null when this task is no run task. */
export function runTaskModel(qa: TaskQa | null): RunTaskModel | null {
  const r = qa?.run_result;
  if (!qa?.is_run_task || !isObj(r)) return null;
  const outcome = text(r.outcome);
  const session = text(r.session_id);
  // A session in line for a device is `running` on the wire; nothing has started.
  const queued = outcome === "running" && !!qa.sessions.find((s) => s.id === session)?.queued;
  const phase: RunPhase = !outcome || queued ? "waiting" : outcome === "running" ? "running" : outcome === "passed" || outcome === "failed" ? "finished" : "stopped";
  const kind = text(r.kind);
  const platform = text(r.platform) as Platform | null;
  const kindWord = kind ? (kind in { map: 1, explore: 1, draft: 1, check: 1, triage: 1 } ? requestKindWord(kind) : sessionKindWord(kind as never)) : "Quality run";
  const deviceName = isObj(r.device) ? text(r.device.name) : null;
  const device = deviceName && platform === "web" ? viewportWord(deviceName) : deviceName?.replace(/_/g, " ") ?? null;
  const seconds = numberOf(r.duration_seconds);
  const links = isObj(r.links) ? r.links : {};
  const [summary, reason] = [text(r.summary), text(r.reason)];
  return {
    phase,
    what: platform ? `${kindWord} on ${platformWord(platform)}` : kindWord,
    drafting: kind === "draft",
    outcome: queued || !outcome ? WAITING : outcome === "failed" && kind !== "check" ? FOUND : OUTCOME[outcome] ?? WAITING,
    summary: summary ? qualityName(summary) : null,
    reason: reason ? qualityName(reason) : null,
    scenarios: rows(r.scenarios),
    lines: rows(r.lines),
    findings: listOf<QaFinding>(r.findings),
    drafts: listOf<unknown>(r.drafts).filter(isObj).map((d) => ({ id: String(d.id ?? ""), name: text(d.name) ?? "Scenario", toReview: d.status === "draft" })),
    agent: isObj(r.agent) ? text(r.agent.alias) : null,
    device,
    build: text(r.build),
    screens: numberOf(r.screens_reached) || null,
    minutes: seconds != null ? seconds / 60 : null,
    cost: numberOf(r.cost_usd),
    session,
    platform,
    workerRun: text(links.worker_run),
    finish: readFinishDecision(qa.final_decision),
  };
}
