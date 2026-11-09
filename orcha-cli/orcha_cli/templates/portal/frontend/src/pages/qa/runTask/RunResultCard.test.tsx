/** The Run result card: a finished run, a running one, one that stopped; plain words and no ids. */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../../types";
import { RunResultCard } from "./RunResultCard";

const SID = "5f2f1c7e-1111-4222-8333-444455556666";
const TID = "9a8b7c6d-1111-4222-8333-444455556666";
const RESULT = { task_id: TID, is_run_task: true, kind: "check", platform: "android", outcome: "failed", summary: "1 of 2 scenarios failed.", session_id: SID,
  scenarios: [{ scenario_id: "sc1", name: "Sign in", verdict: "pass" }, { scenario_id: "sc2", name: "Reset password", verdict: "fail", note: "The link 404s" }], lines: [],
  findings: [{ id: "f1", session_id: SID, severity: "major", title: "Pay button does nothing", status: "open", frame_ids: [] }],
  drafts: [{ id: "sc3", name: "Pay with a card", status: "draft" }], screens_reached: 9, duration_seconds: 720, cost_usd: 1.25, device: { name: "Pixel 9" }, build: "1.4 (88)",
  agent: { id: "a2", alias: "tess" }, links: { worker_run: "/agents?agent=tess&changes=w1" } };
const FINISHED = { is_run_task: true, run_result: RESULT, sessions: [], scenarios: [], verdicts: [], findings: [], requests: [] };
const withResult = (o: Record<string, unknown>, top: Record<string, unknown> = {}) => ({ ...FINISHED, ...top, run_result: { ...RESULT, ...o } });

function stub(body: unknown, log: unknown = { entries: [], cursor: "", now: { state: "working", level: "info", text: "Checking the sign-in screen" }, live: true, truncated: false }) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const data = url.includes("/qa/run-log") ? log : url.includes("/qa") ? body : {};
    return { ok: true, status: 200, json: async () => data } as Response;
  }) as unknown as typeof fetch;
}
const task = (o: Partial<Task> = {}) => ({ id: TID, title: "Check the app", status: "needs_verification", runs: [], description: "Run /orcha-qa-check for this task on android", ...o }) as unknown as Task;
const mount = (t = task()) => render(<MemoryRouter><RunResultCard task={t} /></MemoryRouter>);
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("RunResultCard", () => {
  it("links back to the work it checks", async () => {
    stub(withResult({}, { requests: [{ id: "r1", status: "done", qa_task_id: TID, source_task_id: "t-work", source_task_title: "Add the discount" }] }));
    mount();
    const link = await screen.findByRole("link", { name: "Add the discount" });
    expect(link.getAttribute("href")).toContain("task=t-work");
  });

  it("shows what ran and how it ended, with every way in", async () => {
    stub(FINISHED);
    mount();
    const card = await screen.findByRole("region", { name: "Run result" });
    await within(card).findByText("1 of 2 scenarios failed.");
    expect(card.textContent).toContain("Check scenarios on Android");
    expect(within(card).getByRole("link", { name: "Pay button does nothing" }).getAttribute("href")).toContain(`session=${SID}`);
    expect(within(card).getByRole("link", { name: "Reset password" }).getAttribute("href")).toContain("scenario=sc2");
    expect(within(card).getByRole("link", { name: "Pay with a card" })).toBeInTheDocument();
    expect(within(card).getByText("The link 404s")).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "Open the run" }).getAttribute("href")).toBe(`/qa?view=sessions&platform=android&session=${SID}`);
    expect(within(card).getByRole("link", { name: "Replay" }).getAttribute("href")).toContain("sub=run");
    expect(within(card).getByRole("link", { name: "What the agent did" }).getAttribute("href")).toBe("/agents?agent=tess&changes=w1");
    expect(within(card).getByRole("link", { name: "tess" }).getAttribute("href")).toBe("/agents?agent=tess");
    for (const fact of ["Pixel 9", "1.4 (88)", "9", "12 min"]) expect(within(card).getByText(fact)).toBeInTheDocument();
  });

  it("shows no ids and no raw text", async () => {
    stub(FINISHED);
    mount();
    const card = await screen.findByRole("region", { name: "Run result" });
    await within(card).findByText("1 of 2 scenarios failed.");
    expect(card.textContent).not.toMatch(/5f2f1c7e|9a8b7c6d|orcha-qa|# raw|\{/);
  });

  it("says what is happening while it runs, with the device and the activity", async () => {
    stub(withResult({ outcome: "running", summary: null, findings: [], drafts: [] }),
      { entries: [{ id: "1", at: "2026-11-05T10:01:00Z", level: "info", kind: "step", text: "Opened the app" }], cursor: "c", now: { state: "working", level: "info", text: "Checking the sign-in screen" }, live: true, truncated: false, session_id: SID, platform: "android" });
    mount(task({ status: "in_progress" }));
    expect(await screen.findByText("Checking the sign-in screen")).toBeInTheDocument();
    expect(await screen.findByText("Opened the app")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Watch the device" }).getAttribute("href")).toContain("sub=run");
    expect(screen.queryByRole("link", { name: "Replay" })).toBeNull();
  });

  it("waits calmly before anything has started", async () => {
    stub({ sessions: [], findings: [], scenarios: [], verdicts: [], requests: [] });
    mount(task({ status: "ready" }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(await screen.findByText("Waiting for its agent to start.")).toBeInTheDocument();
  });

  it("gives the reason a run stopped", async () => {
    stub(withResult({ outcome: "stopped", summary: null, reason: "The agent stopped responding.", scenarios: [], findings: [], drafts: [] }));
    mount();
    expect(await screen.findByText("The agent stopped responding.")).toBeInTheDocument();
    expect(screen.getByText("Could not finish")).toBeInTheDocument();
  });

  it("says when work finished by itself and who allowed it, without calling Quality the verifier", async () => {
    stub(withResult({ outcome: "passed", summary: "All passed." }, { final_decision: { decision: "finished", turned_on_by_alias: "kedar", reasons: [], lines: [] } }));
    mount(task({ status: "completed" }));
    const line = await waitFor(() => { const el = document.querySelector("[data-finished-alone]"); if (!el) throw new Error("not yet"); return el; });
    expect(line.textContent).toContain("Finished by itself");
    expect(line.textContent).toContain("Turned on by kedar");
    expect(line.textContent).not.toContain("Quality");
  });

  it("says nothing about finishing when a person verifies", async () => {
    stub(withResult({ outcome: "passed" }));
    mount();
    await screen.findByText("1 of 2 scenarios failed.");
    expect(document.querySelector("[data-finished-alone]")).toBeNull();
  });
});
