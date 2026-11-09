/**
 * The Atlas page's model, pure (tested alone): the filters and how they sit in the URL, which
 * screens they keep (the same rules as the export, `app_map/atlas_export.py` `keeps`), the
 * storyboard's geometry (cards in a row, the flow arrows between them), and the frame shapes.
 */
import type { Appearance, Atlas, AtlasArea, AtlasDevice, AtlasFlow, AtlasRefresh, AtlasScreen, AtlasSeen, Badge, BlankWhy, DeviceForm, Platform, Presence } from "./types";
import { APPEARANCES, DEVICE_FORMS, PLATFORMS, presenceOf } from "./types";

export const PLATFORM_WORD: Record<Platform, string> = { ios: "iOS", android: "Android", web: "Web" };

export const BADGE_WORD: Record<Badge, string> = {
  same: "Same",
  minor: "Minor differences",
  different: "Different",
  missing: "Not on every platform",
  unchecked: "Not compared yet",
  unmatched: "Not matched yet",
};

/** A badge's word on a card too narrow for the whole one (a single platform's column). */
export const BADGE_SHORT: Record<Badge, string> = {
  same: "Same",
  minor: "Minor",
  different: "Different",
  missing: "Not on all",
  unchecked: "Not compared",
  unmatched: "Not matched",
};
/** Below this card width the badge says its short word. */
export const NARROW_CARD = 220;

/** What a badge means, said when a person hovers or focuses it. */
export const BADGE_MEANS: Record<Badge, string> = {
  same: "The platforms seen live say the same things in the same order and look alike.",
  minor: "Seen live on more than one platform, with small differences: a word, an order, a colour.",
  different: "Seen live on more than one platform, and they say or show mostly different things.",
  missing: "A platform whose code Embodent has mapped has nothing like this screen: no screen, and neither its name nor its words.",
  unchecked: "On more than one platform, but not seen live on two yet, so there is nothing to compare.",
  unmatched: "Found on one platform so far. Embodent has not matched it on the others yet, which is not a difference.",
};

/**
 * What a platform's slot says when it has no screenshot. "Not in the Android code" only when that
 * code has nothing like the screen; when Orcha found no match but cannot say it is not there (the
 * code is not mapped, or mentions it inside another screen), it says only that (#467).
 */
export function presenceWords(p: Presence, platform: Platform): string {
  if (p === "absent") return `Not in the ${PLATFORM_WORD[platform]} code`;
  if (p === "unknown") return `No ${PLATFORM_WORD[platform]} match found`;
  if (p === "unseen") return `Not seen on ${PLATFORM_WORD[platform]} yet`;
  return "Seen";
}

/**
 * What a frame says where a blank capture's picture would be (`BlankWhy`): a title, a line under it
 * on a big frame, and a short word for a small cell. Only what Orcha checked: secure mode when the
 * run found it (FLAG_SECURE on the app's window), else only that the screen was one plain colour.
 */
export function blankWords(why: BlankWhy, platform: Platform): { title: string; line: string; short: string } {
  if (why === "flag_secure") {
    return {
      title: `The ${PLATFORM_WORD[platform]} app hides this screen from screenshots`,
      line: "The app turns on secure mode (FLAG_SECURE), so every screenshot of it is black. Embodent still read its words.",
      short: "Hidden from screenshots",
    };
  }
  return {
    title: "The screenshot came back blank",
    line: "The screen was one plain colour when Embodent captured it, so there is no picture of it. Embodent still read its words.",
    short: "Blank screenshot",
  };
}

/** Where a pair's wipe would be when one side has no picture: why, and what is compared instead. */
export function wipeWords(why: BlankWhy, platform: Platform): string {
  const head = why === "flag_secure" ? `The ${PLATFORM_WORD[platform]} app hides this screen from screenshots` : `${PLATFORM_WORD[platform]}'s screenshot came back blank`;
  return `${head}, so there is nothing to wipe across. Embodent compares their words.`;
}

/** What "Fill in Android" would visit (the same rule as `atlas.fill_plan`): the screens in that
 * platform's code no run has seen there, minus those found behind a sign-in Orcha has no
 * account for (counted, so the page says they are skipped), at most `most`. */
export interface FillPlan {
  platform: Platform;
  /** Screens on the platform not seen there yet, the blocked ones included. */
  unseen: number;
  /** Of those, behind a sign-in with no account: skipped. */
  blocked: number;
  /** How many one pass visits. */
  visits: number;
}

export function fillPlan(a: Pick<Atlas, "screens" | "refresh">, platform: Platform): FillPlan {
  let unseen = 0;
  let blocked = 0;
  for (const s of a.screens) {
    if (s.presence[platform] !== "unseen") continue;
    unseen += 1;
    if (s.blocked_reason) blocked += 1;
  }
  return { platform, unseen, blocked, visits: Math.min(unseen - blocked, a.refresh.fill_most ?? 25) };
}

/** Whether `s` is one a fill-in on `platform` would visit. */
export function fillable(s: Pick<AtlasScreen, "presence" | "blocked_reason">, platform: Platform): boolean {
  return s.presence[platform] === "unseen" && !s.blocked_reason;
}

