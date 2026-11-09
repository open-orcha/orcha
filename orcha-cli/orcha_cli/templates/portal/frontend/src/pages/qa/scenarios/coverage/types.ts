/** Test coverage per feature area (Scenarios > Coverage), as `compute.ts` works it out. */

export type CoverageState = "untested" | "thin" | "covered" | "strong" | "failing";
export type LinkSource = "manual" | "draft" | "migration" | "run_trace" | "text";
export type PlatformKey = "all" | string;

export const COVERAGE_STATES: readonly CoverageState[] = ["untested", "thin", "covered", "strong", "failing"];

export interface LastResult {
  outcome: "pass" | "fail";
  at: string;
  scenario_id?: string;
}

export interface AreaScenario {
  id: string;
  name: string;
  /** Its status: a paused one keeps its coverage, marked. */
  status: string;
  /** Why it is paused ("Flag off"). */
  status_reason?: string | null;
  target_kind: string | null;
  source: LinkSource;
  confidence: number;
  /** 1 a person confirmed it, 0 inferred, -1 rejected (never listed). */
  confirmed: number;
  linked: boolean;
  suggestion: boolean;
  last: Record<string, LastResult>;
}

export interface Depth {
  score: number;
  scenarios: number;
  criteria: number;
  edge_kinds: string[];
  happy_only: boolean;
  accounts: string[];
  examples: number;
  /** With the app map: the area's screens, and how many of them a scenario covers. */
  screens?: number;
  screens_covered?: number;
}

/** The area as the app map knows it (null before the project's map is built). */
export interface AreaMap {
  screens: number;
  covered: number;
  /** The screens no scenario covers yet (the busiest first, at most 8). */
  uncovered: string[];
}

export interface CoverageArea {
  key: string;
  name: string;
  summary: string | null;
  entry: string | null;
  paths: string[];
  source: string;
  state: CoverageState;
  /** The state on each platform, and `all`. */
  states: Record<PlatformKey, CoverageState>;
  depth: Depth;
  depths: Record<PlatformKey, Depth>;
  seen: boolean;
  visits: number;
  recent: boolean;
  explored: { at: string | null; screens: string[] };
  last: Record<string, LastResult>;
  last_result_at: string | null;
  scenarios: AreaScenario[];
  linked: number;
  drafts: number;
  suggestions: number;
  importance: number;
  risk: number;
  rank: number;
  map?: AreaMap | null;
}

export interface PlatformRollup {
  /** Areas with validated scenarios that apply to this platform (covered on paper). */
  covered: number;
  total: number;
  failing: number;
  passing: number;
  /** Of `covered`, the areas with a result on this platform (a scenario ran there). */
  ran: number;
  share: number;
}

export interface Coverage {
  project_id: string;
  computed_at: string;
  headline: string;
  platforms: string[];
  weakest: string | null;
  /**
   * Areas per state, as the map's legend counts them (`covered` is the Covered depth), and
   * `tested`, every area with a scenario (Strong + Covered + Thin + Failing): the headline's "of".
   */
  totals: Record<CoverageState, number> & { areas: number; tested: number; seen: number; scenarios: number; suggestions: number };
  rollup: Record<string, PlatformRollup>;
  areas: CoverageArea[];
  unmapped_screens: { label: string; visits: number }[];
  edge_labels: Record<string, string>;
}

export const PLATFORM_LABEL: Record<string, string> = { all: "All", web: "Web", ios: "iOS", android: "Android", desktop: "Desktop" };

export const STATE_LABEL: Record<CoverageState, string> = {
  untested: "Untested",
  thin: "Thin",
  covered: "Covered",
  strong: "Strong",
  failing: "Covered but failing",
};

export const SOURCE_LABEL: Record<LinkSource, string> = {
  manual: "Linked by hand",
  draft: "Drafted for this area",
  migration: "Migrated test",
  run_trace: "Runs visit it",
  text: "Name match",
};
