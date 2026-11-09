import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { parseOnboardingMap, type ScreenFirstRun } from "./contract";
import { fixture } from "./fixtures";
import { phaseAnnouncement } from "./flow";
import { outcomeOf, resultWords } from "./first-run-result";


const { ResultCard } = await import("./first-run-map");

// Hearth's first run (request cf47ebf1): the starting state failed, then the test came back unprocessable.
const hearth: ScreenFirstRun = {
  scenario_id: "dc7a4069-7779-45fe-80b5-5ad6fb72902e",
  run_id: "867a712d-be8f-46ba-9292-d2bdc5f17a81",
  verdict: "error",
  duration_s: 29.4,
  outcome: "setup_failed",
  reason: "criteria don't fit: they assume a pre-existing household (parent tile, PIN, tabs) that isn't seeded",
  screen_id: "screen:create-household",
  screen: "Create household",
  setup: {
    request_id: "5f4c92e5-aeaa-46cd-8dc6-a1135373ea24",
    run_id: "127919e9-16cc-47f0-a29e-66fa4dc2100c",
    finding: "Add a person button does nothing in onboarding",
    reason: 'Hard blocker: "Add a person" does nothing, so onboarding cannot be completed',
    screen_id: "screen:create-household",
    screen: "Create household",
  },
};

const noop = () => undefined;
function card(run: ScreenFirstRun, opts: { screen?: string | null; pick?: boolean; smoke?: number } = {}) {
  return renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(ResultCard, {
      run,
      screen: opts.screen === undefined ? "Create household" : opts.screen,
      billing: { run: "Claude Code", draft: "Claude Code" },
      smoke: { count: opts.smoke ?? 1, estimate_usd: 0.6, estimate_seconds: 240 },
      busy: null,
      onSuite: noop,
      onOpenMap: noop,
      onPickAnother: opts.pick === false ? null : noop,
      onRetry: noop,
      leaving: false,
    })),
  );
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, " ");

describe("resultWords", () => {
  it("names the starting state that failed, its finding and its screen, and opens the setup run", () => {
    const w = resultWords(hearth, "Settings");
    expect(w.tone).toBe("warn");
    expect(w.title).toBe("Embodent could not set up the starting state");
    expect(w.body).toBe("Add a person button does nothing in onboarding (on Create household).");
    expect(w.aside).toContain("So the test could not be checked: criteria don't fit");
    expect(w.runId).toBe("127919e9-16cc-47f0-a29e-66fa4dc2100c");
    expect(w.runLabel).toBe("Open the setup run");
    expect(w.next.slice(0, 2)).toEqual(["open_run", "pick"]);
    expect(`${w.title} ${w.body}`).not.toContain("Settings");
  });

  it("says a setup that stopped on a finding that does not hold was not the app, and offers another test first", () => {
    const notApp = 'the tap on "Add a person" opened a sheet the screen tree did not show';
    const w = resultWords({ ...hearth, setup: { ...hearth.setup!, finding: undefined, not_app: notApp } }, "Settings");
    expect(w.title).toBe("Embodent could not set up the starting state");
    expect(w.body).toBe(`Not because of your app: ${notApp}. Embodent sets it up again on the next run.`);
    expect(w.body).not.toContain("does nothing");
    expect(w.aside).toBeUndefined();
    expect(w.next).toEqual(["pick", "retry", "open_run", "ask"]);
    expect(w.runId).toBe("127919e9-16cc-47f0-a29e-66fa4dc2100c");
  });

  it("reads a result stored before not_app existed the same way, and quotes no test code", () => {
    const stored = 'The setup did not get there, but not because of the app: "Add a person button does nothing in onboarding" is not an app bug: the screen changed after the tap on "Add a person" (frames 19 and 21 differ), but the tree Embodent read did not…';
    const w = resultWords({ ...hearth, setup: { ...hearth.setup!, reason: stored } }, "Settings");
    expect(w.body.startsWith('Not because of your app: "Add a person button does nothing in onboarding" is not an app bug')).toBe(true);
    expect(w.body.endsWith("but the tree Embodent read did not. Embodent sets it up again on the next run.")).toBe(true);
    expect(w.next[0]).toBe("pick");
    const unchecked = resultWords({ ...hearth, outcome: "unchecked", setup: undefined, reason: "criteria 2, 3 are unrendered test-code text (\\(app.debugDescription)), not outcomes" }, null);
    expect(unchecked.body).not.toContain("\\(");
  });

  it("says a test that could not be checked could not be checked, with the reason", () => {
    const w = resultWords({ ...hearth, outcome: "unchecked", setup: undefined, screen: undefined, screen_id: undefined }, "Settings");
    expect(w.title).toBe("The test could not be checked");
    expect(w.body).toBe("Criteria don't fit: they assume a pre-existing household (parent tile, PIN, tabs) that isn't seeded.");
    expect(w.next[0]).toBe("pick");
    expect(w.body).not.toMatch(/did not match|could not finish/);
  });

  it("gives a failed test its finding and the screen it was on", () => {
    const w = resultWords({ scenario_id: "s", run_id: "r", verdict: "fail", duration_s: 57, outcome: "failed", finding: "The chore is not listed after Save", screen: "Chores" }, "Settings");
    expect(w.tone).toBe("fail");
    expect(w.title).toBe("Did not pass after 57 s");
    expect(w.body).toBe("The chore is not listed after Save (on Chores).");
  });

  it("never says something on a screen did not match when there is no finding", () => {
    for (const run of [
      { scenario_id: "s", run_id: "r", verdict: "fail", outcome: "failed" },
      { scenario_id: "s", run_id: "r", verdict: "fail" },
      { scenario_id: "s", run_id: "r", verdict: "error" },
      { scenario_id: "s", run_id: "r", verdict: "error", outcome: "unchecked" },
    ] as ScreenFirstRun[]) {
      expect(resultWords(run, "Settings").body).not.toMatch(/Settings|did not match/);
    }
  });

  it("keeps 'could not finish' for a run that broke, with its reason and Try again", () => {
    const w = resultWords({ scenario_id: "s", run_id: "", verdict: "error", outcome: "error", reason: "The simulator did not boot in 120 s" }, null);
    expect(w.title).toBe("The run could not finish");
    expect(w.body).toBe("The simulator did not boot in 120 s.");
    expect(w.next).toEqual(["retry", "pick", "open_map"]);
    // A run that ended before #486 kept the request's error as its finding.
    expect(resultWords({ scenario_id: "s", run_id: "r", verdict: "error", finding: "No device answered" }, null).body).toBe("No device answered.");
  });

  it("reads a run that ended before the backend named the outcome", () => {
    expect(outcomeOf({ scenario_id: "s", run_id: "r", verdict: "pass" })).toBe("passed");
    expect(outcomeOf({ scenario_id: "s", run_id: "r", verdict: "fail" })).toBe("failed");
    expect(outcomeOf({ scenario_id: "s", run_id: "r", verdict: "error" })).toBe("error");
    expect(resultWords({ scenario_id: "s", run_id: "r", verdict: "pass", duration_s: 42 }, "Checkout").title).toBe("Passed in 42 s");
  });

  it("writes no em dashes and never says AI", () => {
    const runs: ScreenFirstRun[] = [hearth, { ...hearth, outcome: "unchecked" }, { ...hearth, outcome: "failed", finding: "x" }, { ...hearth, outcome: "error" }, { ...hearth, verdict: "pass", outcome: "passed" }];
    for (const r of runs) {
      const w = resultWords(r, "Settings");
      expect(`${w.title} ${w.body} ${w.aside ?? ""} ${w.said}`).not.toMatch(/—|\bAI\b/);
    }
  });
});