/** "Fill in Android · 19 screens not seen", and what it does in a sentence (its title and toast). */
export function fillWords(plan: FillPlan, r: Pick<AtlasRefresh, "fill_minutes">): { label: string; detail: string } {
  const word = PLATFORM_WORD[plan.platform];
  const n = plan.unseen - plan.blocked;
  const label = `Fill in ${word} · ${n} ${n === 1 ? "screen" : "screens"} not seen`;
  const parts = [
    `Embodent opens the app on ${word} and visits ${plan.visits === n ? (n === 1 ? "that screen" : `those ${n} screens`) : `${plan.visits} of them`}, about ${r.fill_minutes ?? 10} minutes.`,
    plan.blocked ? `${plan.blocked} behind a sign-in Embodent has no account for ${plan.blocked === 1 ? "is" : "are"} skipped: add sign-in hints to the app's target to reach ${plan.blocked === 1 ? "it" : "them"}.` : null,
  ];
  return { label, detail: parts.filter(Boolean).join(" ") };
}

/** What Refresh atlas does on `platform`, in a sentence (its device dialog). */
export function refreshWords(r: Pick<AtlasRefresh, "minutes">, platform: Platform): string {
  return `Embodent opens the app on ${PLATFORM_WORD[platform]} and takes one look at the entry screen and each main area, about ${r.minutes} minutes. Nothing deeper.`;
}

/** A badge that says the platforms differ (the "Differs across platforms" filter). */
export const DIFFERS: readonly Badge[] = ["minor", "different", "missing"];

export interface AtlasFilters {
  area: string | null;
  platforms: Platform[];
  differs: boolean;
  changed: boolean;
  neverSeen: boolean;
  q: string;
  /** Flow arrows shown (on by default). */
  arrows: boolean;
  /** Only looks taken on these kinds of device (none: any). */
  devices: DeviceForm[];
  /** Only looks in these appearances (none: either). */
  appearances: Appearance[];
}

export const NO_FILTERS: AtlasFilters = { area: null, platforms: [], differs: false, changed: false, neverSeen: false, q: "", arrows: true, devices: [], appearances: [] };

const FILTER_WORDS = { differs: "differs", changed: "changed", neverSeen: "never_seen" } as const;

