/** When Quality opens on the onboarding instead of the Exploration home (pure; tested). */
import { PLATFORMS, type Platform, type PlatformOverview, type QaTarget } from "../qaApi";
import type { OnboardingRow } from "./use-onboarding-map";

export interface SetupSteps { app: boolean; tools: boolean; mapped: boolean }

/**
 * What a project has set up (pure; tested):
 *   app    — any platform has its app set;
 *   tools  — `orcha qa enable` can't be seen from the portal, so: any session exists;
 *   mapped — a map session ran, or the map has anything in it (a code build).
 */
export function setupSteps(o: Record<Platform, PlatformOverview>, targets: QaTarget[]): SetupSteps {
  const all = PLATFORMS.map((p) => o[p]);
  return {
    app: targets.some((t) => !!t.app_id) || all.some((x) => !!x.target?.app_id),
    tools: all.some((x) => Object.values(x.last_sessions).some(Boolean)),
    mapped: all.some((x) => !!x.last_sessions.map || x.screens.seen + x.screens.declared + x.screens.blocked > 0),
  };
}

export const comingBackFromFirstRun = (search: string) => new URLSearchParams(search).get("after") === "first_run";

/** The saved sheet started the flow: the code map is past waiting for "Save and map". */
function flowUnderWay(row: OnboardingRow): boolean {
  const code = (row.phases as { code_map?: { state?: string } } | null | undefined)?.code_map?.state;
  return code !== undefined && code !== "pending";
}

/**
 * Whether the tab opens on the onboarding: not when it was finished or skipped; always while it is
 * under way (the flow's own session and screens must not close it); otherwise when some setup step
 * is missing.
 */
export function opensOnOnboarding(steps: SetupSteps, row: OnboardingRow | null | undefined): boolean {
  if (row?.phase === "done" || row?.state === "done") return false;
  if (row && flowUnderWay(row)) return true;
  return !(steps.app && steps.tools && steps.mapped);
}
