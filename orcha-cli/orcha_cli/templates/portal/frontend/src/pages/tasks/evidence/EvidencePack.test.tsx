/**
 * Proof-of-work evidence pack (GET /api/tasks/{tid}/evidence) + the Verdikt
 * panel: the one-line summary is built only from real parts, the details show
 * the DoD checklist with evidence + the agent's labelled claim, tests, risk
 * flags and links; Verdikt states are honest (not set up → Set up link,
 * unavailable → reason + Retry, completed → verdicts/screenshots/report), and
 * actions need an acting human.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EvidencePack } from "./EvidencePack";
import { EvidenceSummaryLine, summaryParts, summaryText } from "./EvidenceSummaryLine";
import { VerdiktPanel } from "./VerdiktPanel";
import { evidenceCss } from "./evidenceCss";
import type { EvidencePack as Pack, EvidenceSummary, VerdiktRun, VerdiktSettings } from "./evidenceTypes";

const SUMMARY: EvidenceSummary = {
  dod: { total: 4, proven: 3, not_proven: 0, needs_human: 1 },
  tests: { status: "passed", passed: 42, failed: 0, skipped: 0, errors: 0, suites: 2 },
  risk_flags: 1,
  verdikt: null,
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
    verdikt: null,
    summary: SUMMARY,
    ...over,
  };
}

const SETTINGS: VerdiktSettings = {
  configured: true, enabled: true, base_url: "http://127.0.0.1:31950", verdikt_project: "shop-web", target_kind: "web",
  target_locator: "http://127.0.0.1:5173", trigger_mode: "manual", timeout_minutes: 30, updated_at: null, updated_by: null,
};

function vrun(over: Partial<VerdiktRun> = {}): VerdiktRun {
  return {
    id: "v1", task_id: "t1", trigger: "manual", triggered_by: "h1", status: "queued", verdict: null, reason: null,
    base_url: "http://127.0.0.1:31950", verdikt_project_id: "p", verdikt_scenario_id: "s", verdikt_request_id: "rq",
    verdikt_run_id: null, target_kind: "web", locator: "http://127.0.0.1:5173", handoff: {}, criteria: [], screenshots: [],
    report_url: null, video_url: null, error: null, created_at: new Date().toISOString(), updated_at: null,
    last_polled_at: null, finished_at: null, ...over,
  };
}

interface Call { url: string; method: string; body: unknown }
let calls: Call[] = [];
let current: Pack;
let settings: VerdiktSettings;
let evidenceStatus = 200;
let triggerAnswer: { status: number; body: unknown };

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
    if (url === "/api/tasks/t1/verdikt/runs" && method === "GET") return res({ task_id: "t1", settings, runs: current.verdikt ? [current.verdikt] : [] });
    if (url === "/api/tasks/t1/verdikt/runs" && method === "POST") return res(triggerAnswer.body, triggerAnswer.status);
    if (url.endsWith("/cancel")) return res(vrun({ status: "cancelled", error: "cancelled from Orcha" }));
    if (url.endsWith("/refresh")) return res(vrun({ status: "running" }));
    return res({});
  }));
}

function mount(props: Partial<Parameters<typeof EvidencePack>[0]> = {}) {
  return render(
    <MemoryRouter>
      <EvidencePack taskId="t1" actorId="h1" noActorReason="Pick an acting human first" {...props} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  current = pack();
  settings = { ...SETTINGS };
  evidenceStatus = 200;
  triggerAnswer = { status: 201, body: vrun() };
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
    expect(summaryParts({ ...SUMMARY, verdikt: { status: "completed", verdict: "pass" } }).at(-1)).toMatchObject({ text: "Verdikt pass", tone: "ok" });
    expect(summaryParts({ ...SUMMARY, verdikt: { status: "unavailable", verdict: null } }).at(-1)?.text).toBe("Verdikt unavailable");
    expect(summaryParts({ ...SUMMARY, dod: { total: 2, proven: 1, not_proven: 1, needs_human: 0 } })[0].tone).toBe("bad");
    expect(summaryParts({ ...SUMMARY, dod: { total: 1, proven: 0, not_proven: 0, needs_human: 1 } })[0].icon).toBeUndefined();
    expect(summaryParts({ ...SUMMARY, dod: { total: 2, proven: 2, not_proven: 0, needs_human: 0 } })[0]).toMatchObject({ icon: "check", tone: "ok" });
    expect(summaryParts(null)).toEqual([]);
    expect(summaryParts(SUMMARY, { short: true })[0].text).toBe("3/4 DoD");
  });
  it("plain-text short form for Needs-you rows", () => {
    expect(summaryText({ ...SUMMARY, verdikt: { status: "completed", verdict: "fail" } })).toBe("3/4 DoD · 42 tests passed · 1 risk · Verdikt fail");
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

  it("Verdikt not set up → a quiet line with a Set up link", async () => {
    settings = { ...SETTINGS, enabled: false, configured: false };
    mount({ defaultOpen: true });
    const panel = await screen.findByTestId("verdikt-panel");
    await waitFor(() => expect(panel.textContent).toContain("Verdikt isn't set up for this project."));
    expect(within(panel).getByRole("link", { name: "Set up" }).getAttribute("href")).toBe("/settings#tab=github-access");
  });

  it("Run in Verdikt posts as the acting human and shows the queued run", async () => {
    mount({ defaultOpen: true });
    const btn = await screen.findByRole("button", { name: "Run in Verdikt" });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    // the server now carries the queued run in the pack
    current = pack({ verdikt: vrun(), summary: { ...SUMMARY, verdikt: { status: "queued", verdict: null } } });
    await act(async () => { fireEvent.click(btn); });
    const post = calls.find((c) => c.url === "/api/tasks/t1/verdikt/runs" && c.method === "POST");
    expect(post?.body).toEqual({ actor_agent_id: "h1" });
    await waitFor(() => expect(screen.getByTestId("verdikt-panel").textContent).toContain("Queued in Verdikt"));
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("without an acting human the Verdikt action is disabled with the reason", async () => {
    mount({ defaultOpen: true, actorId: null });
    const btn = await screen.findByRole("button", { name: "Run in Verdikt" });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(btn.getAttribute("title")).toBe("Pick an acting human first");
  });

  it("a missing target asks for a URL and resends with it", async () => {
    triggerAnswer = { status: 400, body: { detail: "no target to test — set a web URL / app id in Verdikt settings or pass one" } };
    mount({ defaultOpen: true });
    const btn = await screen.findByRole("button", { name: "Run in Verdikt" });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(btn); });
    expect(await screen.findByRole("alert")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("URL to test"), { target: { value: "https://preview.example.dev" } });
    triggerAnswer = { status: 201, body: vrun({ locator: "https://preview.example.dev" }) };
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Run in Verdikt" })); });
    const posts = calls.filter((c) => c.url === "/api/tasks/t1/verdikt/runs" && c.method === "POST");
    expect(posts.at(-1)?.body).toEqual({ actor_agent_id: "h1", locator: "https://preview.example.dev" });
  });

  it("no target URL and no preview URL → the URL field is shown before the first press", async () => {
    settings = { ...SETTINGS, target_locator: null };
    current = pack({ preview_urls: [] });
    mount({ defaultOpen: true });
    expect(await screen.findByLabelText("URL to test")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("URL to test"), { target: { value: "http://localhost:3000" } });
    triggerAnswer = { status: 201, body: vrun({ locator: "http://localhost:3000" }) };
    const btn = screen.getByRole("button", { name: "Run in Verdikt" });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(btn); });
    const posts = calls.filter((c) => c.url === "/api/tasks/t1/verdikt/runs" && c.method === "POST");
    expect(posts.at(-1)?.body).toEqual({ actor_agent_id: "h1", locator: "http://localhost:3000" });
  });

  it("a preview URL from the agent means no URL field is needed", async () => {
    settings = { ...SETTINGS, target_locator: null };
    current = pack({ preview_urls: ["http://localhost:5173/pricing"] });
    mount({ defaultOpen: true });
    await screen.findByRole("button", { name: "Run in Verdikt" });
    expect(screen.queryByLabelText("URL to test")).toBeNull();
  });

  it("a completed run shows verdicts, screenshots, recording and the report", async () => {
    current = pack({
      verdikt: vrun({
        status: "completed", verdict: "fail", reason: "error text colour", verdikt_run_id: "abcd1234ffff",
        criteria: [
          { dod_index: 1, text: "The error text is red", outcome: "fail", expected: "red text", actual: "black text" },
        ],
        screenshots: [{ url: "/api/tasks/t1/verdikt/runs/v1/artifact?path=abcd1234ffff/evidence/001-major.png", path: "abcd1234ffff/evidence/001-major.png", label: "error text colour", kind: "evidence" }],
        report_url: "/api/tasks/t1/verdikt/runs/v1/report", video_url: "/api/tasks/t1/verdikt/runs/v1/artifact?path=abcd1234ffff/run.webm",
        handoff: { skipped_items: [{ dod_index: 0, text: "All tests pass", why: "code-level" }] },
      }),
      summary: { ...SUMMARY, verdikt: { status: "completed", verdict: "fail" } },
    });
    mount({ defaultOpen: true });
    const panel = await screen.findByTestId("verdikt-panel");
    expect(panel.textContent).toContain("Verdict: fail");
    // the per-criterion verdicts live on the DoD checklist, not twice (D12)
    expect(within(panel).queryByRole("list", { name: "Verdikt verdicts" })).toBeNull();
    expect(panel.textContent).toContain("1 code-level DoD item not sent — proven from the run itself.");
    // screenshots / recording / report go through the portal (same origin) — never Verdikt's
    // server-side URL, which may be a Docker-only host (host.docker.internal) the browser can't reach
    const img = within(panel).getByRole("img", { name: "error text colour" });
    expect(img.getAttribute("src")).toBe("/api/tasks/t1/verdikt/runs/v1/artifact?path=abcd1234ffff/evidence/001-major.png");
    expect(within(panel).getByRole("link", { name: /Open Verdikt report/ }).getAttribute("href")).toBe("/api/tasks/t1/verdikt/runs/v1/report");
    expect(within(panel).getByRole("link", { name: /Recording/ }).getAttribute("href")).toBe("/api/tasks/t1/verdikt/runs/v1/artifact?path=abcd1234ffff/run.webm");
    expect(panel.innerHTML).not.toContain("31950");
    expect(within(panel).getByRole("button", { name: "Run again" })).toBeTruthy();
    expect(screen.getByTestId("evidence-summary").textContent).toContain("Verdikt fail");
  });

  it("a screenshot the proxy can't produce says so instead of a broken image", async () => {
    current = pack({
      verdikt: vrun({
        status: "completed", verdict: "pass", verdikt_run_id: "abcd1234ffff",
        screenshots: [
          { url: "/api/tasks/t1/verdikt/runs/v1/artifact?path=abcd1234ffff/evidence/001.png", label: "saved to wishlist", kind: "evidence" },
          { url: "/api/tasks/t1/verdikt/runs/v1/artifact?path=abcd1234ffff/evidence/002.png", label: "wishlist count", kind: "evidence" },
        ],
      }),
    });
    mount({ defaultOpen: true });
    const panel = await screen.findByTestId("verdikt-panel");
    const first = within(panel).getByRole("img", { name: "saved to wishlist" });
    fireEvent.error(first);
    const miss = await within(panel).findByTestId("verdikt-shot-missing");
    expect(miss.textContent).toContain("Screenshot unavailable");
    expect(miss.textContent).toContain("saved to wishlist");
    expect(within(panel).queryByRole("img", { name: "saved to wishlist" })).toBeNull();
    // the other screenshot is unaffected
    expect(within(panel).getByRole("img", { name: "wishlist count" })).toBeTruthy();
  });

  it("an unavailable Verdikt is said with its reason and offers Retry", async () => {
    current = pack({ verdikt: vrun({ status: "unavailable", error: "Verdikt is not reachable at http://127.0.0.1:31950 (Connection refused)" }) });
    mount({ defaultOpen: true });
    const panel = await screen.findByTestId("verdikt-panel");
    expect(panel.textContent).toContain("Verdikt unavailable");
    expect(within(panel).getByRole("alert").textContent).toContain("not reachable");
    expect(within(panel).getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("polls while a Verdikt run is open", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    current = pack({ verdikt: vrun({ status: "running" }) });
    mount();
    await screen.findByTestId("evidence-summary");
    const n = calls.filter((c) => c.url === "/api/tasks/t1/evidence").length;
    await act(async () => { vi.advanceTimersByTime(4100); });
    await waitFor(() => expect(calls.filter((c) => c.url === "/api/tasks/t1/evidence").length).toBeGreaterThan(n));
  });

  it("cancel posts as the acting human", async () => {
    current = pack({ verdikt: vrun({ status: "running" }) });
    mount({ defaultOpen: true });
    const btn = await screen.findByRole("button", { name: "Cancel" });
    await act(async () => { fireEvent.click(btn); });
    const c = calls.find((x) => x.url === "/api/tasks/t1/verdikt/runs/v1/cancel");
    expect(c?.body).toEqual({ actor_agent_id: "h1" });
  });

  it("standalone Verdikt panel lists the per-criterion verdicts", async () => {
    render(
      <MemoryRouter>
        <VerdiktPanel taskId="t1" actorId="h1" latest={vrun({ status: "completed", verdict: "fail", criteria: [
          { dod_index: 3, text: "The error text is red", outcome: "fail", expected: "red text", actual: "black text" },
          { dod_index: 2, text: "Shows Wrong password", outcome: "pass" },
        ] })} />
      </MemoryRouter>,
    );
    const list = await screen.findByRole("list", { name: "Verdikt verdicts" });
    expect(list.textContent).toContain("Expected red text · Actual black text");
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
  });

  it("a run from before the last rejection is labelled and kept out of the proof line (QA 2026-09-30)", async () => {
    current = pack({
      round_started_at: new Date().toISOString(),
      verdikt: vrun({ status: "completed", verdict: "pass", previous_round: true }),
      summary: { ...SUMMARY, verdikt: null },
    });
    mount({ defaultOpen: true });
    const panel = await screen.findByTestId("verdikt-panel");
    expect(within(panel).getByTestId("verdikt-previous-round").textContent).toContain("before the last rejection");
    expect(within(panel).getByRole("button", { name: "Run again" })).toBeTruthy();
    expect(screen.getByTestId("evidence-summary").textContent).not.toContain("Verdikt");
  });

  it("a run of the current round carries no previous-round note", async () => {
    current = pack({ verdikt: vrun({ status: "completed", verdict: "pass" }) });
    mount({ defaultOpen: true });
    const panel = await screen.findByTestId("verdikt-panel");
    expect(within(panel).queryByTestId("verdikt-previous-round")).toBeNull();
  });
});

describe("evidenceCss (QA 2026-09-30)", () => {
  it("a part that wraps to the start of a line does not lead with its '·' separator", () => {
    // jsdom has no layout: pin the mechanism — the dot is positioned into the gap before the
    // part and the line clips its own left edge, so a wrapped part's dot is never visible
    const css = evidenceCss.replace(/\s+/g, " ");
    expect(css).toMatch(/\.ev-part \+ \.ev-part::before \{[^}]*position: absolute;[^}]*left: -7px;/);
    expect(css).toMatch(/\.ev-part \+ \.ev-part \{ position: relative; \}/);
    expect(css).toMatch(/\.ev-line, \.ev-vk-line \{ clip-path: inset\(-8px -8px -8px 0\); \}/);
    expect(css).not.toMatch(/::before \{ content: "·"; color: var\(--v2-text-3\); margin-right/);
  });
});
