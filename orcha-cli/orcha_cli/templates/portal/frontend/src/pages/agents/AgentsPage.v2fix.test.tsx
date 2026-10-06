/**
 * Screen-quality fix round (Agents): payloads never render as "[object Object]",
 * the model control always shows the current value (legacy id / null default),
 * the digest caps per section, auto-wake presets sort, a failed agent says why,
 * and log rows never echo their type label.
 */
import { cleanup, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { AgentsPage } from "./AgentsPage";
import { logRowText } from "./runlog";
import { ToolInput } from "./Conversation";

const SNAP = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [
    { id: "h1", alias: "kedar", kind: "human", role: "Founder", status: "idle", member_role: "owner", github_login: "kedar-gh" },
    { id: "a1", alias: "forge", kind: "ai", role: "Builder", status: "working", model: "claude-opus-4-1-20250805", auto_wake_interval_secs: 600 },
    { id: "a2", alias: "scout", kind: "ai", role: "Researcher", status: "failed", model: null },
  ],
  tasks: [],
  requests: [
    { id: "r1", type: "question", status: "open", priority: 1, requester_id: "a1", target_id: "a2", payload: { question: "Which index should we use?", detail: 3 }, created_at: new Date().toISOString() },
    { id: "r2", type: "handoff", status: "answered", priority: 2, requester_id: "a2", target_id: "a1", payload: { summary: "API shape" }, response: { answer: "Done, see PR" }, created_at: new Date().toISOString() },
  ],
};

const DIGEST = {
  current_focus: "Shipping the rail",
  decisions: ["d1", "d2", "d3", "d4", "d5", "d6", "d7"],
  learnings: [],
  open_threads: ["t1", "t2"],
};

