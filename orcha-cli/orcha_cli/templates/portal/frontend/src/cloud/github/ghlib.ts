/**
 * GitHub hub page — pure logic, ported line-for-line from the vanilla page's
 * static/pages/github-state.js (label colors, expertise suggestions, filters,
 * Fix-popover clauses) and static/pages/github-render.js (error classifiers).
 * No DOM, no fetch — everything here is a deterministic function so the page
 * component stays a thin render/state layer over the same behavior.
 *
 * Endpoint contract (portal_backend/github_hub_routes.py — UNCHANGED backend):
 *   GET  /api/containers/{cid}/github/issues
 *   GET  /api/containers/{cid}/github/pulls          (checks: ALWAYS null here)
 *   GET  /api/containers/{cid}/github/checks?numbers=1,2,3   (max 30 numbers)
 *   GET  /api/containers/{cid}/github/pulls/{number}
 *   GET  /api/containers/{cid}/github/issues/{number}
 *   POST /api/containers/{cid}/github/start  {kind, number, assignee_agent_id?}
 */
import type { Agent } from "../../types";

/* ---- wire shapes (github_hub_routes.py payloads) ------------------------- */
export interface GhLabel {
  name?: string | null;
  color?: string | null;
}
export interface GhRun {
  name?: string | null;
  status?: string | null;
  conclusion?: string | null;
  html_url?: string | null;
}
export interface ChecksRollup {
  passed?: number;
  failing?: number;
  pending?: number;
  total?: number | null;
  runs?: GhRun[];
}
export interface GhIssueRow {
  number: number;
  title?: string | null;
  labels?: GhLabel[];
  assignee?: string | null;
  updated_at?: string | null;
  html_url?: string | null;
  body_excerpt?: string | null;
  tracked_task_id?: string | null;
}
export interface GhPullRow {
  number: number;
  title?: string | null;
  head?: string | null;
  draft?: boolean;
  updated_at?: string | null;
  html_url?: string | null;
  requested_reviewers?: string[];
  checks?: ChecksRollup | null;
  mergeable_state?: string | null;
  tracked_task_id?: string | null;
  // additive: the PR author's login, feeds the filter bar's author datalist.
  // Present on both the plain list path and search-sourced rows.
  author_login?: string | null;
}
export interface GhFileEntry {
  filename?: string | null;
  additions?: number;
  deletions?: number;
  status?: string | null;
  patch?: string | null;
  patch_omitted?: boolean;
}
export interface GhFiles {
  count?: number;
  items?: GhFileEntry[];
  truncated?: boolean;
  patches_truncated?: boolean;
}
export interface GhComment {
  author_login?: string | null;
  body_markdown?: string | null;
  created_at?: string | null;
}
export interface GhPullDetail extends GhPullRow {
  state?: string | null;
  body_markdown?: string | null;
  author_login?: string | null;
  base?: string | null;
  created_at?: string | null;
  assignees?: string[];
  files?: GhFiles;
  comments_count?: number;
  review_comments_count?: number;
}
export interface GhIssueDetail extends GhIssueRow {
  state?: string | null;
  body_markdown?: string | null;
  author_login?: string | null;
  created_at?: string | null;
  assignees?: string[];
  comments_count?: number;
  comments?: GhComment[];
}
export interface GhListPayload {
  available?: boolean;
  repo?: string | null;
  issues?: GhIssueRow[];
  pulls?: GhPullRow[];
  // present on the unavailable degrade shape (available:false), including
  // the local-run "local_source" reason (Orcha Cloud local run, Addendum 2).
  reason?: string | null;
  detail?: string | null;
  // local-binding + GitHub-origin fall-through: on a "local_source" degrade, the
  // working tree's GitHub `origin` repo (owner/name) when one was detected but no
  // token could be resolved for it — null when there's no GitHub origin at all.
  // Absent (undefined) on every other payload shape.
  origin_detected?: string | null;
  // PR-list filtering + pagination (monorepo-scale repos): present on the pulls
  // list payload only (GET .../github/pulls). `source` says which GitHub surface
  // answered ("list" — the plain /pulls call — or "search" — /search/issues, when
  // author=/involvement=/q= is present). `total_count` is GitHub's own search total
  // (int) on the search path; always null on the list path. `has_more` tells the
  // "Load more" footer whether another page exists.
  source?: "list" | "search";
  page?: number;
  per_page?: number;
  total_count?: number | null;
  has_more?: boolean;
}
export interface GhError {
  // "local_source" — Orcha Cloud local run, Addendum 2: the bound repo is
  // the local git working tree, not GitHub, so issues/PRs/checks degrade
  // honestly (browse + Code Space keep working; only the hub is affected).
  kind: "not_connected" | "rate_limited" | "not_found" | "error" | "local_source";
  status?: number;
  detail?: string | null;
  // local-binding + GitHub-origin fall-through — see GhListPayload's docstring.
  // Only ever set alongside kind:"local_source".
  originDetected?: string | null;
}
export interface TaskState {
  task_id: string;
  existing?: boolean;
}
export type GhKind = "issue" | "pull";
export type GhItem = GhIssueRow | GhPullRow;

