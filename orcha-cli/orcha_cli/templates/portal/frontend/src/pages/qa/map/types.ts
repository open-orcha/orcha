/**
 * The app map the canvas draws (`adapt.ts` builds it from `GET C/map`). Pure. `parseAppMap`
 * narrows the JSON (unknown fields dropped, missing ones defaulted), so a map from an older or
 * newer builder still renders.
 */

export type NodeKind = "screen" | "endpoint" | "entity" | "flow";
export type NodeState = "seen" | "declared" | "blocked";
export type EdgeKind = "navigates" | "calls" | "reads" | "writes" | "steps";
/** Where a fact on the map comes from. */
export type EvidenceSource = "code" | "tests" | "live";
export type EndpointSide = "client" | "server" | "both";
export type EntityStore = "swiftdata" | "coredata" | "room" | "prisma" | "api";
export type BuildStatus = "queued" | "running" | "done" | "failed";
export type FeatureCoverage = "untested" | "thin" | "covered" | "strong" | "failing";
/** How a scenario is known to cover a node (`qa_map_cover.py`): its runs went there, its
 * recorded trace did, or it is a team's test converted into a scenario. */
export type CoverVia = "run" | "trace" | "migration";

/** What stopped the Map the app crawl on a screen (`map_blocked(kind=...)`). */
export type BlockedKind = "needs_sign_in" | "needs_data" | "needs_permission" | "paywall" | "external" | "crash" | "other";

export const EVIDENCE_SOURCES: readonly EvidenceSource[] = ["code", "tests", "live"];
const NODE_KINDS: readonly NodeKind[] = ["screen", "endpoint", "entity", "flow"];
const NODE_STATES: readonly NodeState[] = ["seen", "declared", "blocked"];
const EDGE_KINDS: readonly EdgeKind[] = ["navigates", "calls", "reads", "writes", "steps"];
const SIDES: readonly EndpointSide[] = ["client", "server", "both"];
const STORES: readonly EntityStore[] = ["swiftdata", "coredata", "room", "prisma", "api"];
const BUILD_STATUSES: readonly BuildStatus[] = ["queued", "running", "done", "failed"];
const COVERAGES: readonly FeatureCoverage[] = ["untested", "thin", "covered", "strong", "failing"];
const VIAS: readonly CoverVia[] = ["run", "trace", "migration"];
const BLOCKED_KINDS: readonly BlockedKind[] = ["needs_sign_in", "needs_data", "needs_permission", "paywall", "external", "crash", "other"];

export interface CodeRef {
  path: string;
  line: number | null;
}

export interface TestRef {
  path: string;
  test_name: string;
  line: number | null;
  framework: string | null;
}

export interface LiveEvidence {
  runs: number;
  last_run_id: string | null;
  last_seen_at: string | null;
}

/** The crawl's dead end: why it could not reach the screen, and what kind of dead end. */
export interface CrawlEvidence {
  reason: string | null;
  kind: BlockedKind | null;
  run_id: string | null;
  at: string | null;
}

export interface NodeEvidence {
  code: CodeRef[];
  tests: TestRef[];
  /** Null when no run has reached it. */
  live: LiveEvidence | null;
  /** Null unless a crawl marked it a dead end. */
  crawl: CrawlEvidence | null;
}

/** Every kind's detail, flattened: a field another kind does not have is null or empty. */
export interface NodeDetail {
  // screen
  route: string | null;
  platform: string | null;
  anchors: string[];
  actions: string[];
  // endpoint
  method: string | null;
  pattern: string | null;
  side: EndpointSide | null;
  statuses: number[];
  body_keys: string[];
  /** The server route that backs it, as `path:line` or a name. */
  handler: string | null;
  // entity
  store: EntityStore | null;
  fields: string[];
  // flow
  framework: string | null;
  /** A skipped or disabled test: still a flow, marked. */
  skipped: boolean;
  skip_reason: string | null;
  /** Why a flow walks no screen yet (the builder's words), or null. */
  unlinked: string | null;
}

/** One scenario that covers a node, with its newest result (null before it has one). */
export interface CoverLink {
  scenario_id: string;
  title: string;
  result: "pass" | "fail" | null;
  via: CoverVia;
}

export interface AppMapNode {
  id: string;
  /** The `app_map_nodes` row id, which the change feed names; null from an older builder. */
  row_id: string | null;
  kind: NodeKind;
  key: string;
  label: string;
  /** The feature key (`app_features`), or null for a node no feature claims. */
  feature: string | null;
  state: NodeState;
  blocked_reason: string | null;
  frame_url: string | null;
  evidence: NodeEvidence;
  detail: NodeDetail;
  /** The scenarios that cover it; empty when none does (absent from an older builder's map, and
   * optional so hand-built nodes need not say). */
  covered_by?: CoverLink[];
}

