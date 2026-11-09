/**
 * Exploration map: the path an agent walked through an app, rebuilt from a run's steps as a
 * tree of screens.
 *
 * Every `screen` step carries a `screen_hash` and a frame; web runs also record the page
 * (`args.page.url` / `.title`). A node is a page: screens with the same URL are one node, and
 * without a URL (iOS, Android, older web runs) a screen reached only by scrolling, typing or
 * an appearance switch stays on the node it came from. Walking the steps in order:
 * - the first screen is the root;
 * - a screen on a new page becomes a child of the page the agent was on, reached by the
 *   actions taken since (usually one tap). Two exceptions attach it to the root instead: a
 *   page opened by URL, and a page reached through a control that was already on the first
 *   screen (the app's persistent navigation). Without them, an agent moving section to section
 *   through a header menu draws one long chain instead of a tree of sections;
 * - a page seen before is a return (a back press, a home press, a link to a page already
 *   visited). It adds no node; it is kept as a `return` edge and in the journey, so the map
 *   can show the agent backing out and trying something else.
 *
 * Pure: no React, no DOM. `layoutTree` places the nodes as a top-down tidy tree.
 */
import type { Severity } from "../explorations";

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json | undefined };

/** One step as the map reads it. */
export interface Step {
  seq: number;
  kind: string;
  args: Json;
  result: string | null;
  at_ms: number;
  frame_path: string | null;
  screen_hash: string | null;
  foreground?: string | null;
}

/** A finding pinned on the step it was found at. */
export interface Evidence {
  seq: number;
  severity: Severity;
  label: string | null;
}

import { sevRank } from "../../map/kit";

export interface ScreenVisit {
  seq: number;
  atMs: number;
  framePath: string;
}

export interface ScreenNode {
  /** The page URL for web runs, else the first `screen_hash` seen for this node. */
  id: string;
  name: string;
  depth: number;
  parentId: string | null;
  /** How the agent first got here, e.g. `tap "Pricing"`. Null for the root. */
  via: string | null;
  /** Order of discovery (0 = root). */
  order: number;
  visits: ScreenVisit[];
  /** Evidence captured while on this screen. */
  findings: { seq: number; severity: Severity; label: string | null }[];
  /** Worst finding severity on this screen, if any. */
  worst: Severity | null;
  childIds: string[];
}

export interface ScreenEdge {
  id: string;
  source: string;
  target: string;
  kind: "tree" | "return";
  label: string;
}

/** One move of the agent, in order: the path the camera follows in the tour. */
export interface JourneyStep {
  nodeId: string;
  /** The move that arrived here (null for the start). */
  edgeId: string | null;
  label: string | null;
  seq: number;
  atMs: number;
  framePath: string;
}

export interface ExplorationTree {
  nodes: ScreenNode[];
  edges: ScreenEdge[];
  journey: JourneyStep[];
  rootId: string | null;
}

type Obj = { [key: string]: Json | undefined };

function isObj(v: Json | undefined): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: Json | undefined): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** A short label for the element an action targeted: its recorded label, else its text. */
function targetLabel(args: Obj): string | null {
  const sig = isObj(args.sig) ? args.sig : null;
  const target = isObj(args.target) ? args.target : null;
  return (
    str(target?.label) ??
    str(sig?.label) ??
    str(target?.text) ??
    str(target?.spec) ??
    str(target?.id) ??
    str(sig?.value) ??
    (sig && str(sig.type) ? `${sig.type}` : null)
  );
}

function urlPath(raw: string): string {
  try {
    const u = new URL(raw);
    return u.pathname === "/" ? u.host : u.pathname;
  } catch {
    return raw;
  }
}

/** One-line description of an action step, for edge labels and captions. */
export function describeAction(step: Pick<Step, "kind" | "args" | "result">): string {
  const a: Obj = isObj(step.args) ? step.args : {};
  const label = targetLabel(a);
  switch (step.kind) {
    case "tap":
      return label ? `tap "${label}"` : "tap";
    case "long_press":
      return label ? `long-press "${label}"` : "long-press";
    case "type":
      return `type "${String(a.text ?? "").slice(0, 24)}"`;
    case "clear":
      return label ? `clear "${label}"` : "clear";
    case "swipe":
      return `swipe ${String(a.direction ?? "")}`.trim();
    case "press":
      if (a.device_state) return `set ${a.appearance ? "appearance" : "network"}`;
      return `press ${String(a.key ?? "")}`.trim();
    case "launch":
    case "open_url": {
      const target = str(a.bundle_id) ?? str(a.url);
      return target ? `open ${urlPath(target)}` : "open";
    }
    default:
      return step.kind;
  }
}

