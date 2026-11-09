/**
 * Needs setup (#227, #216, #252; epic #257): It could not be tested here. The environment, the
 * device or the test data lacked something, so the result is neither a pass nor a failure. It never
 * files an issue and never counts against a pass rate. (Python) decides it and
 * writes the reason on `scenario_results.setup` and on each criterion it covers (migration 098).
 */
import type { Json } from "../types";

export type NeedsSetupCategory = "environment" | "device" | "test_data";

export interface NeedsSetup {
  /** A stable reason code: `purchases_unavailable`, `device_tree_empty`, `seed_data_missing`, ... */
  code: string;
  category: NeedsSetupCategory | null;
  /** The reason in a few words: "In-app purchases unavailable". */
  title: string;
  /** The one thing to do, in plain words. */
  fix: string;
  /** What the agent saw: `The screen showed "Subscription Unavailable".` */
  detail: string | null;
  /** What decided it: `signature`, `device`, `precondition` or `triage`. */
  source: string | null;
  /** The agent's own verdict before it was set aside (`fail`, `blocked`, ...). */
  judgedOutcome: string | null;
}

const CATEGORIES: readonly NeedsSetupCategory[] = ["environment", "device", "test_data"];

/** The `setup` object of a result or criterion item, or null when it has none. */
export function parseSetup(json: Json | null | undefined): NeedsSetup | null {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
  const o = json as Record<string, Json>;
  if (typeof o.code !== "string" || !o.code) return null;
  const str = (v: Json | undefined) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const category = CATEGORIES.find((c) => c === o.category) ?? null;
  return {
    code: o.code,
    category,
    title: str(o.title) ?? "Needs setup",
    fix: str(o.fix) ?? "",
    detail: str(o.detail),
    source: str(o.source),
    judgedOutcome: str(o.judged_outcome),
  };
}

/** The label of the outcome, everywhere it is shown. */
export const NEEDS_SETUP_LABEL = "Needs setup";

/** What the category means, for a tooltip. */
export const NEEDS_SETUP_CATEGORY_HELP: Readonly<Record<NeedsSetupCategory, string>> = {
  environment: "Something the app needs from its surroundings is missing here (a store sandbox, an account, a test service).",
  device: "The device was not ready for testing (a phone locked or not connected, or it stopped reporting the screen); the app was not judged.",
  test_data: "The data this scenario starts from was not there.",
};

/** One line for a card: "Needs setup: In-app purchases unavailable". */
export function needsSetupLine(setup: NeedsSetup | null): string {
  return setup ? `${NEEDS_SETUP_LABEL}: ${setup.title}` : NEEDS_SETUP_LABEL;
}
