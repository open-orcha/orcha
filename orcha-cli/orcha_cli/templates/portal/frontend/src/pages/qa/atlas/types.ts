/**
 * The Screen atlas as `GET /api/containers/<id>/qa/atlas` returns it (`qa_atlas.py`). Pure:
 * shared by the page and the client. `parseAtlas` narrows the JSON (unknown fields dropped, missing ones defaulted),
 * so an atlas from an older or newer reader still renders.
 */

export type Platform = "ios" | "android" | "web";
export type Badge = "same" | "minor" | "different" | "missing" | "unchecked" | "unmatched";
/**
 * What one platform of a screen is: seen live, in its code but not seen yet, not in its code (the
 * platform's code is mapped and nothing there is like this screen), or no match found (unknown:
 * the code is not mapped, or mentions the screen, which may be part of another one there).
 */
export type Presence = "seen" | "unseen" | "absent" | "unknown";

export const PLATFORMS: readonly Platform[] = ["ios", "android", "web"];
const BADGES: readonly Badge[] = ["same", "minor", "different", "missing", "unchecked", "unmatched"];
const PRESENCES: readonly Presence[] = ["seen", "unseen", "absent", "unknown"];

export type DeviceKind = "phone" | "tablet" | "desktop" | "browser";
const DEVICE_KINDS: readonly DeviceKind[] = ["phone", "tablet", "desktop", "browser"];
/** The kind of device a look was taken on, as a person sorts them (a browser window is a desktop). */
export type DeviceForm = "phone" | "tablet" | "desktop";
export const DEVICE_FORMS: readonly DeviceForm[] = ["phone", "tablet", "desktop"];
export type Appearance = "light" | "dark";
export const APPEARANCES: readonly Appearance[] = ["light", "dark"];
export type Orientation = "portrait" | "landscape";
/**
 * Why a look seen live has no picture (`atlas.BLANK_WHY`): its run found the app in secure mode
 * (Android's FLAG_SECURE: every screenshot of it is black), or its capture was one plain colour.
 * Its words were still read; the frame says why instead of showing the blank.
 */
export type BlankWhy = "flag_secure" | "uniform";
/** How alike the devices of two compared looks are (`atlas.MATCHES`), best first. */
export type PairMatch = "same" | "setting" | "appearance" | "device";
const MATCHES: readonly PairMatch[] = ["same", "setting", "appearance", "device"];

/** What a look was taken on: the frame it is drawn in (`kind`, the run's device, else the frame's
 * shape) and its size in pixels; the device's name, its kind, what the look shows (light or dark),
 * what the device was set to and its orientation, when the atlas knows them (#438). */
export interface AtlasDevice {
  kind: DeviceKind;
  landscape: boolean;
  w: number | null;
  h: number | null;
  name?: string | null;
  form?: DeviceForm | null;
  appearance?: Appearance | null;
  set_appearance?: Appearance | null;
  orientation?: Orientation | null;
}

/** One look of a screen on one device kind and appearance: the newest there (a cell of "Seen on"),
 * or one side of a compared pair. */
export interface AtlasSeen {
  platform: Platform;
  device: string | null;
  form: DeviceForm | null;
  appearance: Appearance | null;
  set_appearance: Appearance | null;
  orientation: Orientation | null;
  w: number | null;
  h: number | null;
  frame_url: string | null;
  at: string | null;
  build: string | null;
  run_id: string | null;
  state: string | null;
  /** Seen, but its capture was blank: no picture, and why. */
  blank?: BlankWhy | null;
}

/** Which device kinds and appearances the atlas has seen each platform on. */
export interface AtlasCoverage {
  form: DeviceForm;
  platforms: Partial<Record<Platform, Appearance[]>>;
}

export interface AtlasVariant {
  platform: Platform;
  node: string;
  seen: boolean;
  frame_url: string | null;
  last_seen_at: string | null;
  build: string | null;
  run_id: string | null;
  route: string | null;
  looks: number;
  device: AtlasDevice | null;
  /** Seen live only with a sign-in form in front of it (a withheld frame or a password asked):
   * not compared, and its frame says so instead of showing the sign-in. */
  signin_only?: boolean;
  /** Seen live, but its capture was blank (an app in secure mode, a screen not drawn yet): no
   * picture, and its frame says why. */
  blank?: BlankWhy | null;
  /** Set by the page's device and appearance filters when this platform has no look that fits
   * them: what its frame says instead ("Not seen on an iPad in dark yet"). */
  unfit?: string;
}