/** The filters a URL holds: `?area=checkout&platforms=ios,android&filter=differs,changed&q=pay&device=tablet&appearance=dark&arrows=0`. */
export function filtersFrom(sp: URLSearchParams | Record<string, string | string[] | undefined>): AtlasFilters {
  const get = (k: string): string | null => {
    if (sp instanceof URLSearchParams) return sp.get(k);
    const v = sp[k];
    return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
  };
  const list = (k: string) => (get(k) ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const filter = new Set(list("filter"));
  return {
    area: get("area") || null,
    platforms: PLATFORMS.filter((p) => list("platforms").includes(p)),
    differs: filter.has(FILTER_WORDS.differs),
    changed: filter.has(FILTER_WORDS.changed),
    neverSeen: filter.has(FILTER_WORDS.neverSeen),
    q: (get("q") ?? "").slice(0, 80),
    arrows: get("arrows") !== "0",
    devices: DEVICE_FORMS.filter((d) => list("device").includes(d)),
    appearances: APPEARANCES.filter((a) => list("appearance").includes(a)),
  };
}

/** The filters as query parameters (only what differs from no filter), kept beside `base`'s others. */
export function filtersQuery(f: AtlasFilters, base?: URLSearchParams): URLSearchParams {
  const q = new URLSearchParams(base);
  for (const k of ["area", "platforms", "filter", "q", "arrows", "device", "appearance"]) q.delete(k);
  if (f.area) q.set("area", f.area);
  if (f.platforms.length) q.set("platforms", f.platforms.join(","));
  if (f.devices?.length) q.set("device", f.devices.join(","));
  if (f.appearances?.length) q.set("appearance", f.appearances.join(","));
  const words = (Object.keys(FILTER_WORDS) as (keyof typeof FILTER_WORDS)[]).filter((k) => f[k]).map((k) => FILTER_WORDS[k]);
  if (words.length) q.set("filter", words.join(","));
  if (f.q.trim()) q.set("q", f.q.trim());
  if (!f.arrows) q.set("arrows", "0");
  return q;
}

export function hasFilters(f: AtlasFilters): boolean {
  return Boolean(f.area || f.platforms.length || f.differs || f.changed || f.neverSeen || f.q.trim() || f.devices?.length || f.appearances?.length);
}

/**
 * The screen differs across `platforms` (every platform when none is picked): not in the code of
 * one of them while on another, or a pair of them seen live that reads differently. Not matched
 * yet is no difference. With iOS and Android picked, a screen missing only on the web does not
 * count (`atlas_export.differs`, the same rule).
 */
export function differsAcross(s: AtlasScreen, platforms: readonly Platform[]): boolean {
  if (!platforms.length) return DIFFERS.includes(s.similarity?.badge ?? "unchecked");
  const have = platforms.filter((p) => s.platforms.includes(p));
  if (have.length && platforms.some((p) => !have.includes(p) && presenceOf(s, p) === "absent")) return true;
  return (s.similarity?.pairs ?? []).some((x) => platforms.includes(x.a) && platforms.includes(x.b) && (x.badge === "minor" || x.badge === "different"));
}

/** Whether the filters keep a screen (`atlas_export.keeps`, the same rules). With a device or an
 * appearance picked, only a screen seen that way on one of the platforms picked (any, else). */
export function keeps(s: AtlasScreen, f: AtlasFilters): boolean {
  if (f.area && s.area !== f.area) return false;
  if (f.platforms.length && !f.platforms.some((p) => s.platforms.includes(p))) return false;
  if (byDevice(f) && !(f.platforms.length ? f.platforms : PLATFORMS).some((p) => fitting(s, p, f))) return false;
  if (f.differs && !differsAcross(s, f.platforms)) return false;
  if (f.changed && !s.change) return false;
  if (f.neverSeen && !s.never_seen) return false;
  const q = f.q.trim().toLowerCase();
  if (q && !s.name.toLowerCase().includes(q) && !(s.route ?? "").toLowerCase().includes(q)) return false;
  return true;
}

export interface AreaRow {
  area: AtlasArea;
  screens: AtlasScreen[];
}

/** The storyboard's rows the filters keep, in order; an area left empty goes. */
export function filterAtlas(atlas: Atlas, f: AtlasFilters): AreaRow[] {
  const byId = new Map(atlas.screens.map((s) => [s.id, s]));
  const out: AreaRow[] = [];
  for (const area of atlas.areas) {
    const screens = area.screens.map((i) => byId.get(i)).filter((s): s is AtlasScreen => Boolean(s && keeps(s, f)));
    if (screens.length) out.push({ area, screens });
  }
  return out;
}

/** The platform columns each card shows: the ones picked, else every platform the project has. */
export function shownPlatforms(atlas: Atlas, f: AtlasFilters): Platform[] {
  const have = atlas.platforms.length ? atlas.platforms : PLATFORMS.filter((p) => atlas.screens.some((s) => s.variants[p]));
  return f.platforms.length ? PLATFORMS.filter((p) => f.platforms.includes(p) && have.includes(p)) : [...have];
}

// ---------- devices and appearance (#438) ----------

/** The device and appearance filters narrow which looks show. */
export function byDevice(f: Pick<AtlasFilters, "devices" | "appearances">): boolean {
  return Boolean(f.devices?.length || f.appearances?.length);
}

function fits(l: Pick<AtlasSeen, "form" | "appearance">, f: Pick<AtlasFilters, "devices" | "appearances">): boolean {
  return (!f.devices?.length || (l.form !== null && f.devices.includes(l.form))) && (!f.appearances?.length || (l.appearance !== null && f.appearances.includes(l.appearance)));
}

/**
 * The look of a screen on `platform` that the device and appearance filters keep: the one the
 * atlas shows when it fits (its like-with-like pick), else the newest that does. Null when none.
 */
export function fitting(s: Pick<AtlasScreen, "seen_on" | "variants">, platform: Platform, f: Pick<AtlasFilters, "devices" | "appearances">): AtlasSeen | null {
  // A blank look was seen that way too: it fits, and says why it has no picture.
  const mine = s.seen_on.filter((l) => l.platform === platform && (l.frame_url || l.blank) && fits(l, f));
  if (!mine.length) return null;
  const shown = s.variants[platform]?.frame_url;
  return mine.find((l) => l.frame_url === shown) ?? mine.reduce((a, b) => ((b.at ?? "") > (a.at ?? "") ? b : a));
}

export const FORM_WORD: Record<DeviceForm, string> = { phone: "Phone", tablet: "Tablet", desktop: "Desktop" };
export const APPEARANCE_WORD: Record<Appearance, string> = { light: "Light", dark: "Dark" };

/** A device in a sentence: "an iPad", "an Android tablet", "a phone-sized browser". */
export function deviceWords(platform: Platform, form: DeviceForm | null): string {
  if (platform === "ios") return form === "tablet" ? "an iPad" : form === "desktop" ? "a Mac" : "an iPhone";
  if (platform === "web") return form === "phone" ? "a phone-sized browser" : form === "tablet" ? "a tablet-sized browser" : "a desktop browser";
  const kind = form ?? "phone";
  return `an ${PLATFORM_WORD[platform]} ${kind}`;
}

/** What took a look, for its chip: "iPhone 17 Pro · Dark · Portrait" (a desktop has no orientation). */
export function chipWords(d: Pick<AtlasSeen, "device" | "form" | "appearance" | "orientation"> | null | undefined, platform?: Platform): string | null {
  if (!d) return null;
  const name = d.device ?? (platform && d.form ? deviceWords(platform, d.form).replace(/^an? /, "").replace(/^\w/, (c) => c.toUpperCase()) : null);
  const parts = [name, d.appearance ? APPEARANCE_WORD[d.appearance] : null, d.form !== "desktop" && d.orientation ? (d.orientation === "landscape" ? "Landscape" : "Portrait") : null];
  const out = parts.filter(Boolean).join(" · ");
  return out || null;
}

/** A device's name short enough for a chip on a small frame: "iPad Pro 13-inch (M5)" is "iPad Pro". */
export function shortDevice(name: string): string {
  return name.replace(/\s*\([^)]*\)/g, "").replace(/\s+\d+(\.\d+)?[-\s]?inch\b/gi, "").trim() || name;
}

/** A variant's device as a look (its chip reads the same as a "Seen on" cell's). */
export function deviceSeen(d: AtlasDevice | null | undefined): Pick<AtlasSeen, "device" | "form" | "appearance" | "orientation"> | null {
  if (!d) return null;
  return { device: d.name ?? null, form: d.form ?? null, appearance: d.appearance ?? null, orientation: d.orientation ?? null };
}

/** What a filtered-out frame says: "Not seen on an iPad in dark yet". */
export function unfitWords(platform: Platform, f: Pick<AtlasFilters, "devices" | "appearances">): string {
  const on = f.devices?.length === 1 ? ` on ${deviceWords(platform, f.devices[0])}` : f.devices?.length ? ` on a ${f.devices.map((d) => FORM_WORD[d].toLowerCase()).join(" or ")}` : ` on ${PLATFORM_WORD[platform]}`;
  const shade = f.appearances?.length === 1 ? ` in ${f.appearances[0]}` : "";
  return `Not seen${on}${shade} yet`;
}

/**
 * The atlas as the device and appearance filters show it: each platform's frame is its look that
 * fits them (`fitting`), or says it was not seen that way; the columns take the kind of device
 * picked. The same atlas when neither filter is on, so nothing else changes.
 */
