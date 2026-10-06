/**
 * Org chart model (pure, unit-tested): build the reporting-line forest from the
 * snapshot, lay it out as a top-down tree of cards, and decide who may edit it.
 *
 * Data: `agent.reports_to` (mig 052) — the manager's agent id, set only by a
 * human (PUT /api/agents/{aid}/reports-to). Pending agent suggestions ("approve
 * hires") are OPEN requests whose `detail.proposed_alias` is set; they render as
 * ghost cards that link to the existing decision flow in Needs you — agents
 * never create agents.
 *
 * The tidy-tree layout (subtree widths, parents centred over their reports,
 * roots side by side, elbow connectors) is adapted from Paperclip's OrgChart
 * (https://github.com/paperclipai/paperclip, MIT — ui/src/pages/OrgChart.tsx).
 */
import type { Identity } from "../../extensions";
import type { ActingAuthority } from "../../state/SnapshotProvider";
import type { Agent, OrchaRequest, Snapshot } from "../../types";
import { fmtUsd, meterTone, spendUnknown, type AgentBudgetStatus } from "../agents/budget/budgetModel";
import { agentPresence } from "../agents/presence";

export interface OrgNode {
  agent: Agent;
  children: OrgNode[];
}

export interface OrgGhost {
  requestId: string;
  alias: string;
  role: string | null;
  rationale: string | null;
  /** the proposed instructions (detail.proposed_prompt), when the suggestion carries them */
  prompt: string | null;
  /** alias of the agent that proposed the hire */
  proposedBy: string;
  /** alias of the human it waits on */
  waitingOn: string;
  href: string;
}

export interface OrgForest {
  /** agents with no manager who manage someone (the top of the chart) */
  roots: OrgNode[];
  /** agents with no manager and no reports — the "Unassigned" lane */
  unassigned: Agent[];
  /** pending agent suggestions (approve hires) */
  ghosts: OrgGhost[];
  /** agent id → manager id, as used by the chart (missing / looping managers dropped) */
  managerOf: Map<string, string>;
  /** ids whose stored manager is not in the live roster (retired) */
  managerGone: Set<string>;
  /** total reporting lines drawn */
  lines: number;
  /** ids whose line to their parent is a PREVIEW (the empty-state suggestion) —
   *  drawn dashed, never saved, absent from managerOf */
  preview?: Set<string>;
}

/** Sibling order: humans first (they usually lead), then roster order. */
function siblingOrder(a: Agent, b: Agent, rank: Map<string, number>): number {
  const ha = a.kind === "human" ? 0 : 1, hb = b.kind === "human" ? 0 : 1;
  if (ha !== hb) return ha - hb;
  return (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0);
}

function suggestionOf(r: OrchaRequest): { alias: string; role: string | null; rationale: string | null; prompt: string | null } | null {
  const d = r.detail as Record<string, unknown> | null | undefined;
  if (!d || typeof d !== "object") return null;
  // UO-11b: a decided suggestion (create / reassign stamp detail.suggestion_decided)
  // is no longer a proposed hire, even while its request stays open
  if (d.suggestion_decided) return null;
  const alias = typeof d.proposed_alias === "string" ? d.proposed_alias.trim() : "";
  if (!alias) return null;
  const role = typeof d.proposed_role === "string" && d.proposed_role.trim() ? d.proposed_role.trim() : null;
  const rationale = typeof d.rationale === "string" && d.rationale.trim() ? d.rationale.trim() : null;
  const prompt = typeof d.proposed_prompt === "string" && d.proposed_prompt.trim() ? d.proposed_prompt.trim() : null;
  return { alias, role, rationale, prompt };
}

/**
 * The forest. `overrides` (agent id → manager id | null) applies optimistic
 * edits on top of the snapshot until the next poll confirms them.
 */
