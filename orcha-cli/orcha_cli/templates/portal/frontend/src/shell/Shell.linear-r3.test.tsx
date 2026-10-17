/**
 * Linear pop — round 3 header fixes (shell-header):
 *  - "c" opens the New task composer (Linear's create key), never while typing,
 *    inside a dialog, or without an acting human; the palette action shows "C".
 *  - the 390 px ⋯ overflow menu: every entry is a menu row; the connection row
 *    is NOT a .v2-conn header glyph (its 28 px circle broke the row).
 *  - the compact Execution chip is a power glyph with a state-dot badge.
 *  - autonomy segments carry no per-segment dot.
 *  - notification rows name the event once (object title + "Task verified · who").
 *  - the page toolbar reveals the selected pill when its row scrolls.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/ui";
import { SnapshotProvider } from "../state/SnapshotProvider";
import { TasksPage } from "../pages/tasks/TasksPage";
import { Shell, ncEarlierRow, ncStripEventSuffix } from "./Shell";
import { isCreateKey } from "./chrome";
import { PageToolbar } from "./PageChrome";
import { FilterPills } from "../components/primitives/FilterPills";
import { installBuiltinProviders } from "./search/builtin";
import { searchProviders } from "./search/providers";

const snapWith = (humans = true) => ({
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan", wakes_enabled: true },
  agents: [
    ...(humans ? [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }] : []),
    { id: "a1", alias: "forge", kind: "ai", status: "working" },
  ],
  tasks: [{ id: "t1", title: "Refactor notification center", status: "completed", priority: 10, assignees: ["forge"] }],
  requests: [],
});

let SNAP: ReturnType<typeof snapWith>;
function stubFetch() {
  const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1")) return json(SNAP);
    if (/\/runs$/.test(url)) return json([]);
    if (/\/notifications/.test(url)) return json({ notifications: [] });
    return json({});
  }));
}

const origWidth = window.innerWidth;
function setWidth(w: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: w });
}

function mountShell(path = "/tasks", page = "tasks", props: Partial<Parameters<typeof Shell>[0]> = {}) {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[path]}>
          <Shell page={page} title="Tasks" {...props}><div>body</div></Shell>
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

beforeEach(() => { localStorage.clear(); SNAP = snapWith(); stubFetch(); window.scrollTo = vi.fn(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); setWidth(origWidth); });

describe('"c" opens New task (Linear create key)', () => {
  it("isCreateKey: a bare c only", () => {
    const k = (o: Partial<KeyboardEvent>) => isCreateKey({ key: "c", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, ...o });
    expect(k({})).toBe(true);
    expect(k({ key: "C", shiftKey: true })).toBe(false);
    expect(k({ metaKey: true })).toBe(false);
    expect(k({ ctrlKey: true })).toBe(false);
    expect(k({ repeat: true })).toBe(false);
    expect(k({ key: "x" })).toBe(false);
  });

  it("pressing c on /tasks opens the page's New task composer (.wk-newtask)", async () => {
    render(
      <ToastProvider>
        <SnapshotProvider>
          <MemoryRouter initialEntries={["/tasks"]}>
            <TasksPage />
          </MemoryRouter>
        </SnapshotProvider>
      </ToastProvider>,
    );
    await screen.findAllByText("Refactor notification center");
    expect(document.querySelector(".wk-newtask")).toBeNull();
    fireEvent.keyDown(document.body, { key: "c" });
    await waitFor(() => expect(document.querySelector(".wk-newtask")).toBeTruthy());
  });

  it("is ignored while typing in a field", async () => {
    mountShell("/", "home");
    await screen.findAllByText("Orcha");
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: "c" });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
    input.remove();
  });

  it("is ignored while a modal dialog is open", async () => {
    mountShell("/", "home");
    await screen.findAllByText("Orcha");
    const dlg = document.createElement("div");
    dlg.setAttribute("role", "dialog");
    dlg.setAttribute("aria-modal", "true");
    dlg.id = "fake-dialog";
    document.body.appendChild(dlg);
    fireEvent.keyDown(document.body, { key: "c" });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(document.querySelectorAll('[aria-modal="true"]')).toHaveLength(1);
    dlg.remove();
  });

  it("with no acting human it never opens the composer (no impersonation) — a toast says why", async () => {
    SNAP = snapWith(false);
    mountShell("/", "home");
    await screen.findAllByText("Orcha");
    // "Orcha" can render (project list) before identity/snapshot settle, when the
    // toast honestly reads "Resolving your identity…" — press until authority lands
    await waitFor(() => {
      fireEvent.keyDown(document.body, { key: "c" });
      expect(screen.queryAllByText(/Pick an acting human first/).length).toBeGreaterThan(0);
    });
    expect(document.querySelector(".wk-newtask")).toBeNull();
  });

  it("the palette's New task action carries the C hint", () => {
    installBuiltinProviders();
    const actions = searchProviders().find((p) => p.id === "actions")!;
    const rows = actions.search("new task", {
      snap: null, cid: "c1", multi: false, projectName: "Orcha", projects: null,
      actingHuman: { id: "h1", alias: "kedar", kind: "human" } as never, embedded: false,
      openExecutionControls: () => {}, openCompose: () => {}, signal: new AbortController().signal,
    });
    const nt = (rows as { id: string; shortcut?: string }[]).find((r) => r.id === "new-task");
    expect(nt?.shortcut).toBe("C");
  });
});

describe("390 px ⋯ overflow menu", () => {
  it("every entry is a menu row; the connection row is not a .v2-conn header glyph", async () => {
    setWidth(390);
    mountShell("/tasks", "tasks", { primaryAction: <button type="button" className="v2-btn v2-btn-primary" aria-keyshortcuts="c">New task</button> });
    await screen.findAllByText("Orcha");
    const more = await waitFor(() => { const b = document.getElementById("hdrMore"); expect(b).toBeTruthy(); return b!; });
    // the primary is NOT in the header at overflow density
    expect(document.querySelector(".v2-header-primary")).toBeNull();
    fireEvent.click(more);
    const pop = await waitFor(() => { const p = document.querySelector(".v2-hdr-more-pop"); expect(p).toBeTruthy(); return p!; });
    const conn = pop.querySelector(".v2-hdr-more-conn")!;
    expect(conn).toBeTruthy();
    expect(conn.classList.contains("v2-conn")).toBe(false);
    expect(conn.classList.contains("v2-hdr-more-row")).toBe(true);
    expect(pop.querySelector(".v2-conn")).toBeNull();
    // the page's primary action sits in the menu, followed by a separator before the shell rows
    expect(pop.querySelector(".v2-hdr-more-primary button")?.textContent).toBe("New task");
    expect(pop.querySelector('.v2-hdr-more-sep[role="separator"]')).toBeTruthy();
  });
});

describe("Execution chip + popover", () => {
  it("the chip carries a power glyph (shown at compact densities) and the state dot", async () => {
    mountShell();
    const btn = await waitFor(() => { const b = document.getElementById("execBtn"); expect(b).toBeTruthy(); return b!; });
    expect(btn.querySelector("svg.v2-exec-glyph")).toBeTruthy();
    expect(btn.querySelector(".v2-exec-dot")).toBeTruthy();
    expect(btn.getAttribute("aria-label")).toMatch(/^Execution — /);
  });

  it("autonomy segments have no leading dot (the selected fill marks the level)", async () => {
    mountShell();
    const btn = await waitFor(() => { const b = document.getElementById("execBtn"); expect(b).toBeTruthy(); return b!; });
    fireEvent.click(btn);
    await waitFor(() => expect(document.getElementById("autTop")).toBeTruthy());
    const radios = Array.from(document.querySelectorAll('#autTop button[role="radio"]'));
    expect(radios).toHaveLength(3);
    for (const r of radios) expect(r.querySelector(".d")).toBeNull();
    expect(radios.map((r) => r.textContent)).toEqual(["Plan-only", "Build to PR", "Full"]);
  });
});

describe("notification rows state the event once (D12)", () => {
  it("strips the event suffix from a preview", () => {
    expect(ncStripEventSuffix("Refactor notification center — verified by hussein after reviewing")).toBe("Refactor notification center");
    expect(ncStripEventSuffix("Adopt the per-file edit lock")).toBe("Adopt the per-file edit lock");
    expect(ncStripEventSuffix("— verified")).toBe("— verified");
  });

  it("verified: title = the task's title, line 2 = event · actor, the preview moves to the tooltip", () => {
    const r = ncEarlierRow(
      { type: "task_verified", preview: "Refactor notification center — verified by hussein", actor_alias: "hussein", deeplink: { kind: "task", id: "t1" } },
      "Orcha",
      (d) => (d.id === "t1" ? "Refactor notification center" : null),
    );
    expect(r.ti).toBe("Refactor notification center");
    expect(r.me).toBe("Task verified · hussein");
    expect(r.ti).not.toMatch(/verified/);
    expect(r.tip).toBe("Refactor notification center — verified by hussein");
  });

  it("without a snapshot title the suffix is stripped; other kinds keep their preview", () => {
    expect(ncEarlierRow({ type: "task_assigned", preview: "Write QA scenarios — assigned by lead", actor_alias: "lead" }, null).ti).toBe("Write QA scenarios");
    const msg = ncEarlierRow({ type: "task_message", preview: "Tokens landed — verified locally", actor_alias: "f" }, null);
    expect(msg.ti).toBe("Tokens landed — verified locally");
    expect(msg.tip).toBeUndefined();
  });
});

describe("page toolbar reveals the selected pill", () => {
  it("scrolls the row's main area when the checked pill is off-screen", () => {
    const rects = new Map<string, DOMRect>();
    const rect = (l: number, w: number) => ({ left: l, right: l + w, width: w, top: 0, bottom: 28, height: 28, x: l, y: 0, toJSON() { return {}; } }) as DOMRect;
    const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("v2-filterbar-main")) return rect(0, 200);
      const k = this.getAttribute("data-pill");
      return (k && rects.get(k)) || rect(0, 0);
    });
    rects.set("a", rect(0, 80)); rects.set("b", rect(90, 80)); rects.set("c", rect(260, 80));
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, get() { return this.classList?.contains("v2-filterbar-main") ? 400 : 0; } });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get() { return this.classList?.contains("v2-filterbar-main") ? 200 : 0; } });
    render(
      <PageToolbar label="Run filters">
        <FilterPills label="Show" value="c" onChange={() => {}} items={[{ key: "a", label: "All" }, { key: "b", label: "Running" }, { key: "c", label: "Failed" }]} />
      </PageToolbar>,
    );
    const main = document.querySelector(".v2-filterbar-main") as HTMLElement;
    expect(main.scrollLeft).toBeGreaterThan(0);
    spy.mockRestore();
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollWidth;
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
  });
});
