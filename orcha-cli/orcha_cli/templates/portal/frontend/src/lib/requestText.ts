/**
 * Human text vs agent instructions on a request (backend mig 065).
 *
 * A code-thread question opens a directed request to the tagged agent. The
 * agent's wake text (anchor header, lesson guide with `<lesson title>`
 * placeholders, "reply via POST /api/code/threads/…", the portal deep link)
 * now lives in `requests.agent_payload` and never reaches people; `payload`
 * is just the question, and `detail` carries `display_title` + `code_thread`
 * {thread_id, kind, path, start_line, end_line, link}.
 *
 * Rows stored before the split still hold the combined text in `payload`
 * (the migration backfills the ones it can link to a thread). `humanizeRequest`
 * handles both: it strips the known agent-only blocks from a legacy payload
 * and derives the same title the backend would store
 * (code_space_routes.code_thread_title — keep the two in step).
 */

export interface CodeThreadRef {
  thread_id: string | null;
  kind: string;
  path: string;
  start_line: number;
  end_line: number;
  /** portal deep link, e.g. /code?path=a.ts&thread=<id> */
  link: string | null;
}

const KIND_LABELS: Record<string, string> = { question: "Question", why: "Why", teach: "Teach", note: "Note" };
const POLITE_LEAD_RE = /^(?:please\s+)?(?:give me|show me|walk me through|teach me|tell me|can you|could you|please)\s+(?:(?:a|an)\s+)?/i;
const CLAUSE_END_RE = /[:,;?!]|\.(?=\s|$)|\s[—–-]\s/;
const SUMMARY_MAX = 60;

/** The question's gist for a title (mirror of code_space_routes._question_summary). */
export function questionSummary(question: string): string {
  let line = (question || "").split(/\n/).map((l) => l.trim()).find(Boolean) ?? "";
  line = line.replace(POLITE_LEAD_RE, "");
  const m = CLAUSE_END_RE.exec(line);
  if (m) line = line.slice(0, m.index);
  line = line.trim();
  if (line.length > SUMMARY_MAX) {
    const head = line.slice(0, SUMMARY_MAX - 1);
    const sp = head.lastIndexOf(" ");
    line = (sp > 0 ? head.slice(0, sp) : head).trimEnd() + "…";
  }
  return line.charAt(0).toUpperCase() + line.slice(1);
}

const lineLabel = (s: number, e: number) => (s === e ? "L" + s : "L" + s + "–" + e);

/** "<Kind> · <gist> — <file> L<lines>" (mirror of code_space_routes.code_thread_title). */
export function codeThreadTitle(kind: string, path: string, start: number, end: number, question: string): string {
  const label = KIND_LABELS[kind] || (kind ? kind.charAt(0).toUpperCase() + kind.slice(1) : "Question");
  const base = (path || "").replace(/\/+$/, "").split("/").pop() || path;
  const where = base + " " + lineLabel(start, end);
  const gist = questionSummary(question);
  return gist ? label + " · " + gist + " — " + where : label + " · " + where;
}

// "[code thread — teach] local@8cf5234 deploy/docker-compose.yml:1-1\n"
const LEGACY_HEAD_RE = /^\[code thread — ([a-z]+)\] \S+@\S+ (.+?):(\d+)-(\d+)\n/;
const GUIDE_START = "\n\nanswer as a short lesson in markdown";
const REPLY_RE = /\n\nreply via POST \/api\/code\/threads\/([0-9a-fA-F-]+)\/messages[^\n]*(?:\nview\/reply in the portal: (\S+))?/;

/** A legacy combined code-thread payload split into the question and its thread, or null. */
export function parseLegacyCodeThread(text: unknown): { question: string; ref: CodeThreadRef } | null {
  if (typeof text !== "string") return null;
  const h = LEGACY_HEAD_RE.exec(text);
  if (!h) return null;
  const rest = text.slice(h[0].length);
  const reply = REPLY_RE.exec(rest);
  const guideAt = rest.indexOf(GUIDE_START);
  const cuts = [guideAt, reply ? reply.index : -1].filter((i) => i >= 0);
  // no trailer at all (a truncated row): drop a trailing partial guide/reply line if any
  const question = (cuts.length ? rest.slice(0, Math.min(...cuts)) : rest.replace(/\n\n(?:answer as a short lesson|reply via POST )[\s\S]*$/, "")).trim();
  const link = reply && reply[2] ? reply[2] : null;
  const tid = reply ? reply[1] : link ? new URLSearchParams(link.split("?")[1] || "").get("thread") : null;
  return {
    question,
    ref: { thread_id: tid, kind: h[1], path: h[2], start_line: Number(h[3]), end_line: Number(h[4]), link },
  };
}

function refFromDetail(d: Record<string, unknown> | null | undefined): CodeThreadRef | null {
  const c = d && typeof d === "object" ? (d as { code_thread?: unknown }).code_thread : null;
  if (!c || typeof c !== "object") return null;
  const o = c as Record<string, unknown>;
  if (typeof o.path !== "string") return null;
  const start = Number(o.start_line) || 1;
  return {
    thread_id: typeof o.thread_id === "string" ? o.thread_id : null,
    kind: typeof o.kind === "string" ? o.kind : "question",
    path: o.path,
    start_line: start,
    end_line: Number(o.end_line) || start,
    link: typeof o.link === "string" ? o.link : null,
  };
}

export interface HumanRequestText {
  /** what a person reads as the ask (agent-only blocks removed) */
  payload: unknown;
  /** a display title when the request has one (code-thread questions), else null */
  title: string | null;
  /** the code thread the request belongs to, when it came from one */
  codeThread: CodeThreadRef | null;
}

/** The human-facing view of a request's payload + detail (see file header). */
export function humanizeRequest(payload: unknown, detail?: Record<string, unknown> | null): HumanRequestText {
  const fromDetail = refFromDetail(detail);
  const legacy = parseLegacyCodeThread(payload);
  const ref = fromDetail ?? legacy?.ref ?? null;
  const question = legacy ? legacy.question : payload;
  const stored = detail && typeof detail.display_title === "string" && detail.display_title.trim() ? detail.display_title.trim() : null;
  const title = stored ?? (ref ? codeThreadTitle(ref.kind, ref.path, ref.start_line, ref.end_line, typeof question === "string" ? question : "") : null);
  return { payload: question, title, codeThread: ref ? { ...ref, link: ref.link ?? (legacy?.ref.link || null) } : null };
}