export function buildOrgForest(snap: Snapshot | null, overrides: Record<string, string | null> = {}): OrgForest {
  const agents = snap?.agents ?? [];
  const byId = new Map(agents.map((a) => [String(a.id), a]));
  const rank = new Map(agents.map((a, i) => [String(a.id), i]));
  const raw = new Map<string, string | null>();
  for (const a of agents) {
    const id = String(a.id);
    const m = id in overrides ? overrides[id] : a.reports_to ?? null;
    raw.set(id, m != null ? String(m) : null);
  }
  const managerOf = new Map<string, string>();
  const managerGone = new Set<string>();
  for (const [id, m] of raw) {
    if (!m || m === id) continue;
    if (!byId.has(m)) { managerGone.add(id); continue; }
    managerOf.set(id, m);
  }
  // Break any loop defensively (the API refuses cycles; a stale optimistic edit
  // racing a poll could still show one for a frame): the first member of a loop
  // met in roster order becomes a root.
  for (const a of agents) {
    const start = String(a.id);
    const seen = new Set<string>([start]);
    let cur = managerOf.get(start);
    while (cur) {
      if (seen.has(cur)) { managerOf.delete(start); break; }
      seen.add(cur);
      cur = managerOf.get(cur);
    }
  }
  const kids = new Map<string, Agent[]>();
  for (const [id, m] of managerOf) {
    const list = kids.get(m) ?? [];
    list.push(byId.get(id)!);
    kids.set(m, list);
  }
  const build = (a: Agent): OrgNode => ({
    agent: a,
    children: (kids.get(String(a.id)) ?? []).slice().sort((x, y) => siblingOrder(x, y, rank)).map(build),
  });
  const top = agents.filter((a) => !managerOf.has(String(a.id))).slice().sort((x, y) => siblingOrder(x, y, rank));
  const roots = top.filter((a) => kids.has(String(a.id))).map(build);
  const unassigned = top.filter((a) => !kids.has(String(a.id)));

  // UO-11b: a proposed alias that is already a live member is hired — its real
  // card is on the chart, so never draw a ghost next to it
  const live = new Set(agents.map((a) => (a.alias || "").trim().toLowerCase()));
  const ghosts: OrgGhost[] = (snap?.requests ?? [])
    .filter((r) => r.status === "open")
    .map((r) => {
      const s = suggestionOf(r);
      if (!s || live.has(s.alias.toLowerCase())) return null;
      return {
        requestId: String(r.id), alias: s.alias, role: s.role, rationale: s.rationale, prompt: s.prompt,
        proposedBy: r.from, waitingOn: r.to,
        href: "/needs?item=" + encodeURIComponent("request:" + r.id),
      };
    })
    .filter((g): g is OrgGhost => g != null);

  return { roots, unassigned, ghosts, managerOf, managerGone, lines: managerOf.size };
}

/** Every agent below `id` (its reports, their reports, …). */
export function descendantsOf(forest: OrgForest, id: string): Set<string> {
  const out = new Set<string>();
  const down = new Map<string, string[]>();
  for (const [c, m] of forest.managerOf) down.set(m, [...(down.get(m) ?? []), c]);
  const stack = [...(down.get(id) ?? [])];
  while (stack.length) {
    const c = stack.pop()!;
    if (out.has(c)) continue;
    out.add(c);
    stack.push(...(down.get(c) ?? []));
  }
  return out;
}

/** May `agentId` report to `managerId`? (not itself, not one of its own reports — no loops) */
export function canReportTo(forest: OrgForest, agentId: string, managerId: string): boolean {
  if (agentId === managerId) return false;
  return !descendantsOf(forest, agentId).has(managerId);
}

/** The managers `agentId` may be moved under, in roster order. */
export function managerCandidates(snap: Snapshot | null, forest: OrgForest, agentId: string): Agent[] {
  const below = descendantsOf(forest, agentId);
  return (snap?.agents ?? []).filter((a) => String(a.id) !== agentId && !below.has(String(a.id)));
}

/** The manager chain above `id`, root first, nearest manager last (real lines only). */
export function managerChain(forest: OrgForest, byId: Map<string, Agent>, id: string): Agent[] {
  const out: Agent[] = [];
  const seen = new Set<string>([id]);
  let cur = forest.managerOf.get(id);
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const a = byId.get(cur);
    if (!a) break;
    out.unshift(a);
    cur = forest.managerOf.get(cur);
  }
  return out;
}

/** Who reports directly to `id` (real lines only), in roster order. */
export function directReports(snap: Snapshot | null, forest: OrgForest, id: string): Agent[] {
  return (snap?.agents ?? []).filter((a) => forest.managerOf.get(String(a.id)) === id);
}

/* ---- the default view + the one-click setup (empty state) ------------------------ */

