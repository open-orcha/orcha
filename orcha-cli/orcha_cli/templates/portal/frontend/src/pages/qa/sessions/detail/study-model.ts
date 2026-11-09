/**
 * The Study face's decisions, without the DOM: which scene a study gets, which source rows it
 * shows (only the ones with something in them), which names the explorer has opened, how a
 * studied page reads (title, navigation, links, texts) and what the Features row holds.
 * Everything comes from the study's manifest, the run's screens and the explorer's own reads:
 * nothing here is invented.
 */
import { featureNameFromKey } from "../explorations";
import type { BriefingSource, Exploration } from "../explorations";
import type { StudyItem, StudyManifest, StudyScreen, StudySource, StudySourceKind } from "../explorations";
import { studyFeatures } from "./model";

// Scenes --------------------------------------------------------------------------------------

/**
 * - code: a repository is linked, the explorer reads files.
 * - site: no repository, a web (or desktop) target: Orcha studies the live site in a browser.
 * - device: no repository, a phone: the app's screens in a device frame.
 * - timeline: no repository and no screen yet, but earlier runs left memory, findings or
 *   explorations: what they learned, in order. The site or device scene takes over with the
 *   first screen and keeps the timeline beside it.
 */
export type StudyScene = "code" | "site" | "device" | "timeline";

const PAST_KINDS: readonly StudySourceKind[] = ["memory", "findings", "history"];

export function isPhonePlatform(platform: string | null | undefined): boolean {
  return platform === "ios" || platform === "android";
}

export function chooseScene(input: { manifest: StudyManifest | null | undefined; platform: string | null | undefined; hasScreen: boolean }): StudyScene {
  const m = input.manifest;
  if (m?.repo) return "code";
  const past = Boolean(m?.sources.some((s) => PAST_KINDS.includes(s.kind)));
  if (past && !input.hasScreen) return "timeline";
  return isPhonePlatform(input.platform) ? "device" : "site";
}

/** The source kinds a scene draws itself; the rows under it leave them out. */
export const SCENE_KINDS: Readonly<Record<StudyScene, readonly StudySourceKind[]>> = {
  code: ["code", "tests", "docs", "features"],
  site: ["features"],
  device: ["features"],
  timeline: ["memory", "findings", "history", "features"],
};

export const SCENE_TITLE: Readonly<Record<StudyScene, string>> = {
  code: "Reading the code",
  site: "Reading the live site",
  device: "Reading the app",
  timeline: "Recalling earlier runs",
};

/** The one honest line for a study without a repository; null when there is one (or not known yet). */
export function missingRepoLine(manifest: StudyManifest | null | undefined, scene: StudyScene, platform: string | null | undefined): string | null {
  if (!manifest || manifest.repo) return null;
  if (scene === "timeline") return "No repository linked: reading what earlier runs learned";
  if (isPhonePlatform(platform)) return "No repository linked: studying the app on the device";
  return platform === "desktop" ? "No repository linked: studying the running app" : "No repository linked: studying the live site";
}

// What the explorer opened ---------------------------------------------------------------------

/** A briefing source's kind as the manifest's. */
const REPORTED_KIND: Readonly<Record<BriefingSource["kind"], StudySourceKind>> = {
  code: "code",
  test: "tests",
  scenario: "scenarios",
  doc: "docs",
  context: "context",
  memory: "memory",
  finding: "findings",
};

/** Files the agent read that are Orcha's own (the pack, the brief, the skill), not the app's. */
function isOwnFile(path: string): boolean {
  return /(^|\/)(qa-runs|\.claude|skills)\//.test(path) || /\.(study|exploration|scope)\.md$/.test(path);
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\\/g, "/");
}