export interface AtlasPair {
  a: Platform;
  b: Platform;
  score: number | null;
  badge: Badge;
  reasons: string[];
  /** How alike the two looks' devices are; null from an older atlas. */
  match: PairMatch | null;
  /** Like with like (same kind of device and appearance, or a pair with the web): only then scored. */
  fair: boolean;
  /** Which looks it compares: "iPhone 17 Pro vs Pixel 9a, both light". */
  words: string | null;
  /** The two looks compared (their frames are what its wipe shows). */
  looks: { a: AtlasSeen; b: AtlasSeen } | null;
}

export interface AtlasSimilarity {
  badge: Badge;
  label: string;
  score: number | null;
  reasons: string[];
  pairs: AtlasPair[];
}

export interface AtlasState {
  state: string;
  label: string;
  platforms: Platform[];
  frame_url: string | null;
  at: string | null;
  /** The device of the newest look in this state, so the filmstrip draws it at its own shape. */
  device_name?: string | null;
  w?: number | null;
  h?: number | null;
  /** No look in this state has a picture: why (its capture was blank). */
  blank?: BlankWhy | null;
}

export interface AtlasLook {
  frame_url: string | null;
  at: string | null;
  first_at: string | null;
  build: string | null;
  run_id: string | null;
  state: string | null;
  blank?: BlankWhy | null;
}

export interface AtlasPlatformChange {
  platform: Platform;
  kind: "new" | "changed";
  what: string[];
  before: AtlasLook | null;
  after: AtlasLook | null;
}

export interface AtlasMove {
  id: string;
  label: string;
}

export interface AtlasScreen {
  id: string;
  name: string;
  area: string;
  route: string | null;
  nodes: string[];
  platforms: Platform[];
  variants: Partial<Record<Platform, AtlasVariant>>;
  /** Every project platform's presence; one the atlas did not say is `unknown`, never absent. */
  presence: Partial<Record<Platform, Presence>>;
  similarity: AtlasSimilarity | null;
  states: AtlasState[];
  last_seen_at: string | null;
  last_build: string | null;
  never_seen: boolean;
  code_only: boolean;
  code_texts: string[];
  flows: string[];
  from: AtlasMove[];
  to: AtlasMove[];
  change: { kind: "new" | "changed"; platforms: AtlasPlatformChange[] } | null;
  blocked_reason: string | null;
  /** Its newest look on each platform, device kind and appearance it was seen on ("Seen on"). */
  seen_on: AtlasSeen[];
}

export interface AtlasArea {
  key: string;
  name: string;
  summary: string | null;
  screens: string[];
  differs: number;
  seen: number;
}

export interface AtlasFlow {
  from: string;
  to: string;
  label: string;
  count: number;
  seen: boolean;
}

export interface AtlasSince {
  value: string | null;
  kind: "build" | "date";
  label: string;
  at: string | null;
  default: boolean;
}

export interface AtlasBuild {
  id: string;
  label: string;
  at: string | null;
}

export interface AtlasRefresh {
  minutes: number;
  /** The newest map session's state: idle (never ran), pending, running, done, skipped, failed. */
  state: string;
  note: string | null;
  depth: string | null;
  /** While the pass runs: the map nodes it aims at, and the platform it maps on. */
  targets: string[];
  /** While the pass runs: the map nodes it has seen so far. */
  shots?: string[];
  platform: Platform | null;
  /** "Fill in Android" (a deeper pass at a platform's unseen screens): its minutes and the most
   * screens one pass visits. Missing from an older backend. */
  fill_minutes?: number;
  fill_most?: number;
}

