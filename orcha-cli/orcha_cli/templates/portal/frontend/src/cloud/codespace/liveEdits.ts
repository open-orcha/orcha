/**
 * Phase 2 — Live panel edit extraction. Pure functions, no DOM: given the
 * classified run stream (lib/classify.ts's LogEvent[] — the SAME feed
 * runlog.tsx/useRunStream already produce; no new backend/instrumentation),
 * pick out Edit/Write/MultiEdit tool calls and turn each into a per-file
 * "patch card" — a synthetic unified-diff-like line list the existing
 * FilesChanged/diffLineClass add/del tinting can render directly.
 *
 * Tool input shapes (Claude Code tool_use.input, JSON-stringified into
 * LogEvent.detail by classifyLine — see classify.ts's `c.type === "tool_use"`
 * branch):
 *   Write      { file_path, content }
 *   Edit       { file_path, old_string, new_string }
 *   MultiEdit  { file_path, edits: [{ old_string, new_string }, ...] }
 */
import type { LogEvent } from "../../lib/classify";

export type LiveEditKind = "write" | "edit" | "multiedit";

export interface LiveEditEvent {
  kind: LiveEditKind;
  filePath: string;
  // synthetic unified-diff-style lines: "+" prefixed adds, "-" prefixed dels,
  // context lines bare — same shape diffLineClass()/FilesChanged expects.
  lines: string[];
  add: number;
  del: number;
  seq: number; // stable ordering key (index into the source stream)
}

const EDIT_TOOL_NAMES: Record<string, LiveEditKind> = {
  Write: "write",
  Edit: "edit",
  MultiEdit: "multiedit",
};

function safeParse(detail: string | undefined): Record<string, unknown> | null {
  if (!detail) return null;
  try {
    const v = JSON.parse(detail);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// old_string/new_string -> synthetic +/- lines (line-level diff is overkill
// here — the honest "painting" is showing what left and what arrived).
function editLines(oldStr: unknown, newStr: unknown): { lines: string[]; add: number; del: number } {
  const lines: string[] = [];
  let add = 0;
  let del = 0;
  const oldLines = typeof oldStr === "string" && oldStr.length ? oldStr.split("\n") : [];
  const newLines = typeof newStr === "string" && newStr.length ? newStr.split("\n") : [];
  oldLines.forEach((l) => { lines.push("-" + l); del++; });
  newLines.forEach((l) => { lines.push("+" + l); add++; });
  return { lines, add, del };
}

function writeLines(content: unknown): { lines: string[]; add: number; del: number } {
  const asLines = typeof content === "string" && content.length ? content.split("\n") : [];
  return { lines: asLines.map((l) => "+" + l), add: asLines.length, del: 0 };
}

/** Extract Edit/Write/MultiEdit events, in stream order, from a classified log. */
export function extractLiveEdits(events: LogEvent[]): LiveEditEvent[] {
  const out: LiveEditEvent[] = [];
  events.forEach((e, seq) => {
    if (e.type !== "tool") return;
    const toolKind = EDIT_TOOL_NAMES[e.text];
    if (!toolKind) return;
    const input = safeParse(e.detail);
    if (!input) return;
    const filePath = typeof input.file_path === "string" ? input.file_path : "";
    if (!filePath) return;

    if (toolKind === "write") {
      const { lines, add, del } = writeLines(input.content);
      out.push({ kind: toolKind, filePath, lines, add, del, seq });
      return;
    }
    if (toolKind === "edit") {
      const { lines, add, del } = editLines(input.old_string, input.new_string);
      out.push({ kind: toolKind, filePath, lines, add, del, seq });
      return;
    }
    // multiedit: one card per file, concatenating each sub-edit's lines
    const edits = Array.isArray(input.edits) ? (input.edits as Array<Record<string, unknown>>) : [];
    let lines: string[] = [];
    let add = 0;
    let del = 0;
    edits.forEach((ed) => {
      const r = editLines(ed.old_string, ed.new_string);
      lines = lines.concat(r.lines);
      add += r.add;
      del += r.del;
    });
    out.push({ kind: toolKind, filePath, lines, add, del, seq });
  });
  return out;
}

export interface FilePatchCard {
  filePath: string;
  edits: LiveEditEvent[]; // every edit event touching this file, in order
  add: number;
  del: number;
  lastSeq: number;
}

/** Group extracted edit events into one card per touched file (paint timeline). */
export function groupLiveEditsByFile(edits: LiveEditEvent[]): FilePatchCard[] {
  const byPath = new Map<string, FilePatchCard>();
  edits.forEach((e) => {
    let card = byPath.get(e.filePath);
    if (!card) {
      card = { filePath: e.filePath, edits: [], add: 0, del: 0, lastSeq: e.seq };
      byPath.set(e.filePath, card);
    }
    card.edits.push(e);
    card.add += e.add;
    card.del += e.del;
    card.lastSeq = Math.max(card.lastSeq, e.seq);
  });
  // most-recently-touched file first (the "painting" ordering the design calls for)
  return Array.from(byPath.values()).sort((a, b) => b.lastSeq - a.lastSeq);
}
