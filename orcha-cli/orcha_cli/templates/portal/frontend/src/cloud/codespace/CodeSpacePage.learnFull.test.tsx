/**
 * CodeSpacePage × Learn — the full-page lesson (?lesson=<id>&view=full&step=N):
 * entering and exiting (header button, F, Esc, browser Back), the URL round-trip
 * (a reloaded / shared link restores full page on the same step), keyboard
 * stepping (←/→ and J/K), step clicks, a step citing ANOTHER file switching the
 * editor to it, the library row menu, presenter mode, and the single-column
 * narrow layout with its inline code peek.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { CodeSpacePage } from "./CodeSpacePage";

const AGENTS = [
  { id: "h1", alias: "kedar", kind: "human", status: "idle" },
  { id: "a1", alias: "forge", kind: "ai", status: "idle", role: "engineer" },
];
const TREE_ROOT = { ref: "HEAD", path: "", entries: [{ name: "a.ts", path: "a.ts", type: "file" }, { name: "b.ts", path: "b.ts", type: "file" }] };
const fileOf = (p: string, prefix: string) => ({ ref: "HEAD", path: p, content: Array.from({ length: 12 }, (_, i) => "const " + prefix + (i + 1) + " = " + (i + 1) + ";").join("\n"), size: 200 });
const LESSON = { id: "L1", ref: "HEAD", sha: "abc", path: "a.ts", start_line: 2, end_line: 4, kind: "teach", status: "answered", tagged_agent_id: "a1", tagged_alias: "forge", first_message: "Teach me the values.", created_at: "now", updated_at: "now", blob_match: true };
const ANSWER = "# The values\n> Three constants.\n\n## Steps\n1. **First** (L2-3) the start.\n2. **Then** (L4) the end.\n3. **Elsewhere** the helper in b.ts:5-6 does the rest.\n\n## Key concepts\n- Constants\n";

function stubFetch() {
  const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/containers/c1/github/browse/tree")) return json(TREE_ROOT);
    if (url.startsWith("/api/containers/c1/github/browse/file")) {
      const p = new URL(url, "http://x").searchParams.get("path") || "a.ts";
      return json(fileOf(p, p === "b.ts" ? "w" : "v"));
    }
    if (url.startsWith("/api/code/threads/L1")) {
      return json({ ...LESSON, messages: [
        { id: "m1", is_human: true, author_alias: "kedar", body: "Teach me the values.", created_at: "now" },
        { id: "m2", is_human: false, author_alias: "forge", author_agent_id: "a1", body: ANSWER, created_at: "now" },
      ] });
    }
    if (url.includes("/code/threads")) return json({ threads: [LESSON] });
    if (url.startsWith("/api/containers/c1/code/outline")) return json({ available: true, ref: "HEAD", path: "a.ts", language: "typescript", symbols: [] });
    if (url.startsWith("/api/containers/c1")) return json({ container: { id: "c1", name: "Acme", status: "active", autonomy_level: "plan" }, agents: AGENTS, tasks: [], requests: [] });
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    return json({});
  }) as unknown as typeof fetch;
}

let loc = "";
let nav: NavigateFunction | null = null;
function Probe() {
  const l = useLocation();
  const n = useNavigate();
  useEffect(() => { loc = l.pathname + l.search; nav = n; });
  return null;
}
const params = () => new URLSearchParams(loc.slice(loc.indexOf("?")));

function mount(url = "/code?path=a.ts") {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={["/code", url]} initialIndex={1}>
          <CodeSpacePage />
          <Probe />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

const line = (n: number) => document.querySelector(`[data-cs-line="${n}"]`) as HTMLElement;
const focused = () => Array.from(document.querySelectorAll(".cs-line.lesson-focus")).map((el) => Number(el.getAttribute("data-cs-line")));
const body = () => document.querySelector(".cs-body") as HTMLElement;
const isFull = () => body()?.classList.contains("is-lesson-full") ?? false;
const progress = () => screen.getByRole("progressbar", { name: /lesson progress/i });

async function openLessonFromGutter() {
  await waitFor(() => expect(line(2)?.querySelector(".cs-gutter-lesson") ?? null).not.toBeNull());
  fireEvent.click(line(2).querySelector(".cs-gutter-lesson")!);
  expect(await screen.findByRole("heading", { name: "The values" })).toBeInTheDocument();
  await waitFor(() => expect(focused()).toEqual([2, 3]));
}

describe("CodeSpacePage — full-page lesson", () => {
  beforeEach(() => { localStorage.clear(); loc = ""; nav = null; });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); document.documentElement.removeAttribute("data-lesson-present"); });

  it("the header button enters full page (URL + layout) and exits back to the rail on the same step", async () => {
    stubFetch();
    mount();
    await openLessonFromGutter();
    expect(params().get("lesson")).toBe("L1");
    expect(isFull()).toBe(false);
    fireEvent.keyDown(document, { key: "ArrowRight" });
    await waitFor(() => expect(focused()).toEqual([4]));
    expect(params().get("step")).toBe("2");

    fireEvent.click(screen.getByRole("button", { name: "Full page" }));
    await waitFor(() => expect(isFull()).toBe(true));
    expect(params().get("view")).toBe("full");
    // the file tree's toolbar (symbol search + pane toggles) is gone; the lesson + editor stay
    expect(screen.queryByRole("button", { name: "File tree" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "The values" })).toBeInTheDocument();
    expect(progress()).toHaveAttribute("aria-valuetext", "Step 2 of 3");
    expect(focused()).toEqual([4]);

    fireEvent.click(screen.getByRole("button", { name: "Exit full page" }));
    await waitFor(() => expect(isFull()).toBe(false));
    expect(params().get("view")).toBeNull();
    expect(params().get("lesson")).toBe("L1");
    expect(params().get("step")).toBe("2");
    expect(screen.getByRole("tab", { name: "Learn", selected: true })).toBeInTheDocument();
    expect(progress()).toHaveAttribute("aria-valuetext", "Step 2 of 3");
    expect(focused()).toEqual([4]);
  });

  it("F enters and Esc exits; F is ignored while typing", async () => {
    stubFetch();
    mount();
    await openLessonFromGutter();
    const search = document.querySelector(".cs-symsearch-in") as HTMLInputElement;
    expect(search).toBeTruthy();
    fireEvent.keyDown(search, { key: "f" });
    expect(isFull()).toBe(false);
    fireEvent.keyDown(document.body, { key: "f" });
    await waitFor(() => expect(isFull()).toBe(true));
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(isFull()).toBe(false));
    expect(params().get("lesson")).toBe("L1");
  });

  it("browser Back exits full page before leaving the lesson", async () => {
    stubFetch();
    mount();
    await openLessonFromGutter();
    fireEvent.keyDown(document.body, { key: "f" });
    await waitFor(() => expect(isFull()).toBe(true));
    act(() => { nav!(-1); });
    await waitFor(() => expect(isFull()).toBe(false));
    expect(params().get("lesson")).toBe("L1");
    expect(screen.getByRole("heading", { name: "The values" })).toBeInTheDocument();
  });

  it("a shared ?lesson=&view=full&step= link restores full page on that step; stepping round-trips to the URL", async () => {
    stubFetch();
    mount("/code?path=a.ts&lesson=L1&view=full&step=2");
    expect(await screen.findByRole("heading", { name: "The values" })).toBeInTheDocument();
    await waitFor(() => expect(isFull()).toBe(true));
    expect(progress()).toHaveAttribute("aria-valuetext", "Step 2 of 3");
    await waitFor(() => expect(focused()).toEqual([4]));

    // K = previous, J = next, ←/→ too
    fireEvent.keyDown(document.body, { key: "k" });
    await waitFor(() => expect(params().get("step")).toBeNull());
    expect(progress()).toHaveAttribute("aria-valuetext", "Step 1 of 3");
    await waitFor(() => expect(focused()).toEqual([2, 3]));
    fireEvent.keyDown(document.body, { key: "j" });
    await waitFor(() => expect(params().get("step")).toBe("2"));
    fireEvent.keyDown(document.body, { key: "ArrowLeft" });
    await waitFor(() => expect(params().get("step")).toBeNull());

    // clicking a collapsed step jumps to it
    const steps = document.querySelectorAll(".cs-lesson-step");
    fireEvent.click(within(steps[1] as HTMLElement).getByText("Then"));
    await waitFor(() => expect(progress()).toHaveAttribute("aria-valuetext", "Step 2 of 3"));
    expect(params().get("step")).toBe("2");

    // a reloaded full-page link has no pushed entry to pop: Esc just drops ?view=
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(isFull()).toBe(false));
    expect(loc.startsWith("/code?")).toBe(true);
    expect(params().get("lesson")).toBe("L1");
  });

  it("a step citing another file switches the editor to that file and glows its lines", async () => {
    stubFetch();
    mount("/code?path=a.ts&lesson=L1&view=full&step=2");
    await waitFor(() => expect(focused()).toEqual([4]));
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    await waitFor(() => expect(params().get("path")).toBe("b.ts"));
    await waitFor(() => expect(line(5)?.textContent).toContain("const w5"));
    await waitFor(() => expect(focused()).toEqual([5, 6]));
    // and back: the lesson's own file again
    fireEvent.keyDown(document.body, { key: "ArrowLeft" });
    await waitFor(() => expect(params().get("path")).toBe("a.ts"));
    await waitFor(() => expect(focused()).toEqual([4]));
  });

  it("rapid stepping onto a cross-file step keeps BOTH ?step= and ?path= (no clobbered URL writes)", async () => {
    stubFetch();
    mount("/code?path=a.ts&lesson=L1&view=full");
    await waitFor(() => expect(focused()).toEqual([2, 3]));
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    await waitFor(() => expect(params().get("path")).toBe("b.ts"));
    await waitFor(() => expect(focused()).toEqual([5, 6]));
    expect(params().get("step")).toBe("3");
    expect(params().get("lesson")).toBe("L1");
    expect(params().get("view")).toBe("full");
  });

  it("the library row menu opens a lesson straight into full page", async () => {
    stubFetch();
    mount();
    await waitFor(() => expect(line(2)).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "Learn" }));
    const more = await screen.findByRole("button", { name: /lesson actions for/i });
    fireEvent.click(more);
    fireEvent.click(await screen.findByRole("menuitem", { name: /open full page/i }));
    await waitFor(() => expect(isFull()).toBe(true));
    expect(params().get("lesson")).toBe("L1");
    expect(await screen.findByRole("heading", { name: "The values" })).toBeInTheDocument();
    // Back: out of full page, still on the lesson
    act(() => { nav!(-1); });
    await waitFor(() => expect(isFull()).toBe(false));
    expect(params().get("lesson")).toBe("L1");
  });

  it("Present hides the app sidebar (wide only) and exiting full page drops it", async () => {
    stubFetch();
    mount("/code?path=a.ts&lesson=L1&view=full");
    expect(await screen.findByRole("heading", { name: "The values" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Present" }));
    await waitFor(() => expect(document.documentElement.hasAttribute("data-lesson-present")).toBe(true));
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(isFull()).toBe(false));
    expect(document.documentElement.hasAttribute("data-lesson-present")).toBe(false);
  });
});

describe("CodeSpacePage — full-page lesson at 390px", () => {
  const RO = globalThis.ResizeObserver;
  beforeEach(() => {
    localStorage.clear();
    loc = "";
    globalThis.ResizeObserver = class {
      cb: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) { this.cb = cb; }
      observe() { setTimeout(() => this.cb([{ contentRect: { width: 390 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver), 0); }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); globalThis.ResizeObserver = RO; });

  it("is a single column: the lesson with an inline peek of the active step's lines; no Present", async () => {
    stubFetch();
    mount("/code?path=a.ts&lesson=L1&view=full");
    expect(await screen.findByRole("heading", { name: "The values" })).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector(".cs-shell")!.getAttribute("data-layout")).toBe("narrow"));
    expect(isFull()).toBe(true);
    const peek = await screen.findByLabelText("Code for step 1");
    expect(peek.textContent).toContain("const v2 = 2;");
    expect(peek.textContent).toContain("const v3 = 3;");
    expect(peek.textContent).not.toContain("const v4 = 4;");
    expect(screen.queryByRole("button", { name: "Present" })).not.toBeInTheDocument();

    // the peek follows the step — across files too
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    await waitFor(() => expect(screen.getByLabelText("Code for step 2").textContent).toContain("const v4 = 4;"));
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    await waitFor(() => expect(params().get("path")).toBe("b.ts"));
    await waitFor(() => expect(screen.getByLabelText("Code for step 3").textContent).toContain("const w5 = 5;"));
  });
});
