/**
 * The device picker's model (`device-picker-view.tsx`): this Mac's devices, what `GET C/devices?all`
 * reports, plus the browser sizes. Rows group by platform: the phones connected now, the paired
 * ones that are not, then the simulators or emulators, running first. A search matches model, OS,
 * platform and state. A stopped device boots when a run is sent to it; Orcha never creates one.
 */
import { PLATFORM_NAMES } from "./ui";
import type { DeviceSetup, TargetKind, WorkerDevice } from "./types";

/** A row's state chip. `ready` / `setup`: a phone that can take a run now, or needs something
 * done first (its fix shows under the row). `busy`: another run has it. */
export type DeviceState = "booted" | "running" | "stopped" | "ready" | "setup" | "busy" | "offline";

export const DEVICE_STATE_LABELS: Record<DeviceState, string> = {
  booted: "Booted",
  running: "Running",
  stopped: "Stopped",
  ready: "Ready",
  setup: "Needs setup",
  busy: "In use",
  offline: "Not found",
};

/** The heading of the connected phones in a platform's group. */
export const CONNECTED_GROUP_LABEL = "This Mac · connected";

/** The heading of the phones this Mac paired before that are not connected now. */
export const AWAY_GROUP_LABEL = "Paired · not connected";

/** What the connected-phones group says when no phone is connected: how to connect one. */
export const CONNECT_PHONE_HELP: Record<"ios" | "android", string> = {
  ios: "No iPhone or iPad connected. Plug one into this Mac, unlock it and tap Trust, and turn on Developer Mode (Settings › Privacy & Security). It shows here.",
  android: "No Android phone connected. Turn on USB debugging (Settings › Developer options), plug it into this Mac and allow this computer. Over Wi-Fi: adb connect <phone-ip>:5555.",
};

export const DEFAULT_DEVICE_NOUN: Record<TargetKind, string> = {
  ios: "Any booted simulator",
  android: "Any running emulator",
  web: "Desktop browser (1280×800)",
};

/** Order platforms are listed in, everywhere. */
export const PLATFORM_ORDER: readonly TargetKind[] = ["web", "ios", "android"];

export function sortKinds(kinds: Iterable<TargetKind>): TargetKind[] {
  const set = new Set(kinds);
  return PLATFORM_ORDER.filter((k) => set.has(k));
}

/** "USB" / "Wi-Fi": how a physical phone is connected. */
export function connectionLabel(connection: string | null | undefined): string | null {
  if (connection === "usb") return "USB";
  if (connection === "network") return "Wi-Fi";
  return null;
}

/** A phone's second line: "iPhone 17 Pro Max · iOS 26.6.1 · USB", the model only when the name
 * does not already say it. */
export function physicalDetail(d: { name: string; model?: string | null; os?: string | null; connection?: string | null }): string {
  const model = d.model && d.model !== d.name ? d.model : null;
  return [model, d.os, connectionLabel(d.connection) ?? "Not connected"].filter(Boolean).join(" · ");
}

/** "Pixel_9_Pro" reads "Pixel 9 Pro". */
export const prettyAvd = (name: string) => name.replace(/_/g, " ");

/** Who has a device now: a run sent to it waits its turn. */
export function heldWords(d: WorkerDevice): string | null {
  const h = "held_by" in d ? d.held_by : null;
  if (!h) return null;
  return h.project && h.kind ? `${h.project}'s ${h.kind} run has it` : "Another run has it";
}

/** What a session is told to run on: a device's name, a viewport on the web. */
export function deviceValue(d: WorkerDevice): string {
  return d.kind === "web" ? d.viewport : d.name;
}

/** One device as the picker receives it. */
export interface PickerInput {
  device: WorkerDevice;
  /** False: no longer seen on this machine. */
  online?: boolean;
}

