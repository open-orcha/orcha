/**
 * Verdikt panel — preview environments (mig 064) and "Open in Verdikt":
 * honest preview states (starting / ready + Preview link / failed + last log
 * lines / stopped), the "No preview command set" note (the no-preview path is
 * unchanged), the log toggle, and Open in Verdikt on the section and on every
 * earlier run row (portal redirect URLs, never a Verdikt host).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VerdiktPanel, verdiktOpenHref } from "./VerdiktPanel";
import type { VerdiktPreview, VerdiktRun, VerdiktSettings } from "./evidenceTypes";

const SETTINGS: VerdiktSettings = {
  configured: true, enabled: true, base_url: "http://host.docker.internal:31970", verdikt_project: "acme-web", target_kind: "web",
  target_locator: "http://127.0.0.1:5173/", trigger_mode: "manual", timeout_minutes: 30, updated_at: null, updated_by: null,
  preview_command: null, preview_ready_path: "/", preview_timeout_seconds: 120, preview_ttl_minutes: 60,
};

function preview(over: Partial<VerdiktPreview> = {}): VerdiktPreview {
  return {
    id: "p1", status: "starting", port: null, verdikt_url: null, open_url: null, log_url: "/api/tasks/t1/verdikt/runs/v1/preview/log",
    branch: "orcha/task-pixel-1", worktree_name: "task-pixel-1", ready_path: "/", error: null, log_tail: null, stop_reason: null,
    created_at: null, claimed_at: null, ready_at: null, stopped_at: null, expires_at: null, ...over,
  };
}

function vrun(over: Partial<VerdiktRun> = {}): VerdiktRun {
  return {
    id: "v1", task_id: "t1", trigger: "manual", triggered_by: "h1", status: "queued", verdict: null, reason: null,
    base_url: "http://host.docker.internal:31970", verdikt_project_id: null, verdikt_scenario_id: null, verdikt_request_id: null,
    verdikt_run_id: null, target_kind: "web", locator: "", handoff: {}, criteria: [], screenshots: [],
    report_url: null, video_url: null, error: null, created_at: new Date().toISOString(), updated_at: null,
    last_polled_at: null, finished_at: null, preview: null, ...over,
  };
}

let settings: VerdiktSettings;
let runs: VerdiktRun[];
let logLines: string[];
const fetched: string[] = [];

beforeEach(() => {
  settings = { ...SETTINGS };
  runs = [];
  logLines = [];
  fetched.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    fetched.push(url);
    const res = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
    if (url === "/api/tasks/t1/verdikt/runs") return res({ task_id: "t1", settings, runs });
    if (url === "/api/tasks/t1/verdikt/runs/v1/preview/log") return res({ status: "failed", lines: logLines });
    return res({}, 404);
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("VerdiktPanel preview states", () => {
  it("says there's no preview command and which URL Verdikt will test (the old path)", async () => {
    render(<VerdiktPanel taskId="t1" latest={null} actorId="h1" />);
    const note = await screen.findByTestId("verdikt-preview-note");
    expect(note.textContent).toBe("No preview command set: Verdikt will test http://127.0.0.1:5173/.");
    expect(screen.queryByTestId("verdikt-preview")).toBeNull();
  });

  it("with a command and no run yet, says Verdikt will test a preview of the branch", async () => {
    settings = { ...SETTINGS, preview_command: "python3 -m http.server {port}" };
    render(<VerdiktPanel taskId="t1" latest={null} actorId="h1" />);
    expect((await screen.findByTestId("verdikt-preview-note")).textContent).toContain("a preview of this task's branch");
  });

  it("an older backend without preview settings shows no preview note", async () => {
    const { preview_command: _a, preview_ready_path: _b, preview_timeout_seconds: _c, preview_ttl_minutes: _d, ...old } = SETTINGS;
    settings = old as VerdiktSettings;
    render(<VerdiktPanel taskId="t1" latest={null} actorId="h1" />);
    await screen.findByText("Not run for this task yet.");
    expect(screen.queryByTestId("verdikt-preview-note")).toBeNull();
  });

  it("starting: waiting for the preview, no Preview link yet", async () => {
    render(<VerdiktPanel taskId="t1" latest={vrun({ preview: preview({ status: "starting" }) })} actorId="h1" />);
    const pv = await screen.findByTestId("verdikt-preview");
    expect(pv.getAttribute("data-status")).toBe("starting");
    expect(pv.textContent).toContain("Starting preview…");
    expect(pv.textContent).toContain("orcha/task-pixel-1");
    expect(screen.getByTestId("verdikt-panel").textContent).toContain("Waiting for the preview");
    expect(screen.getByTestId("verdikt-panel").textContent).toContain("web:preview");
    expect(within(pv).queryByRole("link", { name: /Preview/ })).toBeNull();
  });

  it("ready: shows the URL Verdikt tests and a Preview link to the portal redirect", async () => {
    const run = vrun({
      locator: "http://127.0.0.1:41234/", verdikt_request_id: "rq",
      preview: preview({ status: "ready", port: 41234, verdikt_url: "http://127.0.0.1:41234/", open_url: "/api/tasks/t1/verdikt/runs/v1/preview" }),
    });
    render(<VerdiktPanel taskId="t1" latest={run} actorId="h1" />);
    const pv = await screen.findByTestId("verdikt-preview");
    expect(pv.textContent).toContain("Preview ready at http://127.0.0.1:41234/");
    const link = within(pv).getByRole("link", { name: "Preview" });
    expect(link.getAttribute("href")).toBe("/api/tasks/t1/verdikt/runs/v1/preview");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(screen.getByTestId("verdikt-panel").textContent).toContain("Queued in Verdikt");
  });

  it("failed: plain reason + the last log lines, without repeating the run error", async () => {
    const tail = Array.from({ length: 12 }, (_, i) => "line " + i).join("\n") + "\nnpm ERR! missing script: build";
    const run = vrun({
      status: "failed", error: "Preview failed: the preview command exited with code 1 before it answered",
      preview: preview({ status: "failed", error: "the preview command exited with code 1 before it answered", log_tail: tail }),
    });
    render(<VerdiktPanel taskId="t1" latest={run} actorId="h1" />);
    const pv = await screen.findByTestId("verdikt-preview");
    expect(within(pv).getByRole("alert").textContent).toBe("Preview failed: the preview command exited with code 1 before it answered");
    const log = within(pv).getByLabelText("Preview log");
    expect(log.textContent?.split("\n")).toHaveLength(6);
    expect(log.textContent).toContain("npm ERR! missing script: build");
    // the failure is said once
    expect(screen.getByTestId("verdikt-panel").textContent?.match(/Preview failed/g)).toHaveLength(1);
    // Retry stays available
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("the Log toggle loads the full tail from the log route", async () => {
    logLines = Array.from({ length: 80 }, (_, i) => "full " + i);
    const run = vrun({ preview: preview({ status: "ready", port: 41234, verdikt_url: "http://127.0.0.1:41234/", open_url: "/x", log_tail: "short tail" }) });
    render(<VerdiktPanel taskId="t1" latest={run} actorId="h1" />);
    const btn = await screen.findByRole("button", { name: "Log" });
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByLabelText("Preview log").textContent).toContain("full 79"));
    expect(fetched).toContain("/api/tasks/t1/verdikt/runs/v1/preview/log");
    expect(screen.getByLabelText("Preview log").textContent?.split("\n")).toHaveLength(80);
    fireEvent.click(screen.getByRole("button", { name: "Hide log" }));
    expect(screen.queryByLabelText("Preview log")).toBeNull();
  });

  it("stopped: says why", async () => {
    const run = vrun({ status: "completed", verdict: "pass", verdikt_run_id: "abcd", preview: preview({ status: "stopped", stop_reason: "the Verdikt run is completed" }) });
    render(<VerdiktPanel taskId="t1" latest={run} actorId="h1" />);
    expect((await screen.findByTestId("verdikt-preview")).textContent).toContain("Preview stopped: the Verdikt run is completed");
  });
});

describe("Open in Verdikt", () => {
  it("builds portal redirect URLs", () => {
    expect(verdiktOpenHref("t1")).toBe("/api/tasks/t1/verdikt/open");
    expect(verdiktOpenHref("t 1", "v/1")).toBe("/api/tasks/t%201/verdikt/open?run=v%2F1");
  });

  it("before any run it opens the project (task-level redirect), in a new tab", async () => {
    render(<VerdiktPanel taskId="t1" latest={null} actorId="h1" />);
    const open = await screen.findByTestId("verdikt-open");
    expect(open.getAttribute("href")).toBe("/api/tasks/t1/verdikt/open");
    expect(open.getAttribute("target")).toBe("_blank");
    expect(open.textContent).toBe("Open in Verdikt");
    expect(open.getAttribute("href")).not.toContain("docker");
  });

  it("with a run it opens that run; each earlier run row has its own button", async () => {
    const latest = vrun({ id: "v3", status: "completed", verdict: "pass", verdikt_run_id: "r3", locator: "http://127.0.0.1:41234/" });
    runs = [latest, vrun({ id: "v2", status: "completed", verdict: "fail", verdikt_run_id: "r2", locator: "http://127.0.0.1:5173/" }),
      vrun({ id: "v1", status: "failed", error: "Preview failed: x" })];
    render(<VerdiktPanel taskId="t1" latest={latest} actorId="h1" />);
    expect((await screen.findByTestId("verdikt-open")).getAttribute("href")).toBe("/api/tasks/t1/verdikt/open?run=v3");
    const hist = await screen.findByTestId("verdikt-history");
    expect(hist.textContent).toContain("Earlier runs (2)");
    expect(within(hist).getByTestId("verdikt-open-v2").getAttribute("href")).toBe("/api/tasks/t1/verdikt/open?run=v2");
    expect(within(hist).getByTestId("verdikt-open-v1").getAttribute("href")).toBe("/api/tasks/t1/verdikt/open?run=v1");
    expect(hist.textContent).toContain("Verdict: fail");
    expect(hist.textContent).toContain("Verdikt run failed");
  });

  it("isn't offered when Verdikt has no URL and nothing ran", async () => {
    settings = { ...SETTINGS, enabled: false, configured: false, base_url: null };
    render(<VerdiktPanel taskId="t1" latest={null} actorId="h1" />);
    await screen.findByText("Verdikt isn't set up for this project.");
    expect(screen.queryByTestId("verdikt-open")).toBeNull();
  });
});

describe("VerdiktPanel preview note after the command is cleared", () => {
  it("an earlier preview-backed run still shows its preview, and the note says the next run tests the URL", async () => {
    const run = vrun({ status: "failed", error: "Preview failed: x", preview: preview({ status: "failed", error: "x" }) });
    render(<VerdiktPanel taskId="t1" latest={run} actorId="h1" />);
    expect((await screen.findByTestId("verdikt-preview")).getAttribute("data-status")).toBe("failed");
    expect((await screen.findByTestId("verdikt-preview-note")).textContent).toBe("No preview command set: Verdikt will test http://127.0.0.1:5173/.");
  });

  it("with the command still set, a finished preview run shows no extra note", async () => {
    settings = { ...SETTINGS, preview_command: "python3 -m http.server {port}" };
    const run = vrun({ status: "completed", verdict: "pass", preview: preview({ status: "stopped", stop_reason: "done" }) });
    render(<VerdiktPanel taskId="t1" latest={run} actorId="h1" />);
    await screen.findByTestId("verdikt-preview");
    await waitFor(() => expect(fetched).toContain("/api/tasks/t1/verdikt/runs"));
    expect(screen.queryByTestId("verdikt-preview-note")).toBeNull();
  });
});
