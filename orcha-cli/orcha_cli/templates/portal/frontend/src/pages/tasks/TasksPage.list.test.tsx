/**
 * Tasks list / board polish (Linear "My issues" + "Agent tasks"):
 *  - with no explicit selection the split list opens the first task awaiting a
 *    human decision (TSK-004); with nothing to decide no task is auto-picked;
 *  - a selected task hidden by the filters closes the inspector with a note;
 *  - ↑/↓ j/k SELECT while the inspector is open (the preview follows);
 *  - group by assignee lists a multi-assignee task under every assignee;
 *  - the board hides finished columns by default (one click to show), columns
 *    can be hidden from their ⋯ menu, and label-less cards carry no chip row;
 *  - an empty result shows ONE clear affordance;
 *  - cancelling a pushed New task composer returns to where the user was.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { TasksPage } from "./TasksPage";
import { boardColumnHidden } from "./TaskListView";
import { tasksListCss as listCss } from "./tasksListCss";

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
let loc = { pathname: "", search: "" };

const jsonRes = (data: unknown, status = 200) => ({ ok: status < 300, status, json: async () => data }) as Response;

beforeEach(() => {
  SNAP = {
    container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
    agents: [
      { id: "h1", alias: "kedar", kind: "human", status: "idle" },
      { id: "a1", alias: "forge", kind: "ai", status: "idle" },
      { id: "a2", alias: "mira", kind: "ai", status: "idle" },
    ],
    tasks: [
      task("t1aaaaaa", "Verify me", "needs_verification", 10, { created_at: "2026-08-04T00:00:00Z" }),
      task("t2bbbbbb", "Second task", "in_progress", 50, { created_at: "2026-08-03T00:00:00Z", assignees: ["forge", "mira"] }),
      task("t3cccccc", "Mira's work", "ready", 30, { assignees: ["mira"], created_at: "2026-08-02T00:00:00Z" }),
      task("t4dddddd", "Shipped thing", "completed", 100, { created_at: "2026-08-01T00:00:00Z" }),
    ],
    requests: [],
  };
  window.scrollTo = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
      if (url.startsWith("/api/containers/c1")) return jsonRes(SNAP);
      if (/\/messages$/.test(url)) return jsonRes({ messages: [] });
      if (/\/runs$/.test(url)) return jsonRes([]);
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

function Probe() {
  const l = useLocation();
  loc = { pathname: l.pathname, search: l.search };
  return null;
}

function renderPage(entries: string[] = ["/tasks"], index?: number) {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={entries} initialIndex={index ?? entries.length - 1}>
          <TasksPage />
          <Probe />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

const rows = () => Array.from(document.querySelectorAll<HTMLElement>(".trow"));
const rowIds = () => rows().map((r) => r.getAttribute("data-id"));
const urlTask = () => new URLSearchParams(loc.search).get("task");
const inspectorOpen = () => !!document.querySelector("#detailMain");

describe("Tasks list — default selection (TSK-004) / explicit selection", () => {
  it("opens the first needs_verification task by default, derived (not written to ?task=)", async () => {
    renderPage(["/tasks"]);
    await waitFor(() => expect(inspectorOpen()).toBe(true));
    expect(document.querySelector(".trow.is-selected")?.getAttribute("data-id")).toBe("t1aaaaaa");
    expect(urlTask()).toBeNull();
    // its verification gate is on screen
    expect(await screen.findByRole("button", { name: /^Accept/ })).toBeInTheDocument();
  });

  it("falls back to a pending plan, never to an arbitrary first row", async () => {
    const tasks = SNAP.tasks as Record<string, unknown>[];
    tasks[0].status = "completed";
    tasks[1].plan_message = { body: "My plan", author_alias: "forge", at: "2026-08-03T01:00:00Z" };
    renderPage(["/tasks"]);
    await waitFor(() => expect(inspectorOpen()).toBe(true));
    expect(document.querySelector(".trow.is-selected")?.getAttribute("data-id")).toBe("t2bbbbbb");
  });

  it("closing the default inspector keeps it closed", async () => {
    renderPage(["/tasks"]);
    await waitFor(() => expect(inspectorOpen()).toBe(true));
    act(() => {
      (document.activeElement as HTMLElement | null)?.blur?.();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await waitFor(() => expect(inspectorOpen()).toBe(false));
    expect(document.querySelector(".trow.is-selected")).toBeNull();
  });

  it("the board never auto-opens a task", async () => {
    renderPage(["/tasks?view=board"]);
    await screen.findByRole("region", { name: "In progress" });
    expect(inspectorOpen()).toBe(false);
  });

  it("does not open the inspector when nothing awaits a decision", async () => {
    (SNAP.tasks as Record<string, unknown>[])[0].status = "completed";
    renderPage(["/tasks"]);
    await waitFor(() => expect(rowIds()).toHaveLength(4));
    expect(inspectorOpen()).toBe(false);
    expect(document.querySelector(".trow.is-selected")).toBeNull();
    // picking a row opens it
    fireEvent.click(rows()[1]);
    await waitFor(() => expect(urlTask()).toBe(rowIds()[1]));
    expect(inspectorOpen()).toBe(true);
  });

  it("a selected task hidden by the filters closes the inspector and says so", async () => {
    renderPage(["/tasks?task=t1aaaaaa&status=ready"]);
    const note = await waitFor(() => {
      const n = document.querySelector("[data-hidden-selection]");
      expect(n).toBeTruthy();
      return n as HTMLElement;
    });
    expect(note.textContent).toContain("Verify me");
    expect(inspectorOpen()).toBe(false);
    expect(rowIds()).toEqual(["t3cccccc"]);
    fireEvent.click(within(note).getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(inspectorOpen()).toBe(true));
    expect(document.querySelector("[data-hidden-selection]")).toBeNull();
    expect(urlTask()).toBe("t1aaaaaa");
  });
});

describe("Tasks list — keyboard selection follows the inspector", () => {
  it("↓ and j on a focused row select the next task while the inspector is open", async () => {
    renderPage(["/tasks?task=t1aaaaaa"]);
    await waitFor(() => expect(inspectorOpen()).toBe(true));
    const order = rowIds();
    const first = rows()[0];
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    await waitFor(() => expect(urlTask()).toBe(order[1]));
    fireEvent.keyDown(document.activeElement!, { key: "j" });
    await waitFor(() => expect(urlTask()).toBe(order[2]));
    fireEvent.keyDown(document.activeElement!, { key: "k" });
    await waitFor(() => expect(urlTask()).toBe(order[1]));
  });

  it("j/k work from anywhere on the page (focus not in a field)", async () => {
    renderPage(["/tasks?task=t1aaaaaa"]);
    await waitFor(() => expect(inspectorOpen()).toBe(true));
    const order = rowIds();
    (document.activeElement as HTMLElement | null)?.blur?.();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
    });
    await waitFor(() => expect(urlTask()).toBe(order[1]));
  });

  it("without an open inspector ↓ only moves focus (Enter opens)", async () => {
    (SNAP.tasks as Record<string, unknown>[])[0].status = "completed"; // nothing to decide → no default inspector
    renderPage(["/tasks"]);
    await waitFor(() => expect(rowIds()).toHaveLength(4));
    const first = rows()[0];
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows()[1]);
    expect(urlTask()).toBeNull();
  });
});

describe("Tasks list — grouping and empty results", () => {
  it("group by assignee lists a multi-assignee task under each assignee", async () => {
    renderPage(["/tasks?group=assignee"]);
    await waitFor(() => expect(document.querySelectorAll(".tl-group").length).toBe(2));
    const forge = document.querySelector('.tl-group[data-group="forge"]')!;
    const mira = document.querySelector('.tl-group[data-group="mira"]')!;
    expect(forge.querySelector('[data-id="t2bbbbbb"]')).toBeTruthy();
    expect(mira.querySelector('[data-id="t2bbbbbb"]')).toBeTruthy();
  });

  it("an empty result offers one Clear filters, not a second inline 'clear'", async () => {
    renderPage(["/tasks?q=zzzznomatch"]);
    expect(await screen.findByText(/No tasks match these filters/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "clear" })).toBeNull();
  });
});

describe("Tasks board — columns", () => {
  it("boardColumnHidden: finished columns hidden by default, shown when the filter asks, explicit choice wins", () => {
    expect(boardColumnHidden("completed", {}, [])).toBe(true);
    expect(boardColumnHidden("cancelled", {}, [])).toBe(true);
    expect(boardColumnHidden("in_progress", {}, [])).toBe(false);
    expect(boardColumnHidden("completed", { completed: false }, [])).toBe(false);
    expect(boardColumnHidden("in_progress", { in_progress: true }, [])).toBe(true);
    expect(boardColumnHidden("completed", {}, ["completed", "cancelled"])).toBe(false);
    expect(boardColumnHidden("completed", { completed: true }, ["completed"])).toBe(false);
  });

  it("hides the Completed column by default and shows it from the Hidden columns strip", async () => {
    renderPage(["/tasks?view=board"]);
    await screen.findByRole("region", { name: "In progress" });
    expect(screen.queryByRole("region", { name: "Completed" })).toBeNull();
    const show = document.querySelector<HTMLButtonElement>('[data-show-column="completed"]')!;
    expect(show.textContent).toContain("1");
    fireEvent.click(show);
    const col = await screen.findByRole("region", { name: "Completed" });
    expect(within(col).getByRole("button", { name: /Shipped thing/ })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("orcha:v2:tasks:boardHidden") || "{}")).toEqual({ completed: false });
  });

  it("a column's ⋯ menu hides it", async () => {
    renderPage(["/tasks?view=board"]);
    const col = await screen.findByRole("region", { name: "Ready" });
    fireEvent.click(within(col).getByRole("button", { name: "Ready column options" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Hide column/ }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Ready" })).toBeNull());
    expect(document.querySelector('[data-show-column="ready"]')).toBeTruthy();
  });

  it("the Ready column offers + New task; priority always leads the chip row", async () => {
    renderPage(["/tasks?view=board"]);
    const ready = await screen.findByRole("region", { name: "Ready" });
    expect(within(ready).getByRole("button", { name: "New task" })).toBeInTheDocument();
    const card = within(ready).getByRole("button", { name: /Mira's work/ });
    // Linear "Agent tasks": the priority bars sit first in the chip row on
    // every card (never beside the id on chip-less cards)
    const chips = card.querySelector(".v2-bcard-chips");
    expect(chips).toBeTruthy();
    expect(chips!.firstElementChild!.classList.contains("tl-pchip")).toBe(true);
    expect(card.querySelector(".v2-bcard-id [data-priority]")).toBeNull();
  });

  it("the Hidden columns rail sits BESIDE the scrolling board (fixed rail, never inside the scroller)", async () => {
    renderPage(["/tasks?view=board"]);
    await screen.findByRole("region", { name: "In progress" });
    const board = screen.getByRole("region", { name: "Task board" });
    // not a sticky flex item inside the board (it shrank to 130 px and overlapped the columns)
    expect(board.classList.contains("has-aside")).toBe(false);
    expect(board.querySelector("[data-show-column]")).toBeNull();
    const rail = screen.getByRole("complementary", { name: "Hidden columns" });
    expect(rail.classList.contains("tl-hiddenrail")).toBe(true);
    expect(rail.parentElement).toBe(board.parentElement);
    expect(rail.parentElement!.classList.contains("tl-boardrow")).toBe(true);
    expect(rail.querySelector('[data-show-column="completed"]')).toBeTruthy();
    // the rail is a fixed 200 px column outside the scroller
    expect(listCss).toMatch(/\.tl-hiddenrail\s*\{[^}]*flex:\s*0 0 200px/);
  });
});

describe("New task composer — cancel returns to where the user was", () => {
  const cancel = () => {
    const d = screen.getByRole("dialog");
    const btn = within(d).queryByRole("button", { name: /^Cancel$/ }) || within(d).getAllByRole("button", { name: /close/i })[0];
    fireEvent.click(btn);
  };

  it("pushed ?new=1 (from another page) → cancel goes back", async () => {
    renderPage(["/", "/tasks?new=1"]);
    await screen.findByRole("dialog");
    cancel();
    await waitFor(() => expect(loc.pathname).toBe("/"));
  });

  it("a cold deep link just drops the param", async () => {
    renderPage(["/tasks?new=1"]);
    await screen.findByRole("dialog");
    cancel();
    await waitFor(() => expect(new URLSearchParams(loc.search).get("new")).toBeNull());
    expect(loc.pathname).toBe("/tasks");
  });
});

function mockMedia(maxWidth: number) {
  const width = maxWidth;
  vi.stubGlobal("matchMedia", (q: string) => {
    const m = /max-width:\s*(\d+)px/.exec(q);
    return { matches: m ? width <= Number(m[1]) : false, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false };
  });
  window.matchMedia = (globalThis as unknown as { matchMedia: typeof window.matchMedia }).matchMedia;
}

describe("toolbar polish (round 2)", () => {
  it("the toolbar field is a filter (distinct from the header search)", async () => {
    renderPage(["/tasks"]);
    const f = (await screen.findByLabelText("Filter tasks")) as HTMLInputElement;
    expect(f.placeholder).toBe("Filter tasks…");
  });

  it("Filter popover: no visible native boxes, a trailing check marks chosen items, inputs stay operable", async () => {
    renderPage(["/tasks?status=in_progress"]);
    await screen.findByText("Second task");
    fireEvent.click(document.querySelector<HTMLButtonElement>("[data-filter-btn]")!);
    const pop = await screen.findByRole("dialog", { name: "Filter by status and assignee" });
    const inProg = within(pop).getByRole("checkbox", { name: /In progress/ }) as HTMLInputElement;
    expect(inProg.checked).toBe(true);
    expect(inProg.classList.contains("wk-pop-in")).toBe(true);
    const opt = inProg.closest("label")!;
    expect(opt.querySelector(".wk-pop-check .v2-ico")).toBeTruthy();
    const ready = within(pop).getByRole("checkbox", { name: /Ready/ }) as HTMLInputElement;
    expect(ready.closest("label")!.querySelector(".wk-pop-check .v2-ico")).toBeNull();
    fireEvent.click(ready);
    await waitFor(() => expect(new URLSearchParams(loc.search).get("status")).toBe("in_progress,ready"));
    // assignee radio: "Any assignee" is checked → carries the check
    const any = within(pop).getByRole("radio", { name: /Any assignee/ }) as HTMLInputElement;
    expect(any.checked).toBe(true);
    expect(any.closest("label")!.querySelector(".wk-pop-check .v2-ico")).toBeTruthy();
  });

  it("phone: the scope pills collapse into one menu that switches scope", async () => {
    mockMedia(390);
    renderPage(["/tasks"]);
    await screen.findByText("Second task");
    expect(document.querySelector(".tl-scopes")).toBeNull();
    const btn = document.querySelector<HTMLButtonElement>(".tl-scopemenu")!;
    expect(btn.textContent).toContain("All tasks");
    expect(btn.textContent).toContain("4");
    fireEvent.click(btn);
    const menu = await screen.findByRole("menu", { name: "Task scope" });
    expect(within(menu).getByRole("menuitemradio", { name: /All tasks/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /Done/ }));
    await waitFor(() => expect(new URLSearchParams(loc.search).get("status")).toBe("completed,cancelled"));
  });

  it("narrow board: hidden columns render as a line above the board, not a side rail", async () => {
    mockMedia(390);
    renderPage(["/tasks?view=board"]);
    await screen.findByRole("region", { name: "In progress" });
    expect(document.querySelector(".tl-hiddencols-top [data-show-column=\"completed\"]")).toBeTruthy();
    expect(document.querySelector(".v2-board-aside")).toBeNull();
  });
});

describe("after create", () => {
  it("shows a loading skeleton (not 'Task not found') until the snapshot carries the new task", async () => {
    let created = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method || "GET";
        if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
        if (url.startsWith("/api/containers/c1") && method === "GET") return jsonRes(SNAP);
        if (/\/api\/containers\/c1\/tasks$/.test(url) && method === "POST") {
          created = true;
          return jsonRes({ task_id: "tnew0001", status: "ready" });
        }
        if (/\/messages$/.test(url)) return jsonRes({ messages: [] });
        if (/\/runs$/.test(url)) return jsonRes([]);
        return jsonRes({});
      }),
    );
    renderPage(["/tasks?new=1"]);
    const d = await screen.findByRole("dialog");
    for (const box of within(d).getAllByRole("textbox")) fireEvent.change(box, { target: { value: "Brand new" } });
    const submit = within(d).getAllByRole("button").find((b) => /create/i.test(b.textContent || ""))!;
    fireEvent.click(submit);
    await waitFor(() => expect(created).toBe(true));
    await waitFor(() => expect(new URLSearchParams(loc.search).get("task")).toBe("tnew0001"));
    expect(await screen.findByRole("status", { name: "Loading the new task" })).toBeInTheDocument();
    expect(screen.queryByText("Task not found")).toBeNull();
  });
});
