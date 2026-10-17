/**
 * Code Space — polish round 1 (Linear review r1) behaviour:
 *  - landing: no Quick actions row; the rail starts hidden on wide layouts
 *    and the Threads-panel toggle reveals it (never persisted);
 *  - deep link ?thread= paints a band over the thread's anchored range;
 *  - breadcrumbs collapse to "… / file" instead of truncating every segment;
 *  - Edit mode keeps the thread gutter markers (CM6 gutterLineClass) and
 *    the same glyphs as the read view (no ligatures);
 *  - thread kinds are D8 dot chips.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EditorState, Text } from "@codemirror/state";
import { gutterLineClass } from "@codemirror/view";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { Breadcrumbs, shouldCompact } from "./Breadcrumbs";
import { CodeSpacePage } from "./CodeSpacePage";
import { buildThreadMarks, setThreadLines, THREAD_LINE_CLASS, threadMarks } from "./editorThreadMarks";
import { MONO_FEATURES } from "./editorTheme";
import { KindChip } from "./threadBits";

const AGENTS = [
  { id: "h1", alias: "kedar", kind: "human", status: "idle" },
  { id: "a1", alias: "forge", kind: "ai", status: "idle" },
];
const TREE_ROOT = { ref: "HEAD", path: "", entries: [{ name: "a.ts", path: "a.ts", type: "file" }] };
const FILE_A = { ref: "HEAD", path: "a.ts", content: "one\ntwo\nthree\nfour\nfive", size: 24 };
const THREAD = {
  id: "t1", ref: "HEAD", sha: "abc1234def", path: "a.ts", start_line: 2, end_line: 4, kind: "question", status: "open",
  created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z", blob_match: true, first_message: "why?",
};

function stub() {
  const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/containers/c1/github/browse/tree")) return json(TREE_ROOT);
    if (url.startsWith("/api/containers/c1/github/browse/file")) return json(FILE_A);
    if (url.startsWith("/api/containers/c1/code/threads")) return json({ threads: [THREAD] });
    if (url.startsWith("/api/code/threads/t1")) return json({ ...THREAD, messages: [] });
    if (url.startsWith("/api/containers/c1/code/outline")) return json({ available: true, ref: "HEAD", path: "a.ts", language: null, symbols: [] });
    if (url.startsWith("/api/containers/c1")) {
      return json({ container: { id: "c1", name: "Acme", status: "active", autonomy_level: "plan" }, agents: AGENTS, tasks: [], requests: [] });
    }
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    return json({});
  }) as unknown as typeof fetch;
}

function mount(entry: string) {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[entry]}>
          <CodeSpacePage />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

describe("CodeSpacePage — polish r1", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("landing: no Quick actions; the rail starts hidden and the Threads panel toggle reveals it without persisting", async () => {
    stub();
    mount("/code");
    await screen.findByText("Recent threads");
    expect(screen.queryByText("Quick actions")).not.toBeInTheDocument();
    const body = document.querySelector(".cs-body") as HTMLElement;
    expect(body.className).toContain("rail-collapsed");
    const toggle = screen.getByRole("button", { name: "Threads panel" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(body.className).not.toContain("rail-collapsed");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    // the landing reveal is session-only — the persisted per-browser choice is untouched
    expect(JSON.parse(localStorage.getItem("orcha:cs:collapsed") || "{}").rail).toBe(false);
  });

  it("a file view shows the rail by default (only the landing hides it)", async () => {
    stub();
    mount("/code?path=a.ts");
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    expect((document.querySelector(".cs-body") as HTMLElement).className).not.toContain("rail-collapsed");
  });

  it("deep link ?thread= paints a band over exactly the thread's anchored lines", async () => {
    stub();
    mount("/code?path=a.ts&line=2&thread=t1");
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    await vi.waitFor(() => expect(document.querySelectorAll(".cs-line.in-thread")).toHaveLength(3));
    const band = Array.from(document.querySelectorAll(".cs-line.in-thread")).map((el) => el.getAttribute("data-cs-line"));
    expect(band).toEqual(["2", "3", "4"]);
    expect(document.querySelector('[data-cs-line="2"]')!.className).toContain("thread-start");
    expect(document.querySelector('[data-cs-line="4"]')!.className).toContain("thread-end");
    expect(document.querySelector('[data-cs-line="1"]')!.className).not.toContain("in-thread");
  });

  it("no ?thread= → no band", async () => {
    stub();
    mount("/code?path=a.ts&line=2");
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    expect(document.querySelector(".cs-line.in-thread")).toBeNull();
  });
});

describe("Breadcrumbs compact mode", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("shouldCompact: only when measured and the full trail overflows", () => {
    expect(shouldCompact(0, 0)).toBe(false);
    expect(shouldCompact(300, 0)).toBe(false); // unmeasured container (jsdom)
    expect(shouldCompact(200, 240)).toBe(false);
    expect(shouldCompact(260, 240)).toBe(true);
  });

  it("collapses to '… / file' when the trail doesn't fit; '…' opens the parent directory", () => {
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(200);
    const onOpenDir = vi.fn();
    render(<div><Breadcrumbs path="src/shell/deep/Shell.tsx" onOpenDir={onOpenDir} /></div>);
    const nav = screen.getByRole("navigation", { name: "File path" });
    expect(nav.className).toContain("is-compact");
    expect(screen.queryByRole("button", { name: "Repository root" })).toBeNull();
    expect(screen.queryByText("shell")).toBeNull();
    expect(screen.getByText("Shell.tsx").getAttribute("aria-current")).toBe("page");
    fireEvent.click(screen.getByRole("button", { name: "Open src/shell/deep" }));
    expect(onOpenDir).toHaveBeenCalledWith("src/shell/deep");
  });

  it("keeps the full, untruncated trail when it fits", () => {
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(180);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
    render(<div><Breadcrumbs path="src/shell/Shell.tsx" onOpenDir={vi.fn()} /></div>);
    expect(screen.getByRole("navigation", { name: "File path" }).className).not.toContain("is-compact");
    expect(screen.getByRole("button", { name: "Repository root" })).toBeInTheDocument();
    expect(screen.getByText("shell")).toBeInTheDocument();
  });
});

describe("editor parity with the read view", () => {
  it("buildThreadMarks: one marker per valid, de-duplicated line, in order", () => {
    const doc = Text.of(["a", "b", "c", "d"]);
    const set = buildThreadMarks(doc, [3, 1, 3, 9, 0]);
    const at: number[] = [];
    set.between(0, doc.length, (from) => { at.push(doc.lineAt(from).number); });
    expect(at).toEqual([1, 3]);
  });

  it("thread markers follow edits and are replaced by setThreadLines", () => {
    let state = EditorState.create({ doc: "a\nb\nc", extensions: [threadMarks(() => [2])] });
    const lines = () => {
      const out: number[] = [];
      for (const set of state.facet(gutterLineClass)) {
        set.between(0, state.doc.length, (from, _to, m) => { if (m.elementClass === THREAD_LINE_CLASS) out.push(state.doc.lineAt(from).number); });
      }
      return out;
    };
    expect(lines()).toEqual([2]);
    state = state.update({ changes: { from: 0, insert: "new\n" } }).state; // a line inserted above
    expect(lines()).toEqual([3]);
    state = state.update({ effects: setThreadLines.of([1, 4]) }).state;
    expect(lines()).toEqual([1, 4]);
  });

  it("the editor disables programming ligatures like the viewer", () => {
    expect(MONO_FEATURES).toBe('"liga" 0, "calt" 0');
  });
});

describe("KindChip", () => {
  afterEach(() => cleanup());
  it("is a D8 chip: dot + the kind word (never colour alone)", () => {
    render(<KindChip kind="why" />);
    const chip = document.querySelector(".cs-kind-chip") as HTMLElement;
    expect(chip.className).toContain("v2-chip");
    expect(chip.querySelector(".v2-chip-dot.v2-tone-info")).not.toBeNull();
    expect(chip.querySelector(".kind-tag")?.textContent).toBe("Why");
  });
});
