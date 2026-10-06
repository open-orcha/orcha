/**
 * Presentation model for one Activity run-log row (Agent E, fix round 1).
 *
 * The classification itself is lib/classify.ts (shared with the agent and
 * task Runs tabs) and is NOT changed here. This only turns a classified
 * LogEvent into something readable in a narrow inspector:
 *   - a short sentence-case kind label ("Tool", "Result", "Thinking" …) and a
 *     tone, instead of a 150px uppercase column;
 *   - a meaningful one-line summary (the tool's description / command / path,
 *     the first line of a tool result) instead of the duplicated
 *     "TOOL RESULT  tool result";
 *   - details as a labelled key/value list (tool input objects) or plain text,
 *     never a raw JSON string (brief D4);
 *   - the run-complete line toned by the run's real outcome, so a killed or
 *     failed run is never painted success-green.
 * Colour is reserved for errors (review: blue "Tool" / green "Done" labels
 * were colour noise) — every other label is muted text. The worker's own
 * result line is "Done"; the process-exit line the portal appends ("exited ·
 * exit 0", the stream's terminal status) is "Exit", so a finished run never
 * shows two consecutive "Done" rows.
 */
import type { LogEvent } from "../../lib/classify";
import type { RunBucket } from "./runModel";

export type LogTone = "ok" | "info" | "warn" | "danger" | "accent" | "muted" | "neutral";

export interface LogRowView {
  kind: string; // short label
  tone: LogTone;
  text: string; // one-line (or short multi-line) summary; never raw JSON
  fields: [string, string][] | null; // tool-input key/values
  body: string | null; // long text detail (tool output, thinking)
  raw: string | null; // unparseable structured detail, shown as "Raw payload"
}

const KIND: Record<string, { kind: string; tone: LogTone }> = {
  boot: { kind: "Wake", tone: "muted" },
  narrate: { kind: "Said", tone: "muted" },
  think: { kind: "Thinking", tone: "muted" },
  tool: { kind: "Tool", tone: "muted" },
  result: { kind: "Result", tone: "muted" },
  subagent: { kind: "Subagent", tone: "muted" },
  decision: { kind: "Embodent", tone: "muted" },
  error: { kind: "Error", tone: "danger" },
  done: { kind: "Done", tone: "muted" },
};

/** The portal-appended process-exit row: a bare status word, optionally "· exit N". */
const EXIT_LINE = /^[a-z_]+( · exit -?\d+)?$/;

const LABEL_KIND: Record<string, string> = {
  "injected prompt": "Prompt",
  "orcha-action": "Embodent",
  decision: "Decision",
  hook: "Hook",
  reasoning: "Reasoning",
  lifecycle: "System",
  progress: "Progress",
  log: "Output",
};

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function firstLine(s: string): string {
  const line = s.split("\n").map((l) => l.trim()).find((l) => l && !/^=+.*=+$/.test(l)) || "";
  return clip(line, 160);
}

function tryParse(s: string): unknown {
  const t = s.trim();
  if (!t || (t[0] !== "{" && t[0] !== "[" && t[0] !== '"')) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

function scalar(v: unknown): string | null {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

/** "file_path" → "File path" */
export function humanKey(k: string): string {
  const s = k.replace(/[_-]+/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : k;
}

const SUMMARY_KEYS = ["description", "command", "file_path", "path", "pattern", "url", "query", "prompt", "subject"];

/** Pretty "Tool · summary" line + key/values for a tool-input object. */
function toolInput(detail: string): { summary: string; fields: [string, string][] | null; raw: string | null } {
  const v = tryParse(detail);
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const fields: [string, string][] = [];
    let complex = false;
    for (const [k, val] of Object.entries(o)) {
      const s = scalar(val);
      if (s == null) {
        complex = true;
        fields.push([humanKey(k), JSON.stringify(val, null, 2)]);
      } else if (s !== "") fields.push([humanKey(k), s]);
    }
    const key = SUMMARY_KEYS.find((k) => typeof o[k] === "string" && (o[k] as string).trim());
    return { summary: key ? firstLine(o[key] as string) : "", fields: fields.length ? fields : null, raw: complex && !fields.length ? JSON.stringify(v, null, 2) : null };
  }
  if (v !== undefined) return { summary: "", fields: null, raw: JSON.stringify(v, null, 2) };
  return { summary: firstLine(detail), fields: null, raw: null };
}

/** Human text for the run-complete payload (classify stores it JSON-stringified). */
function doneText(text: string): string {
  const v = tryParse(text);
  if (typeof v === "string") return v.replace(/_/g, " ");
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const t = scalar(o.result) || scalar(o.summary) || scalar(o.message) || scalar(o.subtype);
    if (t) return t;
  }
  return text.replace(/^"|"$/g, "");
}

export function doneTone(bucket: RunBucket | null, stoppedByHuman = false): LogTone {
  if (bucket === "failed") return stoppedByHuman ? "muted" : "danger";
  return "muted";
}

export function logRowView(ev: LogEvent, outcome: { bucket: RunBucket; stoppedByHuman?: boolean } | null = null): LogRowView {
  const base = KIND[ev.type] || { kind: ev.label ? humanKey(ev.label) : "Event", tone: "neutral" as LogTone };
  let kind = LABEL_KIND[ev.label] || base.kind;
  let tone = base.tone;
  const detail = ev.detail || "";
  let text = ev.text || "";
  let fields: [string, string][] | null = null;
  let body: string | null = null;
  let raw: string | null = null;

  if (ev.type === "tool" || (ev.type === "decision" && ev.label === "orcha-action")) {
    const ti = toolInput(detail);
    text = ti.summary ? text + " · " + ti.summary : text;
    fields = ti.fields;
    raw = ti.raw;
  } else if (ev.type === "result" || (ev.type === "decision" && ev.label === "decision")) {
    const parsed = tryParse(detail);
    if (parsed !== undefined && typeof parsed !== "string") raw = JSON.stringify(parsed, null, 2);
    else body = typeof parsed === "string" ? parsed : detail || null;
    const summary = firstLine(typeof parsed === "string" ? parsed : detail);
    if (!text || text === "tool result" || /^decision received/.test(text)) text = summary || (ev.type === "result" ? "(empty result)" : "Decision received");
  } else if (ev.type === "done") {
    if (EXIT_LINE.test(text.trim())) {
      kind = "Exit";
      text = text.trim().replace(/_/g, " ");
    } else text = doneText(text);
    tone = doneTone(outcome ? outcome.bucket : null, !!outcome?.stoppedByHuman);
  } else if (detail) {
    const parsed = tryParse(detail);
    if (parsed !== undefined && typeof parsed !== "string") raw = JSON.stringify(parsed, null, 2);
    else body = typeof parsed === "string" ? parsed : detail;
  }
  if (ev.type === "think" && text === "(thinking)" && body) text = firstLine(body);
  return { kind, tone, text, fields, body, raw };
}