describe("ResultCard", () => {
  it("renders the starting state's failure with a link to its run and Pick another test", () => {
    const html = card(hearth);
    const t = text(html);
    expect(html).toContain('data-onboarding-outcome="setup_failed"');
    expect(t).toContain("Embodent could not set up the starting state");
    expect(t).toContain("Add a person button does nothing in onboarding (on Create household).");
    expect(html).toContain('href="/qa?view=sessions&amp;session=127919e9-16cc-47f0-a29e-66fa4dc2100c"');
    expect(t).toContain("Open the setup run");
    expect(html).toContain("data-onboarding-pick-another-after");
    expect(t).not.toMatch(/could not finish|did not match/);
  });

  it("offers Pick another test first for a test that could not be checked, and hides it when there is none", () => {
    const run = { ...hearth, outcome: "unchecked" as const, setup: undefined };
    const html = card(run);
    expect(text(html)).toContain("The test could not be checked");
    expect(html.indexOf("data-onboarding-pick-another-after")).toBeLessThan(html.indexOf("data-onboarding-open-run"));
    expect(card(run, { pick: false })).not.toContain("data-onboarding-pick-another-after");
  });

  it("keeps the way out and the suite for a pass", () => {
    const html = card({ scenario_id: "s", run_id: "r", verdict: "pass", duration_s: 42, outcome: "passed" }, { screen: "Checkout", smoke: 12 });
    expect(text(html)).toContain("Passed in 42 s");
    expect(text(html)).toContain("Your first test checked Checkout on the device.");
    expect(html).toContain("data-onboarding-open-map");
    expect(html).toContain("data-onboarding-next-suite");
  });

  it("offers Try again for a run that broke", () => {
    const html = card({ scenario_id: "s", run_id: "", verdict: "error", outcome: "error", reason: "No device answered" });
    expect(text(html)).toContain("The run could not finish");
    expect(html).toContain("data-onboarding-retry");
    expect(html).not.toContain("data-onboarding-open-run");
  });
});

describe("the contract and the live region", () => {
  it("parses what happened, the screen and the setup run", () => {
    const m = fixture("small");
    const raw = JSON.parse(JSON.stringify(m));
    raw.phase = "done";
    raw.screens[0].first_run = { ...hearth, outcome: "setup_failed" };
    const parsed = parseOnboardingMap(raw)!;
    expect(parsed.screens[0].first_run).toMatchObject({ outcome: "setup_failed", screen: "Create household", setup: { run_id: hearth.setup!.run_id } });
    raw.screens[0].first_run = { ...hearth, outcome: "bogus" };
    expect(parseOnboardingMap(raw)!.screens[0].first_run!.outcome).toBeUndefined();
  });

  it("announces what really happened", () => {
    const m = fixture("small");
    m.phase = "done";
    m.screens = m.screens.map((s, i) => (i === 0 ? { ...s, first_run: hearth } : { ...s, first_run: undefined }));
    expect(phaseAnnouncement(m).text).toBe("Embodent could not set up the starting state: Add a person button does nothing in onboarding (on Create household).");
  });
});
