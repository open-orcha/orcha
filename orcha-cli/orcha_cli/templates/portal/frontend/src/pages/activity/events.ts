/**
 * Project events for Activity › Events (Agent E). Derived ONLY from the live
 * snapshot — the latest message per task (message_summary.last, or the
 * expanded thread when present) and each request's creation / answer — the
 * same sources as the Overview "Live activity" feed (HomePage activityEvents,
 * parity H-06). No event is fabricated: rows without a timestamp are dropped.
 *
 * Text is always human-readable (brief D4): request payloads / responses are
 * reduced to their question / summary / title field, never a raw JSON string.
 * Authors: a human message carries the human's alias when the snapshot knows
 * it (else "Human"); a message with no author is "system", never "—".
 */
import { normalizePayload, payloadText, payloadTitle as primitivePayloadTitle } from "../../components/primitives/Payload";
import type { OrchaRequest, Task } from "../../types";

export type EventKind = "message" | "decision" | "request" | "answer";
export interface ProjectEvent {
  key: string;
  kind: EventKind;
  who: string; // alias, "Human" or "system"
  /** the entity the event is about (task title / request type), shown muted */
  subject: string;
  /** request / answer counterpart (the target of a request, the requester of an answer) */
  other: string | null;
  /** request type in words ("question", "plan approval"); null for task messages */
  reqType: string | null;
  text: string;
  at: string; // ISO
  href: string;
  taskId: string | null;
  requestId: string | null;
  /** older consecutive comments by the same actor folded into this entry (collapseEvents) */
  folded?: ProjectEvent[];
}

export const EVENT_KIND_LABEL: Record<EventKind, string> = {
  message: "Message",
  decision: "Human message",
  request: "Request",
  answer: "Answer",
};

/**
 * One readable line for a request payload / response — the shared primitive
 * (components/primitives/Payload): the question / summary / title field,
 * else the other readable strings. Never JSON, never "[object Object]".
 */
export function payloadLine(v: unknown): string {
  const t = primitivePayloadTitle(v) || payloadText(v);
  if (t) return t;
  // numbers / booleans only (no readable string anywhere): "k: v" pairs, still never JSON
  const n = normalizePayload(v);
  if (n && typeof n === "object" && !Array.isArray(n))
    return Object.entries(n as Record<string, unknown>)
      .filter(([, x]) => typeof x === "number" || typeof x === "boolean")
      .map(([k, x]) => k.replace(/_/g, " ") + ": " + String(x))
      .join(" · ");
  return "";
}

/**
 * Markdown source → plain preview text (brief D4: no raw formats in a feed
 * line). Keeps the words, drops the syntax: heading hashes, list / quote
 * markers, code fences and backticks, emphasis markers and link / image
 * syntax. Word-internal underscores / stars (snake_case, a * b) are kept.
 */