function pathMatches(read: string, path: string): boolean {
  const r = norm(read);
  const p = norm(path).replace(/^\.\//, "");
  return r === p || r.endsWith(`/${p}`);
}

/** A briefing's `ref` names this item: its path or its name, either way round. */
function refMatches(ref: string, item: StudyItem): boolean {
  const r = norm(ref);
  if (!r) return false;
  if (item.path && (pathMatches(r, item.path) || norm(item.path).endsWith(`/${r}`))) return true;
  const n = norm(item.name);
  if (r === n || (item.key && r === norm(item.key))) return true;
  return r.length >= 6 && n.length >= 6 && (n.includes(r) || r.includes(n));
}

export interface ReadState {
  /** The explorer's reads of the app's files (Orcha's own files left out), oldest first. */
  files: string[];
  /** What it reported in its briefing. */
  reported: BriefingSource[];
}

export function readState(manifest: StudyManifest | null | undefined, briefingSources: readonly BriefingSource[] | undefined, readFiles: readonly string[] | undefined): ReadState {
  return {
    files: (readFiles ?? []).filter((f) => typeof f === "string" && f && !isOwnFile(f)),
    reported: [...(manifest?.reported?.sources ?? briefingSources ?? [])],
  };
}

export function isItemLit(kind: StudySourceKind, item: StudyItem, read: ReadState): boolean {
  if (item.path && read.files.some((f) => pathMatches(f, item.path as string))) return true;
  return read.reported.some((s) => REPORTED_KIND[s.kind] === kind && refMatches(s.ref, item));
}

/** A path short enough for a chip: repo-relative when the manifest knows it, else its last parts. */
export function displayPath(path: string, known: readonly string[] = []): string {
  const hit = known.find((k) => pathMatches(path, k));
  if (hit) return hit;
  const parts = path.split("/").filter(Boolean);
  return parts.length > 3 ? parts.slice(-3).join("/") : parts.join("/");
}

// Source rows ---------------------------------------------------------------------------------

export const SOURCE_LABEL: Readonly<Record<StudySourceKind, string>> = {
  code: "Code",
  tests: "Tests",
  docs: "Docs",
  scenarios: "Scenarios",
  features: "Features",
  app_map: "App map",
  context: "Your context",
  memory: "Memory",
  findings: "Open findings",
  history: "Past runs",
};

/** "412 files", "38 tests in 12 files", "3 scenarios", "1 note". */
export function countLabel(s: Pick<StudySource, "kind" | "count" | "files">): string {
  const n = s.count;
  const plural = (one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  switch (s.kind) {
    case "code":
      return plural("file");
    case "tests":
      return plural("test") + (s.files ? ` in ${s.files} ${s.files === 1 ? "file" : "files"}` : "");
    case "docs":
      return plural("doc");
    case "scenarios":
      return plural("scenario");
    case "features":
      return plural("feature");
    case "app_map":
      return plural("screen");
    case "context":
      return "attached";
    case "memory":
      return plural("note");
    case "findings":
      return plural("finding");
    case "history":
      return plural("exploration");
  }
}

export interface RowChip extends StudyItem {
  lit: boolean;
  /** Named by the explorer's briefing, not in the pack's first names. */
  reported?: boolean;
}

export interface SourceRow {
  kind: StudySourceKind;
  label: string;
  count: string;
  chips: RowChip[];
  /** Names beyond the chips. */
  more: number;
  from?: string;
}

/**
 * The rows under the scene: one per source with something in it, minus the kinds the scene
 * draws. A name lights up once the explorer opened it; a source it reported that the pack did
 * not name is added to its row, marked as reported.
 */
/** Names a row shows before "+N more" (the opened ones always show). */
export const ROW_CHIPS = 6;

export function sourceRows(manifest: StudyManifest | null | undefined, read: ReadState, exclude: readonly StudySourceKind[] = []): SourceRow[] {
  if (!manifest) return [];
  const rows: SourceRow[] = [];
  for (const s of manifest.sources) {
    if (exclude.includes(s.kind) || s.count <= 0) continue;
    const chips: RowChip[] = s.items
      .map((i) => ({ ...i, lit: isItemLit(s.kind, i, read) }))
      .filter((c, n) => n < ROW_CHIPS || c.lit);
    const named = chips.length;
    for (const r of read.reported) {
      if (REPORTED_KIND[r.kind] !== s.kind) continue;
      if (s.items.some((i) => refMatches(r.ref, i)) || chips.some((c) => c.reported && c.name === r.ref)) continue;
      chips.push({ name: r.ref, detail: r.note, lit: true, reported: true });
    }
    rows.push({
      kind: s.kind,
      label: SOURCE_LABEL[s.kind],
      count: countLabel(s),
      chips,
      more: Math.max(0, s.count - named),
      ...(s.from ? { from: s.from } : {}),
    });
  }
  return rows;
}

// The code scene ------------------------------------------------------------------------------

export interface CodeFile {
  path: string;
  kind: "code" | "tests" | "docs";
  /** A test's title, a doc's title. */
  label?: string;
  lit: boolean;
}

/** How many files of each kind the code scene streams (the manifest names up to 12 each). */
export const CODE_SCENE_SHARE = { code: 8, tests: 5, docs: 3 } as const;

/** The files the code scene streams: the first code paths, then test files, then docs. One the
 * explorer opened is always shown, past its kind's share. */
export function codeFiles(manifest: StudyManifest | null | undefined, read: ReadState): CodeFile[] {
  const out: CodeFile[] = [];
  const seen = new Set<string>();
  for (const kind of ["code", "tests", "docs"] as const) {
    const s = manifest?.sources.find((x) => x.kind === kind);
    const items = s?.items ?? [];
    const shown = items.filter((i, n) => n < CODE_SCENE_SHARE[kind] || isItemLit(kind, i, read));
    for (const i of shown) {
      const path = i.path ?? i.name;
      if (seen.has(path)) continue;
      seen.add(path);
      out.push({ path, kind, label: kind === "code" ? undefined : i.name, lit: isItemLit(kind, i, read) });
    }
  }
  return out;
}

/** The files the explorer opened, in order, as short paths: the code scene pins them. */
export function pinnedFiles(manifest: StudyManifest | null | undefined, read: ReadState, limit = 8): string[] {
  const known = (manifest?.sources ?? []).flatMap((s) => s.items.map((i) => i.path).filter((p): p is string => Boolean(p)));
  const out: string[] = [];
  for (const f of read.files) {
    const p = displayPath(f, known);
    if (!out.includes(p)) out.push(p);
  }
  for (const r of read.reported) {
    if (r.kind !== "code" && r.kind !== "test" && r.kind !== "doc") continue;
    const p = displayPath(r.ref, known);
    if (!out.includes(p)) out.push(p);
  }
  return out.slice(-limit);
}

// The site and device scenes ------------------------------------------------------------------

/** Labels that are chrome on almost every site or app, never one of its sections. */
const GENERIC = /^(close|menu|open menu|back|back to home( page)?|home|log ?in|sign ?(in|up)|register|get started|search|skip( to)?.*|cancel|ok|done|next|more|accept( all)?|reject( all)?|cookie.*|privacy.*|terms.*|language|×)$/i;

export function isSectionLabel(label: string): boolean {
  const t = label.trim();
  if (t.length < 3 || t.length > 28 || t.split(/\s+/).length > 3) return false;
  return !GENERIC.test(t);
}

export interface PageOutline {
  seq: number;
  /** "dribbble.com/" for a page; null on a phone screen. */
  address: string | null;
  title: string | null;
  /** The first labels to click, in reading order: the navigation. */
  nav: string[];
  /** The other labels to click. */
  links: string[];
  /** Sentences on the page that are not controls: headings, intros. */
  texts: string[];
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host.replace(/^www\./, "")}${u.pathname}`;
  } catch {
    return url;
  }
}

/** How a studied page or screen reads: title, its navigation, its other links and its texts. */
export function pageOutline(screen: StudyScreen): PageOutline {
  const order = new Map(screen.texts.map((t, i) => [t, i] as const));
  // The page's own order (its texts are in reading order); anchors it does not show go last.
  const anchors = [...screen.anchors].sort((a, b) => (order.get(a) ?? 1e6) - (order.get(b) ?? 1e6));
  const nav = anchors.filter(isSectionLabel).slice(0, 8);
  const links = anchors.filter((a) => !nav.includes(a)).slice(0, 10);
  const anchorSet = new Set(screen.anchors);
  const texts = screen.texts.filter((t) => !anchorSet.has(t) && t.length >= 16 && t.length <= 110).slice(0, 4);
  return {
    seq: screen.seq,
    address: screen.url ? shortUrl(screen.url) : null,
    title: screen.title ?? (screen.url ? null : (screen.texts.find((t) => !anchorSet.has(t)) ?? null)),
    nav,
    links,
    texts,
  };
}

/** The sections the studied screens show (their navigation), first seen first. */
export function discoveredSections(screens: readonly StudyScreen[], limit = 8): string[] {
  const out: string[] = [];
  for (const s of screens) {
    for (const label of pageOutline(s).nav) {
      if (!out.some((o) => o.toLowerCase() === label.toLowerCase())) out.push(label);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// The Features row ----------------------------------------------------------------------------

export interface FeatureChip {
  key: string;
  name: string;
}

export type FeatureOrigin = "targets" | "briefing" | "feature_map" | "site" | "none";

/**
 * The Features row: the target features first (with the briefing's own as it arrives), else
 * the feature map, else the sections the studied screens show. Never a placeholder.
 */
export function featureChips(
  e: Pick<Exploration, "targets" | "charter" | "briefing" | "study">,
  screens: readonly StudyScreen[],
  limit = 8,
): { chips: FeatureChip[]; origin: FeatureOrigin } {
  const map = e.study?.sources.find((s) => s.kind === "features")?.items ?? [];
  const nameOf = (key: string) => map.find((i) => i.key === key)?.name ?? featureNameFromKey(key);
  const named = studyFeatures(e);
  if (named.length) {
    return { chips: named.slice(0, limit).map((k) => ({ key: k, name: nameOf(k) })), origin: e.targets.length ? "targets" : "briefing" };
  }
  if (map.length) return { chips: map.slice(0, limit).map((i) => ({ key: i.key ?? i.name, name: i.name })), origin: "feature_map" };
  const sections = discoveredSections(screens, limit);
  if (sections.length) return { chips: sections.map((s) => ({ key: s, name: s })), origin: "site" };
  return { chips: [], origin: "none" };
}

/** What the Features row says while it has nothing yet: what is being looked for, and where. */
export function featuresWaitingLine(scene: StudyScene): string {
  switch (scene) {
    case "code":
      return "Looking for the app's features in its code and its feature map.";
    case "site":
      return "Looking for the site's sections in its navigation, once the first page loads.";
    case "device":
      return "Looking for the app's sections on its first screens.";
    case "timeline":
      return "Looking for features in what earlier runs learned, then on the first screen.";
  }
}

// The timeline --------------------------------------------------------------------------------

export interface TimelineEntry {
  kind: "history" | "findings" | "memory";
  title: string;
  detail?: string;
  at?: string;
}

/** What earlier runs learned, newest exploration first, then its open findings, then memory. */
export function timelineEntries(manifest: StudyManifest | null | undefined, limit = 10): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  const src = (k: StudySourceKind) => manifest?.sources.find((s) => s.kind === k);
  for (const h of src("history")?.items ?? []) out.push({ kind: "history", title: h.name, detail: h.detail, at: h.at });
  const findings = src("findings");
  for (const f of findings?.items ?? []) out.push({ kind: "findings", title: f.name, detail: [f.detail, findings?.from ? `left open by ${findings.from}` : null].filter(Boolean).join(" · ") || undefined });
  for (const m of src("memory")?.items ?? []) out.push({ kind: "memory", title: m.name, detail: m.detail });
  return out.slice(0, limit);
}
