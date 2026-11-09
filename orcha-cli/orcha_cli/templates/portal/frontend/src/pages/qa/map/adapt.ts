/**
 * `GET C/map` as the `AppMap` the canvas draws. A node keeps each source's part apart
 * (`evidence[source]`, `detail[source]`): here they fold into the one evidence and detail the map
 * reads, `crawl` and `agent` count as live evidence and a dead end. Coverage, edge coverage and
 * each source's last read come from the extra fields of `read_map`; they are optional, so a map
 * without them still draws.
 */
import { frameUrl, screenRoute, type Platform, type QaFeature, type QaMap as ApiMap, type QaNode } from "../qaApi";
import { parseAppMap, type AppMap } from "./types";

type Obj = Record<string, unknown>;

const FOLD_ORDER = ["code", "tests", "live", "crawl", "agent"];

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);

/** `"Cart.swift:12"` or `{path, line}`. */
function ref(v: unknown): Obj | null {
  if (isObj(v)) return v;
  if (typeof v !== "string" || !v) return null;
  const m = /^(.*?):(\d+)$/.exec(v);
  return m ? { path: m[1], line: Number(m[2]) } : { path: v, line: null };
}

function liveOf(ev: Obj, node: QaNode): Obj {
  const parts = [ev.live, ev.crawl].filter(isObj);
  if (parts.length === 0) return {};
  const ids = [...new Set(parts.flatMap((p) => list(p.session_ids)).filter((x): x is string => typeof x === "string"))];
  const said = parts.reduce((n, p) => n + (typeof p.runs === "number" ? p.runs : 0), 0);
  const sighted = parts.some((p) => typeof p.sightings === "number" && p.sightings > 0);
  const runs = Math.max(ids.length, said, sighted ? 1 : 0);
  const at = parts.map((p) => p.last_seen_at).find((x) => typeof x === "string") ?? node.last_seen_at;
  const last = parts.map((p) => p.last_run_id).find((x) => typeof x === "string") ?? ids[0] ?? null;
  return runs > 0 ? { runs, last_run_id: last, last_seen_at: at } : {};
}

/** The dead end a run or an agent reported on a screen. */
function crawlOf(ev: Obj, node: QaNode): Obj | null {
  if (!node.blocked_kind && !node.blocked_reason) return null;
  const agent = isObj(ev.agent) && isObj(ev.agent.blocked) ? ev.agent.blocked : {};
  return { kind: node.blocked_kind, reason: node.blocked_reason, run_id: agent.session_id ?? null, at: agent.at ?? null };
}

function evidenceOf(n: QaNode): Obj {
  const ev = isObj(n.evidence) ? n.evidence : {};
  return {
    code: list(ev.code).flatMap((c) => ref(c) ?? []),
    tests: list(ev.tests).flatMap((t) => ref(t) ?? []),
    live: liveOf(ev, n),
    crawl: crawlOf(ev, n),
  };
}

/** Each source's detail folded: the first source (code first) to say a field says it; lists join. */
function detailOf(n: QaNode, platform: Platform): Obj {
  const parts = isObj(n.detail) ? n.detail : {};
  const ordered = [...FOLD_ORDER.map((s) => parts[s]), parts].filter(isObj);
  const first = (key: string): unknown => ordered.map((p) => p[key]).find((v) => v != null && v !== "" && !(Array.isArray(v) && v.length === 0));
  const joined = (key: string): unknown[] => [...new Set(ordered.flatMap((p) => list(p[key])))];
  return {
    route: screenRoute(n),
    platform,
    // What a run read on the screen is what the screen says.
    anchors: (isObj(parts.live) ? parts.live.anchors : null) ?? first("anchors"),
    actions: joined("actions"),
    method: first("method"),
    pattern: first("pattern"),
    side: first("side"),
    statuses: joined("statuses"),
    body_keys: joined("body_keys"),
    handler: first("handler"),
    store: first("store"),
    fields: first("fields"),
    framework: first("framework"),
    skipped: first("skipped"),
    skip_reason: first("skip_reason"),
    unlinked: first("unlinked"),
  };
}

const orderOf = (detail: unknown): unknown => {
  if (!isObj(detail)) return null;
  return [...Object.values(detail).filter(isObj), detail].map((p) => p.order).find((v) => typeof v === "number") ?? null;
};

/** The map's sources in the three the canvas knows: a crawl's sighting is a live one. */
const sourcesOf = (sources: readonly string[] | null | undefined): string[] => [...new Set((sources ?? []).map((s) => (s === "crawl" ? "live" : s)))];

function featureOf(f: QaFeature, screens: readonly QaNode[]): Obj {
  const mine = screens.filter((n) => n.feature_key === f.key);
  return { ...f, screens: mine.length, seen: mine.filter((n) => n.state === "seen").length };
}

/** What a build read and what it reused: each import reads one source, the others stay as last read. */
function buildReads(source: string | null, error: string | null | undefined, sources: unknown): Obj {
  const read = source === "code" || source === "tests" ? source : "live";
  const known = isObj(sources) ? sources : {};
  const reused: Obj = {};
  for (const s of ["code", "tests", "live"]) {
    const part = known[s];
    if (s !== read && isObj(part) && typeof part.at === "string") reused[s] = part.at;
  }
  return { planned: [read], reused, sources: { [read]: error ? { error } : {} } };
}

export function adaptMap(api: ApiMap, cid: string, platform: Platform): AppMap {
  const extra = api as unknown as Obj;
  const screens = api.nodes.filter((n) => n.kind === "screen");
  // Features are per project: on a platform with screens, one none of them belong to is left out.
  const here = new Set(screens.map((n) => n.feature_key));
  const features = api.features.filter((f) => screens.length === 0 || here.has(f.key));
  const known = new Set(features.map((f) => f.key));
  const b = api.last_build;
  return parseAppMap({
    project_id: cid,
    built_at: b ? (b.ended_at ?? b.started_at) : null,
    build: b ? { id: b.id, status: b.status, started_at: b.started_at, finished_at: b.ended_at, error: b.error, ...buildReads(b.source, b.error, extra.sources) } : null,
    sources: extra.sources,
    features: features.map((f) => featureOf(f, screens)),
    nodes: api.nodes.map((n) => ({
      id: n.id,
      row_id: n.id,
      kind: n.kind,
      key: n.key,
      label: n.label,
      feature: n.feature_key && known.has(n.feature_key) ? n.feature_key : null,
      state: n.state,
      blocked_reason: n.blocked_reason,
      frame_url: n.frame_id ? frameUrl(n.frame_id) : null,
      evidence: evidenceOf(n),
      detail: detailOf(n, platform),
      covered_by: (n as unknown as Obj).covered_by,
    })),
    edges: api.edges.map((e) => {
      const more = e as unknown as Obj;
      return { id: e.id, kind: e.kind, from: e.from_node_id, to: e.to_node_id, label: e.label, count: e.count, sources: sourcesOf(e.sources), order: orderOf(more.detail), covered: more.covered };
    }),
  });
}