export function viewAtlas(atlas: Atlas, f: Pick<AtlasFilters, "devices" | "appearances">): Atlas {
  if (!byDevice(f)) return atlas;
  const screens = atlas.screens.map((s) => {
    const variants: AtlasScreen["variants"] = {};
    for (const p of PLATFORMS) {
      const v = s.variants[p];
      if (!v) continue;
      const l = fitting(s, p, f);
      if (!l) {
        variants[p] = v.seen ? { ...v, frame_url: null, unfit: unfitWords(p, f) } : v;
        continue;
      }
      if (l.frame_url === v.frame_url && (l.blank ?? null) === (v.blank ?? null)) {
        variants[p] = v;
        continue;
      }
      const kind = p === "web" ? "browser" : (l.form ?? "phone");
      variants[p] = {
        ...v,
        frame_url: l.frame_url,
        last_seen_at: l.at,
        build: l.build,
        run_id: l.run_id,
        blank: l.frame_url ? null : (l.blank ?? null),
        device: { kind, landscape: l.orientation === "landscape", w: l.w, h: l.h, name: l.device, form: l.form, appearance: l.appearance, set_appearance: l.set_appearance, orientation: l.orientation },
      };
    }
    return { ...s, variants };
  });
  const devices = { ...atlas.devices };
  if (f.devices?.length === 1) {
    const d = f.devices[0];
    for (const p of PLATFORMS) {
      if (!devices[p] && !atlas.platforms.includes(p)) continue;
      devices[p] = { kind: p === "web" && d === "desktop" ? "browser" : d, landscape: false };
    }
  }
  return { ...atlas, screens, devices };
}

const FORM_PLURAL: Record<DeviceForm, string> = { phone: "Phones", tablet: "Tablets", desktop: "Desktop" };

/** "light and dark", "light". */
function shades(list: readonly Appearance[]): string {
  return APPEARANCES.filter((a) => list.includes(a)).join(" and ");
}

