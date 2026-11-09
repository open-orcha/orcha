/**
 * The backend each platform's app talks to (#453), as the We found sheet, the environment editor
 * and the Map step show it, and as `createProject` stores it. The repository says which URL each
 * build uses (`found.backends`, `the backends reader`); which one a project's runs
 * reach depends on the build they run: one Embodent makes from this checkout, or one someone adds.
 * Pure: the tests drive these.
 */
import { hostOf, isLocalHost } from "./ui";
import type { BuildSource, TargetKind } from "./types";
import type { BackendBuild, FoundBackend, FoundSheet, PlatformKind } from "./contract";

/** What the We found sheet read about backends, and for which folder (read once per folder). */
export interface DetectedBackends {
  /** `<repo>\0<subdir>`: the folder the sheet read. */
  for: string;
  list: FoundBackend[];
  unknown: Partial<Record<PlatformKind, string>>;
}

export function detectedBackends(key: string, found: Pick<FoundSheet, "backends" | "backend_unknown">): DetectedBackends {
  return { for: key, list: found.backends ?? [], unknown: found.backend_unknown ?? {} };
}

/** The build a platform's runs use. A phone runs what Embodent builds from this checkout
 * ("Build from the repository"), else a build someone adds (an APK, an IPA, a path, a URL, or
 * none: whatever is installed), treated as a release build. A web app on this Mac is the
 * checkout's dev server; one at a hosted URL is the deployed release. */
export function runBuild(kind: TargetKind, source: BuildSource | null | undefined, locator = ""): Exclude<BackendBuild, "any"> {
  if (kind === "web") return locator && !isLocalHost(hostOf(locator)) ? "release" : "checkout";
  return source === "repo" ? "checkout" : "release";
}

/** The backend `kind`'s runs reach on `build`: that build's own, else the one every build uses;
 * null when the repository does not say (never a guess from the other build). */
export function backendFor(detected: Pick<DetectedBackends, "list"> | null | undefined, kind: TargetKind, build: Exclude<BackendBuild, "any">): FoundBackend | null {
  const mine = (detected?.list ?? []).filter((b) => b.platforms.includes(kind));
  return mine.find((b) => b.build === build) ?? mine.find((b) => b.build === "any") ?? null;
}

/** The backend a wizard target's runs reach, from its build and its locator. */
export function targetBackend(
  detected: Pick<DetectedBackends, "list"> | null | undefined,
  target: { kind: TargetKind; locator: string; build: { source: BuildSource } },
): FoundBackend | null {
  return backendFor(detected, target.kind, runBuild(target.kind, target.build.source, target.locator));
}

/** "127.0.0.1:54321", "abcd.supabase.co", "api.truckline.io/v1": the URL without its scheme. */
export function backendHost(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

export const BUILD_WORDS: Record<BackendBuild, string> = {
  checkout: "Builds from this checkout",
  release: "Release builds (an APK or IPA you add)",
  any: "Every build",
};

/** The same for a web app: its dev server on this Mac, or the deployed site. */
export const WEB_BUILD_WORDS: Record<BackendBuild, string> = {
  checkout: "The dev server from this checkout",
  release: "The deployed site",
  any: "Every build",
};

/** Which builds a backend serves, in words that fit its platforms. */
export function buildWords(b: Pick<FoundBackend, "build" | "platforms">): string {
  return (b.platforms.every((k) => k === "web") ? WEB_BUILD_WORDS : BUILD_WORDS)[b.build];
}

/** What production means for a run, in one line. */
export const PRODUCTION_MEANS = "Production: each run asks first and stays read-only unless you allow changes to real data.";

/** How a backend reads as a badge: production, local (this Mac or a private network), or hosted
 * but marked staging, dev, test or preview. */
export function backendTone(b: Pick<FoundBackend, "url" | "production">): "production" | "local" | "hosted" {
  if (b.production) return "production";
  return isLocalHost(hostOf(b.url)) ? "local" : "hosted";
}

export const TONE_WORDS = { production: "Production", local: "Local", hosted: "Not production" } as const;

/** The platforms a list names, in the order the sheet lists platforms. */
export function platformOrder(kinds: readonly PlatformKind[]): PlatformKind[] {
  return (["ios", "android", "web"] as const).filter((k) => kinds.includes(k));
}

/**
 * The Map step's line about where the live pass lands, before it starts: production (read-only),
 * unknown (check first), or nothing to say (a local or test backend).
 */
export function liveBackendLine(detected: DetectedBackends | null | undefined, kind: TargetKind, b: FoundBackend | null): { tone: "production" | "unknown"; text: string } | null {
  if (b?.production) return { tone: "production", text: `This build talks to ${b.service} at ${backendHost(b.url)}, a production system: the pass is read-only.` };
  if (b || kind === "web") return null;
  const why = detected?.unknown?.[kind as PlatformKind];
  return { tone: "unknown", text: `Embodent could not tell which backend this build talks to${why ? ` (${lowerFirst(why)})` : ""}. If it could be production, check the environment before you start.` };
}

function lowerFirst(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}