function jsonRes(data: unknown) {
  return { ok: true, status: 200, json: async () => data } as Response;
}
function stubFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1")) return jsonRes(SNAP);
    if (url === "/api/models") return jsonRes({ models: [], default: "claude-opus-5" });
    if (url === "/api/reasoning-efforts") return jsonRes({ efforts: [] });
    if (url.includes("/digest")) return jsonRes({ digest: DIGEST });
    if (url.includes("/a2/runs")) return jsonRes({ runs: [{ run_id: "run-9", status: "killed", kill_reason: JSON.stringify({ cause: "stalled" }), started_at: new Date().toISOString(), ended_at: new Date().toISOString() }] });
    if (url.includes("/runs")) return jsonRes({ runs: [] });
    if (url.includes("/conversation")) return jsonRes({ conversation: null, turns: [] });
    return jsonRes({});
  }) as unknown as typeof fetch;
}
function mount(path: string) {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="*" element={<AgentsPage />} />
          </Routes>
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

describe("Agents screen-quality fixes", () => {
  beforeEach(() => {
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

  it("request rows render object payloads as readable text, never [object Object] or JSON", async () => {
    const { container } = mount("/agents?agent=forge&tab=requests");
    await screen.findByText("Roster · 3");
    await screen.findByText("Which index should we use?");
    expect(screen.getByText(/Done, see PR/)).toBeInTheDocument();
    expect(container.textContent).not.toContain("[object Object]");
    expect(container.textContent).not.toContain('{"');
  });

  it("a legacy model id outside the curated list is shown as the current value — humanized, raw id as tooltip", async () => {
    const { container } = mount("/agents?agent=forge&tab=config");
    await screen.findByText("Roster · 3");
    const seg = await waitFor(() => container.querySelector("#modelSeg") as HTMLElement);
    expect(seg.getAttribute("data-model")).toBe("claude-opus-4-1-20250805");
    // the dropdown trigger shows the real current value as a product name, and the menu lists it first (checked)
    const trigger = seg.querySelector("button") as HTMLButtonElement;
    expect(trigger.textContent).toContain("Opus 4.1 (legacy)");
    expect(trigger.getAttribute("title")).toContain("claude-opus-4-1-20250805");
    // the header chip reads the same product name, raw id in its tooltip; Details keeps the raw id
    const chip = container.querySelector(".ahead .ag-model") as HTMLElement;
    expect(chip.textContent).toBe("Opus 4.1 (legacy)");
    expect(chip.getAttribute("title")).toContain("claude-opus-4-1-20250805");
    expect(container.querySelector(".ag-kv")?.textContent).toContain("claude-opus-4-1-20250805");
    fireEvent.click(trigger);
    const first = within(screen.getByRole("listbox", { name: "Models" })).getAllByRole("option")[0];
    expect(first.textContent).toContain("Opus 4.1 (legacy)");
    expect(first.getAttribute("aria-disabled")).toBe("true");
  });

  it("a null model lights the default model and says the default applies", async () => {
    const { container } = mount("/agents?agent=scout&tab=config");
    await screen.findByText("Roster · 3");
    const seg = await waitFor(() => container.querySelector("#modelSeg") as HTMLElement);
    expect(seg.getAttribute("data-model")).toBe("claude-opus-5");
    expect(seg.querySelector("button")?.textContent).toContain("Opus 5 · default");
    expect(container.textContent).toContain("none set, so the default (Opus 5) applies");
  });

  it("auto-wake presets are sorted by cadence with a custom 10m between 5m and 15m", async () => {
    const { container } = mount("/agents?agent=forge&tab=config");
    await screen.findByText("Roster · 3");
    const seg = await waitFor(() => container.querySelector("#awakeSeg") as HTMLElement);
    expect(Array.from(seg.querySelectorAll("button")).map((b) => b.textContent)).toEqual(["Off", "5m", "10m", "15m", "1h"]);
  });

  it("the memory digest caps each section on its own (Open threads is never starved)", async () => {
    mount("/agents?agent=forge&tab=memory");
    await screen.findByText("Roster · 3");
    await screen.findByText("t2"); // both threads visible despite 7 decisions
    expect(screen.queryByText("d7")).toBeNull();
    fireEvent.click(screen.getByText(/Show more · 6 of 7/));
    await screen.findByText("d7");
  });

  it("a failed agent shows the last run's failure reason with a way to the Runs tab", async () => {
    mount("/agents?agent=scout");
    await screen.findByText("Roster · 3");
    // the reason ONCE (no "Last run failed" echo of the Failed pill), and a way to that run
    await screen.findByText(/Watchdog: stalled/);
    expect(document.querySelector(".ag-fail")?.textContent).not.toMatch(/failed/i);
    expect(document.querySelector("#agentPresence")?.textContent).toBe("Failed");
    fireEvent.click(screen.getByRole("button", { name: /View run/ }));
    expect(screen.getByRole("tab", { name: "Runs" })).toHaveAttribute("aria-selected", "true");
  });

  it("a human's header carries member role + GitHub login", async () => {
    const { container } = mount("/agents?agent=kedar");
    await screen.findByText("Roster · 3");
    expect(container.querySelector(".ahead .role")?.textContent).toContain("@kedar-gh");
    expect(container.querySelector(".ahead .role")?.textContent).toContain("owner");
  });
});

describe("run log + tool input formatting", () => {
  afterEach(() => cleanup());

  it("logRowText never echoes the type label; it falls back to the detail's first line", () => {
    expect(logRowText({ type: "result", label: "tool result", text: "tool result", detail: "\n  12 files changed\nmore" })).toBe("12 files changed");
    expect(logRowText({ type: "tool", label: "tool", text: "Bash · ls", detail: "x" })).toBe("Bash · ls");
  });

  it("ToolInput renders an object (or a JSON string) as labelled fields, not a JSON dump", () => {
    const { container } = render(<ToolInput value={'{"command":"rm -rf build","timeout_ms":5000}'} />);
    expect(container.querySelector("dl.gkv")).toBeTruthy();
    expect(container.textContent).toContain("Command");
    expect(container.textContent).toContain("rm -rf build");
    expect(container.textContent).toContain("Timeout ms");
    expect(container.textContent).not.toContain('{"');
  });
});
