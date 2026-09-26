/**
 * Proves the ErrorBoundary wiring in CodeSpacePage.tsx is real, not just
 * unit-tested in isolation (ErrorBoundary.test.tsx) — mocks ThreadRail to
 * throw unconditionally and confirms the REST of the page (tree, content,
 * shell) survives, with the rail's own "reload pane" fallback in its place.
 * A separate file because vi.mock(...) is module-scoped/hoisted; keeping it
 * out of CodeSpacePage.test.tsx avoids mocking ThreadRail for every other
 * test in that suite.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";

vi.mock("./ThreadRail", () => ({
  ThreadRail: () => {
    throw new Error("simulated rail crash");
  },
}));

// import AFTER the mock so CodeSpacePage picks up the mocked ThreadRail.
const { CodeSpacePage } = await import("./CodeSpacePage");

const AGENTS = [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }];
const TREE_ROOT = { ref: "HEAD", path: "", entries: [{ name: "a.ts", path: "a.ts", type: "file" }] };
const FILE_A = { ref: "HEAD", path: "a.ts", content: "const x = 1;", size: 20 };

function stubFetch() {
  const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/containers/c1/github/browse/tree")) return json(TREE_ROOT);
    if (url.startsWith("/api/containers/c1/github/browse/file")) return json(FILE_A);
    if (url.startsWith("/api/containers/c1")) {
      return json({ container: { id: "c1", name: "Acme", status: "active", autonomy_level: "plan" }, agents: AGENTS, tasks: [], requests: [] });
    }
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    return json({});
  }) as unknown as typeof fetch;
}

function mount(initialEntry = "/code?path=a.ts") {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <CodeSpacePage />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

describe("CodeSpacePage — ErrorBoundary is genuinely wired around the rail pane", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("a throwing ThreadRail is contained by its boundary; the tree/content panes and app shell keep rendering", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch();
    mount();

    // the content pane painted fine — the rail's crash didn't take it down.
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    expect(document.querySelector(".cs-tree-pane")).not.toBeNull();
    expect(document.querySelector(".sidebar")).not.toBeNull();

    // the rail itself shows the compact fallback, not a blank/crashed page.
    expect(screen.getByText(/something broke here — reload pane/i)).toBeInTheDocument();
    expect(screen.getByText(/reload rail pane/i)).toBeInTheDocument();
  });

  it("'reload rail pane' re-attempts the mount (still throws, but never escapes the boundary)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch();
    mount();
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    const reloadBtn = await screen.findByText(/reload rail pane/i);
    fireEvent.click(reloadBtn);
    // still crashes (the mock always throws) but the boundary re-catches it
    // and the fallback is still there — no uncaught error escapes to blank
    // the page on retry either.
    expect(await screen.findByText(/reload rail pane/i)).toBeInTheDocument();
    expect(screen.getByText("a.ts", { selector: ".rb-file-path" })).toBeInTheDocument();
  });
});
