/**
 * CodeSpacePage × Learn — the editor side of lessons: a teach/why thread's first
 * line carries a gutter lesson marker that opens the lesson in the rail; the
 * lesson's active step glows its cited lines while the rest of the file dims;
 * stepping with → moves the glow; leaving the lesson clears it.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { CodeSpacePage } from "./CodeSpacePage";

const AGENTS = [
  { id: "h1", alias: "kedar", kind: "human", status: "idle" },
  { id: "a1", alias: "forge", kind: "ai", status: "idle", role: "engineer" },
];
const TREE_ROOT = { ref: "HEAD", path: "", entries: [{ name: "a.ts", path: "a.ts", type: "file" }] };
const FILE_A = { ref: "HEAD", path: "a.ts", content: Array.from({ length: 12 }, (_, i) => "const v" + (i + 1) + " = " + (i + 1) + ";").join("\n"), size: 200 };
const LESSON = { id: "L1", ref: "HEAD", sha: "abc", path: "a.ts", start_line: 2, end_line: 4, kind: "teach", status: "answered", tagged_agent_id: "a1", tagged_alias: "forge", first_message: "Teach me the values.", created_at: "now", updated_at: "now", blob_match: true };
const ANSWER = "# The values\n> Three constants.\n\n## Steps\n1. **First** (L2-3) the start.\n2. **Then** (L4) the end.\n";

function stubFetch() {
  const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/containers/c1/github/browse/tree")) return json(TREE_ROOT);
    if (url.startsWith("/api/containers/c1/github/browse/file")) return json(FILE_A);
    if (url.startsWith("/api/code/threads/L1")) {
      return json({ ...LESSON, messages: [
        { id: "m1", is_human: true, author_alias: "kedar", body: "Teach me the values.", created_at: "now" },
        { id: "m2", is_human: false, author_alias: "forge", author_agent_id: "a1", body: ANSWER, created_at: "now" },
      ] });
    }
    if (url.startsWith("/api/containers/c1/code/threads")) return json({ threads: [LESSON] });
    if (url.startsWith("/api/containers/c1/code/outline")) return json({ available: true, ref: "HEAD", path: "a.ts", language: "typescript", symbols: [] });
    if (url.startsWith("/api/containers/c1")) return json({ container: { id: "c1", name: "Acme", status: "active", autonomy_level: "plan" }, agents: AGENTS, tasks: [], requests: [] });
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    return json({});
  }) as unknown as typeof fetch;
}

function mount() {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={["/code?path=a.ts"]}>
          <CodeSpacePage />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

const line = (n: number) => document.querySelector(`[data-cs-line="${n}"]`) as HTMLElement;
const focused = () => Array.from(document.querySelectorAll(".cs-line.lesson-focus")).map((el) => Number(el.getAttribute("data-cs-line")));

describe("CodeSpacePage — Learn in the editor", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("marks a lesson's first line in the gutter (spark, not a plain dot) and tints short lessons' lines", async () => {
    stubFetch();
    mount();
    await waitFor(() => expect(line(2)?.querySelector(".cs-gutter-lesson") ?? null).not.toBeNull());
    expect(line(2).querySelector(".cs-gutter-dot")).toBeNull();
    expect(line(3).classList.contains("lesson-covered")).toBe(true);
    expect(line(6).classList.contains("lesson-covered")).toBe(false);
  });

  it("the gutter marker opens the lesson; its steps glow their lines and dim the rest; → moves the glow", async () => {
    stubFetch();
    mount();
    await waitFor(() => expect(line(2)?.querySelector(".cs-gutter-lesson") ?? null).not.toBeNull());
    fireEvent.click(line(2).querySelector(".cs-gutter-lesson")!);

    // rail switched to Learn and shows the lesson (not a new-thread composer)
    expect(await screen.findByRole("heading", { name: "The values" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Learn", selected: true })).toBeInTheDocument();
    expect(screen.queryByLabelText(/thread message/i)).not.toBeInTheDocument();

    await waitFor(() => expect(focused()).toEqual([2, 3]));
    expect(document.querySelector(".rb-code")!.classList.contains("has-lesson-focus")).toBe(true);
    expect(line(2).classList.contains("lesson-focus-start")).toBe(true);
    expect(line(3).classList.contains("lesson-focus-end")).toBe(true);

    fireEvent.keyDown(document, { key: "ArrowRight" });
    await waitFor(() => expect(focused()).toEqual([4]));

    // back to the library clears the glow
    fireEvent.click(screen.getByRole("button", { name: /library/i }));
    await waitFor(() => expect(focused()).toEqual([]));
    expect(document.querySelector(".rb-code")!.classList.contains("has-lesson-focus")).toBe(false);
  });
});