export interface AppMapEdge {
  id: string;
  kind: EdgeKind;
  from: string;
  to: string;
  label: string | null;
  count: number;
  sources: EvidenceSource[];
  /** A `steps` edge's place in its flow. */
  order: number;
  /** A scenario walked it (a run or a recorded trace took this move). */
  covered?: boolean;
}

export interface AppMapFeature {
  key: string;
  name: string;
  summary: string | null;
  screens: number;
  seen: number;
  coverage: FeatureCoverage;
  /** Its screens a scenario covers. */
  covered_screens?: number;
}

export interface AppMapBuild {
  id: string;
  status: BuildStatus;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  /** The sources this build reads (#467): one it does not is reused from an earlier read. */
  planned?: EvidenceSource[];
  /** Each source it reused, with when that read was made. */
  reused?: Partial<Record<EvidenceSource, string | null>>;
  /** Each source it read so far, and whether the read worked. */
  ran?: Partial<Record<EvidenceSource, boolean>>;
}

const SOURCE_KEYS: readonly EvidenceSource[] = ["code", "tests", "live"];

export interface CodeSource {
  at: string | null;
  repo: string | null;
  screens: number;
  edges: number;
  endpoints: number;
  entities: number;
}

export interface TestsSource {
  at: string | null;
  tests: number;
  flows: number;
  frameworks: string[];
}

export interface LiveSource {
  at: string | null;
  runs: number;
  last_run_id: string | null;
}

export interface AppMapCounts {
  features: number;
  /** The screens Coverage counts too: each platform's own screen apart (#467), split in `platforms`. */
  screens: number;
  seen: number;
  declared: number;
  blocked: number;
  /** How many of `screens` are each platform's (empty from a map built before #467). */
  platforms: Partial<Record<"ios" | "android" | "web", number>>;
  endpoints: number;
  entities: number;
  flows: number;
  edges: number;
}

export interface AppMap {
  project_id: string;
  built_at: string | null;
  /** The latest build, or null before the first one. */
  build: AppMapBuild | null;
  /** What each source said last; null for a source that has not been read. */
  sources: { code: CodeSource | null; tests: TestsSource | null; live: LiveSource | null };
  counts: AppMapCounts;
  features: AppMapFeature[];
  nodes: AppMapNode[];
  edges: AppMapEdge[];
}

export const STATE_LABEL: Record<NodeState, string> = { seen: "Seen", declared: "Declared", blocked: "Blocked" };
export const BLOCKED_KIND_LABEL: Record<BlockedKind, string> = {
  needs_sign_in: "Needs sign-in",
  needs_data: "Needs data",
  needs_permission: "Needs a permission",
  paywall: "Behind a paywall",
  external: "Leaves the app",
  crash: "Crashes",
  other: "Dead end",
};
export const SOURCE_LABEL: Record<EvidenceSource, string> = { code: "Code", tests: "Tests", live: "Live" };
export const SIDE_LABEL: Record<EndpointSide, string> = { client: "App", server: "Server", both: "App + server" };
export const STORE_LABEL: Record<EntityStore, string> = { swiftdata: "SwiftData", coredata: "Core Data", room: "Room", prisma: "Prisma", api: "API" };

function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function strings(v: unknown): string[] {
  return arr(v).filter((x): x is string => typeof x === "string" && x !== "");
}

function oneOf<T extends string>(values: readonly T[], v: unknown): T | null {
  return values.includes(v as T) ? (v as T) : null;
}

function codeRef(v: unknown): CodeRef | null {
  const o = obj(v);
  const path = str(o.path);
  return path ? { path, line: numOrNull(o.line) } : null;
}

function evidenceOf(v: unknown): NodeEvidence {
  const e = obj(v);
  const live = obj(e.live);
  const runs = num(live.runs);
  return {
    code: arr(e.code).flatMap((c) => codeRef(c) ?? []),
    tests: arr(e.tests).flatMap((t): TestRef[] => {
      const o = obj(t);
      const name = str(o.test_name) ?? str(o.name);
      const path = str(o.path);
      if (!name && !path) return [];
      return [{ path: path ?? "", test_name: name ?? path ?? "", line: numOrNull(o.line), framework: str(o.framework) }];
    }),
    // A run that saw it says so with a count or a last run; an empty `{}` is no live evidence.
    live: runs > 0 || str(live.last_run_id)
      ? { runs: Math.max(1, runs), last_run_id: str(live.last_run_id), last_seen_at: str(live.last_seen_at) }
      : null,
    crawl: crawlOf(e.crawl),
  };
}

