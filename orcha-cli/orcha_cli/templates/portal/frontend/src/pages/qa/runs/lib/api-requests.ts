/**
 * A run's API traffic and request checks (`run_api_requests` / `run_request_checks`,
 * migration 066), as `GET /api/runs/[id]/api-requests` returns them and the run page's API tab
 * shows them. Pure helpers only: filtering, status tone, paths, bodies.
 */

/** One request the app sent. */
export interface ApiRequestRow {
  seq: number;
  at_ms: number | null;
  scenario: string | null;
  scenario_id: string | null;
  method: string | null;
  url: string | null;
  /** The status the app got; null when no response came. */
  status: number | null;
  /** True when the request failed without a response (aborted, offline, timeout). */
  failed: boolean;
  request_body: string | null;
  kind?: string | null;
  /** How long it took, sent to answered (`api_log`, migration 136); null on older runs. */
  ms?: number | null;
}

/** One `Request:` check result, written at a scenario's outcome. */
export interface RequestCheckRow {
  seq: number;
  scenario: string | null;
  scenario_id: string | null;
  ok: boolean;
  text: string;
}

export interface ApiRequestsResponse {
  requests: ApiRequestRow[];
  checks: RequestCheckRow[];
}

export const REQUEST_CHECK_COLUMNS = "seq, scenario, scenario_id, ok, text";

function bool(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true";
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return v == null ? null : String(v);
}

/** A DB row as an `ApiRequestRow` (SQLite may hand back 0/1 and numeric strings). */
export function toApiRequestRow(r: Record<string, unknown>): ApiRequestRow {
  return {
    seq: Number(r.seq),
    at_ms: num(r.at_ms),
    scenario: str(r.scenario),
    scenario_id: str(r.scenario_id),
    method: str(r.method),
    url: str(r.url),
    status: num(r.status),
    failed: bool(r.failed),
    request_body: str(r.request_body),
    ms: num(r.ms),
  };
}

/** A call slower than this reads as slow in the API tab (amber), and twice it as very slow. */
export const SLOW_CALL_MS = 1000;

/** How long a call took: "84 ms", "1.2 s"; "–" when the run did not time it. */
export function fmtCallMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "–";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** "slow" from `SLOW_CALL_MS`, "very" from twice it, else null. */
export function callSpeed(ms: number | null | undefined): "slow" | "very" | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  return ms >= SLOW_CALL_MS * 2 ? "very" : ms >= SLOW_CALL_MS ? "slow" : null;
}

export function toRequestCheckRow(r: Record<string, unknown>): RequestCheckRow {
  return {
    seq: Number(r.seq),
    scenario: str(r.scenario),
    scenario_id: str(r.scenario_id),
    ok: bool(r.ok),
    text: str(r.text) ?? "",
  };
}

export type ApiRequestKind = "all" | "fetch" | "document" | "failed";

export const API_REQUEST_KINDS: readonly { value: ApiRequestKind; label: string }[] = [
  { value: "all", label: "All" },
  { value: "fetch", label: "API calls" },
  { value: "document", label: "Pages" },
  { value: "failed", label: "Failed" },
];

/** Failed: no response, or a 4xx/5xx, whatever sent it. */
export function isFailedRequest(r: ApiRequestRow): boolean {
  return r.failed || (r.status != null && r.status >= 400);
}

export function matchesKind(r: ApiRequestRow, kind: ApiRequestKind): boolean {
  if (kind === "fetch") return r.kind !== "document";
  if (kind === "document") return r.kind === "document";
  if (kind === "failed") return isFailedRequest(r);
  return true;
}

/** The URL's path and query (`/api/orders?page=2`), or the raw text when it does not parse. */
export function pathOf(url: string | null): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

export function filterRequests(rows: readonly ApiRequestRow[], kind: ApiRequestKind, query: string): ApiRequestRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter(
    (r) => matchesKind(r, kind) && (!q || pathOf(r.url).toLowerCase().includes(q) || (r.method ?? "").toLowerCase() === q),
  );
}

export function countByKind(rows: readonly ApiRequestRow[]): Record<ApiRequestKind, number> {
  const out: Record<ApiRequestKind, number> = { all: rows.length, fetch: 0, document: 0, failed: 0 };
  for (const r of rows) {
    if (r.kind === "document") out.document++;
    else out.fetch++;
    if (isFailedRequest(r)) out.failed++;
  }
  return out;
}

export type StatusTone = "ok" | "redirect" | "client" | "server" | "failed" | "pending";

export function statusTone(r: Pick<ApiRequestRow, "status" | "failed">): StatusTone {
  if (r.failed) return "failed";
  if (r.status == null) return "pending";
  if (r.status >= 500) return "server";
  if (r.status >= 400) return "client";
  if (r.status >= 300) return "redirect";
  return "ok";
}

export function statusLabel(r: Pick<ApiRequestRow, "status" | "failed">): string {
  if (r.failed) return "failed";
  return r.status == null ? "–" : String(r.status);
}

/** The body pretty-printed when it is JSON, else as sent. */
export function prettyBody(body: string | null): { text: string; json: boolean } {
  if (!body) return { text: "", json: false };
  try {
    return { text: JSON.stringify(JSON.parse(body), null, 2), json: true };
  } catch {
    return { text: body, json: false };
  }
}

export interface CheckGroup {
  scenario: string;
  scenarioId: string | null;
  checks: RequestCheckRow[];
  failed: number;
}

/** Checks grouped by scenario, in the order the scenarios first reported. */
export function groupChecks(checks: readonly RequestCheckRow[]): CheckGroup[] {
  const groups = new Map<string, CheckGroup>();
  for (const c of [...checks].sort((a, b) => a.seq - b.seq)) {
    const name = c.scenario ?? "No scenario";
    const key = `${c.scenario_id ?? ""}\u0000${name}`;
    let g = groups.get(key);
    if (!g) {
      g = { scenario: name, scenarioId: c.scenario_id, checks: [], failed: 0 };
      groups.set(key, g);
    }
    g.checks.push(c);
    if (!c.ok) g.failed++;
  }
  return [...groups.values()];
}

/** The check's text without its leading ✓/✗ (the row shows its own glyph). */
export function checkText(text: string): string {
  return text.replace(/^[✓✗]\s*/, "");
}