/** Humans who receive escalations: every human member who can act (a viewer is read-only). */
export function receivesEscalations(a: Agent): boolean {
  return a.kind === "human" && (a.member_role || "").toLowerCase() !== "viewer";
}

/** The person "Everyone reports to …" names: the project owner, else the acting
 *  human, else the first human who can act. */
export function pickOwner(snap: Snapshot | null, actingId?: string | null): Agent | null {
  const humans = (snap?.agents ?? []).filter(receivesEscalations);
  return humans.find((h) => (h.member_role || "").toLowerCase() === "owner")
    ?? (actingId != null ? humans.find((h) => String(h.id) === String(actingId)) : undefined)
    ?? humans[0] ?? null;
}

export interface OrgSuggestion {
  owner: Agent;
  /** the AI agents that would report to `owner` (all of them have no manager today) */
  changes: Agent[];
}

/** "Everyone reports to <owner>" — offered only while the project has NO reporting
 *  lines. Nothing is written until a human confirms (each change is its own
 *  authorized PUT /api/agents/{aid}/reports-to). */
export function reportingSuggestion(snap: Snapshot | null, forest: OrgForest, actingId?: string | null): OrgSuggestion | null {
  if (forest.lines > 0) return null;
  const owner = pickOwner(snap, actingId);
  if (!owner) return null;
  const changes = (snap?.agents ?? []).filter((a) => a.kind === "ai" && String(a.id) !== String(owner.id) && !forest.managerOf.has(String(a.id)));
  return changes.length ? { owner, changes } : null;
}

/**
 * Visual default when there are no reporting lines: the humans who receive
 * escalations sit on top (owner first); with a suggestion, its lines are drawn
 * under the owner as a dashed PREVIEW. Display only — `managerOf` / `lines` are
 * untouched and nothing is written.
 */
export function withDefaultView(forest: OrgForest, suggestion: OrgSuggestion | null): OrgForest {
  if (forest.lines > 0) return forest;
  const tops = forest.unassigned.filter(receivesEscalations);
  if (!tops.length) return forest;
  const ownerId = suggestion ? String(suggestion.owner.id) : null;
  tops.sort((a, b) => (String(a.id) === ownerId ? -1 : String(b.id) === ownerId ? 1 : 0));
  const preview = new Set((suggestion?.changes ?? []).map((a) => String(a.id)));
  const roots: OrgNode[] = tops.map((h) => ({
    agent: h,
    children: String(h.id) === ownerId ? suggestion!.changes.map((a) => ({ agent: a, children: [] })) : [],
  }));
  const unassigned = forest.unassigned.filter((a) => !receivesEscalations(a) && !preview.has(String(a.id)));
  return { ...forest, roots, unassigned, preview };
}

/* ---- card facts (real data only) --------------------------------------------------- */

const CLOSED_TASK = new Set(["completed", "done", "cancelled", "canceled", "failed", "terminated", "archived"]);

/** Open (not finished / cancelled / failed) tasks per assignee alias. */
export function openTaskCounts(snap: Snapshot | null): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of snap?.tasks ?? []) {
    if (CLOSED_TASK.has(String(t.status || "").toLowerCase())) continue;
    const who = new Set([...(t.assignees ?? []), ...(t.assignee ? [t.assignee] : [])]);
    for (const a of who) out.set(a, (out.get(a) ?? 0) + 1);
  }
  return out;
}

export type BudgetsLoad = "loading" | "ready" | "unsupported";
export interface SpendFact {
  text: string;
  tone: "ok" | "warn" | "over" | "muted";
  title: string;
}

/**
 * This month's spend vs budget for a card — the budgets API's REAL figures.
 * A month whose runs reported no dollar cost is "not metered" (never $0), and
 * so is an agent the budgets API does not know about.
 */