/** A readable screen name from how the agent got there. */
function nameFrom(via: Step | null, fallback: string): string {
  if (!via) return fallback;
  const a: Obj = isObj(via.args) ? via.args : {};
  if (via.kind === "launch" || via.kind === "open_url") {
    const target = str(a.bundle_id) ?? str(a.url);
    if (target) return urlPath(target);
  }
  if (via.kind === "press") {
    const key = str(a.key);
    if (key === "back") return "Back";
    if (key === "home") return "Home";
  }
  return targetLabel(a) ?? fallback;
}

/**
 * What identifies a screen: its tree hash, or, when the accessibility tree was unavailable
 * for that look (`args.tree_unavailable`; every such tree hashes the same), the pixel digest
 * of its frame. Without this a run whose tree timed out throughout collapses into one node.
 */
function screenKeyHash(step: Step): string | null {
  const a = isObj(step.args) ? step.args : null;
  if (a?.tree_unavailable) {
    const digest = str(a.frame_digest);
    if (digest) return `px:${digest}`;
  }
  return step.screen_hash;
}

/** The device's home screen or launcher: not part of the app, so never a node. */
function isSystemHome(step: Step): boolean {
  const fg = step.foreground ?? "";
  return fg === "com.apple.springboard" || /launcher/i.test(fg);
}

/** Actions that change a screen's state but not the page it is on. */
const STATE_KINDS = new Set(["swipe", "type", "clear", "wait", "find"]);

function isStateOnly(moves: readonly Step[]): boolean {
  return (
    moves.length > 0 &&
    moves.every((m) => STATE_KINDS.has(m.kind) || (m.kind === "press" && isObj(m.args) && Boolean(m.args.device_state)))
  );
}

function pageOf(step: Step): { url: string; title: string } | null {
  const a = isObj(step.args) ? step.args : null;
  const page = a && isObj(a.page) ? a.page : a;
  const url = page ? str(page.url) : null;
  return url ? { url, title: str(page!.title) ?? "" } : null;
}

/** "Pricing – Linear" → "Pricing". Long titles keep their first part. */
function shortTitle(title: string): string | null {
  const t = title.trim();
  if (!t) return null;
  const first = t.split(/\s+[–—|·-]\s+/)[0].trim();
  return (first || t).slice(0, 48);
}

function anchorsOf(step: Step): Set<string> {
  const a = isObj(step.args) ? step.args : null;
  const list = a && Array.isArray(a.anchors) ? a.anchors : [];
  return new Set(list.filter((x): x is string => typeof x === "string"));
}

/** Whether a move was global navigation: opening a URL, or a control on the first screen. */
function isGlobalMove(via: Step | null, rootAnchors: Set<string>): boolean {
  if (!via) return false;
  if (via.kind === "launch" || via.kind === "open_url") return true;
  if (via.kind !== "tap") return false;
  const label = targetLabel(isObj(via.args) ? via.args : {});
  return Boolean(label && rootAnchors.has(label));
}

function hostOf(step: Step): string | null {
  const fg = step.foreground;
  // "unknown (?)" is what a device session reports when the tree never came back.
  if (!fg || /^unknown\b/i.test(fg)) return null;
  try {
    return new URL(fg).host;
  } catch {
    return fg;
  }
}

