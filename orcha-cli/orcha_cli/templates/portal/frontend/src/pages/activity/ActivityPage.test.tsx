/**
 * Activity page (Agent E): addressable runs view with URL filters, entity
 * links, honest failure reasons, project-scoped data, a live log that only
 * follows at the bottom (Jump to latest), and expandable tool details that
 * survive stream appends.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { ActivityPage } from "./ActivityPage";

interface Call { url: string; init?: RequestInit }
let calls: Call[] = [];

const SNAP = {
  container: { id: "c1", name: "Acme", status: "active", autonomy_level: "plan" },
  agents: [
    { id: "h1", alias: "kedar", kind: "human", role: "Founder", status: "idle" },
    { id: "a1", alias: "forge", kind: "ai", role: "Builder", status: "working", last_active: "2026-09-28T10:00:00Z",
      active_run: { run_id: "r-live", task_id: "t1", task_title: "Fix login", started_at: "2026-09-28T10:00:00Z" } },
    { id: "a2", alias: "scout", kind: "ai", role: "Research", status: "idle", last_active: "2026-09-27T10:00:00Z", active_run: null },
  ],
  tasks: [{ id: "t1", title: "Fix login", status: "in_progress", assignees: ["forge"], message_summary: { count: 0, last: null } }],
  requests: [],
};

const RUNS_A1 = [
  { run_id: "r-live", agent_id: "a1", task_id: "t1", status: "running", wake_event: "task_assigned", started_at: "2026-09-28T10:00:00Z", ended_at: null, output: null },
  { run_id: "r-ok", agent_id: "a1", task_id: "t1", status: "exited", exit_code: 0, started_at: "2026-09-28T08:00:00Z", ended_at: "2026-09-28T08:03:00Z", output: "" },
  { run_id: "r-kill", agent_id: "a1", task_id: null, status: "killed", kill_reason: JSON.stringify({ cause: "hard_cap" }), wake_event: "auto_wake", started_at: "2026-09-28T07:00:00Z", ended_at: "2026-09-28T07:30:00Z", output: "" },
  // a run of an agent that is NOT in this project must never render (cross-project guard)
  { run_id: "r-foreign", agent_id: "zz", status: "exited", exit_code: 0, started_at: "2026-09-28T09:00:00Z", ended_at: "2026-09-28T09:01:00Z" },
];
const RUNS_A2 = [
  { run_id: "r-scout", agent_id: "a2", status: "exited", exit_code: 3, started_at: "2026-09-28T06:00:00Z", ended_at: "2026-09-28T06:01:00Z", output: "" },
];

function jsonRes(data: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => data } as Response;
}
function stubFetch(opts: { failA2?: boolean } = {}) {
  calls = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    calls.push({ url, init });
    if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1")) return jsonRes(SNAP);
    if (url.startsWith("/api/agents/a1/runs")) return jsonRes({ runs: RUNS_A1 });
    if (url.startsWith("/api/agents/a2/runs")) return opts.failA2 ? jsonRes({}, false) : jsonRes({ runs: RUNS_A2 });
    if (url.startsWith("/api/tasks/t1/runs")) return jsonRes({ runs: RUNS_A1.filter((r) => r.task_id === "t1") });
    if (url.startsWith("/api/runs/") && url.endsWith("/stop")) return jsonRes({ stop_requested: true });
    return jsonRes({});
  }) as unknown as typeof fetch;
}

let loc = "";
function LocProbe() {
  const l = useLocation();
  loc = l.pathname + l.search;
  return null;
}
function mount(path = "/activity") {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[path]}>
          <LocProbe />
          <Routes>
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="*" element={<div>elsewhere</div>} />
          </Routes>
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

const rows = () => Array.from(document.querySelectorAll<HTMLElement>(".act-row"));

describe("ActivityPage", () => {
  beforeEach(() => {
    stubFetch();
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    delete (globalThis as { EventSource?: unknown }).EventSource;
  });

  it("lists runs across the project's AI agents newest first, with exact outcome labels and failure reasons", async () => {
    mount();
    await waitFor(() => expect(rows().length).toBe(4));
    const text = rows().map((r) => r.textContent || "");
    expect(text[0]).toContain("Running");
    expect(text[0]).toContain("Fix login");
    expect(text.some((t) => t.includes("Exited · exit 0"))).toBe(true);
    const killed = text.find((t) => t.includes("Killed"))!;
    expect(killed).toContain("watchdog: hit the runtime cap");
    expect(text.find((t) => t.includes("scout"))).toContain("non-zero exit code 3");
    // cross-project guard: the foreign agent's run is dropped
    expect(text.join(" ")).not.toContain("unknown agent");
    // only AI agents are queried (humans never run workers)
    expect(calls.some((c) => c.url.startsWith("/api/agents/h1/runs"))).toBe(false);
  });

  it("the state filter lives in the URL and filters by outcome bucket", async () => {
    mount("/activity?state=failed");
    await waitFor(() => expect(rows().length).toBe(2));
    expect(rows().map((r) => r.textContent).join(" ")).not.toContain("Running");
    fireEvent.click(screen.getByRole("radio", { name: /^Running/ }));
    await waitFor(() => expect(loc).toContain("state=running"));
    await waitFor(() => expect(rows().length).toBe(1));
  });

  it("?agent= queries only that agent's feed (limit 50); ?task= uses the task feed", async () => {
    mount("/activity?agent=scout");
    await waitFor(() => expect(rows().length).toBe(1));
    expect(calls.some((c) => c.url === "/api/agents/a2/runs?limit=50")).toBe(true);
    expect(calls.some((c) => c.url.startsWith("/api/agents/a1/runs"))).toBe(false);
    cleanup();
    stubFetch();
    mount("/activity?task=t1");
    await waitFor(() => expect(rows().length).toBe(2));
    expect(calls.some((c) => c.url === "/api/tasks/t1/runs?limit=50")).toBe(true);
    expect(screen.getByRole("button", { name: "Clear task filter" })).toBeInTheDocument();
  });

  it("an unknown ?agent= says so instead of showing another agent's runs", async () => {
    mount("/activity?agent=ghost");
    await screen.findByText("Agent not found");
  });

  it("selecting a run opens the inspector with entity links, exact status and a human-gated Stop for running runs", async () => {
    mount();
    await waitFor(() => expect(rows().length).toBe(4));
    fireEvent.click(rows()[0]);
    await waitFor(() => expect(loc).toContain("run=r-live"));
    const insp = await screen.findByRole("region", { name: "Run r-live" });
    expect(within(insp).getByRole("link", { name: /forge/ })).toHaveAttribute("href", "/agents?agent=forge&tab=runs");
    expect(within(insp).getByRole("link", { name: "Fix login" })).toHaveAttribute("href", "/tasks?task=t1");
    const stop = within(insp).getByRole("button", { name: "Stop run" });
    fireEvent.click(stop);
    const dlg = await screen.findByRole("dialog");
    expect(dlg.textContent).toMatch(/only this run/i); // copy owned by agents/runlog StopRunButton
    fireEvent.click(within(dlg).getByRole("button", { name: "Stop run" }));
    await waitFor(() => {
      const c = calls.find((x) => x.url === "/api/runs/r-live/stop");
      expect(c).toBeTruthy();
      expect(c!.init!.body).toBe(JSON.stringify({ actor_agent_id: "h1" }));
    });
  });

  it("a finished run's inspector says an exit is not task completion and shows no Stop", async () => {
    mount("/activity?run=r-ok");
    const insp = await screen.findByRole("region", { name: "Run r-ok" });
    expect(insp.textContent).toContain("A run exiting is not task completion");
    // D12: the boilerplate lives behind a focusable help icon (tooltip), not a sentence in the panel
    expect(insp.querySelector(".act-help")).toHaveAttribute("tabindex", "0");
    expect(within(insp).queryByRole("button", { name: "Stop run" })).toBeNull();
    // the stream state settles after the run-log effect runs (slow under a loaded worker pool)
    await waitFor(() => expect(insp.textContent).toContain("Captured output")); // not "Live"
  });

  it("a failed run's inspector states the exit code once (no '· exit N' in Status, no synthesised Reason row)", async () => {
    mount("/activity?run=r-scout");
    const insp = await screen.findByRole("region", { name: "Run r-scout" });
    const props = insp.querySelector(".act-props")!;
    expect(props.textContent).toContain("Exited");
    expect(props.textContent).not.toMatch(/exit 3/);
    expect(props.textContent).not.toContain("non-zero exit code");
    expect(props.textContent).not.toContain("Reason");
    expect(props.querySelector(".act-status")).toHaveAttribute("title", "Exit code 3");
  });

  it("a running run's Started shows only the clock time (Duration already says how long)", async () => {
    mount("/activity?run=r-live");
    const insp = await screen.findByRole("region", { name: "Run r-live" });
    const props = insp.querySelector(".act-props")!;
    await waitFor(() => expect(props.textContent).toContain("still running"));
    expect(props.textContent).not.toMatch(/\bago\b/);
  });

  it("outage: a failed refresh keeps the last-known runs, the open run and its counts; recovery refetches at once (e2e-scope-live-16)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setInterval", "setTimeout", "clearInterval", "clearTimeout", "Date"] });
    try {
      let down = false;
      calls = [];
      global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : String(input);
        calls.push({ url, init });
        if (down) throw new TypeError("Failed to fetch");
        if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
        if (url.startsWith("/api/containers/c1")) return jsonRes(SNAP);
        if (url.startsWith("/api/agents/a1/runs")) return jsonRes({ runs: RUNS_A1 });
        if (url.startsWith("/api/agents/a2/runs")) return jsonRes({ runs: RUNS_A2 });
        return jsonRes({});
      }) as unknown as typeof fetch;
      mount("/activity?run=r-ok");
      await waitFor(() => expect(rows().length).toBe(4));
      await screen.findByRole("region", { name: "Run r-ok" });
      const allPill = () => screen.getByRole("radio", { name: /^All runs/ }).textContent;
      expect(allPill()).toContain("4");

      // the backend goes away for longer than the 20 s refresh tick
      down = true;
      await act(async () => { await vi.advanceTimersByTimeAsync(26_000); });
      await screen.findByText(/Couldn't refresh runs — showing the last-known list/);
      expect(rows().length).toBe(4); // never "Runs unavailable" over data already shown
      expect(screen.queryByText("Runs unavailable")).toBeNull();
      expect(screen.getByRole("region", { name: "Run r-ok" })).toBeInTheDocument(); // the open run stays mounted
      expect(screen.queryByText("Run not in the loaded window")).toBeNull();
      expect(allPill()).toContain("4"); // last-known count, never a fake 0
      expect(allPill()).not.toMatch(/\b0\b/);

      // it comes back: the next snapshot poll flips the connection live and
      // the runs refetch right away — not at the next 20 s tick
      const before = calls.filter((c) => c.url.startsWith("/api/agents/")).length;
      down = false;
      await act(async () => { await vi.advanceTimersByTimeAsync(3_500); });
      await waitFor(() => expect(calls.filter((c) => c.url.startsWith("/api/agents/")).length).toBeGreaterThan(before));
      await waitFor(() => expect(screen.queryByText(/Couldn't refresh runs/)).toBeNull());
      expect(rows().length).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a first load where every runs feed fails shows 'Runs unavailable' with unknown (not 0) pill counts", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : String(input);
      if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
      if (url.startsWith("/api/containers/c1")) return jsonRes(SNAP);
      return jsonRes({}, false);
    }) as unknown as typeof fetch;
    mount();
    await screen.findAllByText("Runs unavailable");
    expect(document.querySelector(".v2-pill-count")).toBeNull();
  });

  it("a partial refresh failure keeps the failed agent's last-known runs next to the fresh ones", async () => {
    let failA2 = false;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : String(input);
      if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
      if (url.startsWith("/api/containers/c1")) return jsonRes(SNAP);
      if (url.startsWith("/api/agents/a1/runs")) return jsonRes({ runs: RUNS_A1 });
      if (url.startsWith("/api/agents/a2/runs")) return failA2 ? jsonRes({}, false) : jsonRes({ runs: RUNS_A2 });
      return jsonRes({});
    }) as unknown as typeof fetch;
    mount("/activity?run=r-scout");
    await waitFor(() => expect(rows().length).toBe(4));
    failA2 = true;
    fireEvent.click(screen.getByRole("button", { name: /Refresh runs/ }));
    await screen.findByText(/Runs unavailable for scout\. Their last-known runs are kept/);
    expect(rows().length).toBe(4);
    expect(screen.getByRole("region", { name: "Run r-scout" })).toBeInTheDocument();
  });

  it("the run inspector says 'No task' and 'Claude · conversation' (no 'pinned' / 'lane' jargon)", async () => {
    const runs = [{ run_id: "r-conv", agent_id: "a1", task_id: null, status: "exited", exit_code: 0, runtime: "claude", lane: "conversation", started_at: "2026-09-28T08:00:00Z", ended_at: "2026-09-28T08:03:00Z", output: "" }];
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : String(input);
      if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
      if (url.startsWith("/api/containers/c1")) return jsonRes(SNAP);
      if (url.startsWith("/api/agents/a1/runs")) return jsonRes({ runs });
      return jsonRes({ runs: [] });
    }) as unknown as typeof fetch;
    mount("/activity?run=r-conv");
    const insp = await screen.findByRole("region", { name: "Run r-conv" });
    expect(insp.textContent).toContain("No task");
    expect(insp.textContent).not.toContain("pinned");
    expect(insp.querySelector(".act-runtime")!.textContent).toBe("Claude · conversation");
    expect(insp.textContent).not.toMatch(/\blane\b/);
  });

  it("Events previews strip markdown and requests read 'asked … for info' / 'answered …' (never 'sent an info to')", async () => {
    const snap = {
      ...SNAP,
      tasks: [{ ...SNAP.tasks[0], message_summary: { count: 1, last: { body: "## Plan\n1. Add a `billing_webhooks_v2` table\n- see [docs](https://x.y)", created_at: "2026-09-28T09:00:00Z", is_human: false, author_alias: "forge" } } }],
      requests: [{ id: "q9", type: "info", status: "answered", requester_id: "a1", target_id: "a2", payload: { question: "Which region?" }, response: { answer: "eu-west" }, created_at: "2026-09-28T09:30:00Z", responded_at: "2026-09-28T09:40:00Z", task_link: null }],
    };
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : String(input);
      if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
      if (url.startsWith("/api/containers/c1")) return jsonRes(snap);
      return jsonRes({ runs: [] });
    }) as unknown as typeof fetch;
    mount("/activity?view=events");
    const list = await screen.findByRole("list", { name: "Project events" });
    await waitFor(() => expect(list.textContent).toContain("Plan Add a billing_webhooks_v2 table see docs"));
    expect(list.textContent).not.toMatch(/##|`|\]\(/);
    expect(list.textContent).toContain("asked scout for info");
    expect(list.textContent).toMatch(/answered forge's info request/);
    expect(list.textContent).not.toMatch(/sent an? info/);
  });

  it("Events folds consecutive comments by one actor ('commented on X and N more'), expandable", async () => {
    const snap = {
      ...SNAP,
      tasks: [
        { ...SNAP.tasks[0], message_summary: { count: 1, last: { body: "Pushed a fix", created_at: "2026-09-28T09:00:00Z", is_human: false, author_alias: "forge" } } },
        { id: "t2", title: "Add export", status: "in_progress", assignees: ["forge"], message_summary: { count: 1, last: { body: "Export wired", created_at: "2026-09-28T08:50:00Z", is_human: false, author_alias: "forge" } } },
        { id: "t3", title: "Docs pass", status: "in_progress", assignees: ["scout"], message_summary: { count: 1, last: { body: "Docs done", created_at: "2026-09-28T08:40:00Z", is_human: false, author_alias: "scout" } } },
      ],
    };
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : String(input);
      if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
      if (url.startsWith("/api/containers/c1")) return jsonRes(snap);
      return jsonRes({ runs: [] });
    }) as unknown as typeof fetch;
    mount("/activity?view=events");
    const list = await screen.findByRole("list", { name: "Project events" });
    await waitFor(() => expect(list.querySelectorAll(".v2-tl-event").length).toBe(2));
    expect(list.textContent).toMatch(/forge.*commented on Fix login and 1 more/);
    expect(list.textContent).not.toContain("Export wired");
    fireEvent.click(within(list).getByRole("button", { name: "1 more" }));
    await waitFor(() => expect(list.querySelectorAll(".v2-tl-event").length).toBe(3));
    expect(list.textContent).toContain("Export wired");
    fireEvent.click(within(list).getByRole("button", { name: "Show less" }));
    await waitFor(() => expect(list.querySelectorAll(".v2-tl-event").length).toBe(2));
  });

  it("a failing agent feed is disclosed inline while the others still render", async () => {
    stubFetch({ failA2: true });
    mount();
    await waitFor(() => expect(rows().length).toBe(3));
    expect(screen.getByText(/Runs unavailable for scout/)).toBeInTheDocument();
  });

  it("Events view renders request payloads as text (never JSON), calls the acting human 'you', and keeps Refresh's slot", async () => {
    const snap = {
      ...SNAP,
      tasks: [{ ...SNAP.tasks[0], message_summary: { count: 2, last: { body: "Looks good", created_at: "2026-09-28T09:00:00Z", is_human: true, author_alias: "kedar" } } }],
      requests: [{ id: "q1", type: "question", status: "open", requester_id: "a1", target_id: "h1", payload: { question: "Ship on Friday?", extra: 1 }, response: null, created_at: "2026-09-28T09:30:00Z", responded_at: null, task_link: null }],
    };
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : String(input);
      if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
      if (url.startsWith("/api/containers/c1")) return jsonRes(snap);
      return jsonRes({ runs: [] });
    }) as unknown as typeof fetch;
    mount("/activity?view=events");
    const list = await screen.findByRole("list", { name: "Project events" });
    await waitFor(() => expect(list.textContent).toContain("Ship on Friday?"));
    expect(list.textContent).not.toContain("{");
    // kedar is the acting human: his own message reads "You", the question "to you"
    expect(list.textContent).toContain("You");
    expect(list.textContent).toContain("asked you a question");
    expect(list.textContent).not.toContain("kedar");
    expect(list.textContent).not.toMatch(/\bhuman\b/);
    expect(screen.queryByRole("button", { name: /Refresh/ })).toBeNull();
    // the refresh slot stays (empty, hidden from AT) so the agent chip never jumps
    expect(document.querySelector(".act-toolbar .act-slot")).not.toBeNull();
  });

  it("a project with no AI agents shows only the empty state (no filters)", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : String(input);
      if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
      if (url.startsWith("/api/containers/c1")) return jsonRes({ ...SNAP, agents: [SNAP.agents[0]] });
      return jsonRes({});
    }) as unknown as typeof fetch;
    mount();
    await screen.findByRole("heading", { name: "No AI agents yet" }).catch(() => screen.findAllByText("No AI agents yet"));
    // no agent chip and no run-state pills (they could only filter nothing) —
    // just the Runs/Events toggle; no invented zero counts
    expect(screen.queryByRole("button", { name: /Filter by agent/ })).toBeNull();
    expect(screen.queryByRole("radio", { name: "Running" })).toBeNull();
    expect(document.querySelector(".v2-pill-count")).toBeNull();
    expect(screen.getByRole("button", { name: /^Runs/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("rows carry a full-text tooltip and a one-line 'ago · duration' meta", async () => {
    mount();
    await waitFor(() => expect(rows().length).toBe(4));
    const killed = rows().find((r) => (r.textContent || "").includes("Killed"))!;
    expect(killed.getAttribute("title")).toContain("forge");
    expect(killed.getAttribute("title")).toContain("watchdog: hit the runtime cap");
    expect(killed.querySelector(".act-row-meta")!.textContent).toMatch(/ · 30m$/);
  });

  it("a running row shows ONE live time fact ('running 8m'), never 'ago · duration'", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-28T10:08:41Z"));
    mount();
    await waitFor(() => expect(rows().length).toBe(4));
    const live = rows().find((r) => (r.textContent || "").includes("Running"))!;
    const meta = live.querySelector(".act-row-meta")!;
    expect(meta.textContent).toBe("running 8m");
    expect(meta.textContent).not.toContain("ago");
    expect(meta.querySelector(".act-dur")).toBeNull();
  });

  it("an agent project whose runs window is empty hides the run-state pills", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : String(input);
      if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
      if (url.startsWith("/api/containers/c1")) return jsonRes(SNAP);
      return jsonRes({ runs: [] });
    }) as unknown as typeof fetch;
    mount();
    await screen.findAllByText("No runs yet");
    expect(screen.queryByRole("radio", { name: /^Running/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Filter by agent|All agents/ })).toBeInTheDocument();
  });

  it("groups runs under collapsible day bands (Linear list bands) whose counts add up", async () => {
    mount();
    await waitFor(() => expect(rows().length).toBe(4));
    const toggles = Array.from(document.querySelectorAll<HTMLButtonElement>(".act-group .v2-group-toggle"));
    expect(toggles.length).toBeGreaterThan(0);
    const total = toggles.map((b) => Number(b.querySelector(".v2-group-count")?.textContent || 0)).reduce((a, b) => a + b, 0);
    expect(total).toBe(4);
    // collapsing a band hides its rows (aria-expanded + hidden region)
    const first = toggles[0];
    const region = document.getElementById(first.getAttribute("aria-controls")!)!;
    expect(region.hidden).toBe(false);
    fireEvent.click(first);
    expect(first).toHaveAttribute("aria-expanded", "false");
    expect(region.hidden).toBe(true);
  });

  it("the Runs/Events view toggle (not a state pill) switches view, drops the run and the run-state filter", async () => {
    mount("/activity?run=r-ok&state=finished");
    await screen.findByRole("region", { name: "Run r-ok" });
    // Events is not one of the run-state pills
    expect(screen.queryByRole("radio", { name: /Events/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Events/ }));
    await waitFor(() => expect(loc).toContain("view=events"));
    expect(loc).not.toContain("run=");
    expect(loc).not.toContain("state="); // no dead filter leaks into the Events URL
    expect(screen.queryByRole("button", { name: /Refresh/ })).toBeNull();
    // the run-state pills are gone; the Events view has its own kind pills
    expect(screen.queryByRole("radio", { name: /^Failed/ })).toBeNull();
    expect(screen.getByRole("radio", { name: /^All events/ })).toHaveAttribute("aria-checked", "true");
    // the agent chip keeps its place in both views
    expect(screen.getByRole("button", { name: /Filter by agent/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Runs/ }));
    await waitFor(() => expect(loc).not.toContain("view=events"));
  });

  it("Escape closes the open run (URL loses &run=) unless typing", async () => {
    mount("/activity?run=r-ok");
    await screen.findByRole("region", { name: "Run r-ok" });
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(loc).not.toContain("run="));
    expect(screen.queryByRole("region", { name: "Run r-ok" })).toBeNull();
  });

  it("the agent filter is a chip + menu of avatars that sets ?agent=", async () => {
    mount();
    await waitFor(() => expect(rows().length).toBe(4));
    const chip = screen.getByRole("button", { name: /Filter by agent: all agents/ });
    expect(chip.tagName).toBe("BUTTON");
    expect(document.querySelector("select")).toBeNull();
    fireEvent.click(chip);
    const menu = await screen.findByRole("menu", { name: "Filter by agent" });
    const items = within(menu).getAllByRole("menuitemradio");
    expect(items.map((i) => i.querySelector(".v2-menu-label")!.textContent)).toEqual(["All agents", "forge", "scout"]);
    expect(items[0]).toHaveAttribute("aria-checked", "true");
    expect(menu.querySelectorAll(".v2-av").length).toBe(2); // round avatars, not bare names
    fireEvent.click(items[2]);
    await waitFor(() => expect(loc).toContain("agent=scout"));
    await waitFor(() => expect(rows().length).toBe(1));
    expect(screen.getByRole("button", { name: /Filter by agent: scout/ })).toBeInTheDocument();
  });

  it("failure reasons stay on the row as muted text (no loud red / amber text)", async () => {
    mount();
    await waitFor(() => expect(rows().length).toBe(4));
    const reason = document.querySelector(".act-row-reason")!;
    expect(reason).toBeTruthy();
    expect(reason.className).not.toMatch(/act-tone-/);
  });

  it("Events timeline: every event is one muted line (no cards) linked to its task / request, filterable by kind", async () => {
    const snap = {
      ...SNAP,
      tasks: [{ ...SNAP.tasks[0], message_summary: { count: 1, last: { body: "Pushed a fix", created_at: "2026-09-28T09:00:00Z", is_human: false, author_alias: "forge" } } }],
      requests: [{ id: "q1", type: "plan_approval", status: "open", from: "forge", to: "kedar", requester_id: "a1", target_id: "h1", payload: { summary: "Rotate keys" }, response: null, created_at: "2026-09-28T09:30:00Z", responded_at: null, task_link: null }],
    };
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : String(input);
      if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
      if (url.startsWith("/api/containers/c1")) return jsonRes(snap);
      return jsonRes({ runs: [] });
    }) as unknown as typeof fetch;
    mount("/activity?view=events");
    const list = await screen.findByRole("list", { name: "Project events" });
    await waitFor(() => expect(list.textContent).toContain("Pushed a fix"));
    expect(within(list).getByRole("link", { name: "Fix login" })).toHaveAttribute("href", "/tasks?task=t1");
    const req = within(list).getByRole("link", { name: /Rotate keys/ });
    expect(req).toHaveAttribute("href", "/requests?req=q1");
    expect(req.closest("li")!.textContent).toMatch(/asked (you|kedar) to approve a plan/);
    expect(list.textContent).not.toContain("plan_approval");
    // Linear activity lines, not bordered cards
    expect(list.querySelector(".v2-tl-card")).toBeNull();
    expect(list.querySelectorAll(".v2-tl-event").length).toBe(2);
    expect(within(list).getByText("Pushed a fix").closest("li")!.textContent).toMatch(/forge.*commented on/);
    // kind pills: Messages hides the request
    expect(screen.getByRole("radio", { name: /^Requests/ }).textContent).toContain("1");
    fireEvent.click(screen.getByRole("radio", { name: /^Messages/ }));
    await waitFor(() => expect(loc).toContain("kind=messages"));
    await waitFor(() => expect(list.querySelectorAll(".v2-tl-event").length).toBe(1));
    expect(list.textContent).not.toContain("Rotate keys");
  });

  it("Events view lists snapshot-derived events and keeps the tab in the URL", async () => {
    mount("/activity?view=events");
    await screen.findByText("No events");
    // the explainer is the Events toggle's tooltip, not a sentence on the page (D12)
    const toggle = screen.getByRole("button", { name: /^Events/ });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle.getAttribute("title")).toMatch(/latest task messages and request activity/i);
    expect(document.querySelector(".act-feed")!.textContent).not.toMatch(/Latest task messages/);
  });
});

/* ---- live log: follow only at the bottom, Jump to latest, details survive ---- */
class FakeES {
  static all: FakeES[] = [];
  url: string;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) { this.url = url; FakeES.all.push(this); }
  close() {}
  emit(d: unknown) { this.onmessage?.({ data: JSON.stringify(d) }); }
}