export function spendFact(b: AgentBudgetStatus | null | undefined, load: BudgetsLoad): SpendFact | null {
  if (load === "loading") return null;
  if (load === "unsupported" || !b) return { text: "not metered", tone: "muted", title: "No spend figures for this agent this month" };
  const u = b.usage;
  const limit = b.limits?.usd ?? null;
  if (spendUnknown(u)) {
    return { text: "not metered", tone: "muted", title: "This month's runs reported no dollar cost (subscription or unpriced model)" + (limit != null ? " · budget " + fmtUsd(limit) : "") };
  }
  const spend = fmtUsd(u.spend_usd);
  if (limit == null) return { text: spend, tone: "muted", title: spend + " this month · no monthly budget" };
  const tone = b.paused ? "over" : meterTone(b.usd_ratio);
  // budgets are usually whole dollars: "$18.71 / $120", not "$18.71 / $120.00" (card space)
  const cap = Number.isInteger(limit) ? "$" + limit.toLocaleString("en-US") : fmtUsd(limit);
  return {
    text: spend + " / " + cap, tone,
    title: b.paused ? (b.reason || "Monthly budget reached — paused for new runs") : spend + " of a " + fmtUsd(limit) + " monthly budget",
  };
}

/** An invited human who has never signed in (cloud builds report the heartbeat;
 *  the open build omits the field, so it never matches there). PS-33: the
 *  backend never routes asks to them, so the card must not say it does. */
export function invitedNotSignedIn(a: Agent): boolean {
  if (a.kind !== "human" || !a.github_login) return false;
  const hb = a as Agent & { last_heartbeat_at?: string | null };
  return "last_heartbeat_at" in hb && !hb.last_heartbeat_at;
}

export interface OrgStatus {
  text: string;
  /** css status class suffix for the dot (s-working, s-awaiting_request, …) */
  cls: string;
  /** tooltip */
  title: string;
}
const PRESENCE_CLS: Record<string, string> = {
  working: "working", waking: "working", busy: "awaiting_request", needs: "awaiting_human",
  waiting: "awaiting_request", blocked: "blocked", failed: "failed",
};

/**
 * VD-09: the ONE status vocabulary — an AI agent's card reads exactly what the
 * roster / board / sidebar read (agents/presence.ts), so a lease-lapsed running
 * run with a stale stored `awaiting_request` reads Working everywhere.
 */
export function orgStatus(a: Agent, snap?: Snapshot | null): OrgStatus {
  if (a.kind === "human") {
    if ((a.member_role || "").toLowerCase() === "viewer") return { text: "Read-only", cls: "invited", title: "Viewers can read but not act" };
    if (invitedNotSignedIn(a)) return { text: "Invited · not signed in", cls: "invited", title: "Invited but has not signed in yet, so asks are not routed to them" };
    return { text: "Receives escalations", cls: "human", title: "Can receive asks and escalations" };
  }
  if (a.status === "terminated") return { text: "Retired", cls: "idle", title: "The agent was terminated." };
  const p = agentPresence(a, { snap: snap ?? null });
  return { text: p.label, cls: PRESENCE_CLS[p.k] ?? "idle", title: p.reason };
}

/** The live status words for a card ("Working", "Waiting", "Idle", "Receives escalations"). */
export function liveStatusText(a: Agent, snap?: Snapshot | null): string {
  return orgStatus(a, snap).text;
}

/** Arrow-key navigation between cards: the nearest card in that direction
 *  (primary-axis distance + 2 × off-axis drift), or null at the edge. */
export function spatialNext(items: Placed[], fromId: string, dir: "up" | "down" | "left" | "right", w = CARD_W, h = CARD_H): string | null {
  const from = items.find((p) => p.id === fromId);
  if (!from) return null;
  const cx = from.x + w / 2, cy = from.y + h / 2;
  let best: string | null = null, bestScore = Infinity;
  for (const p of items) {
    if (p.id === fromId) continue;
    const dx = p.x + w / 2 - cx, dy = p.y + h / 2 - cy;
    const primary = dir === "up" ? -dy : dir === "down" ? dy : dir === "left" ? -dx : dx;
    const drift = dir === "up" || dir === "down" ? Math.abs(dx) : Math.abs(dy);
    if (primary <= 1) continue;
    const score = primary + drift * 2;
    if (score < bestScore) { bestScore = score; best = p.id; }
  }
  return best;
}

/* ---- who may edit ------------------------------------------------------------ */

export const ORG_GRANT_REASON = "Requires the owner role or the Agents permission (manage_agents)";
export const NO_HUMAN_ORG_REASON = "Pick an acting human first — reporting lines are changed by a human.";

export interface OrgAuthority {
  can: boolean;
  human: Agent | null;
  pending: boolean;
  reason: string | null;
}