export interface AtlasCounts {
  screens: number;
  seen: number;
  never_seen: number;
  changed: number;
  differs: number;
  same: number;
  minor: number;
  different: number;
  missing: number;
  /** On two platforms but not seen live on two yet. */
  unchecked: number;
  /** Found on one platform only, the others not matched yet. */
  unmatched: number;
  /** On more than one platform. */
  matched: number;
  areas: number;
  looks: number;
}

export interface Atlas {
  project_id: string;
  slug: string | null;
  name: string | null;
  generated_at: string | null;
  platforms: Platform[];
  /** The frame each platform's column is drawn in (an iPad-first app's iOS is a tablet). */
  devices: Partial<Record<Platform, { kind: DeviceKind; landscape: boolean }>>;
  /** Which device kinds and appearances each platform was seen on, phones first. */
  coverage: AtlasCoverage[];
  counts: AtlasCounts;
  areas: AtlasArea[];
  screens: AtlasScreen[];
  flows: AtlasFlow[];
  since: AtlasSince;
  builds: AtlasBuild[];
  refresh: AtlasRefresh;
}

type J = Record<string, unknown>;

const obj = (v: unknown): J => (v && typeof v === "object" && !Array.isArray(v) ? (v as J) : {});
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strs = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === "string");
const isPlatform = (v: unknown): v is Platform => typeof v === "string" && (PLATFORMS as readonly string[]).includes(v);
const platforms = (v: unknown): Platform[] => arr(v).filter(isPlatform);
const badge = (v: unknown): Badge => (typeof v === "string" && (BADGES as readonly string[]).includes(v) ? (v as Badge) : "unchecked");
const blankWhy = (v: unknown): BlankWhy | null => (v === "flag_secure" || v === "uniform" ? v : null);

function look(v: unknown): AtlasLook | null {
  if (!v || typeof v !== "object") return null;
  const o = obj(v);
  return { frame_url: str(o.frame_url), at: str(o.at), first_at: str(o.first_at), build: str(o.build), run_id: str(o.run_id), state: str(o.state), blank: blankWhy(o.blank) };
}

const form = (v: unknown): DeviceForm | null => DEVICE_FORMS.find((k) => k === v) ?? null;
const shade = (v: unknown): Appearance | null => APPEARANCES.find((k) => k === v) ?? null;
const turn = (v: unknown): Orientation | null => (v === "portrait" || v === "landscape" ? v : null);

function device(v: unknown): AtlasDevice | null {
  if (!v || typeof v !== "object") return null;
  const o = obj(v);
  const kind = DEVICE_KINDS.find((k) => k === o.kind);
  if (!kind) return null;
  return {
    kind,
    landscape: o.landscape === true,
    w: numOrNull(o.w),
    h: numOrNull(o.h),
    name: str(o.name),
    form: form(o.form),
    appearance: shade(o.appearance),
    set_appearance: shade(o.set_appearance),
    orientation: turn(o.orientation),
  };
}

function seenLook(v: unknown, p?: Platform): AtlasSeen | null {
  const o = obj(v);
  const platform = p ?? (isPlatform(o.platform) ? o.platform : null);
  if (!platform) return null;
  return {
    platform,
    device: str(o.device),
    form: form(o.form),
    appearance: shade(o.appearance),
    set_appearance: shade(o.set_appearance),
    orientation: turn(o.orientation),
    w: numOrNull(o.w),
    h: numOrNull(o.h),
    frame_url: str(o.frame_url),
    at: str(o.at),
    build: str(o.build),
    run_id: str(o.run_id),
    state: str(o.state),
    // A look with a picture is never blank.
    blank: str(o.frame_url) ? null : blankWhy(o.blank),
  };
}

function variant(p: Platform, v: unknown): AtlasVariant {
  const o = obj(v);
  return {
    platform: p,
    node: str(o.node) ?? "",
    seen: o.seen === true,
    frame_url: str(o.frame_url),
    last_seen_at: str(o.last_seen_at),
    build: str(o.build),
    run_id: str(o.run_id),
    route: str(o.route),
    looks: num(o.looks),
    device: device(o.device),
    ...(o.signin_only === true ? { signin_only: true } : {}),
    ...(blankWhy(o.blank) && !str(o.frame_url) ? { blank: blankWhy(o.blank) } : {}),
  };
}

