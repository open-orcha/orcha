/**
 * Linear review round 3 — tasks fixer: gate evidence styles shared with Needs
 * (workCss), hanging plan steps, the PR chip IN the result sentence (one
 * "#102"), no age on the plan gate header, one icon per activity event, the
 * full-view header title only once the H1 scrolls out, the phone Properties
 * disclosure, and the New-task composer (⌘↵, priority bars in the menu,
 * borderless protocol lines, hidden dependency checkboxes).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { TasksPage } from "./TasksPage";
import { resultWithPr } from "./TaskDetail";
import { workCss } from "./workCss";
import { taskDetailCss as detailCss } from "./detailCss";
import { composerCss } from "./composerCss";

function task(id: string, title: string, status: string, priority: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    title,
    status,
    priority,
    assignees: ["forge"],
    created_by_agent_id: "h1",
    created_at: "2026-08-01T00:00:00Z",
    definition_of_done: "DoD for " + title,
    message_summary: { count: 0, last: null },
    ...extra,
  };
}

let SNAP: Record<string, unknown>;
let RUNS: unknown[] = [];
let MSGS: unknown[] = [];
let calls: { url: string; method: string; body: unknown }[] = [];
const jsonRes = (data: unknown, status = 200) => ({ ok: status < 300, status, json: async () => data }) as Response;

beforeEach(() => {
  calls = [];
  RUNS = [];
  MSGS = [];
  SNAP = {
    container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
    agents: [
      { id: "h1", alias: "kedar", kind: "human", status: "idle" },
      { id: "a1", alias: "forge", kind: "ai", status: "working" },
    ],
    tasks: [
      task("t1aaaaaa", "Verify me", "needs_verification", 10, { result: "I did the thing", created_at: "2026-08-01T00:00:00Z" }),
      task("t2bbbbbb", "Second task", "in_progress", 50, { created_at: "2026-08-02T00:00:00Z", started_at: "2026-08-02T01:00:00Z" }),
      task("t3cccccc", "Third task", "ready", 30, { created_at: "2026-08-03T00:00:00Z" }),
    ],
    requests: [],
  };
  window.scrollTo = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init && init.method) || "GET";
      let body: unknown;
      if (init && typeof init.body === "string") body = JSON.parse(init.body);
      calls.push({ url, method, body });
      if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
      if (url.startsWith("/api/containers/c1")) return jsonRes(SNAP);
      if (/\/messages$/.test(url) && method === "GET") return jsonRes({ messages: MSGS });
      if (/\/runs$/.test(url)) return jsonRes(RUNS);
      if (/\/close-implications$/.test(url))
        return jsonRes({
          downstream_tasks: [],
          in_flight_agents: [],
          spawned_from_request: null,
          open_requests_from_assignees: [],
          summary: { downstream_total: 0, would_unblock: 0, still_blocked: 0, in_flight_agents: 0, open_requests: 0, completes_container: false },
        });
      return jsonRes({});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    /* jsdom */
  }
});

function renderPage(entry: string) {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[entry]}>
          <TasksPage />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

const pane = () => document.querySelector("#detailMain .td-pane") as HTMLElement;
const PR_RESULT = { summary: "Implemented and tested; PR #102 opened. All tests pass.", pr_url: "https://github.com/o/r/pull/102", pr_number: 102 };

