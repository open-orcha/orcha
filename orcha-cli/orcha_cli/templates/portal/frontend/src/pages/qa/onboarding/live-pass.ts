/**
 * The live pass on the Map step, as pure helpers the banner and the side panel render: which
 * banner shows, its words, what Retry asks for, a failure note in plain words, the panel's
 * remembered open or collapsed state and the recent steps it lists. The tests drive these.
 */
import type { LiveBuildInfo, LiveDepth, LiveRun, OnboardingMap, PlatformKind } from "./contract";
import type { MapBeat } from "./flow";

export type LiveBannerKind = "offer" | "running" | "done" | "failed" | "skipped";

/** Which live banner the Map step shows, or none. */
export function liveBannerKind(map: OnboardingMap, beat: MapBeat): LiveBannerKind | null {
  if (beat === "live_offer") return "offer";
  if (beat === "live") return "running";
  if (beat !== "ready") return null;
  const state = map.phases.live.state;
  if (state === "failed") return "failed";
  if (state === "done") return "done";
  if (state === "skipped" && map.screens.length > 0) return "skipped";
  return null;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** The platform the live pass maps on: its crawl's, else the one Embodent chose (the first
 * platform could not be read), else the first one listed. */
export function livePlatformOf(map: OnboardingMap): PlatformKind {
  return map.live_run?.platform ?? map.found.live_platform?.kind ?? map.found.platforms[0]?.kind ?? "ios";
}

/** The screens of the platform this pass walks: a web pass is never told it saw iOS screens. */
export function passScreens(map: OnboardingMap): OnboardingMap["screens"] {
  const here = map.live_run?.platform ?? map.found.live_platform?.kind;
  return here ? map.screens.filter((s) => !s.platform || s.platform === here) : map.screens;
}

/** Screens the device has seen, whatever the pass aimed at. */
export function screensSeen(map: OnboardingMap): number {
  return passScreens(map).filter((s) => s.source !== "code").length;
}

/** The banner's first line while the pass runs, and once it is done. */
export function liveTitle(kind: "running" | "done", map: OnboardingMap, device: string): string {
  const run = map.live_run;
  const n = passScreens(map).length;
  const seen = screensSeen(map);
  if (!run) {
    return kind === "running" ? `Live pass on ${device}: ${seen} of ${n} screens seen` : `Live pass done: ${seen} of ${n} screens seen`;
  }
  const { reached, targets } = run;
  if (run.depth === "deeper") {
    if (targets === 0) return kind === "running" ? `Mapping deeper on ${device}: ${seen} of ${n} screens seen` : `Mapped deeper: ${seen} of ${n} screens seen`;
    const what = `${reached} of ${targets} ${plural(targets, "screen", "screens")} reached`;
    return kind === "running" ? `Mapping deeper on ${device}: ${what}` : `Mapped deeper: ${what}`;
  }
  if (targets === 0) {
    const what = `${seen} ${plural(seen, "screen", "screens")} seen so far`;
    return kind === "running" ? `High-level map on ${device}: ${what}` : `High-level map done: ${seen} ${plural(seen, "screen", "screens")} seen`;
  }
  const what = `${reached} of ${targets} main ${plural(targets, "area", "areas")} seen`;
  return kind === "running" ? `High-level map on ${device}: ${what}` : `High-level map done: ${what}`;
}

/** The progress bar's share, 0 to 100. */
export function livePercent(map: OnboardingMap): number {
  const run = map.live_run;
  if (run && run.targets > 0) return Math.round((Math.min(run.reached, run.targets) / run.targets) * 100);
  const n = map.screens.length;
  return n ? Math.round((screensSeen(map) / n) * 100) : 0;
}

/** Whether the run has no device view yet (queued, building, or no run row yet). */
export function waitingForDevice(run: LiveRun | null): boolean {
  return !run || !run.run_id;
}

/** How the pass's app is built, when Embodent builds it: in the local checkout, or from a clone. */
export type LiveBuild = { local: boolean } | null;

/**
 * What the pass is doing before the device shows the app, in the banner's and the panel's words
 * (#454): "Building the app" while it compiles, never "Waiting for a device" then. Null once the
 * pass is mapping (or has ended).
 */
/** The request a blocked phase is waiting on, as a link. */
export const blockedRequestHref = (id: string) => `/requests?req=${encodeURIComponent(id)}`;

