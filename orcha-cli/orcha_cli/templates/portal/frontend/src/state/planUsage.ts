/**
 * Plan usage (Claude / Codex plan limits) for the web portal.
 *
 * The Embodent desktop app publishes privacy-safe snapshots to
 * `GET /api/plan-usage` (one per desktop host). Whether the sidebar summary
 * shows, and for which providers, is ONE portal-wide setting at
 * `GET|PUT /api/plan-usage/display` (default: off, both). The web only reads
 * its own origin, so the "newest updated_at wins" sync rule reduces to "the
 * server's value", except that a GET started before a local write never
 * overwrites the optimistic value.
 *
 * A module store (useSyncExternalStore) so the Settings switch and the sidebar
 * row share one value: flipping the switch shows/hides the row immediately.
 */
import { useEffect, useSyncExternalStore } from "react";
import { getJSON, sendJSON } from "../api/client";
import { registerTestReset } from "../lib/testResets";

export type PlanProvider = "claude" | "codex";
export type ProvidersChoice = "both" | PlanProvider;

export interface PlanUsageDisplay {
  show: boolean;
  providers: ProvidersChoice;
  updated_at: string | null;
}

export interface PlanWindow { key: string; label: string; used_pct: number; resets_at: string | null }
export interface PlanProviderUsage {
  provider: PlanProvider;
  plan: string | null;
  headline: string | null;
  windows: PlanWindow[];
  today?: { tokens: number; cost_usd: number | null } | null;
}
export interface PlanSnapshot { host: string; captured_at: string; updated_at: string; providers: PlanProviderUsage[] }

export const DISPLAY_URL = "/api/plan-usage/display";
export const USAGE_URL = "/api/plan-usage";
export const PLAN_USAGE_POLL_MS = 2 * 60 * 1000;
export const DEFAULT_DISPLAY: PlanUsageDisplay = { show: false, providers: "both", updated_at: null };
export const PROVIDER_ORDER: PlanProvider[] = ["claude", "codex"];
export const PROVIDER_LABEL: Record<PlanProvider, string> = { claude: "Claude", codex: "Codex" };

/* ---- pure helpers (tested) --------------------------------------------------------------- */

/** A server display payload as a safe value; anything malformed is the default. */
export function normalizeDisplay(raw: unknown): PlanUsageDisplay {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_DISPLAY };
  const o = raw as Record<string, unknown>;
  const providers = o.providers === "claude" || o.providers === "codex" || o.providers === "both" ? o.providers : "both";
  return {
    show: o.show === true,
    providers,
    updated_at: typeof o.updated_at === "string" ? o.updated_at : null,
  };
}

function ts(iso: string | null | undefined): number {
  const n = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/** The newest snapshot's entry for each provider, across every desktop host. */
export function latestByProvider(snapshots: PlanSnapshot[] | null | undefined): Partial<Record<PlanProvider, PlanProviderUsage>> {
  const best: Partial<Record<PlanProvider, { u: PlanProviderUsage; at: number; up: number }>> = {};
  for (const s of snapshots || []) {
    const at = ts(s.captured_at);
    const up = ts(s.updated_at);
    for (const p of s.providers || []) {
      if (p.provider !== "claude" && p.provider !== "codex") continue;
      const cur = best[p.provider];
      if (!cur || at > cur.at || (at === cur.at && up > cur.up)) best[p.provider] = { u: p, at, up };
    }
  }
  const out: Partial<Record<PlanProvider, PlanProviderUsage>> = {};
  for (const k of PROVIDER_ORDER) if (best[k]) out[k] = best[k]!.u;
  return out;
}

/** The provider's busiest window (highest used %), or null when it has none. */
export function busiestWindow(u: PlanProviderUsage | null | undefined): PlanWindow | null {
  let top: PlanWindow | null = null;
  for (const w of u?.windows || []) if (!top || w.used_pct > top.used_pct) top = w;
  return top;
}

export type UsageTone = "ok" | "warn" | "danger";
/** Warn above 75 %, danger above 90 %. */
export function usageTone(pct: number): UsageTone {
  if (pct > 90) return "danger";
  if (pct > 75) return "warn";
  return "ok";
}

export function pctText(pct: number): string {
  return `${Math.round(Math.max(0, Math.min(100, pct)))}%`;
}

export interface ShownProvider { provider: PlanProvider; usage: PlanProviderUsage; peak: number }

/** The providers the summary shows: the chosen ones that have at least one window. */
export function shownProviders(display: PlanUsageDisplay, latest: Partial<Record<PlanProvider, PlanProviderUsage>>): ShownProvider[] {
  if (!display.show) return [];
  const wanted = display.providers === "both" ? PROVIDER_ORDER : [display.providers];
  const out: ShownProvider[] = [];
  for (const p of wanted) {
    const usage = latest[p];
    const top = busiestWindow(usage);
    if (usage && top) out.push({ provider: p, usage, peak: top.used_pct });
  }
  return out;
}

/** "Usage: Claude 34%, Codex 75%" */
export function usageAriaLabel(shown: ShownProvider[]): string {
  return "Usage: " + shown.map((s) => `${PROVIDER_LABEL[s.provider]} ${pctText(s.peak)}`).join(", ");
}

/** "resets in 2h 14m" / "resets in 3d 4h" / "resets now"; null without a reset time. */
export function resetsInLabel(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const mins = Math.round((t - now) / 60000);
  if (mins <= 0) return "resets now";
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `resets in ${d}d${h ? ` ${h}h` : ""}`;
  if (h > 0) return `resets in ${h}h${m ? ` ${m}m` : ""}`;
  return `resets in ${m}m`;
}

/* ---- store -------------------------------------------------------------------------------- */

interface State {
  display: PlanUsageDisplay;
  displayLoaded: boolean;
  snapshots: PlanSnapshot[] | null;
  saving: boolean;
  error: string | null;
}

let state: State = { display: { ...DEFAULT_DISPLAY }, displayLoaded: false, snapshots: null, saving: false, error: null };
let writeSeq = 0;
const subs = new Set<() => void>();

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
}
function subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; }
function snapshot() { return state; }