/* ---- error classifiers (github-render.js verbatim) ------------------------ */
type GhErrorBody = { reason?: string; detail?: string; origin_detected?: string | null };
export function classifyError(status: number, body: GhErrorBody | null): GhError {
  // Orcha Cloud local run, Addendum 2: a local-bound repo answers the hub
  // endpoints with reason:"local_source" (HTTP 200, available:false) — this
  // branch also covers the rare case a caller reaches classifyError() with a
  // non-2xx status carrying the same reason, so it's checked first.
  if (body && body.reason === "local_source") {
    return { kind: "local_source", status, detail: (body && body.detail) || null,
             originDetected: (body && body.origin_detected) ?? null };
  }
  if (status === 404) return { kind: "not_connected", status, detail: (body && body.detail) || null };
  if (status === 403 || status === 429) return { kind: "rate_limited", status, detail: (body && body.detail) || null };
  return { kind: "error", status, detail: (body && body.detail) || null };
}
// Detail 404s are number-scoped (`reason:"not_found"`), distinct from the list
// endpoints' 404-means-not-connected reading — trust the body's reason field.
export function classifyDetailError(status: number, body: GhErrorBody | null): GhError {
  const reason = body && body.reason;
  if (reason === "local_source") {
    return { kind: "local_source", status, detail: (body && body.detail) || null,
             originDetected: (body && body.origin_detected) ?? null };
  }
  if (reason === "not_found") return { kind: "not_found", status, detail: (body && body.detail) || null };
  if (reason === "repo_not_connected") return { kind: "not_connected", status, detail: (body && body.detail) || null };
  if (reason === "rate_limited") return { kind: "rate_limited", status, detail: (body && body.detail) || null };
  if (status === 404) return { kind: "not_found", status, detail: (body && body.detail) || null };
  if (status === 403 || status === 429) return { kind: "rate_limited", status, detail: (body && body.detail) || null };
  return { kind: "error", status, detail: (body && body.detail) || null };
}

/** Body-level check for the list endpoints, which answer HTTP 200 even when
 * `available:false` (see classifyError's docstring) — GitHubPage's list body
 * needs this BEFORE the "no repo" empty state so a local binding renders the
 * degrade callout instead of "No GitHub repo connected". */
export function isLocalSourcePayload(body: { available?: boolean; reason?: string | null } | null | undefined): boolean {
  return !!body && body.available === false && body.reason === "local_source";
}

/* ---- merge chip states / dispatch labels ---------------------------------- */
export const CLEAN_STATES: Record<string, 1> = { clean: 1, has_hooks: 1 };

// Founder decision: a PR's dispatch button reads "Fix ->", an issue's "Start ->".
export function dispatchLabel(kind: GhKind): { label: string; tooltip: string } {
  return kind === "pull"
    ? { label: "Fix", tooltip: "Dispatch an agent to fix checks/review feedback on this PR" }
    : { label: "Start", tooltip: "Dispatch an agent to work on this issue" };
}

