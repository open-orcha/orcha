/**
 * Learn quick starts — pure builder for the one-click lesson requests the Learn tab
 * (and the editor's floating Teach · Why lens) offer, aware of the open file and the
 * current line selection. Each quick start is a REAL teach/why code thread
 * (codespaceApi.createThread) anchored to a file + line range; the body is the
 * question the agent sees (it also gets the lesson-format guide server-side).
 */
import type { ThreadKind } from "./codespaceTypes";
import { baseName } from "./lesson";

export type QuickStartId = "explain-file" | "why-exists" | "teach-selection" | "why-selection" | "tour";

export interface QuickStart {
  id: QuickStartId;
  kind: Extract<ThreadKind, "teach" | "why">;
  label: string;
  /** Muted second line: what it anchors to. */
  hint: string;
  icon: string;
  path: string;
  start: number;
  end: number;
  body: string;
}

export interface QuickStartContext {
  /** The open file ("" when none). */
  path: string;
  /** Line count of the open file (0 when unknown). */
  lineCount?: number;
  selection?: { start: number; end: number } | null;
  /** Anchor file for a repo tour when no file is open (default README.md). */
  repoAnchor?: string;
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function linesWord(s: number, e: number): string {
  return s === e ? "line " + s : "lines " + s + "–" + e;
}

/** Quick starts for the given context, most specific first. */
export function buildQuickStarts(ctx: QuickStartContext): QuickStart[] {
  const out: QuickStart[] = [];
  const path = (ctx.path || "").replace(/^\/+/, "");
  const sel = ctx.selection && ctx.selection.start >= 1 ? ctx.selection : null;
  if (path && sel) {
    const where = linesWord(sel.start, sel.end);
    out.push({
      id: "teach-selection",
      kind: "teach",
      label: sel.start === sel.end ? "Teach me the concept at line " + sel.start : "Teach me the concept at lines " + sel.start + "–" + sel.end,
      hint: baseName(path) + " · " + where,
      icon: "spark",
      path,
      start: sel.start,
      end: sel.end,
      body: `Teach me the concept in ${baseName(path)} ${where}: what it is, how this code uses it, and what to read next.`,
    });
    out.push({
      id: "why-selection",
      kind: "why",
      label: "Why is it written this way?",
      hint: baseName(path) + " · " + where,
      icon: "info",
      path,
      start: sel.start,
      end: sel.end,
      body: `Why is ${baseName(path)} ${where} written this way? Walk me through the decision and the alternatives.`,
    });
  }
  if (path) {
    const n = Math.max(1, ctx.lineCount || 1);
    out.push({
      id: "explain-file",
      kind: "teach",
      label: "Explain this file",
      hint: baseName(path) + (ctx.lineCount ? " · " + ctx.lineCount + " lines" : ""),
      icon: "code",
      path,
      start: 1,
      end: n,
      body: `Explain ${path}: what it does, how it is structured, and the key lines to read first.`,
    });
    out.push({
      id: "why-exists",
      kind: "why",
      label: "Why does this exist?",
      hint: baseName(path),
      icon: "info",
      path,
      start: 1,
      end: 1,
      body: `Why does ${path} exist? What problem does it solve, and what would break without it?`,
    });
    const dir = dirOf(path);
    out.push({
      id: "tour",
      kind: "teach",
      label: dir ? "Give me a tour of " + dir + "/" : "Give me a tour of this repo",
      hint: dir ? "folder · anchored at " + baseName(path) : "repo · anchored at " + baseName(path),
      icon: "folder",
      path,
      start: 1,
      end: 1,
      body: dir
        ? `Give me a tour of the ${dir}/ folder, starting from ${baseName(path)}: what lives here, how the files fit together, and where to start reading.`
        : `Give me a tour of this repository, starting from ${path}: the main parts, how they fit together, and where to start reading.`,
    });
  } else {
    const anchor = ctx.repoAnchor || "README.md";
    out.push({
      id: "tour",
      kind: "teach",
      label: "Give me a tour of this repo",
      hint: "repo · anchored at " + anchor,
      icon: "folder",
      path: anchor,
      start: 1,
      end: 1,
      body: "Give me a tour of this repository: the main parts, how they fit together, and where to start reading.",
    });
  }
  return out;
}