function similarity(v: unknown): AtlasSimilarity | null {
  if (!v || typeof v !== "object") return null;
  const o = obj(v);
  return {
    badge: badge(o.badge),
    label: str(o.label) ?? "",
    score: numOrNull(o.score),
    reasons: strs(o.reasons),
    pairs: arr(o.pairs)
      .map(obj)
      .filter((p) => isPlatform(p.a) && isPlatform(p.b))
      .map((p) => {
        const lk = p.looks && typeof p.looks === "object" ? obj(p.looks) : null;
        const la = lk ? seenLook(lk.a, p.a as Platform) : null;
        const lb = lk ? seenLook(lk.b, p.b as Platform) : null;
        return {
          a: p.a as Platform,
          b: p.b as Platform,
          score: numOrNull(p.score),
          badge: badge(p.badge),
          reasons: strs(p.reasons),
          match: MATCHES.find((m) => m === p.match) ?? null,
          // An older atlas had no word on it: every pair it scored was taken as fair.
          fair: p.fair === undefined ? true : p.fair === true,
          words: str(p.words),
          looks: la && lb ? { a: la, b: lb } : null,
        };
      }),
  };
}

function moves(v: unknown): AtlasMove[] {
  return arr(v)
    .map(obj)
    .filter((m) => typeof m.id === "string")
    .map((m) => ({ id: m.id as string, label: str(m.label) ?? "" }));
}

function screen(v: unknown): AtlasScreen | null {
  const o = obj(v);
  const id = str(o.id);
  if (!id) return null;
  const vs = obj(o.variants);
  const variants: Partial<Record<Platform, AtlasVariant>> = {};
  for (const p of PLATFORMS) if (vs[p]) variants[p] = variant(p, vs[p]);
  const ch = o.change && typeof o.change === "object" ? obj(o.change) : null;
  const pres = obj(o.presence);
  const presence: Partial<Record<Platform, Presence>> = {};
  for (const p of PLATFORMS) {
    const v = pres[p];
    if (typeof v === "string" && (PRESENCES as readonly string[]).includes(v)) presence[p] = v as Presence;
    else if (variants[p]) presence[p] = variants[p].seen ? "seen" : "unseen";
  }
  return {
    id,
    name: str(o.name) ?? id,
    area: str(o.area) ?? "other",
    route: str(o.route),
    nodes: strs(o.nodes),
    platforms: platforms(o.platforms).filter((p) => variants[p]),
    variants,
    presence,
    similarity: similarity(o.similarity),
    states: arr(o.states)
      .map(obj)
      .filter((s) => typeof s.state === "string")
      .map((s) => ({
        state: s.state as string,
        label: str(s.label) ?? (s.state as string),
        platforms: platforms(s.platforms),
        frame_url: str(s.frame_url),
        at: str(s.at),
        device_name: str(s.device_name),
        w: typeof s.w === "number" && s.w > 0 ? s.w : null,
        h: typeof s.h === "number" && s.h > 0 ? s.h : null,
        blank: str(s.frame_url) ? null : blankWhy(s.blank),
      })),
    last_seen_at: str(o.last_seen_at),
    last_build: str(o.last_build),
    never_seen: o.never_seen === true,
    code_only: o.code_only === true,
    code_texts: strs(o.code_texts),
    flows: strs(o.flows),
    from: moves(o.from),
    to: moves(o.to),
    change: ch
      ? {
          kind: ch.kind === "new" ? "new" : "changed",
          platforms: arr(ch.platforms)
            .map(obj)
            .filter((c) => isPlatform(c.platform))
            .map((c) => ({ platform: c.platform as Platform, kind: c.kind === "new" ? "new" : "changed", what: strs(c.what), before: look(c.before), after: look(c.after) })),
        }
      : null,
    blocked_reason: str(o.blocked_reason),
    seen_on: arr(o.seen_on)
      .map((x) => seenLook(x))
      .filter((x): x is AtlasSeen => x !== null),
  };
}

