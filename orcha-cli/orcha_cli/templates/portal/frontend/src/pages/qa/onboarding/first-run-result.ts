import { duration, type FirstRunOutcome, type ScreenFirstRun } from "./contract";

/**
 * What the first run's result card says (#486): what really happened, never a guess. Hearth's
 * card said "The run could not finish. Something on Settings did not match. The finding is on
 * the run." when the starting state Embodent made first had failed on another screen and the test
 * then could not be checked; there was no finding and Settings was only the picked test's screen.
 *
 * - passed: "Passed in 42 s".
 * - failed: the test's finding and the screen it was on.
 * - setup_failed: "Embodent could not set up the starting state" with that run's finding (or
 *   reason) and its screen; the test's own result under it; the link opens the setup run.
 * - unchecked: "The test could not be checked" with the reason.
 * - error: "The run could not finish", only when the run itself broke.
 */

export type ResultTone = "pass" | "fail" | "warn";
/** The next steps the card offers, the first one primary. */
export type ResultNext = "open_map" | "open_run" | "pick" | "retry" | "suite" | "ask";

export interface ResultWords {
  outcome: FirstRunOutcome;
  tone: ResultTone;
  title: string;
  body: string;
  /** A quieter line under the body: what the test did after a setup that failed. */
  aside?: string;
  /** The run "Open the run" opens: the setup run when the setup failed. */
  runId?: string;
  runLabel: string;
  next: ResultNext[];
  /** What "Ask Embodent" asks. */
  question: string;
  /** The live region's line. */
  said: string;
}

/** The outcome, also for a run that ended before the backend said it (`verdict` only). */
export function outcomeOf(run: ScreenFirstRun): FirstRunOutcome {
  if (run.outcome) return run.outcome;
  return run.verdict === "pass" ? "passed" : run.verdict === "fail" ? "failed" : "error";
}

/** "the household isn't seeded" -> "The household isn't seeded." */
function sentence(text: string): string {
  const t = text.trim().replace(/[\s.]+$/, "");
  return t ? `${t[0].toUpperCase()}${t.slice(1)}.` : "";
}

function on(text: string, screen?: string): string {
  const t = text.trim().replace(/[\s.]+$/, "");
  return screen ? `${t} (on ${screen}).` : `${t}.`;
}

/** The card's words for an ended first run. `ranOn` names the screen it landed on, for a pass. */
/** A run's reason without the test code an agent quoted from an imported test (#486). */
function noCode(text: string): string {
  return text.replace(/\s*\(\s*\\\([^()]*\)\s*\)/g, "").replace(/\\\([^()]*\)/g, "…");
}

const NOT_APP = /^The setup did not get there, but not because of the app:\s*/;

/** Why the setup's failure was not the app's (#486): the backend's `not_app`, or a result stored
 * before it that kept the state's own words in `reason`. */
function notAppOf(setup: ScreenFirstRun["setup"]): string | undefined {
  const said = setup?.not_app ?? (setup?.reason && NOT_APP.test(setup.reason) ? setup.reason.replace(NOT_APP, "") : undefined);
  const out = said?.replace(/\.?\s*Embodent makes it again on the next run that needs it\.?\s*$/, "").replace(/[\s.…]+$/, "").trim();
  return out || undefined;
}

export function resultWords(run: ScreenFirstRun, ranOn: string | null): ResultWords {
  const outcome = outcomeOf(run);
  const took = run.duration_s ? duration(run.duration_s) : null;
  const runId = run.run_id || undefined;
  switch (outcome) {
    case "passed":
      return {
        outcome,
        tone: "pass",
        title: `Passed${took ? ` in ${took}` : ""}`,
        body: ranOn ? `Your first test checked ${ranOn} on the device. The result is on the map.` : "Your first test passed on the device. The result is on the map.",
        runId,
        runLabel: "Open the run",
        next: ["open_map", "suite", "ask"],
        question: "What should I test next?",
        said: `Your first test passed${run.duration_s ? ` in ${Math.round(run.duration_s)} seconds` : ""}.`,
      };
    case "failed": {
      const body = run.finding ? on(run.finding, run.screen) : "It did not pass. What went wrong is on the run.";
      return {
        outcome,
        tone: "fail",
        title: `Did not pass${took ? ` after ${took}` : ""}`,
        body,
        runId,
        runLabel: "Open the run",
        next: ["open_run", "pick", "open_map", "ask"],
        question: "Why did my first test fail?",
        said: `Your first test did not pass. ${body}`,
      };
    }
    case "setup_failed": {
      const setup = run.setup;
      const notApp = notAppOf(setup);
      if (notApp) {
        // The setup stopped on a finding Embodent found does not hold (#486): not the app; the
        // next run sets the state up again, whichever test it runs.
        const body = `Not because of your app: ${notApp}. Embodent sets it up again on the next run.`;
        return {
          outcome,
          tone: "warn",
          title: "Embodent could not set up the starting state",
          body,
          runId: setup?.run_id || runId,
          runLabel: setup?.run_id ? "Open the setup run" : "Open the run",
          next: ["pick", "retry", "open_run", "ask"],
          question: "Why could Embodent not set up the starting state?",
          said: `Embodent could not set up the starting state. ${body}`,
        };
      }
      const what = setup?.finding ?? setup?.reason;
      const body = what ? on(what, setup?.screen ?? run.screen) : "Its setup run did not reach the screen your tests start from.";
      const aside = run.reason
        ? `So the test could not be checked: ${noCode(run.reason).trim().replace(/[\s.]+$/, "")}.`
        : run.finding
          ? `The test ran without it and found: ${run.finding.trim().replace(/[\s.]+$/, "")}.`
          : "The test ran without it, so its result says little about your app.";
      return {
        outcome,
        tone: "warn",
        title: "Embodent could not set up the starting state",
        body,
        aside,
        runId: setup?.run_id || runId,
        runLabel: setup?.run_id ? "Open the setup run" : "Open the run",
        next: ["open_run", "pick", "open_map", "ask"],
        question: "Why could Embodent not set up the starting state?",
        said: `Embodent could not set up the starting state: ${body}`,
      };
    }
    case "unchecked": {
      const body = run.reason ? sentence(noCode(run.reason)) : "The run could not check it as written. The details are on the run.";
      return {
        outcome,
        tone: "warn",
        title: "The test could not be checked",
        body,
        runId,
        runLabel: "Open the run",
        next: ["pick", "open_run", "open_map", "ask"],
        question: "Why could my first test not be checked?",
        said: `The test could not be checked. ${body}`,
      };
    }
    default: {
      // A run that ended before #486 kept the request's error as its finding.
      const reason = run.reason ?? (run.outcome ? undefined : run.finding);
      const body = reason ? sentence(reason) : "It stopped before it gave a verdict. Its log is on the run.";
      return {
        outcome: "error",
        tone: "fail",
        title: "The run could not finish",
        body,
        runId,
        runLabel: "Open the run",
        next: [...(runId ? (["open_run"] as const) : []), "retry", "pick", "open_map"],
        question: "Why could my first run not finish?",
        said: `The run could not finish. ${body}`,
      };
    }
  }
}
