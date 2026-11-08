/**
 * The "Prompt to fix" of an issue is never empty.
 *
 * The agent writes a fix prompt for every finding (`findings.fix_prompt`, `verdicts/report_render.py`),
 * and since the issue's occurrences carry it. Older occurrences, and failures no finding
 * describes (a criterion that failed on its own), have none: for those this composes one,
 * deterministically, from what the issue already knows. Pure, so the detail route and the
 * panel agree and it is cheap to test.
 */

export interface FixPromptInput {
  title: string;
  expected?: string | null;
  actual?: string | null;
  /** The step range of the run that reproduces it (`findings.repro_*_step`). */
  reproFrom?: number | null;
  reproTo?: number | null;
  runId?: string | null;
  scenarioName?: string | null;
  criterionText?: string | null;
  feature?: string | null;
  screen?: string | null;
  platform?: string | null;
  /** `"check"`: only a drafted Check line failed; the fix is in the scenario. */
  kind?: "check" | null;
  /** Triage could not reproduce it and called it an environment problem: nothing to fix in
   * the app. (A `test_issue` diagnosis already made the issue `kind: "check"`.) */
  environment?: boolean | null;
}

const PLATFORM_WORDS: Record<string, string> = { ios: "iOS app", android: "Android app", web: "web app", desktop: "desktop app" };

function clean(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+\n/g, "\n").trim();
}

/** A fix prompt built from the issue's own facts, in the shape the agent's prompts use. */
export function composeFixPrompt(input: FixPromptInput): string {
  const title = clean(input.title) || "A QA run reported a problem";
  const app = input.platform ? PLATFORM_WORDS[input.platform] ?? `${input.platform} app` : "app";
  if (input.environment && input.kind !== "check") {
    return [
      `Not an app bug: Embodent's triage re-ran "${title}" on the device, could not reproduce it, and found an environment problem (the device, its data or a service it needs), not a defect in the ${app}.`,
      input.actual ? `\nWhat the first run saw:\n${clean(input.actual)}` : "",
      "\nDo not change the app for this. Fix the test environment (reset the device's data, configure the service the scenario needs, or restart the device) and run the scenario again.",
    ].filter(Boolean).join("\n").trim();
  }
  if (input.kind === "check") {
    return [
      `A drafted check in the Embodent scenario "${clean(input.scenarioName) || "this scenario"}" fails although the ${app} behaves correctly: ${title}.`,
      input.criterionText ? `\nCriterion: ${clean(input.criterionText)}` : "",
      input.actual ? `\nWhat the run saw:\n${clean(input.actual)}` : "",
      "\nFix the check, not the app: match the element's real role and label in the captured screen (a web password input is a SecureTextField), and do not check transient states such as a \"Signing in…\" button.",
    ].filter(Boolean).join("\n").trim();
  }
  const where = [clean(input.feature) && `the ${clean(input.feature)} feature`, clean(input.screen) && `the ${clean(input.screen)} screen`]
    .filter(Boolean)
    .join(", on ");
  const lines: string[] = [`Fix this bug in the ${app}${where ? ` (${where})` : ""}: ${title}.`];
  if (input.scenarioName) lines.push("", `Found by the Embodent scenario "${clean(input.scenarioName)}".`);
  if (input.expected) lines.push("", `Expected: ${clean(input.expected)}`);
  if (input.actual) lines.push(`Actual: ${clean(input.actual)}`);
  if (!input.expected && input.criterionText) lines.push("", `It should satisfy: ${clean(input.criterionText)}`);
  if (input.reproFrom != null) {
    const span = input.reproTo != null && input.reproTo !== input.reproFrom ? `steps ${input.reproFrom} to ${input.reproTo}` : `step ${input.reproFrom}`;
    lines.push("", `To reproduce: replay ${span} of Embodent run ${input.runId ?? "(the latest run)"}.`);
  } else if (input.runId) {
    lines.push("", `Seen in Embodent run ${input.runId}.`);
  }
  lines.push(
    "",
    "Find the cause in the code, fix it with the smallest change that makes the expected behaviour true, and add or update a test that would have caught it.",
  );
  return lines.join("\n").trim();
}

/** The occurrence's own prompt when it has one, else a composed one. Never empty. A check problem
 * or an environment problem never shows the agent's "fix the app" prompt: the fix is not in
 * the app. */
export function fixPromptFor(stored: string | null | undefined, input: FixPromptInput): { text: string; source: "agent" | "composed" } {
  if (input.kind === "check" || input.environment) return { text: composeFixPrompt(input), source: "composed" };
  const own = clean(stored);
  return own ? { text: own, source: "agent" } : { text: composeFixPrompt(input), source: "composed" };
}

/**
 * The prompt as it goes into Claude Code (or Cursor): a short header naming where it came from,
 * so the coding agent knows it is a QA report and not a feature request.
 */
export function forCodingAgent(prompt: string, issueUrl?: string | null): string {
  const header = `Embodent QA issue${issueUrl ? ` (${issueUrl})` : ""}.`;
  return `${header}\n\n${prompt.trim()}`;
}