export const EMPTY_COUNTS: AtlasCounts = {
  screens: 0,
  seen: 0,
  never_seen: 0,
  changed: 0,
  differs: 0,
  same: 0,
  minor: 0,
  different: 0,
  missing: 0,
  unchecked: 0,
  unmatched: 0,
  matched: 0,
  areas: 0,
  looks: 0,
};

/** A platform's presence on a screen: what the atlas said, else `unknown` (never a guess at absent). */
export function presenceOf(s: AtlasScreen, p: Platform): Presence {
  return s.presence[p] ?? (s.variants[p] ? (s.variants[p].seen ? "seen" : "unseen") : "unknown");
}

/** The atlas JSON narrowed to `Atlas`. Throws when it is not an object with a project id. */
export function parseAtlas(json: unknown): Atlas {
  const o = obj(json);
  const pid = str(o.project_id);
  if (!pid) throw new Error("The atlas answer has no project.");
  const screens = arr(o.screens)
    .map(screen)
    .filter((s): s is AtlasScreen => s !== null);
  const ids = new Set(screens.map((s) => s.id));
  const c = obj(o.counts);
  const since = obj(o.since);
  const refresh = obj(o.refresh);
  const devs = obj(o.devices);
  const devices: Atlas["devices"] = {};
  for (const p of PLATFORMS) {
    const d = device({ ...obj(devs[p]), w: null, h: null });
    if (d) devices[p] = { kind: d.kind, landscape: d.landscape };
  }
  return {
    project_id: pid,
    slug: str(o.slug),
    name: str(o.name),
    generated_at: str(o.generated_at),
    platforms: platforms(o.platforms),
    devices,
    coverage: arr(o.coverage)
      .map(obj)
      .filter((c) => form(c.form))
      .map((c) => {
        const ps = obj(c.platforms);
        const out: AtlasCoverage["platforms"] = {};
        for (const p of PLATFORMS) if (Array.isArray(ps[p])) out[p] = APPEARANCES.filter((a) => (ps[p] as unknown[]).includes(a));
        return { form: form(c.form) as DeviceForm, platforms: out };
      }),
    counts: Object.fromEntries(Object.keys(EMPTY_COUNTS).map((k) => [k, num(c[k])])) as unknown as AtlasCounts,
    areas: arr(o.areas)
      .map(obj)
      .filter((a) => typeof a.key === "string")
      .map((a) => ({
        key: a.key as string,
        name: str(a.name) ?? (a.key as string),
        summary: str(a.summary),
        screens: strs(a.screens).filter((i) => ids.has(i)),
        differs: num(a.differs),
        seen: num(a.seen),
      })),
    screens,
    flows: arr(o.flows)
      .map(obj)
      .filter((f) => typeof f.from === "string" && typeof f.to === "string" && ids.has(f.from as string) && ids.has(f.to as string))
      .map((f) => ({ from: f.from as string, to: f.to as string, label: str(f.label) ?? "", count: num(f.count), seen: f.seen === true })),
    since: { value: str(since.value), kind: since.kind === "build" ? "build" : "date", label: str(since.label) ?? "the last 7 days", at: str(since.at), default: since.default !== false },
    builds: arr(o.builds)
      .map(obj)
      .filter((b) => typeof b.id === "string")
      .map((b) => ({ id: b.id as string, label: str(b.label) ?? (b.id as string), at: str(b.at) })),
    refresh: {
      minutes: num(refresh.minutes, 3),
      state: str(refresh.state) ?? "idle",
      note: str(refresh.note),
      depth: str(refresh.depth),
      targets: strs(refresh.targets),
      shots: strs(refresh.shots),
      platform: isPlatform(refresh.platform) ? refresh.platform : null,
      fill_minutes: num(refresh.fill_minutes, 10),
      fill_most: num(refresh.fill_most, 25),
    },
  };
}

/** An atlas with nothing on it yet: no screen known from the code, tests or runs. */
export function isEmptyAtlas(a: Atlas | null): boolean {
  return !a || a.screens.length === 0;
}

/** The onboarding live pass is going (queued or exploring): the atlas fills in as it runs. */
export function isFilling(a: Atlas | null): boolean {
  return Boolean(a && (a.refresh.state === "running" || a.refresh.state === "pending"));
}
