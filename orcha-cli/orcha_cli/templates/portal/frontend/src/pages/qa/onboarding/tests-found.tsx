import { ScanLine } from "../map/kit/icons";
import { frameworkLabel, plural } from "./ui";
import type { FoundSheet } from "./contract";

/** What the repository's tests add up to. */
export interface TestSurvey {
  total: number;
  ui: number;
  frameworks: { framework: string; ui: number }[];
  truncated?: boolean;
}

const DEVICE_UI_FRAMEWORKS = ["xcuitest", "espresso", "maestro", "detox", "playwright", "cypress", "gherkin"];
export function deviceUiTests(survey: Pick<TestSurvey, "frameworks">): TestSurvey["frameworks"] {
  return survey.frameworks.filter((f) => f.ui > 0 && DEVICE_UI_FRAMEWORKS.includes(f.framework));
}
export function componentTests(survey: Pick<TestSurvey, "frameworks">): TestSurvey["frameworks"] {
  return survey.frameworks.filter((f) => f.ui > 0 && !DEVICE_UI_FRAMEWORKS.includes(f.framework));
}

export function surveyOf(found: FoundSheet): TestSurvey {
  const frameworks = found.tests.map((t) => ({ framework: t.framework as string, ui: t.count }));
  const ui = frameworks.reduce((n, f) => n + f.ui, 0);
  return { total: ui, ui, frameworks };
}

function truncatedNote(survey: TestSurvey): string | null {
  return survey.truncated ? "Stopped reading after a large number of files, so there may be more." : null;
}

/**
 * Connect: the tests the project folder already has, said in one quiet line. Nothing is brought
 * over here: the map's Bring it in step does that, once, after mapping.
 */
export function TestsFound({ found, reading }: { found: FoundSheet | null; reading: boolean }) {
  if (reading) {
    return (
      <div className="flex flex-col gap-1" role="status" data-onboarding-tests-reading>
        <p className="flex items-center gap-1.5 text-xs text-muted">
          <ScanLine className="size-3.5 animate-pulse" aria-hidden /> Looking for existing tests…
        </p>
        <span className="relative block h-px w-40 overflow-hidden bg-border" aria-hidden>
          <span className="block h-full w-1/3 animate-sweep bg-primary" />
        </span>
      </div>
    );
  }
  if (!found) return null;
  return <TestsNote survey={surveyOf(found)} />;
}

/**
 * "Found 19 UI tests (9 XCUITest, 10 Maestro). You can bring them in after mapping." UI tests
 * drive the app on a device or in a browser, as the Map step counts them; tests that render a
 * screen without one (Jest) are named apart, so the two never disagree (#454).
 */
export function testsNoteText(survey: TestSurvey): string {
  if (!survey.ui) return `Found ${plural(survey.total, "test")}, none with screens to check. They stay as code.`;
  const device = deviceUiTests(survey);
  const component = componentTests(survey);
  const deviceN = device.reduce((n, f) => n + f.ui, 0);
  const componentN = component.reduce((n, f) => n + f.ui, 0);
  const by = (fws: TestSurvey["frameworks"]) => fws.map((f) => `${f.ui} ${frameworkLabel(f.framework)}`).join(", ");
  const parts: string[] = [];
  if (deviceN) parts.push(`Found ${plural(deviceN, "UI test")} (${by(device)}). You can bring them in after mapping.`);
  if (componentN) {
    const what = `${plural(componentN, `${component.map((f) => frameworkLabel(f.framework)).join(" and ")} test`)} that ${componentN === 1 ? "renders" : "render"} screens without a device`;
    parts.push(deviceN ? `Also ${what}: they keep running where they are.` : `No UI tests that drive the app; ${what}. They keep running where they are.`);
  }
  return parts.join(" ");
}

/** The survey's result as one quiet line: bringing tests in is the Bring it in step's job. */
function TestsNote({ survey }: { survey: TestSurvey }) {
  const note = truncatedNote(survey);
  return (
    <p className="flex items-start gap-1.5 text-xs text-muted" role="status" data-onboarding-tests-found>
      <ScanLine className="mt-px size-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
      <span>
        <span data-onboarding-tests-headline>{testsNoteText(survey)}</span>
        {note ? (
          <span className="ml-1" data-onboarding-tests-truncated>
            {note}
          </span>
        ) : null}
      </span>
    </p>
  );
}
