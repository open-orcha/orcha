/**
 * The Verdikt auto-fix loop UI (mig 068): the attempts timeline ("Attempt 1 ✗ 1/3 · …"), each
 * attempt linking to its run evidence and its code changes; the loop status ("Auto-fix running:
 * attempt 2 of 3" / why it stopped); Stop auto-fix; the per-task override (and why it is
 * disabled while Verdikt doesn't run automatically); the task-page section; the Verdikt panel
 * wiring; and the Needs-you summary part.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutofixOverride, AutofixSection, AutofixStatus, AutofixTimeline, timelineText } from "./AutofixPanel";
import { VerdiktPanel } from "./VerdiktPanel";
import { autofixPart, summaryText } from "./EvidenceSummaryLine";
import type { AutofixAttempt, AutofixLoop, AutofixState, EvidenceSummary, VerdiktSettings } from "./evidenceTypes";

function att(n: number, outcome: string, over: Partial<AutofixAttempt> = {}): AutofixAttempt {
  return {
    attempt: n, outcome, action: outcome === "pass" ? "passed" : outcome === "fail" ? "reworked" : "stopped",
    verdikt_run: "r" + n, report_url: `/api/tasks/t1/verdikt/runs/r${n}/report`, open_url: `/api/tasks/t1/verdikt/open?run=r${n}`,
    failed: outcome === "fail" ? [{ text: "The error text is red", expected: "red", actual: "black" }] : [],
    changes: { summary: "Changed 2 files", files: 2, href: `/agents?agent=Pixel&changes=w${n}` }, created_at: null, ...over,
  };
}

function loop(over: Partial<AutofixLoop> = {}): AutofixLoop {
  return {
    id: "l1", status: "running", current: true, max_attempts: 3, attempts_made: 1, current_attempt: 2, stop_kind: null,
    stop_label: null, stop_reason: null, stopped_by: null, started_at: null, stopped_at: null, attempts: [att(1, "fail")], ...over,
  };
}

function state(over: Partial<AutofixState> = {}): AutofixState {
  return { task_id: "t1", effective: true, why: "Auto-fix is on for this project", override: "inherit",
    project: { enabled: true, max_attempts: 3, applies: true }, loop: loop(), ...over };
}

const PASSED = loop({
  status: "stopped", current_attempt: 3, attempts_made: 3, stop_kind: "pass", stop_label: "Verdikt passed",
  stop_reason: "Verdikt passed on attempt 3 of 3 — ready for your review",
  attempts: [att(1, "fail"), att(2, "fail"), att(3, "pass")],
});

interface Call { url: string; method: string; body: unknown }
let calls: Call[] = [];
let answer: AutofixState;
let putStatus = 200;

beforeEach(() => {
  calls = [];
  putStatus = 200;
  answer = state();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const res = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
    if (url === "/api/tasks/t1/verdikt/autofix/stop") {
      answer = state({ loop: loop({ status: "stopped", stop_kind: "stopped_by_human", stop_reason: "root stopped auto-fix" }) });
      return res(answer);
    }
    if (url === "/api/tasks/t1/verdikt/autofix" && method === "PUT") {
      if (putStatus !== 200) return res({ detail: "forbidden" }, putStatus);
      answer = { ...answer, override: (body as { mode: AutofixState["override"] }).mode };
      return res(answer);
    }
    if (url === "/api/tasks/t1/verdikt/autofix") return res(answer);
    if (url === "/api/tasks/t1/verdikt/runs") {
      const settings: VerdiktSettings = {
        configured: true, enabled: true, base_url: "http://v", verdikt_project: "p", target_kind: "web", target_locator: "http://x",
        trigger_mode: "always", timeout_minutes: 30, updated_at: null, updated_by: null, autofix_enabled: true, autofix_max_attempts: 3,
      };
      return res({ task_id: "t1", settings, runs: [], autofix: answer });
    }
    return res({}, 404);
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AutofixTimeline", () => {
  it("reads Attempt 1 ✗ 1/3 · Attempt 2 ✗ 2/3 · Attempt 3 ✓ 3/3, each linking to its evidence and changes", () => {
    render(<AutofixTimeline loop={PASSED} />);
    expect(timelineText(PASSED)).toBe("Attempt 1 ✗ 1/3 · Attempt 2 ✗ 2/3 · Attempt 3 ✓ 3/3");
    const items = within(screen.getByTestId("autofix-timeline")).getAllByRole("listitem");
    expect(items.map((li) => li.getAttribute("data-outcome"))).toEqual(["fail", "fail", "pass"]);
    expect(items[2].textContent).toContain("Attempt 3");
    expect(items[2].textContent).toContain("3/3");
    const report = screen.getByRole("link", { name: "Attempt 2: fail — open its Verdikt report" });
    expect(report.getAttribute("href")).toBe("/api/tasks/t1/verdikt/runs/r2/report");
    expect(screen.getByRole("link", { name: "Attempt 2 code changes" }).getAttribute("href")).toBe("/agents?agent=Pixel&changes=w2");
    expect(items[0].getAttribute("title")).toContain("✗ The error text is red — black");
  });

  it("shows the attempt in flight while the loop runs", () => {
    render(<AutofixTimeline loop={loop()} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[1].getAttribute("data-outcome")).toBe("pending");
    expect(items[1].textContent).toContain("Attempt 2");
    expect(items[1].textContent).toContain("2/3");
  });
});

describe("AutofixStatus", () => {
  it("running: says which attempt, and Stop auto-fix stops it as the acting human", async () => {
    const changed = vi.fn();
    render(<AutofixStatus state={state()} taskId="t1" actorId="h1" onChanged={changed} />);
    expect(screen.getByText("Auto-fix running: attempt 2 of 3")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Stop auto-fix" })); });
    const stop = calls.find((c) => c.url.endsWith("/autofix/stop"));
    expect(stop?.method).toBe("POST");
    expect(stop?.body).toEqual({ actor_agent_id: "h1" });
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ loop: expect.objectContaining({ stop_kind: "stopped_by_human" }) }));
  });

  it("Stop is disabled with the reason when nobody can act", () => {
    render(<AutofixStatus state={state()} taskId="t1" actorId={null} noActorReason="Pick who you are first" />);
    const b = screen.getByRole("button", { name: "Stop auto-fix" }) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.title).toBe("Pick who you are first");
  });

  it("stopped: says why in plain words, no Stop button", () => {
    render(<AutofixStatus state={state({ loop: PASSED })} taskId="t1" actorId="h1" />);
    expect(screen.getByText("Verdikt passed on attempt 3 of 3 — ready for your review")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop auto-fix" })).toBeNull();
    expect(screen.getByTestId("autofix-status").getAttribute("data-stop")).toBe("pass");
  });

  it("renders nothing for a loop from an earlier review cycle", () => {
    const { container } = render(<AutofixStatus state={state({ loop: { ...PASSED, current: false } })} taskId="t1" actorId="h1" />);
    expect(container.textContent).toBe("");
  });
});

describe("AutofixOverride", () => {
  it("sets the per-task override", async () => {
    const changed = vi.fn();
    render(<AutofixOverride state={state()} taskId="t1" actorId="h1" onChanged={changed} />);
    expect(screen.getByRole("radio", { name: "Project default (on)" }).getAttribute("aria-checked")).toBe("true");
    await act(async () => { fireEvent.click(screen.getByRole("radio", { name: "Off" })); });
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe("/api/tasks/t1/verdikt/autofix");
    expect(put?.body).toEqual({ actor_agent_id: "h1", mode: "off" });
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ override: "off" }));
  });

  it("is disabled with the reason while Verdikt doesn't run automatically", () => {
    render(<AutofixOverride state={state({ effective: false, project: { enabled: true, max_attempts: 3, applies: false } })} taskId="t1" actorId="h1" />);
    expect((screen.getByRole("radio", { name: "On" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("autofix-why").textContent).toContain("Only works when Verdikt runs automatically");
  });

  it("explains a refused change", async () => {
    putStatus = 403;
    render(<AutofixOverride state={state()} taskId="t1" actorId="h1" />);
    await act(async () => { fireEvent.click(screen.getByRole("radio", { name: "On" })); });
    expect(screen.getByRole("alert").textContent).toContain("manage_repo");
  });
});

describe("AutofixSection (task page)", () => {
  it("loads the loop and shows status + timeline", async () => {
    render(<AutofixSection taskId="t1" status="in_progress" actorId="h1" />);
    expect(await screen.findByText("Auto-fix running: attempt 2 of 3")).toBeTruthy();
    expect(screen.getByTestId("autofix-timeline")).toBeTruthy();
  });

  it("shows nothing when the task never had a loop", async () => {
    answer = state({ loop: null });
    const { container } = render(<AutofixSection taskId="t1" status="needs_verification" actorId="h1" />);
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector("[data-testid='autofix-section']")).toBeNull();
  });
});

describe("VerdiktPanel wiring", () => {
  it("shows the loop status and the override from the runs response", async () => {
    render(<VerdiktPanel taskId="t1" latest={null} actorId="h1" />);
    expect(await screen.findByText("Auto-fix running: attempt 2 of 3")).toBeTruthy();
    expect(screen.getByTestId("autofix-override")).toBeTruthy();
  });
});

describe("summary part (Needs-you rows)", () => {
  const base: EvidenceSummary = {
    dod: { total: 2, proven: 1, not_proven: 0, needs_human: 1 },
    tests: { status: "passed", passed: 4, failed: 0, skipped: 0, errors: 0, suites: 1 },
    risk_flags: 0, verdikt: { status: "completed", verdict: "pass" }, line: "",
  };
  it("a task stopped by the loop says why, first", () => {
    const s = { ...base, autofix: { status: "stopped" as const, attempts_made: 2, max_attempts: 3, current_attempt: 2,
      stop_kind: "same_failure" as const, stop_label: "No progress", stop_reason: "No progress: the same 1 criterion failed …" } };
    expect(summaryText(s)).toBe("Auto-fix stopped: same failure twice · 1/2 DoD · 4 tests passed · Verdikt pass");
    expect(autofixPart(s.autofix)?.title).toBe("No progress: the same 1 criterion failed …");
  });
  it("pass, running and non-fail stops", () => {
    expect(autofixPart({ status: "stopped", attempts_made: 3, max_attempts: 3, current_attempt: 3, stop_kind: "pass",
      stop_label: "Verdikt passed", stop_reason: "x" })?.text).toBe("Verdikt passed on attempt 3/3");
    expect(autofixPart({ status: "running", attempts_made: 1, max_attempts: 3, current_attempt: 2, stop_kind: null,
      stop_label: null, stop_reason: null })?.text).toBe("Auto-fix: attempt 2 of 3");
    expect(autofixPart({ status: "stopped", attempts_made: 2, max_attempts: 3, current_attempt: 2, stop_kind: "non_fail",
      stop_label: "x", stop_reason: "Verdikt was blocked and couldn't finish the check on attempt 2 of 3 (login wall) — that isn't a test fail" })?.text)
      .toBe("Auto-fix stopped: Verdikt was blocked and couldn't finish the check on attempt 2 of 3");
    expect(autofixPart(null)).toBeNull();
  });
});