/** Owner or manage_agents under a verified identity; any acting human in the open build. */
export function orgAuthority(a: ActingAuthority, identity: Identity | null): OrgAuthority {
  if (a.pending) return { can: false, human: null, pending: true, reason: a.reason };
  if (!a.human) return { can: false, human: null, pending: false, reason: a.reason || NO_HUMAN_ORG_REASON };
  if (identity && identity.member_role !== "owner" && (identity.grants || []).indexOf("manage_agents") < 0) {
    return { can: false, human: null, pending: false, reason: ORG_GRANT_REASON };
  }
  return { can: true, human: a.human, pending: false, reason: null };
}

/* ---- card text ----------------------------------------------------------------- */

/** The one-line "what is this agent doing" snippet on a card (real data only).
 *  Follows presence (VD-09): a Working agent never reads "Waiting on a request". */
export function workSnippet(a: Agent, snap?: Snapshot | null): string | null {
  if (a.kind === "human") return null;
  const k = a.status === "terminated" ? "offline" : agentPresence(a, { snap: snap ?? null }).k;
  if (k === "working") return a.current_task?.title || null;
  if (k === "waiting") return "Waiting on a request";
  if (a.current_task?.title) return a.current_task.title;
  return null;
}

export function roleLine(a: Agent): string {
  const role = (a.role || "").trim();
  if (role && role !== "—") return role;
  if (a.kind === "human") {
    const r = (a.member_role || "").trim();
    return r ? r[0].toUpperCase() + r.slice(1) : "Human";
  }
  return "Agent";
}

/* ---- layout -------------------------------------------------------------------- */

export const CARD_W = 272;
export const CARD_H = 112;
/** a proposed-hire card: role (2 lines) + rationale (3 lines) + Approve / Decline */
export const GHOST_H = 196;
export const GAP_X = 16;
export const GAP_Y = 52;
export const PAD = 24;
export const LANE_GAP = 40;
export const LANE_HEAD = 28;

export interface Placed {
  id: string;
  x: number;
  y: number;
}
export interface Edge {
  from: string;
  to: string;
  d: string;
  /** a preview line (the empty-state suggestion) — drawn dashed, not saved */
  preview?: boolean;
}
export interface LaneBox {
  key: "unassigned" | "ghosts";
  x: number;
  y: number;
  w: number;
  h: number;
  count: number;
}
export interface OrgLayout {
  cards: Placed[];
  ghosts: Placed[];
  edges: Edge[];
  lanes: LaneBox[];
  width: number;
  height: number;
  treeHeight: number;
  /** width of the reporting tree alone (0 when there is none) — what the zoom fits */
  treeWidth: number;
}

function subtreeWidth(n: OrgNode, memo: Map<OrgNode, number>): number {
  const hit = memo.get(n);
  if (hit != null) return hit;
  const w = n.children.length === 0
    ? CARD_W
    : Math.max(CARD_W, n.children.reduce((s, c) => s + subtreeWidth(c, memo), 0) + (n.children.length - 1) * GAP_X);
  memo.set(n, w);
  return w;
}

/** Elbow connector with softened corners (parent bottom-centre → child top-centre). */
export function elbow(x1: number, y1: number, x2: number, y2: number): string {
  const mid = Math.round((y1 + y2) / 2);
  if (Math.abs(x1 - x2) < 0.5) return `M ${x1} ${y1} V ${y2}`;
  const r = Math.min(6, Math.abs(x2 - x1) / 2, (y2 - y1) / 4);
  const dir = x2 > x1 ? 1 : -1;
  return `M ${x1} ${y1} V ${mid - r} Q ${x1} ${mid} ${x1 + dir * r} ${mid} H ${x2 - dir * r} Q ${x2} ${mid} ${x2} ${mid + r} V ${y2}`;
}

/**
 * Positions for every card, connector and lane. `minWidth` lets the lanes
 * wrap to the viewport when the tree is narrow (a flat team is one long lane).
 */