function coverLinks(v: unknown): CoverLink[] {
  return arr(v).flatMap((x): CoverLink[] => {
    const o = obj(x);
    const id = str(o.scenario_id);
    if (!id) return [];
    return [{ scenario_id: id, title: str(o.title) ?? "Scenario", result: oneOf(["pass", "fail"] as const, o.result), via: oneOf(VIAS, o.via) ?? "run" }];
  });
}

function crawlOf(v: unknown): CrawlEvidence | null {
  const c = obj(v);
  const reason = str(c.reason);
  const kind = oneOf(BLOCKED_KINDS, c.kind);
  if (!reason && !kind) return null;
  return { reason, kind, run_id: str(c.run_id), at: str(c.at) };
}

/**
 * A blocked screen's reason with its kind: "Needs sign-in: the listing asks for an account". The
 * plain reason when the crawl gave no kind (or `other`), the kind alone when it gave no reason.
 */
export function blockedText(node: Pick<AppMapNode, "blocked_reason" | "evidence">): string | null {
  const reason = node.blocked_reason ?? node.evidence.crawl?.reason ?? null;
  const kind = node.evidence.crawl?.kind ?? null;
  if (!kind || kind === "other") return reason;
  const label = BLOCKED_KIND_LABEL[kind];
  if (!reason) return label;
  // A reason that already says the kind ("Needs sign-in") is not repeated.
  return reason.toLowerCase().startsWith(label.toLowerCase()) ? reason : `${label}: ${reason}`;
}

function handlerOf(v: unknown): string | null {
  if (typeof v === "string") return v || null;
  const ref = codeRef(v);
  return ref ? (ref.line ? `${ref.path}:${ref.line}` : ref.path) : null;
}

function detailOf(v: unknown): NodeDetail {
  const d = obj(v);
  return {
    route: str(d.route),
    platform: str(d.platform),
    anchors: strings(d.anchors),
    actions: strings(d.actions),
    method: str(d.method)?.toUpperCase() ?? null,
    pattern: str(d.pattern),
    side: oneOf(SIDES, d.side),
    statuses: arr(d.statuses).filter((s): s is number => typeof s === "number" && Number.isFinite(s)),
    body_keys: strings(d.body_keys),
    handler: handlerOf(d.handler),
    store: oneOf(STORES, typeof d.store === "string" ? d.store.toLowerCase().replace(/[\s_-]/g, "") : null),
    fields: arr(d.fields).flatMap((f) => (typeof f === "string" ? [f] : str(obj(f).name) ?? [])),
    framework: str(d.framework),
    skipped: d.skipped === true || Boolean(str(d.skip_reason)),
    skip_reason: str(d.skip_reason),
    unlinked: str(d.unlinked),
  };
}

function sourceAt(o: Record<string, unknown>): string | null {
  return str(o.at);
}

/** Narrow the builder's JSON to an `AppMap`. Nodes without an id or a known kind, and edges
 * whose ends are not on the map, are dropped. */