describe("gate evidence + plan styles live in workCss (Needs injects only workCss)", () => {
  it("workCss carries the evidence separator rules; detailCss no longer does", () => {
    expect(workCss).toMatch(/\.td-ev-part \+ \.td-ev-part::before\s*\{[^}]*content:\s*"·"/);
    expect(workCss).toMatch(/\.td-ev-part\s*\{[^}]*display:\s*inline-flex/);
    expect(workCss).toMatch(/\.td-ev-status\s*\{/);
    expect(workCss).toMatch(/\.td-ev-line\s*\{[^}]*display:\s*flex/);
    expect(detailCss).not.toMatch(/\.td-ev-part/);
  });
  it("numbered plan steps hang (the number sits outside the wrapped text)", () => {
    expect(workCss).toMatch(/\.wk-md \.md-li\.md-oli[^{]*\{[^}]*padding-left:\s*24px/);
    expect(workCss).toMatch(/\.wk-md \.md-oli > \.md-num\s*\{[^}]*position:\s*absolute/);
  });
});

describe("result with a PR — the chip sits IN the sentence (one #102)", () => {
  it("resultWithPr replaces the 'PR #102' mention and drops the repeated link + number keys", () => {
    const r = resultWithPr({ ...PR_RESULT, tests: 214 })!;
    expect(r).toBeTruthy();
    expect(Object.keys(r.rest)).toEqual(["tests"]);
    render(<div data-testid="l">{r.line}</div>);
    const l = screen.getByTestId("l");
    expect(l.textContent).toBe("Implemented and tested; #102 opened. All tests pass.");
    expect(l.querySelectorAll('a[href="https://github.com/o/r/pull/102"]').length).toBe(1);
  });
  it("appends the chip when the summary never names the PR; null without a PR or a summary", () => {
    const r = resultWithPr({ summary: "Done", pr_url: "https://github.com/o/r/pull/7" })!;
    render(<div data-testid="l">{r.line}</div>);
    expect(screen.getByTestId("l").textContent).toBe("Done #7");
    expect(resultWithPr({ summary: "Done" })).toBeNull();
    expect(resultWithPr({ pr_url: "https://github.com/o/r/pull/7" })).toBeNull();
    expect(resultWithPr("PR #7")).toBeNull();
  });
  it("the verification gate shows ONE #102 link, inline on the result line (no separate block)", async () => {
    (SNAP.tasks as Record<string, unknown>[])[0].result = PR_RESULT;
    renderPage("/tasks?task=t1aaaaaa");
    const gate = await waitFor(() => {
      const g = document.querySelector('.td-gate[data-kind="verify"]') as HTMLElement;
      expect(g).toBeTruthy();
      return g;
    });
    const links = Array.from(gate.querySelectorAll("a")).filter((a) => /#102/.test(a.textContent || ""));
    expect(links.length).toBe(1);
    expect(links[0].closest(".td-result-line")).toBeTruthy();
    expect(gate.querySelector(".v2-payload-refline, .v2-payload-refs")).toBeNull();
    expect((gate.textContent || "").match(/#102/g)!.length).toBe(1);
  });
});

describe("plan gate header — no age repeat (D12)", () => {
  it("reads 'by forge' only; the age stays on the row + timeline", async () => {
    SNAP.tasks = [
      task("t4dddddd", "Plan me", "in_progress", 10, {
        started_at: "2026-08-02T01:00:00Z",
        plan_message: { body: "1. Do a\n2. Do b", author_alias: "forge", at: new Date(Date.now() - 40 * 60000).toISOString() },
      }),
    ];
    renderPage("/tasks?task=t4dddddd");
    const by = await waitFor(() => {
      const el = document.querySelector('.td-gate[data-kind="plan"] .td-g-by') as HTMLElement;
      expect(el).toBeTruthy();
      return el;
    });
    expect(by.textContent).toBe("by forge");
  });
});

describe("activity timeline — one icon per event line", () => {
  it("run events carry the status glyph only (no inline actor avatar)", async () => {
    RUNS = [{ run_id: "r1", agent: "forge", status: "succeeded", exit_code: 0, started_at: "2026-08-02T02:00:00Z", ended_at: "2026-08-02T02:10:00Z" }];
    renderPage("/tasks?task=t2bbbbbb&full=1");
    const ev = await waitFor(() => {
      const li = Array.from(document.querySelectorAll(".td-acts li")).find((x) => /started a run/.test(x.textContent || "")) as HTMLElement;
      expect(li).toBeTruthy();
      return li;
    });
    expect(ev.querySelector(".td-tl-who")!.textContent).toBe("forge");
    expect(ev.querySelector(".td-tl-who .v2-av, .td-tl-who [class*='avatar']")).toBeNull();
  });
});

describe("full view header — title only once the H1 scrolls out", () => {
  it("marks the pane while the H1 is visible, and flips when it leaves", async () => {
    let cb: ((es: { isIntersecting: boolean }[]) => void) | null = null;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(f: (es: { isIntersecting: boolean }[]) => void) {
          cb = f;
        }
        observe() {}
        disconnect() {}
      },
    );
    renderPage("/tasks?task=t2bbbbbb&full=1");
    await waitFor(() => expect(pane()?.getAttribute("data-h1-visible")).toBe("true"));
    cb!([{ isIntersecting: false }]);
    await waitFor(() => expect(pane().getAttribute("data-h1-visible")).toBe("false"));
    expect(detailCss).toMatch(/\[data-h1-visible="true"\] \.td-head \.v2-pagehead-title\s*\{[^}]*visibility:\s*hidden/);
  });
  it("the phone rule no longer hides the header ID", () => {
    expect(detailCss).not.toMatch(/\.td-head \.td-id \{ display: none; \}/);
  });
});

describe("phone — Properties collapse to one disclosure line", () => {
  it("renders 'Properties' collapsed above Activity; expanding reveals the rail", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("max-width: 560px"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
    renderPage("/tasks?task=t2bbbbbb&full=1");
    const btn = await screen.findByRole("button", { name: "Properties" });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    const body = document.getElementById(btn.getAttribute("aria-controls")!)!;
    expect(body.hidden).toBe(true);
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(body.hidden).toBe(false);
  });
});

describe("New task composer (r3)", () => {
  const openComposer = async () => {
    renderPage("/tasks?new=1");
    return screen.findByRole("dialog", { name: /New task/ });
  };
  it("priority menu items lead with the priority bars glyph", async () => {
    const dialog = await openComposer();
    fireEvent.click(dialog.querySelector("#nt_pri")!);
    const pm = await screen.findByRole("menu", { name: "Priority" });
    const items = within(pm).getAllByRole("menuitemradio");
    // the four presets + "Custom…" (an exact number — numeric priorities stay settable, TSK-035)
    expect(items.map((i) => i.textContent)).toEqual(["Urgent", "High", "Normal", "Low", "Custom…"]);
    for (const i of items) expect(i.querySelector(".td-people-ico [data-priority], .td-people-ico svg, .td-people-ico span")).toBeTruthy();
    expect(within(pm).getByRole("menuitemradio", { name: /Normal/ }).getAttribute("aria-checked")).toBe("true");
  });
  it("⌘↵ creates from any field; the button shows the hint", async () => {
    const dialog = await openComposer();
    expect(dialog.querySelector(".nt-kbd")!.textContent).toBe("⌘↵");
    fireEvent.change(document.querySelector("#nt_title")!, { target: { value: "Ship it" } });
    fireEvent.change(document.querySelector("#nt_dod")!, { target: { value: "It ships" } });
    fireEvent.keyDown(document.querySelector("#nt_dod")!, { key: "Enter", metaKey: true });
    await waitFor(() => expect(calls.some((c) => c.url === "/api/containers/c1/tasks" && c.method === "POST")).toBe(true));
  });
  it("protocol fields are borderless lines with accessible names (no labelled boxes)", async () => {
    const dialog = await openComposer();
    fireEvent.click(dialog.querySelector("[data-proto-toggle]")!);
    const proto = dialog.querySelector("#nt_proto") as HTMLElement;
    expect(proto.hidden).toBe(false);
    expect(proto.querySelector(".wk-textarea")).toBeNull();
    expect(within(proto).getByLabelText("Review chain").id).toBe("nt_p_chain");
    expect(within(proto).getByLabelText("Notes").id).toBe("nt_p_notes");
    expect(composerCss).toMatch(/\.nt-proto-in\s*\{[^}]*border:\s*0/);
  });
  it("dependency options keep checkbox semantics but hide the native box behind a trailing check", async () => {
    const dialog = await openComposer();
    fireEvent.click(dialog.querySelector("[data-deps-btn]")!);
    const list = await screen.findByRole("group", { name: "Open tasks" });
    const cb = within(list).getAllByRole("checkbox")[0];
    expect(cb.classList.contains("v2-sr")).toBe(true);
    fireEvent.click(cb);
    expect(cb.closest(".wk-deps-opt")!.querySelector(".wk-deps-check svg, .wk-deps-check .v2-ico")).toBeTruthy();
  });
  it("the property row never wraps on a phone", () => {
    expect(composerCss).toMatch(/@media \(max-width: 480px\)\s*\{\s*\.nt-props\s*\{[^}]*flex-wrap:\s*nowrap;[^}]*overflow-x:\s*auto/);
  });
});