registerTestReset(() => {
  state = { display: { ...DEFAULT_DISPLAY }, displayLoaded: false, snapshots: null, saving: false, error: null };
  writeSeq = 0;
  subs.clear();
});

export function usePlanUsageState(): State {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Re-read the display setting. A 404 / network error (older portal) keeps what we have. */
export async function refreshDisplay(): Promise<void> {
  const seq = writeSeq;
  try {
    const raw = await getJSON<unknown>(DISPLAY_URL);
    if (seq !== writeSeq) return; // a local write happened meanwhile: it wins
    set({ display: normalizeDisplay(raw), displayLoaded: true });
  } catch {
    if (seq === writeSeq && !state.displayLoaded) set({ displayLoaded: true });
  }
}

export async function refreshUsage(): Promise<void> {
  try {
    const raw = await getJSON<{ snapshots?: PlanSnapshot[] }>(USAGE_URL);
    set({ snapshots: Array.isArray(raw?.snapshots) ? raw.snapshots : [] });
  } catch {
    /* keep the last good snapshots; an older portal has no route */
  }
}

/** Optimistic write: the UI changes now, then PUT; a refusal restores the previous value. */
export async function saveDisplay(next: { show: boolean; providers: ProvidersChoice }): Promise<void> {
  const prev = state.display;
  const seq = ++writeSeq;
  set({ display: { ...prev, show: next.show, providers: next.providers }, saving: true, error: null, displayLoaded: true });
  try {
    const raw = await sendJSON<unknown>("PUT", DISPLAY_URL, { show: next.show, providers: next.providers });
    if (seq === writeSeq) set({ display: normalizeDisplay(raw), saving: false });
  } catch (e) {
    console.warn("[plan-usage] saving the display setting failed", e);
    if (seq === writeSeq) set({ display: prev, saving: false, error: errText(e) });
  }
}

function errText(e: unknown): string {
  const status = (e as { status?: unknown } | null)?.status;
  if (status === 401 || status === 403) return "You don't have permission to change this.";
  if (status === 404) return "This Embodent doesn't support the setting yet — update it with orcha upgrade.";
  return "Couldn't save — try again.";
}

function visible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

/**
 * Keep the display setting (and, while it is on, the snapshots) fresh: on mount,
 * whenever the page becomes visible / focused again, and every 2 minutes while
 * the page is visible.
 */
export function usePlanUsagePolling(): void {
  const show = usePlanUsageState().display.show;
  useEffect(() => {
    const tick = () => {
      if (!visible()) return;
      void refreshDisplay();
      if (state.display.show) void refreshUsage();
    };
    tick();
    const id = window.setInterval(tick, PLAN_USAGE_POLL_MS);
    const onVis = () => { if (visible()) tick(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
    };
  }, []);
  // turning the setting on (here or from Settings) loads the numbers right away
  useEffect(() => { if (show) void refreshUsage(); }, [show]);
}