export function parseAppMap(raw: unknown): AppMap {
  const r = obj(raw);
  const nodes: AppMapNode[] = arr(r.nodes).flatMap((x): AppMapNode[] => {
    const n = obj(x);
    const id = str(n.id);
    const kind = oneOf(NODE_KINDS, n.kind);
    if (!id || !kind) return [];
    const key = str(n.key) ?? id.replace(/^[a-z]+:/, "");
    return [
      {
        id,
        row_id: str(n.row_id),
        kind,
        key,
        label: str(n.label) ?? key,
        feature: str(n.feature),
        state: oneOf(NODE_STATES, n.state) ?? "declared",
        blocked_reason: str(n.blocked_reason),
        frame_url: str(n.frame_url),
        evidence: evidenceOf(n.evidence),
        detail: detailOf(n.detail),
        covered_by: coverLinks(n.covered_by),
      },
    ];
  });
  const ids = new Set(nodes.map((n) => n.id));
  const edges: AppMapEdge[] = arr(r.edges).flatMap((x, i): AppMapEdge[] => {
    const e = obj(x);
    const kind = oneOf(EDGE_KINDS, e.kind);
    const from = str(e.from);
    const to = str(e.to);
    if (!kind || !from || !to || !ids.has(from) || !ids.has(to)) return [];
    const detail = obj(e.detail);
    return [
      {
        id: str(e.id) ?? `${kind}:${from}>${to}:${i}`,
        kind,
        from,
        to,
        label: str(e.label),
        count: Math.max(1, num(e.count)),
        sources: EVIDENCE_SOURCES.filter((s) => strings(e.sources).includes(s)),
        order: numOrNull(e.order) ?? num(detail.order),
        covered: e.covered === true,
      },
    ];
  });
  const features: AppMapFeature[] = arr(r.features).flatMap((x): AppMapFeature[] => {
    const f = obj(x);
    const key = str(f.key);
    if (!key) return [];
    return [
      {
        key,
        name: str(f.name) ?? key,
        summary: str(f.summary),
        screens: num(f.screens),
        seen: num(f.seen),
        coverage: oneOf(COVERAGES, f.coverage) ?? "untested",
        covered_screens: num(f.covered_screens),
      },
    ];
  });
  const sources = obj(r.sources);
  const code = obj(sources.code);
  const tests = obj(sources.tests);
  const live = obj(sources.live);
  const c = obj(r.counts);
  const screens = nodes.filter((n) => n.kind === "screen");
  const platformCounts = (v: unknown): AppMapCounts["platforms"] => {
    const o = obj(v);
    const out: AppMapCounts["platforms"] = {};
    for (const p of ["ios", "android", "web"] as const) if (typeof o[p] === "number" && Number(o[p]) > 0) out[p] = num(o[p]);
    return out;
  };
  // Counts the builder left out are counted here, so the header never says 0 over a full map.
  const count = (key: string, fallback: number) => (typeof c[key] === "number" ? num(c[key]) : fallback);
  return {
    project_id: String(r.project_id ?? ""),
    built_at: str(r.built_at),
    build: parseBuild(r.build),
    sources: {
      code: Object.keys(code).length
        ? { at: sourceAt(code), repo: str(code.repo), screens: num(code.screens), edges: num(code.edges), endpoints: num(code.endpoints), entities: num(code.entities) }
        : null,
      tests: Object.keys(tests).length ? { at: sourceAt(tests), tests: num(tests.tests), flows: num(tests.flows), frameworks: strings(tests.frameworks) } : null,
      live: Object.keys(live).length ? { at: sourceAt(live), runs: num(live.runs), last_run_id: str(live.last_run_id) } : null,
    },
    counts: {
      features: count("features", features.length),
      screens: count("screens", screens.length),
      seen: count("seen", screens.filter((n) => n.state === "seen").length),
      declared: count("declared", screens.filter((n) => n.state === "declared").length),
      blocked: count("blocked", screens.filter((n) => n.state === "blocked").length),
      platforms: platformCounts(c.platforms),
      endpoints: count("endpoints", nodes.filter((n) => n.kind === "endpoint").length),
      entities: count("entities", nodes.filter((n) => n.kind === "entity").length),
      flows: count("flows", nodes.filter((n) => n.kind === "flow").length),
      edges: count("edges", edges.length),
    },
    features,
    nodes,
    edges,
  };
}

/** Parse one build's status row (`GET /api/projects/<id>/app-map/builds/<build_id>`). */
export function parseBuild(raw: unknown): AppMapBuild | null {
  const b = obj(raw);
  const id = str(b.id);
  if (!id) return null;
  const planned = Array.isArray(b.planned) ? SOURCE_KEYS.filter((s) => (b.planned as unknown[]).includes(s)) : undefined;
  const reusedRaw = obj(b.reused);
  const reused: AppMapBuild["reused"] = {};
  for (const s of SOURCE_KEYS) if (s in reusedRaw) reused[s] = str(reusedRaw[s]);
  const parts = obj(b.sources);
  const ran: AppMapBuild["ran"] = {};
  for (const s of SOURCE_KEYS) {
    const part = parts[s];
    if (part && typeof part === "object") ran[s] = !obj(part).error;
  }
  return {
    id, status: oneOf(BUILD_STATUSES, b.status) ?? "running", started_at: str(b.started_at), finished_at: str(b.finished_at), error: str(b.error),
    ...(planned ? { planned, reused, ran } : {}),
  };
}

/** Whether the map has nothing on it yet (no build, or a build that found nothing). A project's
 * feature list alone (from the feature scan) is no map: it would draw empty regions. */
export function isEmptyMap(map: AppMap): boolean {
  return map.nodes.length === 0;
}

/** Whether a build is still going. */
export function isBuilding(build: AppMapBuild | null): boolean {
  return build?.status === "queued" || build?.status === "running";
}