export interface PickerRow {
  /** Stable selection key (`devicePickerKey`). */
  key: string;
  kind: TargetKind;
  device: WorkerDevice;
  title: string;
  /** Second line: OS, serial, viewports. */
  detail: string;
  state: DeviceState;
  /** A phone this Mac knows: under "This Mac · connected", else "Paired · not connected". */
  physical: boolean;
  /** What a phone needs before it can run, shown under the row. */
  setup: DeviceSetup | null;
  /** Lower sorts first: running before anything else. */
  rank: number;
  /** Lower-cased text the search matches. */
  haystack: string;
}

/** A stable key per device: by udid, serial or browser size, never by list position, so a pick
 * survives the list being re-read or re-sorted. A browser size is its own key: it is what the
 * session takes as its device. */
export function devicePickerKey(d: WorkerDevice): string {
  if (d.kind === "ios") return `ios:${d.udid}`;
  if (d.kind === "android") return `android:${d.physical ? d.serial || d.name : d.name}`;
  return d.viewport;
}

function localState(d: WorkerDevice): DeviceState {
  if (d.kind === "web") return "running";
  if (heldWords(d)) return "busy";
  if (d.physical) return d.ready === false ? "setup" : "ready";
  const s = (d.state ?? "").toLowerCase();
  if (s === "shutdown" || s === "stopped") return "stopped";
  return d.kind === "ios" ? "booted" : "running";
}

const STOPPED_NOTE = "Boots when the run starts";

const connected = (d: WorkerDevice) => "connection" in d && Boolean(d.connection);

/** One device as a picker row. */
export function pickerRow(input: PickerInput): PickerRow {
  const d = input.device;
  const key = devicePickerKey(d);
  const kind = d.kind;
  const state: DeviceState = input.online === false ? "offline" : localState(d);
  const physical = d.kind !== "web" && Boolean(d.physical);
  const title = d.kind === "android" && !physical ? prettyAvd(d.name) : d.name;
  const base = d.kind === "web" ? "Chromium" : physical ? physicalDetail(d) : d.kind === "ios" ? d.runtime || "Simulator" : "Emulator";
  const detail = heldWords(d) ?? (state === "stopped" ? `${base} · ${STOPPED_NOTE}` : base);
  const setup = d.kind !== "web" && physical && d.ready === false ? d.setup ?? null : null;
  return {
    key,
    kind,
    device: d,
    title,
    detail,
    state,
    physical,
    setup,
    // Ready and running first, then a phone that needs a step, then what is stopped.
    rank: state === "offline" ? 3 : state === "stopped" || (physical && !connected(d)) ? 2 : state === "setup" ? 1 : 0,
    haystack: `${title} ${detail} ${PLATFORM_NAMES[kind]} local ${physical ? "phone physical" : ""} ${setup?.title ?? ""} ${DEVICE_STATE_LABELS[state]}`.toLowerCase(),
  };
}

/** What "Default" does for a platform, said exactly as a session does it. */
export function defaultDevicePick(kind: TargetKind, rows: readonly PickerRow[] = []): { noun: string; detail: string } {
  const noun = DEFAULT_DEVICE_NOUN[kind];
  const generic = { noun, detail: `The agent picks: ${noun.toLowerCase()}` };
  if (kind === "web") return generic;
  const mine = rows.filter((r) => r.kind === kind && !r.physical);
  if (!mine.length || mine.some((r) => r.state === "booted" || r.state === "running" || r.state === "busy")) return generic;
  // Nothing runs: the session boots the one it always starts with (`android_u2.default_avd`, the
  // default simulators). Said here so a Default run never surprises anyone.
  const stopped = mine.filter((r) => r.state === "stopped");
  const boot = kind === "ios"
    ? stopped.find((r) => r.title === "iPhone 17 Pro") ?? stopped.find((r) => r.title === "iPad Pro 13-inch (M5)")
    : stopped.find((r) => !/tablet|fold|tv|wear|auto/i.test(r.title)) ?? stopped[0];
  if (!boot) return generic;
  return { noun: `Boots ${boot.title}`, detail: `Nothing is running. Orcha boots ${boot.title} first, about a minute.` };
}