export function mdPlain(src: string): string {
  return (src || "")
    .replace(/```[^\n]*\n?/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*>[ \t]?/gm, "")
    .replace(/^[ \t]*(?:[-*+]|\d{1,3}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, "")
    .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, "")
    .replace(/`([^`\n]*)`/g, "$1")
    .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1$2")
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1$2")
    .replace(/~~(?=\S)([^\n]*?\S)~~/g, "$1");
}

const clip = (s: string, n: number) => {
  const one = mdPlain(s).replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
};
const humanWho = (alias: string | null | undefined) => (alias && alias !== "human" ? alias : "Human");
const typeWord = (t: string) => (t ? t.replace(/_/g, " ").toLowerCase() : "request");
const typeLabel = (t: string) => (t ? t.charAt(0).toUpperCase() + t.slice(1).replace(/_/g, " ") : "Request");

/**
 * Who the request was first addressed to. After an escalation `to` is the
 * human it was escalated to; the creation event was sent to `escalated_from`
 * (parity r2: the feed must not read "asked you" for an agent-addressed request).
 */
export function requestFirstTarget(r: OrchaRequest): string | null {
  return (r.escalated && r.escalated_from ? r.escalated_from : r.to) || null;
}

/**
 * Who answered. An answer given BEFORE the escalation (or with no known
 * escalation time) belongs to the agent it was escalated away from, not to
 * the human it now targets (parity r2: "you answered" was mis-credited).
 */
export function requestAnsweredBy(r: OrchaRequest): string | null {
  const before =
    !!r.responded_at && (!r.escalated_at || Date.parse(r.responded_at) < Date.parse(r.escalated_at));
  return (r.escalated && r.escalated_from && before ? r.escalated_from : r.to) || null;
}

export function projectEvents(tasks: Task[], requests: OrchaRequest[]): ProjectEvent[] {
  const out: ProjectEvent[] = [];
  tasks.forEach((t) => {
    const href = "/tasks?task=" + encodeURIComponent(t.id);
    const thread = t.thread || [];
    if (thread.length) {
      thread.forEach((m, i) =>
        out.push({
          key: "t:" + t.id + ":" + (m.id || i),
          kind: m.is_human ? "decision" : "message",
          who: m.is_human ? humanWho(m.from) : m.from && m.from !== "—" ? m.from : "system",
          subject: t.title,
          text: clip(m.body || "", 200),
          other: null,
          reqType: null,
          at: m.at || "",
          href,
          taskId: t.id,
          requestId: null,
        }),
      );
      return;
    }
    const last = t.message_summary && t.message_summary.last;
    if (last) {
      const at = (last as { created_at?: string; at?: string }).created_at ?? last.at ?? "";
      out.push({
        key: "t:" + t.id + ":last",
        kind: last.is_human ? "decision" : "message",
        who: last.is_human ? humanWho(last.author_alias) : last.author_alias || "system",
        subject: t.title,
        text: clip(last.body || "", 200),
        other: null,
        reqType: null,
        at,
        href,
        taskId: t.id,
        requestId: null,
      });
    }
  });
  requests.forEach((r) => {
    const href = "/requests?req=" + encodeURIComponent(r.id);
    const taskId = r.task_link ? r.task_link.task_id : null;
    const firstTo = requestFirstTarget(r);
    const subject = typeLabel(r.type) + (firstTo ? " → " + firstTo : "");
    const reqType = typeWord(r.type);
    out.push({ key: "r:" + r.id, kind: "request", who: r.from || "system", subject, other: firstTo, reqType, text: clip(payloadLine(r.payload), 200), at: r.created_at || "", href, taskId, requestId: r.id });
    if (r.responded_at)
      out.push({ key: "a:" + r.id, kind: "answer", who: requestAnsweredBy(r) || "system", subject: typeLabel(r.type) + (r.from ? " from " + r.from : ""), other: r.from || null, reqType, text: clip(payloadLine(r.response) || "(no answer text)", 200), at: r.responded_at, href, taskId, requestId: r.id });
  });
  return out.filter((e) => e.at && Date.parse(e.at)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export function filterEvents(evs: ProjectEvent[], agentAlias: string | null, taskId: string | null): ProjectEvent[] {
  return evs.filter((e) => (!agentAlias || e.who === agentAlias) && (!taskId || e.taskId === taskId));
}

/**
 * Fold a run of consecutive comments (message / human message) by the SAME
 * actor into one entry so the feed is not a wall of identical "X commented
 * on Y" lines (review r3). Input is newest-first; the kept entry is the
 * newest one (its text / time) and `folded` holds the older ones:
 *   - all on one task  → "commented 3× on <task>"
 *   - several tasks    → "commented on <task> and 2 more" (expandable)
 * The snapshot carries only each task's LATEST message, so the multi-task
 * fold is the common case; the same-task fold fires when a thread is loaded.
 * Requests / answers never fold. `sameGroup` (e.g. same day) bounds a run.
 */
export function collapseEvents(evs: ProjectEvent[], sameGroup: (a: ProjectEvent, b: ProjectEvent) => boolean = () => true): ProjectEvent[] {
  const out: ProjectEvent[] = [];
  const isComment = (e: ProjectEvent) => e.kind === "message" || e.kind === "decision";
  for (const e of evs) {
    const prev = out[out.length - 1];
    if (prev && isComment(e) && prev.kind === e.kind && prev.who === e.who && sameGroup(prev, e)) {
      out[out.length - 1] = { ...prev, folded: [...(prev.folded ?? []), e] };
      continue;
    }
    out.push(e);
  }
  return out;
}

/** true when every folded comment is on the entry's own task ("commented N× on …"). */
export function foldedSameTask(e: ProjectEvent): boolean {
  return !!e.folded?.length && !!e.taskId && e.folded.every((f) => f.taskId === e.taskId);
}

/* ---- Events view filter pills: "All events · Messages · Requests" ---- */
export type EventKindFilter = "all" | "messages" | "requests";
export const EVENT_KIND_FILTERS: { key: EventKindFilter; label: string; hint: string }[] = [
  { key: "all", label: "All events", hint: "Task messages and request activity" },
  { key: "messages", label: "Messages", hint: "The latest message on each task" },
  { key: "requests", label: "Requests", hint: "Requests sent and answered" },
];
export function parseEventKind(v: string | null | undefined): EventKindFilter {
  return v === "messages" || v === "requests" ? v : "all";
}
export function matchesEventKind(e: ProjectEvent, f: EventKindFilter): boolean {
  if (f === "messages") return e.kind === "message" || e.kind === "decision";
  if (f === "requests") return e.kind === "request" || e.kind === "answer";
  return true;
}

/* ---- request wording: plain verbs, never "sent an info to" (wave-4 review) ---- */
const article = (w: string) => (/^[aeiou]/i.test(w) ? "an " : "a ") + w;

/**
 * What a request asks for, as the words after "asked <target>":
 * "a question", "for info", "to approve a plan", "to take on a task",
 * else "for a <type>". `reqType` is the spaced lower-case type word.
 */
export function askPhrase(reqType: string | null | undefined): string {
  const t = (reqType || "").trim();
  if (!t || t === "request") return "for something";
  if (t === "question") return "a question";
  if (t === "info" || t === "info request" || t === "information") return "for info";
  if (t === "plan approval") return "to approve a plan";
  if (t === "task") return "to take on a task";
  return "for " + article(t);
}

/** The thing an answer answers: "question", "info request", "plan approval", "task request", else the type. */
export function answerNoun(reqType: string | null | undefined): string {
  const t = (reqType || "").trim();
  if (!t || t === "request") return "request";
  if (t === "info" || t === "information") return "info request";
  if (t === "task") return "task request";
  return t;
}