/* ---- label colors (github-state.js verbatim) ------------------------------ */
export const LABEL_FALLBACK_PALETTE = [
  "d73a4a", "0075ca", "cfd3d7", "a2eeef", "7057ff", "008672",
  "e4e669", "d876e3", "fbca04", "0e8a16", "c5def5", "ff7619",
];
export function hueForLabel(name: string): number {
  let h = 0;
  for (const c of String(name || "")) h = (h * 31 + c.charCodeAt(0)) % LABEL_FALLBACK_PALETTE.length;
  return h;
}
export function hexLuminance(hex: string): number {
  const h = (hex || "").replace(/[^0-9a-fA-F]/g, "").padEnd(6, "0").slice(0, 6);
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
export function darkenHex(hex: string, amt: number): string {
  const h = (hex || "").replace(/[^0-9a-fA-F]/g, "").padEnd(6, "0").slice(0, 6);
  const ch = (i: number) => Math.max(0, Math.round(parseInt(h.slice(i, i + 2), 16) * (1 - amt)));
  return [0, 2, 4].map((i) => ch(i).toString(16).padStart(2, "0")).join("");
}
// Strict 6-hex-digit sanitizer for anything landing in an inline style value —
// untrusted API data is validated, never interpolated raw.
export function sanitizeHexColor(color: string | null | undefined): string | null {
  if (!color) return null;
  const h = String(color).replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(h) ? h.toLowerCase() : null;
}
// background = label color at ~18% alpha; text = the color itself (dark theme)
// or a luminance-darkened shade (light theme + pale color); deterministic
// fallback palette when GitHub sends no color.
export function labelColors(label: GhLabel | string | null | undefined, theme: string): { name: string; bg: string; fg: string; border: string } {
  const name = (label && typeof label === "object" && label.name) || (typeof label === "string" ? label : "") || "";
  const color = sanitizeHexColor(label && typeof label === "object" ? label.color : null) || LABEL_FALLBACK_PALETTE[hueForLabel(name)];
  const isLight = theme === "light";
  const textColor = isLight && hexLuminance(color) > 0.65 ? darkenHex(color, 0.45) : color;
  return { name, bg: `#${color}2e`, fg: `#${textColor}`, border: `#${color}55` };
}

/* ---- expertise-based "Assign to" suggestions (github-state.js verbatim) ---- */
export const ROLE_TOKEN_SYNONYMS: Record<string, string[]> = {
  web: ["frontend", "react", "next", "webapp", "browser"],
  nextjs: ["next", "react", "frontend", "web", "ssr"],
  frontend: ["web", "ui", "react", "next"],
  clinician: ["clinical", "provider", "doctor", "care"],
  dashboard: ["dashboard", "panel", "overview", "chart"],
  ios: ["swift", "swiftui", "apple", "mobile", "iphone", "ipad"],
  swift: ["swiftui", "ios", "xcode"],
  swiftui: ["swift", "ios", "xcode"],
  patient: ["patients", "clinical", "care"],
  app: ["application", "mobile"],
  mobile: ["ios", "android", "app", "phone"],
  backend: ["server", "api", "service"],
  nestjs: ["nest", "node", "backend", "api"],
  medplum: ["fhir", "ehr", "emr"],
  fhir: ["medplum", "hl7", "healthcare", "ehr", "emr", "interoperability"],
  api: ["backend", "endpoint", "rest", "route", "routes"],
  security: ["auth", "authn", "authz", "vuln", "vulnerability", "secure"],
  hipaa: ["compliance", "phi", "privacy", "baa"],
  compliance: ["hipaa", "policy", "legal", "audit"],
  reviewer: ["review", "reviews"],
  auth: ["authentication", "authorization", "security", "login", "oauth", "sso"],
  phi: ["hipaa", "privacy", "phi"],
  qa: ["test", "testing", "tests", "e2e", "flaky", "regression"],
  test: ["tests", "testing", "qa", "e2e", "flaky"],
  release: ["deploy", "deployment", "ship", "shipping"],
  verification: ["verify", "verified", "qa", "test"],
  ux: ["ui", "design", "css", "styling", "usability"],
  design: ["ux", "ui", "css", "styling", "figma"],
  css: ["style", "styling", "design", "ui"],
  admin: ["operator", "console", "backoffice"],
  operator: ["admin", "console", "ops"],
  panel: ["dashboard", "console", "admin"],
  docs: ["documentation", "writing"],
  documentation: ["docs", "writing"],
  legal: ["policy", "counsel", "contract"],
  policy: ["legal", "compliance", "governance"],
  counsel: ["legal", "compliance"],
  baa: ["hipaa", "compliance", "legal"],
  orchestrator: ["orchestration", "coordinator", "coordinate", "coordinating"],
  architect: ["architecture", "design"],
};

const SUGGEST_WEIGHT_TITLE = 3;
const SUGGEST_WEIGHT_BODY = 1;
const SUGGEST_ORCHESTRATOR_PENALTY = 0.4;
const ORCHESTRATOR_ROLE_RE = /\borchestrat|\barchitect/i;

export function suggestTokenize(text: unknown): string[] {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

export function expandRoleVocabulary(role: string | null | undefined): Set<string> {
  const base = suggestTokenize(role);
  const vocab = new Set(base);
  base.forEach((tok) => {
    const syns = ROLE_TOKEN_SYNONYMS[tok];
    if (syns) syns.forEach((s) => vocab.add(s));
  });
  return vocab;
}

interface WeightedToken { token: string; weight: number }

function itemWeightedTokens(item: (GhItem & { body_markdown?: string | null; body?: string | null }) | null | undefined): WeightedToken[] {
  const it = item || ({} as GhItem & { body_markdown?: string | null; body?: string | null });
  const out: WeightedToken[] = [];
  suggestTokenize(it.title).forEach((t) => out.push({ token: t, weight: SUGGEST_WEIGHT_TITLE }));
  ((it as GhIssueRow).labels || []).forEach((l) => {
    const name = (l && l.name) || (typeof l === "string" ? l : "");
    suggestTokenize(name).forEach((t) => out.push({ token: t, weight: SUGGEST_WEIGHT_TITLE }));
  });
  if ((it as GhPullRow).head) suggestTokenize((it as GhPullRow).head).forEach((t) => out.push({ token: t, weight: SUGGEST_WEIGHT_TITLE }));
  const body = (it as GhIssueRow).body_excerpt || it.body_markdown || it.body || "";
  suggestTokenize(body).forEach((t) => out.push({ token: t, weight: SUGGEST_WEIGHT_BODY }));
  return out;
}

function scoreAgentForItem(weightedTokens: WeightedToken[], agent: Agent): { score: number; tokens: string[] } {
  const vocab = expandRoleVocabulary(agent && agent.role);
  let score = 0;
  const matched: string[] = [];
  const seen: Record<string, boolean> = {};
  weightedTokens.forEach(({ token, weight }) => {
    if (!vocab.has(token)) return;
    score += weight;
    if (!seen[token]) { seen[token] = true; matched.push(token); }
  });
  if (score > 0 && ORCHESTRATOR_ROLE_RE.test(String((agent && agent.role) || ""))) {
    score *= SUGGEST_ORCHESTRATOR_PENALTY;
  }
  return { score, tokens: matched };
}

export interface RankedAgent { agent: Agent; score: number; tokens: string[] }

// Ranks kind==="ai" agents by weighted role/text overlap; [] when no signal.
export function suggestAgents(item: GhItem | null | undefined, agents: Agent[]): RankedAgent[] {
  const list = (agents || []).filter((a) => a.kind === "ai");
  const weightedTokens = itemWeightedTokens(item);
  if (!weightedTokens.length) return [];
  const ranked = list
    .map((agent) => {
      const { score, tokens } = scoreAgentForItem(weightedTokens, agent);
      return { agent, score, tokens: tokens.slice(0, 3) };
    })
    .filter((r) => r.score > 0);
  ranked.sort((a, b) => b.score - a.score); // stable: ties keep roster order
  return ranked;
}

const SUGGEST_CLOSE_SECOND_RATIO = 0.7;
export function topSuggestions(ranked: RankedAgent[]): RankedAgent[] {
  if (!ranked.length) return [];
  const top = [ranked[0]];
  if (ranked.length > 1 && ranked[1].score >= ranked[0].score * SUGGEST_CLOSE_SECOND_RATIO) {
    top.push(ranked[1]);
  }
  return top;
}

/* ---- PR "Fix" info popover clauses (lockstep with _fix_description) ------- */
export function fixOutstandingItems(pull: GhPullDetail | null | undefined): string[] {
  const p = pull || ({} as GhPullDetail);
  const checks = p.checks || {};
  const failing = checks.failing || 0;
  const pending = checks.pending || 0;
  const runs = checks.runs || [];
  const FAIL_CONCLUSIONS: Record<string, 1> = { failure: 1, timed_out: 1, action_required: 1, cancelled: 1, stale: 1, startup_failure: 1 };
  const failingNames = runs
    .filter((r) => r && r.status === "completed" && r.conclusion != null && FAIL_CONCLUSIONS[r.conclusion])
    .map((r) => r.name || "unnamed check");

  const items: string[] = [];
  if (failing) {
    const shown = failingNames.slice(0, 5);
    const more = failingNames.length - shown.length;
    const names = shown.join(", ") + (more > 0 ? `, +${more} more` : "");
    items.push(`${failing} failing check${failing !== 1 ? "s" : ""}` + (names ? `: ${names}` : ""));
  }
  if (pending) items.push(`${pending} check${pending !== 1 ? "s" : ""} still pending`);
  const reviewTotal = (p.review_comments_count || 0) + (p.comments_count || 0);
  if (reviewTotal) items.push(`${reviewTotal} review comment${reviewTotal !== 1 ? "s" : ""} to address`);
  if (p.mergeable_state === "dirty") items.push("merge conflicts with base — rebase or resolve conflicts");
  if (p.draft) items.push("this PR is a draft");
  return items;
}

/* ---- filtering (github-state.js verbatim) --------------------------------- */
// "Mine" = assigned to me (issues) OR requested-review-from me (pulls);
// "Needs review" (pulls only) = requested reviewer AND not draft.
export function matchesFilter(kind: GhKind, item: GhItem, filterKey: string, myLogin: string | null): boolean {
  if (filterKey === "open") return true; // both endpoints already return open-only
  if (filterKey === "mine") {
    if (kind === "issue") return !!myLogin && (item as GhIssueRow).assignee === myLogin;
    return !!myLogin && ((item as GhPullRow).requested_reviewers || []).indexOf(myLogin) >= 0;
  }
  if (filterKey === "needs-review") {
    return kind === "pull" && !!myLogin
      && ((item as GhPullRow).requested_reviewers || []).indexOf(myLogin) >= 0
      && !(item as GhPullRow).draft;
  }
  return true;
}
export function matchesSearch(item: GhItem, q: string): boolean {
  if (!q) return true;
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const num = String(item.number || "");
  return (item.title || "").toLowerCase().indexOf(needle) >= 0
    || num.indexOf(needle.replace(/^#/, "")) >= 0;
}

/* ---- PR-list server-backed filter bar (monorepo-scale repos) -------------
   Query params GET .../github/pulls now accepts: author=, involvement=,
   q=, page=, per_page= — see github_hub_routes.list_github_pulls. */
export type Involvement = "assigned" | "review_requested" | null;
export interface PullsFilter {
  author: string;
  involvement: Involvement;
  q: string;
}
export const EMPTY_PULLS_FILTER: PullsFilter = { author: "", involvement: null, q: "" };
export const PULLS_DEFAULT_PER_PAGE = 30;

// Whether ANY server-backed filter is active — the plain client-side-filtered
// path (existing "Mine"/"Needs review" chips + free-text box over the single
// cached list) stays in effect only when this is false.
export function hasActivePullsFilter(f: PullsFilter): boolean {
  return !!(f.author.trim() || f.involvement || f.q.trim());
}

// Builds the query string for GET .../github/pulls from filter + paging state.
// Omits empty/default params so the plain (no-filter) request stays byte-for
// -byte the vanilla call when nothing is set (page=1 is still passed explicitly
// once paging beyond page 1, never on the very first request).
export function buildPullsQuery(f: PullsFilter, page: number, perPage: number = PULLS_DEFAULT_PER_PAGE): string {
  const params = new URLSearchParams();
  const author = f.author.trim();
  if (author) params.set("author", author);
  if (f.involvement) params.set("involvement", f.involvement);
  const q = f.q.trim();
  if (q) params.set("q", q);
  if (page > 1) params.set("page", String(page));
  if (perPage !== PULLS_DEFAULT_PER_PAGE) params.set("per_page", String(perPage));
  const s = params.toString();
  return s ? "?" + s : "";
}

// Distinct authors seen across loaded PR rows, for the author input's
// <datalist> — both the plain list path and search-sourced rows carry
// author_login, so this simply reads whatever rows are CURRENTLY loaded;
// as pages accumulate the suggestion list only grows.
export function authorsFromRows(rows: GhPullRow[]): string[] {
  const seen = new Set<string>();
  rows.forEach((r) => { if (r.author_login) seen.add(r.author_login); });
  return Array.from(seen).sort((a, b) => a.localeCompare(b));
}

/* ---- misc constants ------------------------------------------------------- */
// Backend CHECKS_BATCH_MAX_NUMBERS mirror — the progressive-fill batch cap.
export const CHECKS_BATCH_CAP = 30;
// First N files expanded by default on the PR Files tab.
export const FILES_EXPANDED_BY_DEFAULT = 3;
