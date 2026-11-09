/**
 * Proof-of-work evidence pack (GET /api/tasks/{tid}/evidence): the one-line summary is
 * built only from real parts, the details show the DoD checklist with evidence + the
 * agent's labelled claim, tests, risk flags and links.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EvidencePack } from "./EvidencePack";
import { EvidenceSummaryLine, summaryParts, summaryText } from "./EvidenceSummaryLine";
import { evidenceCss } from "./evidenceCss";
import type { EvidencePack as Pack, EvidenceSummary } from "./evidenceTypes";

const SUMMARY: EvidenceSummary = {
  dod: { total: 4, proven: 3, not_proven: 0, needs_human: 1 },
  tests: { status: "passed", passed: 42, failed: 0, skipped: 0, errors: 0, suites: 2 },
  risk_flags: 1,
  line: "3/4 DoD items evidenced · 42 tests passed · 1 risk flag",
};

function pack(over: Partial<Pack> = {}): Pack {
  return {
    version: 1, task_id: "t1", task_status: "needs_verification", basis: "b", built_at: new Date().toISOString(),
    round_started_at: null,
    runs: [{ run_id: "r1", agent_alias: "Pixel", status: "exited", exit_code: 0, lane: "work", started_at: null, ended_at: null }],
    tests: {
      status: "passed", passed: 42, failed: 0, skipped: 0, errors: 0, suites: 2, invocations: 3, earlier: 1,
      latest: [
        { run_id: "r1", framework: "npm test", command: "npm test", exit_code: 0, outcome: "passed",
          counts: { passed: 12, failed: 0, skipped: 0, errors: 0, total: 12, unit: "tests", source: "" } },
        { run_id: "r1", framework: "pytest", command: "pytest -q", exit_code: 0, outcome: "passed",
          counts: { passed: 30, failed: 0, skipped: 0, errors: 0, total: 30, unit: "tests", source: "" } },
      ],
    },
    changes: {
      files: 3, additions: 4, deletions: 0, categories: { ui: 1, code: 1, test: 1 },
      summary: "Changed 3 files (+4 −0): 1 UI file, 1 source file, 1 test file.", ui_touching: true,
      flags: [], list: [], truncated_list: false, unavailable_runs: [],
    },
    flags: [{ kind: "auth", label: "Auth / permissions", detail: "1 file(s) in authentication code.", severity: "warn", files: ["api/auth/session.py"], count: 1 }],
    branch: "orcha/login-error", pr_urls: ["https://github.com/acme/shop/pull/42"], preview_urls: [],
    links: [
      { kind: "captured_diff", label: "Captured diff · run r1", href: "/agents?agent=Pixel&changes=r1", run_id: "r1" },
      { kind: "runs", label: "Runs (1)", href: "/tasks?task=t1&tab=runs" },
      { kind: "pr", label: "PR #42", href: "https://github.com/acme/shop/pull/42" },
    ],
    claim: { text: "All tests pass.", truncated: false },
    dod_text: "",
    dod: {
      items: [
        { index: 0, text: "All tests pass", status: "proven", basis: "tests", evidence: "npm test: 12 passed; pytest: 30 passed", claim: "All tests pass." },
        { index: 1, text: "The error text is red", status: "needs_human", basis: "none", evidence: "Related changes: web/src/pages/Login.tsx" },
        { index: 2, text: "`api/missing.py` is removed", status: "not_proven", basis: "changes", evidence: "Not among the changed files: api/missing.py" },
      ],
      total: 3, proven: 1, not_proven: 1, needs_human: 1,
    },
    summary: SUMMARY,
    ...over,
  };
}

interface Call { url: string; method: string; body: unknown }
let calls: Call[] = [];
let current: Pack;
let evidenceStatus = 200;

function install() {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const res = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
    if (url === "/api/tasks/t1/evidence") return evidenceStatus === 200 ? res(current) : res({ detail: "boom" }, evidenceStatus);
    if (url === "/api/tasks/t1/evidence/rebuild") return res(current);
    if (url === "/api/tasks/t1/qa") return res({ final_decision: decision });
    return res({});
  }));
}

let decision: unknown = null;

function mount(props: Partial<Parameters<typeof EvidencePack>[0]> = {}) {
  return render(
    <MemoryRouter>
      <EvidencePack taskId="t1" {...props} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  decision = null;
  current = pack();
  evidenceStatus = 200;
  install();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("summaryParts", () => {
  it("builds only the real parts", () => {
    expect(summaryParts(SUMMARY).map((p) => p.text)).toEqual(["3/4 DoD items evidenced", "42 tests passed", "1 risk flag"]);
    expect(summaryParts({ ...SUMMARY, tests: { ...SUMMARY.tests, status: "none", passed: 0 }, risk_flags: 0 }).map((p) => p.text))
      .toEqual(["3/4 DoD items evidenced", "no tests ran"]);
    // General (non-code) projects: no test-runner talk when none ran
    expect(summaryParts({ ...SUMMARY, tests: { ...SUMMARY.tests, status: "none", passed: 0 }, risk_flags: 0 }, { general: true }).map((p) => p.text))
      .toEqual(["3/4 DoD items evidenced"]);
    expect(summaryParts(SUMMARY, { general: true }).map((p) => p.text)).toContain("42 tests passed");
    expect(summaryParts({ ...SUMMARY, tests: { ...SUMMARY.tests, status: "failed", failed: 2, errors: 1 } })[1])
      .toMatchObject({ text: "3 tests failing", tone: "bad" });
    expect(summaryParts({ ...SUMMARY, tests: { ...SUMMARY.tests, status: "exit_ok", passed: 0 } })[1].text).toBe("tests exited 0");
    expect(summaryParts({ ...SUMMARY, dod: { total: 2, proven: 1, not_proven: 1, needs_human: 0 } })[0].tone).toBe("bad");
    expect(summaryParts({ ...SUMMARY, dod: { total: 1, proven: 0, not_proven: 0, needs_human: 1 } })[0].icon).toBeUndefined();
    expect(summaryParts({ ...SUMMARY, dod: { total: 2, proven: 2, not_proven: 0, needs_human: 0 } })[0]).toMatchObject({ icon: "check", tone: "ok" });
    expect(summaryParts(null)).toEqual([]);
    expect(summaryParts(SUMMARY, { short: true })[0].text).toBe("3/4 DoD");
  });
  it("plain-text short form for Needs-you rows", () => {
    expect(summaryText(SUMMARY)).toBe("3/4 DoD · 42 tests passed · 1 risk");
    expect(summaryText(null)).toBe("");
  });
  it("renders nothing without a summary (Needs-you row before the fetch lands)", () => {
    const { container } = render(<EvidenceSummaryLine summary={undefined} />);
    expect(container.textContent).toBe("");
  });
});

describe("EvidencePack", () => {
  it("shows the one-line summary, then the details on demand", async () => {
    mount();
    const line = await screen.findByTestId("evidence-summary");
    // collapsed (inspector) form is the short one
    expect(line.textContent).toBe("3/4 DoD42 tests passed1 risk");
    expect(screen.queryByTestId("evidence-details")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Details/ }));
    const det = screen.getByTestId("evidence-details");
    const dod = within(det).getByRole("list", { name: "Definition of done checklist" });
    const items = within(dod).getAllByRole("listitem");
    expect(items.map((i) => i.getAttribute("data-status"))).toEqual(["proven", "needs_human", "not_proven"]);
    expect(items[0].textContent).toContain("npm test: 12 passed; pytest: 30 passed");
    // the agent's words are labelled as a claim, not evidence
    expect(items[0].textContent).toContain("Agent says:");
    expect(items[2].textContent).toContain("Not among the changed files: api/missing.py");
    const tests = within(det).getByRole("list", { name: "Test runs" });
    expect(tests.textContent).toContain("pytest -q");
    expect(det.textContent).toContain("1 earlier run of the same command superseded.");
    expect(det.textContent).toContain("Changed 3 files (+4 −0)");
    expect(within(det).getByLabelText(/Auth \/ permissions/)).toBeTruthy();
    expect(within(det).getByRole("link", { name: /Captured diff/ }).getAttribute("href")).toBe("/agents?agent=Pixel&changes=r1");
    expect(within(det).getByRole("link", { name: /PR #42/ }).getAttribute("href")).toBe("https://github.com/acme/shop/pull/42");
  });

  it("a line QA judged shows its screenshot and the way to the request; the pack lists the requests", async () => {
    current = pack({
      dod: {
        items: [{ index: 0, text: "Reset email arrives", status: "proven", basis: "qa", evidence: "QA passed this line on iOS", frame_ids: ["fr1"], qa_request_id: "r1" }, { index: 1, text: "Logs clean", status: "needs_human", basis: "none", evidence: null }],
        total: 2, proven: 1, not_proven: 0, needs_human: 1,
      },
      qa: [{ id: "r1", kind: "check", platform: "ios", round: 2, status: "passed", summary: "All lines passed." }],
    });
    mount({ defaultOpen: true });
    const list = await screen.findByRole("list", { name: "Definition of done checklist" });
    const proof = list.querySelector("[data-qa-proof='r1']") as HTMLElement;
    expect(within(proof).getByRole("button", { name: /Enlarge screenshot: Reset email arrives/ })).toBeInTheDocument();
    expect(within(proof).getByRole("link", { name: "Open the QA request" }).getAttribute("href")).toBe("/qa?view=requests&request=r1");
    expect(list.querySelectorAll("[data-qa-proof]")).toHaveLength(1);
    const qa = screen.getByRole("list", { name: "QA requests" });
    expect(within(qa).getByRole("link", { name: "Check scenarios on iOS" }).getAttribute("href")).toBe("/qa?view=requests&request=r1");
    expect(qa.textContent).toContain("All lines passed.");
  });

  it("shows each line's proof source, and a changed file as weaker than a verdict or a passing test", async () => {
    current = pack({
      dod: {
        items: [
          { index: 0, text: "Reset email arrives", status: "proven", basis: "qa", evidence: "Quality passed it" },
          { index: 1, text: "Unit tests pass", status: "proven", basis: "tests", evidence: "pytest: 30 passed" },
          { index: 2, text: "The route is added", status: "proven", basis: "changes", strong: false, evidence: "api/reset.py changed" },
          { index: 3, text: "The error text is red", status: "needs_human", basis: "none", evidence: null },
        ],
        total: 4, proven: 3, not_proven: 0, needs_human: 1,
      },
    });
    mount({ defaultOpen: true });
    const list = await screen.findByRole("list", { name: "Definition of done checklist" });
    const tags = [...list.querySelectorAll("[data-proof]")].map((t) => [t.textContent, t.getAttribute("data-strength")]);
    expect(tags).toEqual([["Quality", "strong"], ["Tests", "strong"], ["The file changed · weak proof", "weak"], ["Needs a person", "none"]]);
  });

  it("says in plain words which lines kept a task from finishing by itself", async () => {
    decision = { decision: "person", reasons: [{ code: "line_needs_human", text: "1 line: needs a person to look." }, { code: "risk_flags", text: "1 risk flag on this change: migration." }],
      lines: [{ index: 1, text: "The error text is red", why: "needs_human", why_text: "needs a person to look" }] };
    mount();
    const lines = await screen.findByRole("list", { name: "Lines not proven" });
    expect(lines.textContent).toContain("The error text is red");
    expect(lines.textContent).toContain("Needs a person to look.");
    expect(screen.getByRole("list", { name: "Other reasons" }).textContent).toBe("1 risk flag on this change: migration.");
  });

  it("stays quiet when the setting played no part, or the work finished", async () => {
    decision = { decision: "finished", reasons: [], lines: [] };
    mount();
    await screen.findByRole("button", { name: "Details" });
    expect(document.querySelector("[data-finish-why]")).toBeNull();
  });

  it("says why when the pack cannot be loaded, and retries", async () => {
    evidenceStatus = 500;
    mount();
    expect(await screen.findByText("Evidence unavailable — boom")).toBeTruthy();
    evidenceStatus = 200;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("evidence-summary")).toBeTruthy();
  });

  it("no tests is said plainly", async () => {
    current = pack({ tests: { ...pack().tests, status: "none", latest: [], earlier: 0 } });
    mount({ defaultOpen: true });
    expect(await screen.findByText("No test command found in this task's 1 run.")).toBeTruthy();
  });

  it("polls while one of the task's runs is still going", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    current = pack({ runs: [{ run_id: "r1", agent_alias: "Pixel", status: "running", exit_code: null, lane: "work", started_at: null, ended_at: null }] });
    mount();
    await screen.findByTestId("evidence-summary");
    const n = calls.filter((c) => c.url === "/api/tasks/t1/evidence").length;
    await act(async () => { vi.advanceTimersByTime(15100); });
    await waitFor(() => expect(calls.filter((c) => c.url === "/api/tasks/t1/evidence").length).toBeGreaterThan(n));
  });
});

describe("evidenceCss (QA 2026-09-30)", () => {
  it("a part that wraps to the start of a line does not lead with its '·' separator", () => {
    // jsdom has no layout: pin the mechanism — the dot is positioned into the gap before the
    // part and the line clips its own left edge, so a wrapped part's dot is never visible
    const css = evidenceCss.replace(/\s+/g, " ");
    expect(css).toMatch(/\.ev-part \+ \.ev-part::before \{[^}]*position: absolute;[^}]*left: -7px;/);
    expect(css).toMatch(/\.ev-part \+ \.ev-part \{ position: relative; \}/);
    expect(css).toMatch(/\.ev-line \{ clip-path: inset\(-8px -8px -8px 0\); \}/);
    expect(css).not.toMatch(/::before \{ content: "·"; color: var\(--v2-text-3\); margin-right/);
  });
});
