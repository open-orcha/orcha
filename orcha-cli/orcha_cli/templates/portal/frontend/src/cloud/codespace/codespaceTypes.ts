/**
 * Code Space — wire shapes for the code_space_routes.py CONTRACT (frozen in
 * docs/orcha-code-space-design.md, built on a parallel branch):
 *
 *   POST /api/containers/{cid}/code/threads
 *        {ref,path,start_line,end_line,kind,body,tagged_agent_id?,actor_agent_id}
 *   GET  /api/containers/{cid}/code/threads?ref=&path=&status=
 *   GET  /api/code/threads/{tid}
 *   POST /api/code/threads/{tid}/messages  {body,actor_agent_id,resolve?}
 *
 * Pure types + tiny pure helpers only — no DOM, no fetch (matches the
 * browseTypes.ts convention so the rest of codespace/** stays a thin render
 * layer over deterministic shapes).
 */

export type ThreadKind = "question" | "why" | "teach" | "note";
export type ThreadStatus = "open" | "answered" | "resolved";

export interface CodeThreadMessage {
  id: string;
  author_agent_id?: string | null;
  author_alias?: string | null;
  is_human: boolean;
  body: string;
  created_at: string;
}

// A thread as it appears in the per-file/per-repo LIST endpoint.
export interface CodeThreadSummary {
  id: string;
  repo?: string | null;
  ref: string;
  sha: string;
  path: string;
  start_line: number;
  end_line: number;
  kind: ThreadKind;
  status: ThreadStatus;
  created_by_agent_id?: string | null;
  created_by_alias?: string | null;
  tagged_agent_id?: string | null;
  tagged_alias?: string | null;
  request_id?: string | null;
  created_at: string;
  updated_at: string;
  message_count?: number;
  // computed against the requested ref via the browse blob-sha cache — false
  // means the file's blob at `ref` no longer matches the thread's pinned sha,
  // so the anchor is honestly "outdated" until cross-sha remap lands (v-later).
  blob_match?: boolean;
  // Item 3 (Recent quick-jump) only: the thread's opening message body, set
  // by the ?recent= list mode for the row snippet — undefined on every other
  // list shape (by-path counts, per-file rows), which never fetch it.
  first_message?: string | null;
}

// Per-file counts returned when the list is fetched WITHOUT a ?path= filter
// (repo-wide) — keyed by file path, used for the (optional) tree count badges.
export interface CodeThreadFileCounts {
  [path: string]: number;
}

export interface CodeThreadListPayload {
  threads: CodeThreadSummary[];
  counts_by_path?: CodeThreadFileCounts;
}

export interface CodeThreadDetailPayload {
  thread: CodeThreadSummary;
  messages: CodeThreadMessage[];
}

export interface CreateThreadBody {
  ref: string;
  path: string;
  start_line: number;
  end_line: number;
  kind: ThreadKind;
  body: string;
  tagged_agent_id?: string | null;
  actor_agent_id: string;
}

export interface CreateThreadResponse {
  thread: CodeThreadSummary;
  message: CodeThreadMessage;
}

export interface PostMessageBody {
  body: string;
  actor_agent_id: string;
  resolve?: boolean;
}

export interface PostMessageResponse {
  thread: CodeThreadSummary;
  message: CodeThreadMessage;
}

/* ---- one-click question templates (kind selector) -------------------------
 * Founder-designed copy — the composer renders these as one-click buttons;
 * picking one seeds `kind` + a starter body the human can edit before send. */
export interface ThreadTemplate {
  kind: ThreadKind;
  label: string;
  starterBody: string;
}
export const THREAD_TEMPLATES: ThreadTemplate[] = [
  { kind: "question", label: "How does this work?", starterBody: "How does this work?" },
  { kind: "why", label: "Why this decision?", starterBody: "Why this decision?" },
  { kind: "teach", label: "Teach me this concept", starterBody: "Teach me this concept." },
  { kind: "note", label: "Note", starterBody: "" },
];

export function kindLabel(kind: ThreadKind): string {
  switch (kind) {
    case "question": return "Question";
    case "why": return "Why";
    case "teach": return "Teach";
    default: return "Note";
  }
}

// Item 3 — Recent tab's compact per-row glyph (kind at a glance without the
// full kind-tag pill's width).
export function kindGlyph(kind: ThreadKind): string {
  switch (kind) {
    case "question": return "?";
    case "why": return "!";
    case "teach": return "🎓";
    default: return "·";
  }
}

// "outdated — pinned to <sha7>" honesty chip text (blob_match === false).
export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : "";
}

// Anchor label rendered on rail chips / breadcrumbs, e.g. "12" or "12-18".
export function anchorLabel(startLine: number, endLine: number): string {
  return startLine === endLine ? String(startLine) : `${startLine}-${endLine}`;
}

// Group repo-wide threads by path (Phase 4 Learn tab + optional tree badges).
export function groupByPath(threads: CodeThreadSummary[]): Map<string, CodeThreadSummary[]> {
  const m = new Map<string, CodeThreadSummary[]>();
  threads.forEach((t) => {
    const list = m.get(t.path);
    if (list) list.push(t);
    else m.set(t.path, [t]);
  });
  return m;
}

// Phase 4: teach|why threads only, aggregated repo-wide.
export function learnThreads(threads: CodeThreadSummary[] | null | undefined): CodeThreadSummary[] {
  // null-safe: a shape mismatch here once black-screened the rail (Learn bug).
  return (threads ?? []).filter((t) => t.kind === "teach" || t.kind === "why");
}