/** Whether a row matches the search: every word of the query appears somewhere in it. */
export function matchesQuery(row: Pick<PickerRow, "haystack">, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return words.every((w) => row.haystack.includes(w));
}

export interface PickerGroup {
  kind: TargetKind;
  rows: PickerRow[];
}

/** Every row, deduped by key, with names made distinct where two would read the same. */
export function pickerRows(inputs: readonly PickerInput[]): PickerRow[] {
  const byKey = new Map<string, PickerRow>();
  for (const i of inputs) {
    const r = pickerRow(i);
    const prev = byKey.get(r.key);
    if (!prev || (prev.state === "offline" && r.state !== "offline")) byKey.set(r.key, r);
  }
  const rows = [...byKey.values()];
  // Two simulators named alike on the same runtime: add the udid's first block.
  const sig = new Map<string, number>();
  for (const r of rows) sig.set(`${r.title}|${r.detail}`, (sig.get(`${r.title}|${r.detail}`) ?? 0) + 1);
  for (const r of rows) {
    const d = r.device;
    if (d.kind === "ios" && (sig.get(`${r.title}|${r.detail}`) ?? 0) > 1) r.detail = `${r.detail} · ${d.udid.slice(0, 8)}`;
  }
  return rows;
}

function byRank(a: PickerRow, b: PickerRow): number {
  return a.rank - b.rank || a.title.localeCompare(b.title, undefined, { numeric: true }) || b.detail.localeCompare(a.detail, undefined, { numeric: true });
}

/** The rows for these platforms, matching the search, grouped by platform in the standard order
 * (Web, iOS, Android) and sorted within each. */
export function pickerGroups(rows: readonly PickerRow[], opts: { kinds: readonly TargetKind[]; query?: string }): PickerGroup[] {
  const q = opts.query?.trim() ?? "";
  return sortKinds(opts.kinds)
    .map((kind) => ({ kind, rows: rows.filter((r) => r.kind === kind && (!q || matchesQuery(r, q))).sort(byRank) }))
    .filter((g) => g.rows.length > 0);
}

/** A group's rows split into the phones connected to this Mac, the paired ones that are not, and
 * the simulators or emulators. `connected` and `away` are null on the web, a browser. */
export function splitConnected(kind: TargetKind, rows: readonly PickerRow[]): { connected: PickerRow[] | null; away: PickerRow[] | null; virtual: PickerRow[] } {
  if (kind === "web") return { connected: null, away: null, virtual: [...rows] };
  return {
    connected: rows.filter((r) => r.physical && connected(r.device)),
    away: rows.filter((r) => r.physical && !connected(r.device)),
    virtual: rows.filter((r) => !r.physical),
  };
}

/** The row a saved device name (a step's `device`) stands for, or null. */
export function rowForValue(rows: readonly PickerRow[], kind: TargetKind, value: string | null | undefined): PickerRow | null {
  return (value && rows.find((r) => r.kind === kind && deviceValue(r.device) === value)) || null;
}

/** Why a run cannot start on this row now, for a run that starts on the click. */
export function blockedWords(row: PickerRow | null): string | null {
  return row?.setup ? `${row.setup.title} ${row.setup.fix}` : null;
}

/** Platforms with a single choice always made (a browser size): a row reads as picked instead of
 * offering "Default". */
export function impliedLocalPick(kind: TargetKind): boolean {
  return kind === "web";
}

/** The row behind a key, or null. */
export function rowForKey(rows: readonly PickerRow[], key: string | null | undefined): PickerRow | null {
  if (!key) return null;
  return rows.find((r) => r.key === key) ?? null;
}

/** What a platform runs on, in the words of the picker's "Picked" strip: the picked row's name,
 * else the default ("Any booted simulator"). The We found sheet's Device line says exactly this,
 * so the two never disagree (#454). */
export function pickedSummary(rows: readonly PickerRow[], kind: TargetKind, key: string | null | undefined): string {
  const row = rowForKey(rows, key);
  return row ? row.title : defaultDevicePick(kind, rows).noun;
}