/** "iOS and Android", with a lone iOS tablet called an iPad. */
function platformList(form: DeviceForm, ps: Platform[]): string {
  const words = ps.map((p) => (form === "tablet" && p === "ios" ? "iPad" : PLATFORM_WORD[p]));
  return words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/**
 * Which device kinds and appearances the atlas covers, in a line: "Phones: iOS and Android, light
 * and dark. Tablets: iPad only, light." Platforms seen in other appearances are said apart ("iOS in
 * light and dark, Android in light"). Empty when the atlas knows no device yet.
 */
export function coverageWords(atlas: Pick<Atlas, "coverage" | "platforms">): string {
  const parts: string[] = [];
  for (const c of atlas.coverage) {
    const ps = PLATFORMS.filter((p) => c.platforms[p]);
    if (!ps.length) continue;
    const each = ps.map((p) => shades(c.platforms[p] ?? []));
    const only = ps.length === 1 && atlas.platforms.length > 1 ? " only" : "";
    let body: string;
    if (each.every((x) => x === each[0])) body = `${platformList(c.form, ps)}${only}${each[0] ? `, ${each[0]}` : ""}`;
    else body = ps.map((p, i) => `${platformList(c.form, [p])}${each[i] ? ` in ${each[i]}` : ""}`).join(", ");
    parts.push(`${FORM_PLURAL[c.form]}: ${body}.`);
  }
  return parts.join(" ");
}

/** One row of "Seen on": a kind of device in one appearance. */
export interface SeenRow {
  form: DeviceForm;
  /** Null when no look says light or dark: the row is the whole kind of device. */
  appearance: Appearance | null;
  label: string;
}

/**
 * The rows of a screen's "Seen on": phone and tablet (when the atlas has a phone platform), and
 * desktop (when it has the web or a desktop look), each in light and dark; any kind the screen
 * itself was seen on is always there. With no look that says light or dark, one row per kind.
 */
export function seenRows(atlas: Pick<Atlas, "platforms" | "coverage">, s: Pick<AtlasScreen, "seen_on">): SeenRow[] {
  const forms = new Set<DeviceForm>();
  if (atlas.platforms.some((p) => p !== "web")) {
    forms.add("phone");
    forms.add("tablet");
  }
  if (atlas.platforms.includes("web") || atlas.coverage.some((c) => c.form === "desktop")) forms.add("desktop");
  for (const c of atlas.coverage) if (c.form !== "desktop" && Object.keys(c.platforms).length) forms.add(c.form);
  for (const l of s.seen_on) if (l.form) forms.add(l.form);
  const shaded = s.seen_on.some((l) => l.appearance);
  return DEVICE_FORMS.filter((f) => forms.has(f)).flatMap<SeenRow>((form) =>
    shaded ? APPEARANCES.map((appearance) => ({ form, appearance, label: `${FORM_WORD[form]} · ${APPEARANCE_WORD[appearance]}` })) : [{ form, appearance: null, label: FORM_WORD[form] }],
  );
}

/** A "Seen on" cell: the newest look of that platform, kind and appearance; one whose capture was
 * blank (`blank`) is there too, with no picture. `pictured` keeps to looks with a picture. */
export function seenCell(s: Pick<AtlasScreen, "seen_on">, platform: Platform, row: Pick<SeenRow, "form" | "appearance">, pictured = false): AtlasSeen | null {
  return s.seen_on.find((l) => l.platform === platform && l.form === row.form && (row.appearance === null || l.appearance === row.appearance) && (l.frame_url || (!pictured && l.blank))) ?? null;
}

/** What an empty "Seen on" cell says: "Not seen on an Android tablet yet", or, when that device was
 * seen in the other appearance, "Seen on an iPhone in light only" ("in a desktop browser"). */
export function missingWords(s: Pick<AtlasScreen, "seen_on">, platform: Platform, row: Pick<SeenRow, "form" | "appearance">): string {
  const other = row.appearance !== null && s.seen_on.some((l) => l.platform === platform && l.form === row.form && l.appearance && l.appearance !== row.appearance && (l.frame_url || l.blank));
  const on = `${platform === "web" ? "in" : "on"} ${deviceWords(platform, row.form)}`;
  return other ? `Seen ${on} in ${row.appearance === "dark" ? "light" : "dark"} only` : `Not seen ${on} yet`;
}

/** The kinds of device a platform is usually seen on (a phone app on phones and tablets, the web in a
 * desktop browser or a phone-sized one), plus any the atlas has seen it on. A "Seen on" cell outside
 * them stays blank instead of saying "Not seen on an Android desktop yet". */
export function usualForms(atlas: Pick<Atlas, "coverage">, platform: Platform): DeviceForm[] {
  const usual: DeviceForm[] = platform === "web" ? ["desktop", "phone"] : ["phone", "tablet"];
  const seen = atlas.coverage.filter((c) => c.platforms[platform]).map((c) => c.form);
  return DEVICE_FORMS.filter((f) => usual.includes(f) || seen.includes(f));
}

/** A light and a dark look of a screen on one platform and kind of device, the same device first. */
export interface ShadePair {
  platform: Platform;
  form: DeviceForm;
  light: AtlasSeen;
  dark: AtlasSeen;
  /** "iPhone 17 Pro", or both names when two devices took them. */
  device: string;
}

/** The light vs dark wipes a screen has: per platform, its usual kind of device first. */
export function shadePairs(s: Pick<AtlasScreen, "seen_on">, platforms: readonly Platform[], shapes?: Shapes): ShadePair[] {
  const out: ShadePair[] = [];
  for (const p of platforms) {
    const usual = shapes?.[p] === "tablet" || shapes?.[p] === "tabletWide" ? "tablet" : p === "web" ? "desktop" : "phone";
    const forms = [usual, ...DEVICE_FORMS.filter((f) => f !== usual)] as DeviceForm[];
    for (const form of forms) {
      // Only two pictures wipe from light to dark.
      const light = seenCell(s, p, { form, appearance: "light" }, true);
      const dark = seenCell(s, p, { form, appearance: "dark" }, true);
      if (!light || !dark) continue;
      const names = [...new Set([light.device, dark.device].filter(Boolean))] as string[];
      out.push({ platform: p, form, light, dark, device: names.join(" and ") || deviceWords(p, form).replace(/^an? /, "") });
      break;
    }
  }
  return out;
}

// ---------- the live fill-in ----------

/**
 * While the high-level pass runs, the frames it is about to capture: each screen it aims at (one
 * of the screen's map nodes is a target) whose frame on the pass's platform has no screenshot
 * yet. `{screen id: platform}`. Empty when no pass runs or it said nothing of its aim.
 */
export function capturing(atlas: Atlas): Map<string, Platform> {
  const out = new Map<string, Platform>();
  const r = atlas.refresh;
  if (!(r.state === "running" || r.state === "pending") || !r.targets.length) return out;
  const aimed = new Set(r.targets);
  for (const s of atlas.screens) {
    if (!s.nodes.some((n) => aimed.has(n)) && !aimed.has(s.id)) continue;
    const p = r.platform ?? s.platforms[0];
    // A blank capture was taken already: it is not about to be.
    if (p && !s.variants[p]?.frame_url && !s.variants[p]?.blank) out.set(s.id, p);
  }
  return out;
}

/** How far the pass is: its targets with a screenshot now, of all of them. */
export function passProgress(atlas: Atlas): { seen: number; total: number } {
  const r = atlas.refresh;
  if (!r.targets.length) return { seen: 0, total: 0 };
  const aimed = new Set(r.targets);
  const hits = atlas.screens.filter((s) => s.nodes.some((n) => aimed.has(n)) || aimed.has(s.id));
  const seen = hits.filter((s) => {
    const p = r.platform ?? s.platforms[0];
    return Boolean(p && (s.variants[p]?.frame_url || s.variants[p]?.blank));
  }).length;
  return { seen, total: hits.length };
}

// ---------- the storyboard's geometry ----------

/**
 * The frames a platform's column can be drawn in: a phone, an iPad held upright or on its side, a
 * desktop app's window, or a browser window. The atlas picks one per platform (`Atlas.devices`, the
 * kind most of its looks were taken on), so every card in a row is the same size before any
 * screenshot loads.
 */
export type FrameKind = "phone" | "tablet" | "tabletWide" | "desktop" | "browser";
export const FRAME: Record<FrameKind, { w: number; h: number }> = {
  phone: { w: 104, h: 216 },
  tablet: { w: 162, h: 216 },
  tabletWide: { w: 248, h: 186 },
  desktop: { w: 240, h: 160 },
  browser: { w: 216, h: 140 },
};
/** Each platform's frame kind; a platform it does not name is a phone, or a browser for the web. */
export type Shapes = Partial<Record<Platform, FrameKind>>;
export const CARD_PAD = 12;
export const FRAME_GAP = 8;
/** The gutter between two cards, where a flow arrow to the next card runs. */
export const GUTTER = 44;
/** Above the frames (the name on up to two lines, the route) and below them (the badge line). */
export const CARD_HEAD = 50;
export const CARD_FOOT = 34;
/** Room under the cards for the arcs of flows that skip a card: the first lane's drop below the
 * cards, each further lane, and a card's ports (where its arcs leave and arrive) apart. */
export const LANE_DROP = 18;
export const LANE = 12;
export const PORT_GAP = 7;
/** The rounding of an arc's corners. */
const ARC_R = 7;

export function frameKind(p: Platform, shapes?: Shapes): FrameKind {
  return shapes?.[p] ?? (p === "web" ? "browser" : "phone");
}

/**
 * The frame a look is drawn in: the kind of device that took it (an iPad's shot in an iPad, held
 * on its side when it was), a browser window for the web; null when the atlas does not say. A
 * column keeps its own kind for its size (`frameKind`); a look of another kind sits in it whole,
 * shrunk to fit (`slotFit`), never in the wrong device.
 */
export function lookKind(p: Platform, d: Pick<AtlasDevice, "kind" | "landscape"> | null | undefined): FrameKind | null {
  if (!d) return null;
  if (p === "web" || d.kind === "browser") return "browser";
  if (d.kind === "tablet") return d.landscape ? "tabletWide" : "tablet";
  return d.kind === "desktop" ? "desktop" : "phone";
}

/** How much a frame of kind `own` shrinks to sit in a column whose frames are `slot` (never grows). */
export function slotFit(slot: FrameKind, own: FrameKind): number {
  if (slot === own) return 1;
  return Math.min(1, FRAME[slot].w / FRAME[own].w, FRAME[slot].h / FRAME[own].h);
}

/** The atlas's frame kind per platform, from the devices its looks were taken on. */
export function shapesOf(atlas: Pick<Atlas, "devices">): Shapes {
  const out: Shapes = {};
  for (const p of PLATFORMS) {
    const d = atlas.devices[p];
    if (!d) continue;
    out[p] = d.kind === "tablet" ? (d.landscape ? "tabletWide" : "tablet") : d.kind === "desktop" ? "desktop" : d.kind === "browser" ? "browser" : "phone";
  }
  return out;
}

export function cardWidth(plats: readonly Platform[], shapes?: Shapes): number {
  if (!plats.length) return FRAME.phone.w + 2 * CARD_PAD;
  const frames = plats.reduce((w, p) => w + FRAME[frameKind(p, shapes)].w, 0);
  return frames + FRAME_GAP * (plats.length - 1) + 2 * CARD_PAD;
}

/** The tallest frame of the card's platforms. */
export function framesHeight(plats: readonly Platform[], shapes?: Shapes): number {
  return plats.length ? Math.max(...plats.map((p) => FRAME[frameKind(p, shapes)].h)) : FRAME.phone.h;
}

export function cardHeight(plats: readonly Platform[], shapes?: Shapes): number {
  return CARD_HEAD + framesHeight(plats, shapes) + CARD_FOOT + 2 * CARD_PAD;
}

export interface CardBox {
  id: string;
  x: number;
  /** The top of its line: 0 on the first, lower on each line the row wraps onto. */
  y: number;
  w: number;
}

export interface Arrow {
  from: string;
  to: string;
  label: string;
  /** SVG path in the row's coordinates, stopping short of its head. */
  d: string;
  /** The arrowhead, a small triangle at the end, drawn on its own so the line can draw in first. */
  head: string;
  /** Where its label sits (the middle of the arrow). */
  lx: number;
  ly: number;
  /** `next`: to the card right after it; `arc`: around the cards below. */
  kind: "next" | "arc";
  seen: boolean;
}

export interface RowLayout {
  width: number;
  height: number;
  cardH: number;
  cards: CardBox[];
  arrows: Arrow[];
  /** Flows that leave the row for another area, per screen: `{screen id: [{to area, label}]}`. */
  out: Map<string, { area: string; label: string }[]>;
}

/** A triangle whose tip is at (x, y), pointing along (dx, dy). */
function headAt(x: number, y: number, dx: number, dy: number): string {
  const len = 6;
  const half = 3.5;
  const bx = x - dx * len;
  const by = y - dy * len;
  const r = (n: number) => Math.round(n * 10) / 10;
  return `M${r(x)},${r(y)} L${r(bx - dy * half)},${r(by + dx * half)} L${r(bx + dy * half)},${r(by - dx * half)} Z`;
}

/** The space between two lines of a wrapped row, above the next line's arrow lanes. */
export const LINE_GAP = 28;

/**
 * One area's row: its cards left to right in walking order, the gutters between them, and an
 * arrow for each move between two of its screens. With `maxWidth`, the cards wrap onto as many
 * lines as that width needs instead of running off to the right (the page scrolls down, never
 * sideways); without it they stay on one line.
 *
 * A move to the next card on the same line runs straight through the gutter. Any other move
 * leaves its card's bottom from a port on the right half and drops into a lane of its own below
 * that card's line (no two arcs whose spans overlap share a lane). It then either runs across with
 * rounded corners and rises into a port on the left half of a card on the same line, or, for a
 * card on another line, runs to the gutter on that card's left, follows the gutter up or down
 * between the cards and turns into the card's left side. It never runs under a card. Moves to
 * another area are listed per card instead (`out`), never drawn across the page.
 */
export function layoutRow(
  screens: readonly AtlasScreen[],
  plats: readonly Platform[],
  flows: readonly AtlasFlow[],
  areaOf: (id: string) => string | undefined,
  shapes?: Shapes,
  maxWidth?: number,
): RowLayout {
  const w = cardWidth(plats, shapes);
  const cardH = cardHeight(plats, shapes);
  const perLine =
    maxWidth && maxWidth > 0 ? Math.max(1, Math.floor((maxWidth + GUTTER) / (w + GUTTER))) : Math.max(1, screens.length);
  const lineOf = (i: number) => Math.floor(i / perLine);
  const colOf = (i: number) => i % perLine;
  const lines = screens.length ? lineOf(screens.length - 1) + 1 : 0;
  const index = new Map(screens.map((s, i) => [s.id, i]));
  const out = new Map<string, { area: string; label: string }[]>();
  const outPorts = new Map<number, number>();
  const inPorts = new Map<number, number>();
  const mine = flows.filter((f) => index.has(f.from) || index.has(f.to));
  const midY = Math.min(CARD_PAD + CARD_HEAD + framesHeight(plats, shapes) / 2, cardH / 2);
  const colX = (c: number) => c * (w + GUTTER);
  // First pass: what each move is, and the lane below its line that each arc takes.
  type Plan = { f: AtlasFlow; i: number; j: number; next: boolean; line: number; lane: number; sx: number; ex: number; cross: boolean };
  const plans: Plan[] = [];
  const lanes: [number, number][][][] = Array.from({ length: lines }, () => []);
  for (const f of mine) {
    const i = index.get(f.from);
    const j = index.get(f.to);
    if (i === undefined) continue;
    if (j === undefined) {
      // A screen of this area the filters left out is not another area.
      const area = areaOf(f.to);
      if (area && area !== areaOf(f.from)) {
        const list = out.get(f.from) ?? [];
        if (!list.some((x) => x.area === area)) list.push({ area, label: f.label });
        out.set(f.from, list);
      }
      continue;
    }
    const line = lineOf(i);
    if (j === i + 1 && lineOf(j) === line) {
      plans.push({ f, i, j, next: true, line, lane: 0, sx: 0, ex: 0, cross: false });
      continue;
    }
    // Out on the right half of a card's bottom, in on the left half (or its left side, from
    // another line), each next arc a port further.
    const po = outPorts.get(i) ?? 0;
    outPorts.set(i, po + 1);
    const sx = colX(colOf(i)) + w / 2 + PORT_GAP * (po + 1);
    const cross = lineOf(j) !== line;
    let ex: number;
    if (cross) {
      // The gutter on the card's left; left of the first column, inside the rows' side padding.
      ex = colOf(j) === 0 ? -12 : colX(colOf(j)) - GUTTER / 2;
    } else {
      const pi = inPorts.get(j) ?? 0;
      inPorts.set(j, pi + 1);
      ex = colX(colOf(j)) + w / 2 - PORT_GAP * (pi + 1);
    }
    const a = Math.min(sx, ex);
    const b = Math.max(sx, ex);
    const spans = lanes[line];
    let lane = spans.findIndex((list) => list.every(([s0, e0]) => b <= s0 || a >= e0));
    if (lane < 0) {
      spans.push([]);
      lane = spans.length - 1;
    }
    spans[lane].push([a, b]);
    plans.push({ f, i, j, next: false, line, lane, sx, ex, cross });
  }
  // Each line's top: the line before it, its arrow lanes and the gap between lines.
  const below = (l: number) => (lanes[l]?.length ? LANE_DROP + (lanes[l].length - 1) * LANE + 10 : 0);
  const tops: number[] = [];
  for (let l = 0, at = 0; l < lines; l++) {
    tops.push(at);
    at += cardH + below(l) + LINE_GAP;
  }
  const cards = screens.map((s, i) => ({ id: s.id, x: colX(colOf(i)), y: tops[lineOf(i)] ?? 0, w }));
  // Second pass: the paths, now that every line has its place.
  const arrows: Arrow[] = [];
  for (const p of plans) {
    const { f, i, j } = p;
    const top = tops[p.line];
    if (p.next) {
      const x1 = cards[i].x + w + 4;
      const x2 = cards[j].x - 3;
      const y = top + midY;
      arrows.push({ from: f.from, to: f.to, label: f.label, d: `M${x1},${y} L${x2 - 5},${y}`, head: headAt(x2, y, 1, 0), lx: (x1 + x2) / 2, ly: y, kind: "next", seen: f.seen });
      continue;
    }
    const bottom = top + cardH + 2;
    const ly = top + cardH + LANE_DROP + p.lane * LANE;
    const { sx, ex } = p;
    const dir = ex > sx ? 1 : -1;
    const r = Math.max(0, Math.min(ARC_R, Math.abs(ex - sx) / 2, (ly - bottom) / 2));
    if (!p.cross) {
      const tip = bottom + 1;
      arrows.push({
        from: f.from,
        to: f.to,
        label: f.label,
        d: `M${sx},${bottom} L${sx},${ly - r} Q${sx},${ly} ${sx + dir * r},${ly} L${ex - dir * r},${ly} Q${ex},${ly} ${ex},${ly - r} L${ex},${tip + 5}`,
        head: headAt(ex, tip, 0, -1),
        lx: (sx + ex) / 2,
        ly,
        kind: "arc",
        seen: f.seen,
      });
      continue;
    }
    // To a card on another line: along the lane to the gutter on its left, up or down the
    // gutter, then right into the card's side at its frames' middle.
    const ty = cards[j].y + midY;
    const vdir = ty > ly ? 1 : -1;
    const tx = cards[j].x - 3;
    const r2 = Math.max(0, Math.min(ARC_R, Math.abs(ty - ly) / 2, (tx - ex) / 2));
    arrows.push({
      from: f.from,
      to: f.to,
      label: f.label,
      d:
        `M${sx},${bottom} L${sx},${ly - r} Q${sx},${ly} ${sx + dir * r},${ly} L${ex - dir * r},${ly} ` +
        `Q${ex},${ly} ${ex},${ly + vdir * r} L${ex},${ty - vdir * r2} Q${ex},${ty} ${ex + r2},${ty} L${tx - 5},${ty}`,
      head: headAt(tx, ty, 1, 0),
      lx: (sx + ex) / 2,
      ly,
      kind: "arc",
      seen: f.seen,
    });
  }
  const used = Math.min(perLine, screens.length);
  const width = used ? colX(used - 1) + w : 0;
  const height = lines ? tops[lines - 1] + cardH + below(lines - 1) : 0;
  return { width, height, cardH, cards, arrows, out };
}

/** The part of an image that covers a `w` by `h` box without stretching: from the top, centred across. */
function coverRect(iw: number, ih: number, w: number, h: number): { sx: number; sy: number; sw: number; sh: number } {
  if (iw <= 0 || ih <= 0 || w <= 0 || h <= 0) return { sx: 0, sy: 0, sw: Math.max(iw, 0), sh: Math.max(ih, 0) };
  const want = w / h;
  if (iw / ih > want) {
    const sw = ih * want;
    return { sx: (iw - sw) / 2, sy: 0, sw, sh: ih };
  }
  return { sx: 0, sy: 0, sw: iw, sh: iw / want };
}

/**
 * How a screenshot sits in its frame without stretching, as CSS `object-position`: cropped to the
 * frame's shape and kept from the top (a screen's header says the most about it), the same crop
 * the onboarding map's cards use (`coverRect`).
 */
export function framePosition(iw: number, ih: number, w: number, h: number): string {
  const r = coverRect(iw, ih, w, h);
  const spareX = iw - r.sw;
  const spareY = ih - r.sh;
  const x = spareX > 0 ? (r.sx / spareX) * 100 : 50;
  const y = spareY > 0 ? (r.sy / spareY) * 100 : 0;
  return `${Math.round(x)}% ${Math.round(y)}%`;
}

/** A screenshot this much wider or narrower than its frame is shown whole instead of cropped. */
export const FIT_SLACK = 0.12;

/**
 * How a screenshot fills its frame: cropped from the top when it is the frame's shape (a status
 * bar's worth either way), else whole, letterboxed, so the important part is never cut off (an
 * iPad landscape shot in an upright iPad frame, a phone shot in a browser window).
 */
export function frameFit(iw: number, ih: number, w: number, h: number): { fit: "cover" | "contain"; position: string } {
  if (!(iw > 0 && ih > 0 && w > 0 && h > 0)) return { fit: "cover", position: "50% 0%" };
  const ia = iw / ih;
  const fa = w / h;
  if (Math.abs(ia - fa) / fa <= FIT_SLACK) return { fit: "cover", position: framePosition(iw, ih, w, h) };
  return { fit: "contain", position: "50% 50%" };
}

// ---------- words ----------

/**
 * A text as a person reads it: each hole the code leaves for a value (`*`) as an ellipsis, a hole
 * glued to a word's end (a plural, `page*`) left out, and Swift's `^[* property](inflect: true)`
 * as its words; the same rules as `atlas.display_text`. Empty when nothing but holes is left.
 */
export function displayText(text: string): string {
  const t = text
    .split(/\s+/)
    .join(" ")
    .trim()
    .replace(/\^\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(?<=[^\W\d_])\*+(?![\w*])/g, "")
    .replace(/(?<![\w*])\*+(?![\w*])/g, "…")
    .replace(/…(?:\s*…)+/g, "…");
  return /\w/.test(t) ? t : "";
}

/** The words a wireframe shows: what the screen's code says, holes as ellipses, its name left out. */
export function wireWords(s: Pick<AtlasScreen, "name" | "code_texts">): string[] {
  const name = s.name.trim().toLowerCase();
  return [...new Set(s.code_texts.map(displayText).filter((t) => t && t.toLowerCase() !== name))];
}

export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** A move's label as a person reads it: `Tap "Checkout"` → `Tap Checkout`. */
export function moveWords(label: string): string {
  return label.replace(/"([^"]+)"/g, "$1").trim() || "Goes to";
}

