/**
 * The coverage picture in plain counts ("38 screens · 14 covered by your XCUITests · 24 not
 * covered · checkout and sign-in untested"), the framework badges, what Bring it in brings and
 * the first-test fallback. Counted from the screens themselves, so the words always match the
 * colours on the map.
 */
import { frameworkName, type FirstTest, type MapScreen, type OnboardingMap } from "./contract";

export interface CoverageCounts {
  screens: number;
  yours: number;
  qa: number;
  both: number;
  none: number;
}

export function coverageCounts(screens: readonly MapScreen[]): CoverageCounts {
  const c: CoverageCounts = { screens: screens.length, yours: 0, qa: 0, both: 0, none: 0 };
  for (const s of screens) {
    if (s.coverage === "your_tests") c.yours += 1;
    else if (s.coverage === "qa") c.qa += 1;
    else if (s.coverage === "both") c.both += 1;
    else c.none += 1;
  }
  return c;
}

const PLURAL: Record<string, string> = {
  xcuitest: "XCUITests",
  espresso: "Espresso tests",
  maestro: "Maestro flows",
  detox: "Detox tests",
  playwright: "Playwright tests",
  cypress: "Cypress tests",
  gherkin: "Gherkin scenarios",
};

/** "your XCUITests", "your XCUITest and Espresso tests", "your tests". */
export function yourTestsPhrase(frameworks: readonly string[]): string {
  const fws = [...new Set(frameworks)];
  if (fws.length === 1) return `your ${PLURAL[fws[0]] ?? `${frameworkName(fws[0])} tests`}`;
  if (fws.length === 2) return `your ${frameworkName(fws[0])} and ${frameworkName(fws[1])} tests`;
  return "your tests";
}

/** "checkout", "checkout and sign-in", "checkout, sign-in and wallet". */
export function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The frameworks whose tests cover at least one screen, in order of how many they cover. */
export function coveringFrameworks(screens: readonly MapScreen[]): { framework: string; screens: number; tests: number }[] {
  const by = new Map<string, { screens: Set<string>; tests: Set<string> }>();
  for (const s of screens) {
    for (const t of s.tests) {
      const e = by.get(t.framework) ?? { screens: new Set(), tests: new Set() };
      e.screens.add(s.id);
      e.tests.add(`${t.path}#${t.name}`);
      by.set(t.framework, e);
    }
  }
  return [...by.entries()]
    .map(([framework, e]) => ({ framework, screens: e.screens.size, tests: e.tests.size }))
    .sort((a, b) => b.screens - a.screens || a.framework.localeCompare(b.framework));
}

/** The sentence under the coverage picture, as separate parts (the UI joins them with " · "). */
export function coverageSentence(map: Pick<OnboardingMap, "screens" | "summary">): string[] {
  const c = coverageCounts(map.screens);
  const parts = [`${c.screens} ${c.screens === 1 ? "screen" : "screens"}`];
  const byTests = c.yours + c.both;
  if (byTests > 0) parts.push(`${byTests} covered by ${yourTestsPhrase(coveringFrameworks(map.screens).map((f) => f.framework))}`);
  if (c.qa + c.both > 0) parts.push(`${c.qa + c.both} covered by Embodent`);
  parts.push(c.none === 0 ? "every screen covered" : `${c.none} not covered`);
  // The server names screens by id; a person reads their names.
  const critical = map.summary.untested_critical.filter(Boolean).map((id) => map.screens.find((s) => s.id === id)?.name ?? id);
  if (critical.length > 0) parts.push(`${joinAnd(critical)} untested`);
  return parts;
}

/** Which platform a gap is on, for a map of more than one: the same screen name exists on each. */
export function gapPlatform(id: string, ids: readonly string[]): string | null {
  const of = (x: string) => /^screen:([a-z]+):/.exec(x)?.[1] ?? null;
  return new Set(ids.map(of)).size > 1 ? of(id) : null;
}

/** Every distinct existing test (path and name) the map matched to a screen. */
export function matchedTests(screens: readonly MapScreen[]): number {
  const seen = new Set<string>();
  for (const s of screens) for (const t of s.tests) seen.add(`${t.path}#${t.name}`);
  return seen.size;
}

/** What "Bring all N tests in" brings, narrowed by the per-framework and per-area choice. */
export function bringInCount(map: Pick<OnboardingMap, "bring_in">, frameworks: ReadonlySet<string> | null): number {
  return map.bring_in.migrate.filter((m) => !frameworks || frameworks.has(m.framework)).reduce((n, m) => n + m.count, 0);
}

/** The area of a screen: the first segment of its route, else of its first file's folder. */
export function areaOf(screen: Pick<MapScreen, "route" | "files" | "name">): string {
  if (screen.route !== undefined) return screen.route.split("/").filter(Boolean)[0] ?? "home";
  const file = screen.files[0];
  if (file) {
    const parts = file.split("/");
    if (parts.length >= 2) return parts[parts.length - 2];
  }
  return "other";
}

/** What a first run of the smoke set checks at most (`SMOKE_SIZE` on the server). */
const SMOKE_SIZE = 10;

/** The scenarios the smoke set holds: the riskiest of those brought in or drafted. */
export function smokeSuiteCount(screens: readonly MapScreen[]): number {
  const ids = new Set<string>();
  for (const s of screens) for (const sc of s.scenarios) ids.add(sc.id);
  return Math.min(ids.size, SMOKE_SIZE);
}

/** The smoke suite's size, cost and time: the server's figures, else counted from the map
 * with the first test's estimate per scenario. */
export function smokeSuite(map: Pick<OnboardingMap, "screens" | "smoke" | "first_test">): { count: number; estimate_usd: number; estimate_seconds: number } {
  if (map.smoke) return map.smoke;
  const count = smokeSuiteCount(map.screens);
  const one = map.first_test;
  return { count, estimate_usd: count * (one?.estimate_usd ?? 0), estimate_seconds: count * (one?.estimate_seconds ?? 60) };
}

/**
 * The first test when the server has not picked one (yet): the riskiest screen a brought-in
 * test covers, else the riskiest drafted gap. The server's `first_test` always wins.
 */
export function fallbackFirstTest(map: Pick<OnboardingMap, "screens" | "first_test">): FirstTest | null {
  if (map.first_test) return map.first_test;
  const ranked = [...map.screens].sort((a, b) => b.risk.score - a.risk.score);
  for (const status of ["imported", "draft"]) {
    for (const s of ranked) {
      const sc = s.scenarios.find((x) => x.status === status);
      if (sc) {
        return {
          scenario_id: sc.id,
          name: sc.name,
          screen_id: s.id,
          platform: s.platform,
          estimate_seconds: 60,
          estimate_usd: 0,
          why: status === "imported" ? `It covers ${s.name}, the riskiest screen your tests already reach.` : `It checks ${s.name}, the riskiest screen nothing tested before.`,
        };
      }
    }
  }
  return null;
}
