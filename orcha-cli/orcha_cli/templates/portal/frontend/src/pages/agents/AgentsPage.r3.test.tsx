/**
 * Linear pop round 3 — Agents fixes:
 *   - D5: every agent header (AI too) has ⋯ + "1 / N ↑ ↓" through the roster order
 *   - an unknown ?agent= still offers "← All agents"
 *   - roster sub-line: ONE rule (the task with the in-progress glyph, else the role)
 *   - presence parity: the roster word equals the header pill with no host runtime
 *   - runs: the output's first error line is the reason; the whole row toggles;
 *     the Stop dialog is one calm line; the diff preview starts at the first hunk
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { AgentsPage } from "./AgentsPage";
import { diffBodyLines, outputErrorLine, runReasonText } from "./runlog";

const iso = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();
const ENOENT_OUT = [
  JSON.stringify({ type: "system", subtype: "init", cwd: "/w" }),
  "plain stderr line: WARNING urllib3 connection pool is full",
  "Error: spawn claude ENOENT",
  JSON.stringify({ type: "result", subtype: "error_during_execution", result: "Tests still failing" }),
].join("\n");

let SCAN: string | null = iso(0);
const snap = () => ({
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan", last_wake_scan_at: SCAN },
  agents: [
    { id: "a1", alias: "lead", kind: "ai", role: "Tech lead", status: "working", model: "claude-opus-5" },
    { id: "a2", alias: "forge", kind: "ai", role: "Builder", status: "working", model: "claude-opus-5", current_task: { task_id: "t1", title: "Ship login" } },
    { id: "a3", alias: "scout", kind: "ai", role: "Researcher", status: "idle", model: null },
    { id: "h1", alias: "kedar", kind: "human", role: "Founder", status: "idle", member_role: "owner" },
  ],
  tasks: [{ id: "t1", title: "Ship login", status: "in_progress", priority: 2, assignees: ["forge"], created_at: iso(30) }],
  requests: [],
});
const RUNS: Record<string, unknown[]> = {
  a1: [{ run_id: "run-live-1", agent_id: "a1", status: "running", started_at: iso(2) }],
  a3: [{ run_id: "run-fail-1", agent_id: "a3", status: "failed", exit_code: 1, output: ENOENT_OUT, started_at: iso(20), ended_at: iso(19) }],
};

function jsonRes(data: unknown) {
  return { ok: true, status: 200, json: async () => data } as Response;
}
function stubFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1")) return jsonRes(snap());
    if (url === "/api/models") return jsonRes({ models: [], default: "claude-opus-5" });
    if (url === "/api/reasoning-efforts") return jsonRes({ efforts: [] });
    const m = /\/api\/agents\/([^/]+)\/runs/.exec(url);
    if (m) return jsonRes({ runs: RUNS[m[1]] || [] });
    if (url.includes("/conversation")) return jsonRes({ conversation: null, turns: [] });
    return jsonRes({});
  }) as unknown as typeof fetch;
}
let loc = "";
function LocProbe() {
  const l = useLocation();
  loc = l.pathname + l.search;
  return null;
}
function mount(path: string) {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="*" element={<><AgentsPage /><LocProbe /></>} />
          </Routes>
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

describe("Agents — Linear pop r3", () => {
  beforeEach(() => {
    SCAN = iso(0);
    stubFetch();
    localStorage.clear();
    sessionStorage.clear();
    try {
      window.scrollTo = () => {};
    } catch { /* jsdom */ }
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("D5: an AI agent's header has ⋯ (board-column items) and 1 / N ↑ ↓ through the roster", async () => {
    const { container } = mount("/agents?agent=forge&tab=tasks");
    await screen.findByRole("heading", { name: "forge" });
    const head = container.querySelector(".ahead") as HTMLElement;
    expect(within(head).getByRole("group", { name: "agent 2 of 4" })).toBeTruthy();
    fireEvent.click(within(head).getByRole("button", { name: "forge actions" }));
    const menu = await screen.findByRole("menu");
    const labels = within(menu).getAllByRole("menuitem").map((e) => e.textContent?.trim());
    for (const l of ["Open conversation", "Runs", "Requests", "Memory", "Configuration", "Show in Tasks"]) expect(labels.some((x) => x?.startsWith(l))).toBe(true);
    fireEvent.click(within(menu).getByRole("menuitem", { name: /^Runs/ }));
    await waitFor(() => expect(loc).toContain("tab=runs"));
    fireEvent.click(within(head).getByRole("button", { name: "Next agent" }));
    await screen.findByRole("heading", { name: "scout" });
    expect(loc).toContain("agent=scout");
    fireEvent.click(within(container.querySelector(".ahead") as HTMLElement).getByRole("button", { name: "Previous agent" }));
    await screen.findByRole("heading", { name: "forge" });
  });

  it("an unknown ?agent= still offers the way back to the roster", async () => {
    mount("/agents?agent=ghost");
    await screen.findByText("Agent not found");
    fireEvent.click(screen.getByRole("button", { name: "All agents" }));
    await waitFor(() => expect(loc).not.toContain("agent=ghost"));
  });

  it("roster sub-line: the task with its status glyph when on one, else the role — same for every working agent", async () => {
    const { container } = mount("/agents?view=list");
    await screen.findByText("Roster · 4");
    const forge = container.querySelector('.rrow-in[data-alias="forge"]')!;
    const lead = container.querySelector('.rrow-in[data-alias="lead"]')!;
    expect(forge.querySelector(".rl.rl-task")?.textContent).toBe("Ship login");
    expect(forge.querySelector(".rl-task svg")).toBeTruthy();
    expect(lead.querySelector(".rl")?.textContent).toBe("Tech lead");
    expect(lead.querySelector(".rl-task")).toBeNull();
  });

  it("presence parity with no host runtime: roster word == header pill == Working (scanner note in the tooltip)", async () => {
    SCAN = iso(60);
    const { container } = mount("/agents?agent=lead&tab=tasks");
    await screen.findByRole("heading", { name: "lead" });
    const pill = await waitFor(() => {
      const el = container.querySelector("#agentPresence");
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    const word = container.querySelector('.rrow-in[data-alias="lead"] .rword') as HTMLElement;
    expect(pill.textContent).toBe("Working");
    expect(word.textContent).toBe(pill.textContent);
    expect(pill.getAttribute("title")).toMatch(/No host runtime/);
    expect(word.getAttribute("title")).toMatch(/No host runtime/);
  });

  it("Runs: the failure reason is the output's first error line, the whole row toggles, and the exit code is the row tooltip", async () => {
    const { container } = mount("/agents?agent=scout&tab=runs");
    const reason = await screen.findByText("Error: spawn claude ENOENT");
    expect(reason.className).toContain("run-reason");
    const row = container.querySelector(".run-h") as HTMLElement;
    expect(row.getAttribute("title")).toContain("exit code 1");
    const toggle = row.querySelector(".run-toggle") as HTMLElement;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(reason); // row text, not the chevron
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(row);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("the Stop-run dialog is calm: no raw run id, no status enum, one line with the mechanics in a tooltip", async () => {
    mount("/agents?agent=lead&tab=runs");
    fireEvent.click(await screen.findByRole("button", { name: "Stop run" }));
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByText("Stop this run?")).toBeTruthy();
    expect(dlg.textContent).not.toContain("run-live");
    expect(dlg.textContent).not.toContain("in_progress");
    expect(within(dlg).getByRole("note").getAttribute("title")).toMatch(/wake tick/);
  });
});

describe("runlog helpers (r3)", () => {
  it("outputErrorLine: plain stderr errors first, warnings skipped, error results used", () => {
    expect(outputErrorLine(ENOENT_OUT)).toBe("Error: spawn claude ENOENT");
    expect(outputErrorLine("WARNING: slow\n" + JSON.stringify({ type: "result", subtype: "error_max_turns", result: "" }))).toBe("error max turns");
    expect(outputErrorLine(JSON.stringify({ type: "result", subtype: "success", result: "ok" }))).toBe("");
    expect(outputErrorLine(null)).toBe("");
  });
  it("runReasonText prefers the error line over a bare exit code, but keeps a real kill reason", () => {
    expect(runReasonText({ status: "failed", exit_code: 1, kill_reason: null, output: ENOENT_OUT })).toBe("Error: spawn claude ENOENT");
    expect(runReasonText({ status: "failed", exit_code: 1, kill_reason: null, output: "" })).toBe("Exited with code 1");
    expect(runReasonText({ status: "killed", exit_code: 137, kill_reason: "operator killed it", output: ENOENT_OUT })).toBe("Operator killed it");
  });
  it("diffBodyLines starts the preview at the first @@ hunk", () => {
    const lines = ["diff --git a/x b/x", "index 1..2", "--- a/x", "+++ b/x", "@@ -1 +1 @@", "-a", "+b"];
    expect(diffBodyLines(lines)).toEqual(["@@ -1 +1 @@", "-a", "+b"]);
    expect(diffBodyLines(["diff --git a/i.png b/i.png", "index 1..2", "Binary files a/i.png and b/i.png differ"])).toEqual(["Binary files a/i.png and b/i.png differ"]);
  });
});