export function liveStageText(run: LiveRun | null, device: string, build: LiveBuild = null): { title: string; detail: string } | null {
  const stage = run?.stage ?? (run?.run_id ? "mapping" : "queued");
  switch (stage) {
    case "queued":
      return {
        title: "Waiting for a device",
        detail: build
          ? `It starts as soon as a worker is free, then builds the app ${build.local ? "in your local checkout" : "from the repository"} before ${device} opens it.`
          : `The pass starts as soon as ${device} is free.`,
      };
    case "starting":
      return { title: "Starting the pass", detail: "A worker took it and is getting ready." };
    case "waiting_device":
      return { title: "Waiting for a device", detail: `Another run is using ${device}. The pass starts when it is free.` };
    case "device":
      return { title: "Getting the device ready", detail: `Booting or checking ${device}.` };
    case "preparing":
      return { title: "Preparing the environment", detail: "Setting up the environment before the app opens." };
    case "building":
      return {
        title: "Building the app",
        detail: `${build?.local === false ? "Compiling it from the repository" : "Compiling it in your local checkout, with its dependencies installed there"}. This can take a few minutes; the device shows once the app is installed.`,
      };
    case "installing":
      return { title: "Installing the app", detail: `Putting the new build on ${device}.` };
    case "launching":
      return { title: "Opening the app", detail: `The first screen shows here in a moment.` };
    default:
      return null;
  }
}

/** Which build the pass opens, and when that build got there: nothing is compiled for it. */
export function liveBuildWords(build: LiveBuildInfo | null | undefined, device: string): string {
  if (build?.source === "url") return `Embodent opens ${build.app_id}`;
  const at = build?.installed_at ? new Date(build.installed_at) : null;
  const when = at && !Number.isNaN(at.getTime()) ? `installed ${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : "";
  const facts = [build?.version ? `version ${build.version}` : "", when].filter(Boolean).join(", ");
  return `Embodent does not build your code: it opens the build already installed on ${build?.device ?? device}${facts ? ` (${facts})` : ""}`;
}

/** What Retry asks for: the same depth as the pass that stopped. */
export function retryDepth(run: LiveRun | null): LiveDepth {
  return run?.depth ?? "overview";
}

/** The generic note a finished crawl leaves: nothing worth repeating under the banner. */
const PLAIN_DONE = /^the crawl finished/i;

/** The done banner's note: how the pass ended (on its time budget, at the step guard, nothing
 * left to map), or null for the plain "it finished". */
export function doneNote(note: string | undefined): string | null {
  const text = (note ?? "").trim().replace(/\.$/, "");
  return text && !PLAIN_DONE.test(text) ? text : null;
}

/** Why a pass failed, as a sentence. The backend writes it in plain words; an older row may still
 * hold the worker's terse error ("step ceiling 400 reached"), which reads as a sentence here. */
export function failureText(note: string | undefined): string {
  const text = (note ?? "").trim().replace(/\.$/, "");
  if (!text) return "The device was not reachable";
  const ceiling = /step ceiling (\d+) reached/i.exec(text);
  if (ceiling) return `It hit the step limit (${ceiling[1]} steps) before it could write its report`;
  const stalled = /stalled: no new step for (\d+) min/i.exec(text);
  if (stalled) return `The device stopped responding for ${stalled[1]} ${stalled[1] === "1" ? "minute" : "minutes"}`;
  const timedOut = /timed out after (\d+) s/i.exec(text);
  if (timedOut) return `It ran out of time after ${Math.max(1, Math.round(Number(timedOut[1]) / 60))} minutes`;
  if (/^stopped by the user$/i.test(text)) return "It was stopped";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ---------- the side panel ----------

/** Where the viewer's open or collapsed choice is kept (this browser only). */
export const PANEL_KEY = "orcha.qa.onboarding.liveRunPanel";

/** The remembered choice: collapsed unless the viewer opened it before. Storage that throws
 * (a private window, blocked site data) reads as collapsed. */
export function readPanelOpen(storage: Pick<Storage, "getItem"> | null | undefined): boolean {
  try {
    return storage?.getItem(PANEL_KEY) === "open";
  } catch {
    return false;
  }
}

/** Keeps the choice; storage that throws is ignored (the panel still opens and closes). */
export function writePanelOpen(storage: Pick<Storage, "setItem"> | null | undefined, open: boolean): void {
  try {
    storage?.setItem(PANEL_KEY, open ? "open" : "collapsed");
  } catch {
    // Blocked storage: the choice lasts until the page reloads.
  }
}

export function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The steps the panel lists, newest first: the seeded ones with the live ones over them. */
export function recentSteps<T extends { seq: number }>(seeded: readonly T[], live: readonly T[], limit = 7): T[] {
  const bySeq = new Map<number, T>();
  for (const s of seeded) bySeq.set(s.seq, s);
  for (const s of live) bySeq.set(s.seq, s);
  return [...bySeq.values()].sort((a, b) => b.seq - a.seq).slice(0, limit);
}