/** The atlas screen a map node id belongs to (Ask and the Map link into the atlas by node). */
export function screenOfNode(atlas: Atlas, node: string): AtlasScreen | null {
  return atlas.screens.find((s) => s.id === node || s.nodes.includes(node)) ?? null;
}

/** How many areas a row's "leads to" names before "+N more". */
export const LEADS_SHOWN = 3;

/** An area's summary, unless it is only the code map's count of screens ("3 screens: overview"),
 * which an older atlas still sends and which would contradict the row's own count. */
export function areaSummary(summary: string | null): string | null {
  const t = (summary ?? "").trim();
  return !t || /^\d+\s+screens?\b(:.*)?$/i.test(t) ? null : t;
}

/** Badges that say platforms seen live read or look different (evidence from the screens). */
export const LOOKS_DIFFERENT: readonly Badge[] = ["minor", "different"];

/**
 * A row's one count: "5 screens · 3 seen live · 1 differs · 2 not on every platform", or "2 of 5
 * screens" when filtered. What differs where seen live and what one platform's code lacks are
 * said apart: a screen never seen live does not "differ", it is only not on every platform.
 */
export function areaCountWords(shown: number, total: number, seen: number, differs: number, missing = 0): string {
  const n = shown < total ? `${shown} of ${plural(total, "screen")}` : plural(total, "screen");
  return [
    n,
    seen ? `${seen} seen live` : "none seen live yet",
    differs ? `${differs} ${differs === 1 ? "differs" : "differ"}` : null,
    missing ? `${missing} not on every platform` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** "3 of 15 screens" for the toolbar, or the whole count with no filter. */
export function shownWords(kept: number, total: number): string {
  return kept === total ? plural(total, "screen") : `${kept} of ${plural(total, "screen")}`;
}