export function layoutOrg(forest: OrgForest, minWidth = 0): OrgLayout {
  const memo = new Map<OrgNode, number>();
  const cards: Placed[] = [];
  const edges: Edge[] = [];
  const place = (n: OrgNode, x: number, y: number) => {
    const w = subtreeWidth(n, memo);
    const cx = x + (w - CARD_W) / 2;
    cards.push({ id: String(n.agent.id), x: cx, y });
    if (n.children.length) {
      const childrenW = n.children.reduce((s, c) => s + subtreeWidth(c, memo), 0) + (n.children.length - 1) * GAP_X;
      let x0 = x + (w - childrenW) / 2;
      for (const c of n.children) {
        const cw = subtreeWidth(c, memo);
        const childX = x0 + (cw - CARD_W) / 2;
        edges.push({
          from: String(n.agent.id), to: String(c.agent.id),
          preview: forest.preview?.has(String(c.agent.id)) || undefined,
          d: elbow(cx + CARD_W / 2, y + CARD_H, childX + CARD_W / 2, y + CARD_H + GAP_Y),
        });
        place(c, x0, y + CARD_H + GAP_Y);
        x0 += cw + GAP_X;
      }
    }
  };
  let x = PAD;
  for (const r of forest.roots) {
    place(r, x, PAD);
    x += subtreeWidth(r, memo) + GAP_X;
  }
  const treeW = forest.roots.length ? x - GAP_X + PAD : 0;
  const treeBottom = cards.reduce((m, c) => Math.max(m, c.y + CARD_H), 0);
  const treeHeight = forest.roots.length ? treeBottom + PAD : 0;

  const width = Math.max(treeW, minWidth, CARD_W + PAD * 2);
  const cols = Math.max(1, Math.floor((width - PAD * 2 + GAP_X) / (CARD_W + GAP_X)));
  const lanes: LaneBox[] = [];
  const ghosts: Placed[] = [];
  // no tree: leave a line for the "No reporting lines yet" hint above the lanes
  let y = forest.roots.length ? treeBottom + LANE_GAP : PAD + 36;
  const lane = (key: LaneBox["key"], ids: string[], into: Placed[], rowH = CARD_H) => {
    if (!ids.length) return;
    const rows = Math.ceil(ids.length / cols);
    const h = LANE_HEAD + rows * rowH + (rows - 1) * 16;
    lanes.push({ key, x: PAD, y, w: width - PAD * 2, h, count: ids.length });
    ids.forEach((id, i) => {
      into.push({ id, x: PAD + (i % cols) * (CARD_W + GAP_X), y: y + LANE_HEAD + Math.floor(i / cols) * (rowH + 16) });
    });
    y += h + LANE_GAP;
  };
  lane("unassigned", forest.unassigned.map((a) => String(a.id)), cards);
  lane("ghosts", forest.ghosts.map((g) => g.requestId), ghosts, GHOST_H);
  const height = Math.max(treeHeight, lanes.length ? y - LANE_GAP + PAD : 0, CARD_H + PAD * 2);
  return { cards, ghosts, edges, lanes, width, height, treeHeight, treeWidth: treeW };
}

/** VD-04: the initial / "Fit to width" view. The zoom fits the reporting TREE
 *  (never enlarging past 1); the pan then centres the layout that will actually
 *  RENDER at that zoom — the unassigned / proposed lanes wrap to the viewport
 *  (layoutOrg(forest, viewportW / zoom)), so centring on the unwrapped one-column
 *  layout would push the wrapped lane off the right edge. */
export function fitView(forest: OrgForest, viewportW: number, min = 0.35): { zoom: number; panX: number } {
  const zoom = fitZoom(viewportW, layoutOrg(forest, 0).treeWidth, min);
  const shown = layoutOrg(forest, viewportW > 0 ? viewportW / zoom : 0);
  return { zoom, panX: Math.max(0, (viewportW - shown.width * zoom) / 2) };
}

/** Zoom that fits the chart's width into the viewport (never enlarges past 1). */
export function fitZoom(viewportW: number, chartW: number, min = 0.35): number {
  if (viewportW <= 0 || chartW <= 0) return 1;
  return Math.max(min, Math.min(1, viewportW / chartW));
}

/* ---- the 390 px indented list --------------------------------------------------- */

export interface ListRow {
  agent: Agent;
  depth: number;
}

/** Pre-order walk of the forest: each manager followed by its reports, one level deeper. */
export function flattenForest(forest: OrgForest): ListRow[] {
  const out: ListRow[] = [];
  const walk = (n: OrgNode, depth: number) => {
    out.push({ agent: n.agent, depth });
    n.children.forEach((c) => walk(c, depth + 1));
  };
  forest.roots.forEach((r) => walk(r, 0));
  return out;
}