export function buildExplorationTree(
  steps: readonly Step[],
  evidence: readonly Evidence[] = [],
): ExplorationTree {
  const ordered = [...steps].sort((a, b) => a.seq - b.seq);
  const nodes = new Map<string, ScreenNode>();
  const edges = new Map<string, ScreenEdge>();
  const journey: JourneyStep[] = [];
  let current: string | null = null;
  let rootId: string | null = null;
  // Actions taken since the last screen: the last meaningful one names the move.
  let pending: Step[] = [];

  // Which node each screen hash belongs to (for runs without a page URL).
  const nodeOfHash = new Map<string, string>();
  let rootAnchors = new Set<string>();

  for (const step of ordered) {
    if (step.kind !== "screen") {
      if (step.kind !== "wait" && step.kind !== "evidence" && step.kind !== "find") pending.push(step);
      continue;
    }
    const hash = screenKeyHash(step);
    if (!hash || !step.frame_path || isSystemHome(step)) {
      continue;
    }
    const visit: ScreenVisit = { seq: step.seq, atMs: step.at_ms, framePath: step.frame_path };
    const moves = pending;
    const via = moves.length ? moves[moves.length - 1] : null;
    const moveLabel = moves.length ? moves.map(describeAction).slice(-2).join(" → ") : null;
    pending = [];
    const page = pageOf(step);
    const key: string =
      page?.url ??
      (current !== null && isStateOnly(moves) ? current : nodeOfHash.get(hash) ?? hash);
    nodeOfHash.set(hash, key);

    if (current === null) {
      rootId = key;
      rootAnchors = anchorsOf(step);
      nodes.set(key, {
        id: key,
        name: (page && shortTitle(page.title)) ?? hostOf(step) ?? "Start",
        depth: 0,
        parentId: null,
        via: null,
        order: 0,
        visits: [visit],
        findings: [],
        worst: null,
        childIds: [],
      });
      journey.push({ nodeId: key, edgeId: null, label: null, seq: step.seq, atMs: step.at_ms, framePath: step.frame_path });
      current = key;
      continue;
    }

    if (key === current) {
      // Same page (a re-look, a scroll, typed text, a toggle): one more visit, no move.
      nodes.get(key)!.visits.push(visit);
      continue;
    }

    const existing = nodes.get(key);
    let edgeId: string;
    if (!existing) {
      const parent = nodes.get(rootId && current !== rootId && isGlobalMove(via, rootAnchors) ? rootId : current)!;
      const node: ScreenNode = {
        id: key,
        name: (page && shortTitle(page.title)) ?? nameFrom(via, `Screen ${nodes.size + 1}`),
        depth: parent.depth + 1,
        parentId: parent.id,
        via: moveLabel,
        order: nodes.size,
        visits: [visit],
        findings: [],
        worst: null,
        childIds: [],
      };
      nodes.set(key, node);
      parent.childIds.push(key);
      edgeId = `t:${parent.id}->${key}`;
      edges.set(edgeId, { id: edgeId, source: parent.id, target: key, kind: "tree", label: moveLabel ?? "" });
    } else {
      existing.visits.push(visit);
      const treeId = `t:${current}->${key}`;
      const reverseTreeId = `t:${key}->${current}`;
      if (edges.has(treeId)) {
        edgeId = treeId;
      } else if (edges.has(reverseTreeId)) {
        edgeId = reverseTreeId;
      } else {
        edgeId = `r:${current}->${key}`;
        if (!edges.has(edgeId)) {
          edges.set(edgeId, { id: edgeId, source: current, target: key, kind: "return", label: moveLabel ?? "" });
        }
      }
    }
    journey.push({ nodeId: key, edgeId, label: moveLabel, seq: step.seq, atMs: step.at_ms, framePath: step.frame_path });
    current = key;
  }

  // Attach evidence to the screen the agent was on when it was captured.
  if (evidence.length && journey.length) {
    for (const e of evidence) {
      const at = e.seq ?? null;
      if (at == null) continue;
      let owner: string | null = null;
      for (const j of journey) {
        if (j.seq <= at) owner = j.nodeId;
        else break;
      }
      const node = owner ? nodes.get(owner) : null;
      if (!node) continue;
      node.findings.push({ seq: e.seq, severity: e.severity, label: e.label });
      if (e.severity !== "info" && (!node.worst || sevRank(e.severity) < sevRank(node.worst))) {
        node.worst = e.severity;
      }
    }
  }

  // Pages that share a title (a site whose login and signup pages are all "Linear") get their
  // path added, so the map does not show three identical names.
  const byName = new Map<string, ScreenNode[]>();
  for (const n of nodes.values()) byName.set(n.name, [...(byName.get(n.name) ?? []), n]);
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    for (const n of group) {
      if (/^https?:\/\//.test(n.id)) {
        const path = urlPath(n.id);
        if (path !== n.name) n.name = `${n.name} · ${path}`;
      }
    }
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()], journey, rootId };
}

export interface Placed {
  x: number;
  y: number;
}

/**
 * Top-down tidy tree: each leaf gets its own column, a parent sits centred over its children.
 * Returns top-left positions for nodes `nodeW` wide, `rowH` apart vertically.
 */
export function layoutTree(
  tree: ExplorationTree,
  nodeW: number,
  rowH: number,
  gapX = 60,
): Map<string, Placed> {
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const out = new Map<string, Placed>();
  let nextLeafX = 0;
  const place = (id: string): number => {
    const node = byId.get(id)!;
    const kids = node.childIds.filter((c) => byId.has(c));
    let centre: number;
    if (kids.length === 0) {
      centre = nextLeafX + nodeW / 2;
      nextLeafX += nodeW + gapX;
    } else {
      const centres = kids.map(place);
      centre = (centres[0] + centres[centres.length - 1]) / 2;
    }
    out.set(id, { x: centre - nodeW / 2, y: node.depth * rowH });
    return centre;
  };
  if (tree.rootId && byId.has(tree.rootId)) place(tree.rootId);
  return out;
}