describe("ActivityPage live run log", () => {
  beforeEach(() => {
    stubFetch();
    FakeES.all = [];
    (globalThis as { EventSource?: unknown }).EventSource = FakeES;
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    delete (globalThis as { EventSource?: unknown }).EventSource;
  });

  it("streams, reports Live only once open, keeps expanded tool details open across appends, and offers Jump to latest after scrolling up", async () => {
    mount("/activity?run=r-live");
    await screen.findByRole("region", { name: "Run r-live" });
    const es = await waitFor(() => {
      const s = FakeES.all.find((x) => x.url === "/api/agents/a1/runs/r-live/stream");
      expect(s).toBeTruthy();
      return s!;
    });
    expect(screen.getByText("Connecting to stream…")).toBeInTheDocument();
    act(() => es.onopen?.());
    expect(screen.getByText("Live stream")).toBeInTheDocument();

    const toolLine = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls -la" } }] } });
    act(() => es.emit({ seq: 1, line: toolLine }));
    const log = screen.getByRole("log", { name: "Run log" });
    const more = await waitFor(() => {
      const d = within(log).getByRole("button", { name: "Details" });
      expect(d).toHaveAttribute("aria-expanded", "false");
      return d;
    });
    // the tool row reads as "Bash · ls -la", never raw JSON
    expect(log.textContent).toContain("Bash · ls -la");
    expect(log.textContent).not.toContain('{"command"');
    fireEvent.click(more);
    const panel = document.getElementById(more.getAttribute("aria-controls")!)!;
    expect(panel.textContent).toContain("Command");
    expect(panel.textContent).toContain("ls -la");

    // reader scrolls up: the log reports it is not at the bottom
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 200 });
    log.scrollTop = 100;
    fireEvent.scroll(log);
    act(() => es.emit({ seq: 2, line: JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "next step" }] } }) }));

    const jump = await screen.findByRole("button", { name: /Jump to latest/ });
    expect(jump.textContent).toContain("New lines");
    expect(log.scrollTop).toBe(100); // never yanked while reading
    expect(within(log).getAllByRole("button", { name: "Details" })[0]).toBe(more); // same node …
    expect(more).toHaveAttribute("aria-expanded", "true"); // … still expanded
    expect(document.getElementById(more.getAttribute("aria-controls")!)).toBe(panel);
    fireEvent.click(jump);
    expect(screen.queryByRole("button", { name: /Jump to latest/ })).toBeNull();

    act(() => es.onerror?.());
    expect(screen.getByText("Reconnecting…")).toBeInTheDocument();
  });
});
