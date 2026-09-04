/**
 * Code Space — fetch wrappers over the code_space_routes.py CONTRACT (see the
 * module doc in codespaceTypes.ts). Errors classify through the SAME
 * ghlib.ts error ladder the rest of the GitHub-backed surfaces use, so the
 * rail can reuse the existing degrade components as-is.
 *
 *   POST /api/containers/{cid}/code/threads
 *   GET  /api/containers/{cid}/code/threads?ref=&path=&status=
 *   GET  /api/code/threads/{tid}
 *   POST /api/code/threads/{tid}/messages
 */
import { classifyError, type GhError } from "../github/ghlib";
import type {
  CodeThreadDetailPayload,
  CodeThreadListPayload,
  CreateThreadBody,
  CreateThreadResponse,
  PostMessageBody,
  PostMessageResponse,
  CodeThreadSummary,
  CodeThreadMessage,
} from "./codespaceTypes";

export type CsResult<T> = { ok: true; data: T } | { ok: false; error: GhError };

async function doFetch<T>(url: string, init?: RequestInit): Promise<CsResult<T>> {
  try {
    const r = await fetch(url, init);
    const body = await r.json().catch(() => null);
    if (!r.ok) return { ok: false, error: classifyError(r.status, body) };
    return { ok: true, data: body as T };
  } catch (e) {
    return { ok: false, error: { kind: "error", status: 0, detail: (e as Error).message } };
  }
}

function threadsPrefix(cid: string): string {
  return "/api/containers/" + encodeURIComponent(cid) + "/code/threads";
}

export function fetchThreads(
  cid: string,
  opts: { ref?: string; path?: string; status?: string } = {},
): Promise<CsResult<CodeThreadListPayload>> {
  const q = new URLSearchParams();
  if (opts.ref) q.set("ref", opts.ref);
  if (opts.path != null) q.set("path", opts.path);
  if (opts.status) q.set("status", opts.status);
  const qs = q.toString();
  return doFetch<CodeThreadListPayload>(threadsPrefix(cid) + (qs ? "?" + qs : ""));
}

// Item 3 — Recent quick-jump: the n newest threads across every path in the
// container (server caps n at 50; see code_space_routes.py's RECENT_THREADS_MAX).
export function fetchRecentThreads(
  cid: string,
  opts: { n?: number; status?: string } = {},
): Promise<CsResult<CodeThreadListPayload>> {
  const q = new URLSearchParams();
  q.set("recent", String(opts.n ?? 20));
  if (opts.status) q.set("status", opts.status);
  return doFetch<CodeThreadListPayload>(threadsPrefix(cid) + "?" + q.toString());
}

/* ---- wire normalization ---------------------------------------------------
 * The backend returns threads FLAT (thread columns at the top level; the
 * detail route inlines `messages`; the create route returns ONLY the thread
 * row). The UI's nested {thread, messages} shape is normalized HERE, in one
 * place — nothing downstream may assume the wire shape. (This mismatch is
 * what broke every thread open in v1.) */
type FlatThread = CodeThreadSummary & { messages?: CodeThreadMessage[] };

function normalizeDetail(flat: FlatThread): CodeThreadDetailPayload {
  const { messages, ...thread } = flat;
  return { thread: thread as CodeThreadSummary, messages: messages ?? [] };
}

function malformed(): { ok: false; error: GhError } {
  return { ok: false, error: { kind: "error", status: 200, detail: "malformed thread payload" } };
}

function isFlatThread(v: unknown): v is FlatThread {
  return !!v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string";
}

export async function createThread(cid: string, body: CreateThreadBody): Promise<CsResult<CreateThreadResponse>> {
  const r = await doFetch<FlatThread>(threadsPrefix(cid), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) return r;
  if (!isFlatThread(r.data)) return malformed();
  const { thread } = normalizeDetail(r.data);
  // the create route returns only the thread row — synthesize the first
  // message locally from what we just posted (reconciled on the next fetch).
  return {
    ok: true,
    data: {
      thread,
      message: {
        id: "local-" + thread.id,
        thread_id: thread.id,
        author_agent_id: body.actor_agent_id,
        is_human: true,
        body: body.body,
        created_at: thread.created_at,
      } as CodeThreadMessage,
    },
  };
}

export async function fetchThread(tid: string): Promise<CsResult<CodeThreadDetailPayload>> {
  const r = await doFetch<FlatThread>("/api/code/threads/" + encodeURIComponent(tid));
  if (!r.ok) return r;
  if (!isFlatThread(r.data)) return malformed();
  return { ok: true, data: normalizeDetail(r.data) };
}

export async function postThreadMessage(tid: string, body: PostMessageBody): Promise<CsResult<PostMessageResponse>> {
  // wire: the message POST returns the FLAT thread row (status may have
  // flipped) — synthesize the message locally, reconciled on the next fetch.
  const r = await doFetch<FlatThread>("/api/code/threads/" + encodeURIComponent(tid) + "/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) return r;
  if (!isFlatThread(r.data)) return malformed();
  const { thread } = normalizeDetail(r.data);
  return {
    ok: true,
    data: {
      thread,
      message: {
        id: "local-" + thread.id + "-" + thread.updated_at,
        thread_id: thread.id,
        author_agent_id: body.actor_agent_id,
        is_human: true,
        body: body.body,
        created_at: thread.updated_at,
      } as CodeThreadMessage,
    },
  };
}
