/**
 * CodeSpacePage — the full three-pane integration: gutter dots render on
 * annotated lines, clicking a gutter opens the Phase-1 composer pre-filled
 * with the clicked line's anchor, and deep-link ?path=/?line= seed the
 * viewer. fetch stubbed like GitHubPage.test.tsx; mounted through the real
 * SnapshotProvider + MemoryRouter.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { CodeSpacePage } from "./CodeSpacePage";

const AGENTS = [
  { id: "h1", alias: "kedar", kind: "human", status: "idle" },
  { id: "a1", alias: "forge", kind: "ai", status: "idle", role: "engineer" },
];

const TREE_ROOT = {
  ref: "HEAD", path: "",
  entries: [{ name: "a.ts", path: "a.ts", type: "file" }, { name: "readme.md", path: "readme.md", type: "file" }],
};
const FILE_A = { ref: "HEAD", path: "a.ts", content: "const x = 1;\nconsole.log(x);\nexport default x;", size: 60 };
const FILE_MD = { ref: "HEAD", path: "readme.md", content: "# Title\n\nSome **bold** text.", size: 30 };
const THREADS_A = {
  threads: [
    { id: "t1", ref: "HEAD", sha: "abc1234def", path: "a.ts", start_line: 2, end_line: 2, kind: "question", status: "open", created_at: "now", updated_at: "now", blob_match: true },
  ],
};
const THREADS_MD = { threads: [] };

const SYMBOL_SEARCH_RESULT = {
  available: true, ref: "HEAD",
  results: [{ name: "x", kind: "var", path: "a.ts", line: 1 }],
};

function stubFetch() {
  const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/containers/c1/github/browse/tree")) return json(TREE_ROOT);
    if (url.startsWith("/api/containers/c1/github/browse/file")) {
      if (url.includes("path=readme.md")) return json(FILE_MD);
      return json(FILE_A);
    }
    if (url.startsWith("/api/containers/c1/code/threads")) {
      if (url.includes("path=readme.md")) return json(THREADS_MD);
      return json(THREADS_A);
    }
    if (url.startsWith("/api/containers/c1/code/outline")) {
      return json({ available: true, ref: "HEAD", path: "a.ts", language: "typescript", symbols: [] });
    }
    if (url.startsWith("/api/containers/c1/code/symbols")) return json(SYMBOL_SEARCH_RESULT);
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

// MemoryRouter's history stack is internal (not window.history) — real
// back/forward assertions need a router object to drive .navigate(-1)/(1)
// against, which createMemoryRouter + RouterProvider expose and plain
// <MemoryRouter> does not.
function mountWithHistory(initialEntry = "/code?path=a.ts") {
  const router = createMemoryRouter(
    [{ path: "/code", element: <CodeSpacePage /> }],
    { initialEntries: [initialEntry] },
  );
  const view = render(
    <ToastProvider>
      <SnapshotProvider>
        <RouterProvider router={router} />
      </SnapshotProvider>
    </ToastProvider>,
  );
  return { ...view, router };
}

describe("CodeSpacePage", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("renders the file's lines with a gutter dot on the annotated line", async () => {
    stubFetch();
    mount();
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    const line2 = document.querySelector('[data-cs-line="2"]');
    expect(line2).not.toBeNull();
    expect(line2!.querySelector(".cs-gutter-dot")).not.toBeNull();
    // line 1 (no thread) carries no dot
    const line1 = document.querySelector('[data-cs-line="1"]');
    expect(line1!.querySelector(".cs-gutter-dot")).toBeNull();
  });

  it("clicking a line's gutter opens the composer anchored to that line", async () => {
    stubFetch();
    mount();
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    const gutter3 = document.querySelector('[data-cs-line="3"] .cs-gutter') as HTMLElement;
    fireEvent.click(gutter3);
    expect(await screen.findByText(/line 3/i)).toBeInTheDocument();
  });

  // Usability sweep papercut: canceling the composer (Escape or Cancel) used
  // to leave the picked line's highlight stuck with no way to clear it.
  it("Escape closes the gutter composer AND clears the line's stuck selection highlight", async () => {
    stubFetch();
    mount();
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    const gutter3 = document.querySelector('[data-cs-line="3"] .cs-gutter') as HTMLElement;
    fireEvent.click(gutter3);
    await screen.findByText(/line 3/i);
    expect(document.querySelector('[data-cs-line="3"]')!.className).toContain("selected");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText(/line 3/i)).not.toBeInTheDocument();
    expect(document.querySelector('[data-cs-line="3"]')!.className).not.toContain("selected");
  });

  it("deep link ?path=&line= seeds the file and scrolls to the line", async () => {
    stubFetch();
    mount("/code?path=a.ts&line=2");
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    expect(document.querySelector('[data-cs-line="2"]')).not.toBeNull();
  });

  it("shows a per-file thread count badge in the tree", async () => {
    stubFetch();
    mount();
    expect(await screen.findByText("1", { selector: ".cs-tree-badge" })).toBeInTheDocument();
  });

  it("renders a header symbol search input", async () => {
    stubFetch();
    mount();
    expect(await screen.findByPlaceholderText(/search symbols/i)).toBeInTheDocument();
  });

  it("clicking an identifier token in the code pane offers a symbol-search affordance, prefilled", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubFetch();
    mount();
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    const identTok = document.querySelectorAll(".cs-ident-tok");
    expect(identTok.length).toBeGreaterThan(0);
    const consoleTok = Array.from(identTok).find((el) => el.textContent === "console");
    expect(consoleTok).toBeTruthy();
    fireEvent.click(consoleTok as HTMLElement);
    const input = await screen.findByPlaceholderText(/search symbols/i) as HTMLInputElement;
    expect(input.value).toBe("console");
    await act(async () => { vi.advanceTimersByTime(300); });
    vi.useRealTimers();
  });
});

describe("CodeSpacePage — markdown Raw|Rendered toggle (item 1)", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("defaults a .md file to Rendered, rendering through the house Md component", async () => {
    stubFetch();
    mount("/code?path=readme.md");
    await screen.findByText("readme.md", { selector: ".rb-file-path" });
    expect(document.querySelector(".cs-md-rendered")).not.toBeNull();
    // esc-first house markdown (lib/format.ts's mdText): headings render as
    // <span class="md-h">, never raw #-prefixed text.
    expect(document.querySelector(".cs-md-rendered .md-h")).not.toBeNull();
    expect(document.querySelector(".cs-md-rendered strong")).not.toBeNull();
    // Rendered mode has no gutter lines to click/anchor a thread against.
    expect(document.querySelector(".cs-gutter")).toBeNull();
    const renderedBtn = screen.getByText("Rendered");
    expect(renderedBtn.className).toContain("on");
  });

  it("toggling to Raw shows plain code lines with working gutter selection", async () => {
    stubFetch();
    mount("/code?path=readme.md");
    await screen.findByText("readme.md", { selector: ".rb-file-path" });
    fireEvent.click(screen.getByText("Raw"));
    expect(document.querySelector(".cs-md-rendered")).toBeNull();
    const gutter1 = document.querySelector('[data-cs-line="1"] .cs-gutter') as HTMLElement;
    expect(gutter1).not.toBeNull();
    fireEvent.click(gutter1);
    expect(await screen.findByText(/line 1/i)).toBeInTheDocument();
  });

  it("toggling back to Rendered has no gutter, but keeps the Discuss-this-document affordance available", async () => {
    stubFetch();
    mount("/code?path=readme.md");
    await screen.findByText("readme.md", { selector: ".rb-file-path" });
    fireEvent.click(screen.getByText("Raw"));
    fireEvent.click(screen.getByText("Rendered"));
    const rendered = document.querySelector(".cs-md-rendered");
    expect(rendered).not.toBeNull();
    expect(document.querySelector(".cs-gutter")).toBeNull();
    expect(screen.getByText("Discuss this document")).toBeInTheDocument();
  });

  it("a non-.md file has no Raw|Rendered toggle at all", async () => {
    stubFetch();
    mount("/code?path=a.ts");
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    expect(screen.queryByText("Rendered")).not.toBeInTheDocument();
    expect(screen.queryByText("Raw")).not.toBeInTheDocument();
  });

  it("switching from a .md file to a non-.md file resets to Raw's plain gutter view", async () => {
    stubFetch();
    mount("/code?path=readme.md");
    await screen.findByText("readme.md", { selector: ".rb-file-path" });
    expect(document.querySelector(".cs-md-rendered")).not.toBeNull();

    fireEvent.click(screen.getByText("a.ts"));
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    expect(document.querySelector(".cs-md-rendered")).toBeNull();
    expect(document.querySelector('[data-cs-line="1"] .cs-gutter')).not.toBeNull();
  });
});

/* ---- Item 2: thread conversations on rendered markdown ------------------- */
describe("CodeSpacePage — thread conversations on rendered markdown (item 2)", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  // Two distinct "Section" headings (same normalized text) exercise the
  // matcher's positional-not-textual-uniqueness resolution; "Weird `Code`"
  // exercises inline-markup normalization.
  const MD_CONTENT = [
    "# Title",
    "",
    "Some **bold** text.",
    "",
    "## Section",
    "",
    "First section body.",
    "",
    "## Weird `Code` Heading",
    "",
    "More text.",
    "",
    "## Section",
    "",
    "Second section body.",
  ].join("\n");
  const FILE_MD_HEADINGS = { ref: "HEAD", path: "readme.md", content: MD_CONTENT, size: MD_CONTENT.length };
  const THREAD_ON_MD = {
    id: "tmd1", ref: "HEAD", sha: "abc1234def", path: "readme.md", start_line: 5, end_line: 5,
    kind: "question", status: "open", created_at: "now", updated_at: "now", blob_match: true,
  };

  function stubMdFetch(threads: unknown[] = []) {
    const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/containers/c1/github/browse/tree")) return json(TREE_ROOT);
      if (url.startsWith("/api/containers/c1/github/browse/file")) return json(FILE_MD_HEADINGS);
      if (url.startsWith("/api/containers/c1/code/threads")) return json({ threads });
      if (url.startsWith("/api/containers/c1/code/outline")) {
        return json({ available: true, ref: "HEAD", path: "readme.md", language: "markdown", symbols: [] });
      }
      if (url.startsWith("/api/containers/c1/code/symbols")) return json(SYMBOL_SEARCH_RESULT);
      if (url.startsWith("/api/containers/c1")) {
        return json({ container: { id: "c1", name: "Acme", status: "active", autonomy_level: "plan" }, agents: AGENTS, tasks: [], requests: [] });
      }
      if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
      return json({});
    }) as unknown as typeof fetch;
  }

  it("'Discuss this document' opens the composer with a file-level (whole document) anchor", async () => {
    stubMdFetch();
    mount("/code?path=readme.md");
    await screen.findByText("readme.md", { selector: ".rb-file-path" });
    fireEvent.click(screen.getByText("Discuss this document"));
    expect(await screen.findByText(/whole document/i)).toBeInTheDocument();
    // never mislabeled as an ordinary line-1 anchor
    expect(screen.queryByText(/line 1\b/i)).not.toBeInTheDocument();
  });

  it("clicking a heading anchors the composer to that heading's SOURCE line", async () => {
    stubMdFetch();
    mount("/code?path=readme.md");
    await screen.findByText("readme.md", { selector: ".rb-file-path" });
    const heading = document.querySelectorAll(".cs-md-rendered .md-h")[1]; // first "## Section" — source line 5
    fireEvent.click(heading as Element);
    expect(await screen.findByText(/line 5\b/i)).toBeInTheDocument();
  });

  it("a duplicate heading resolves POSITIONALLY to its own occurrence's line, not the first match", async () => {
    stubMdFetch();
    mount("/code?path=readme.md");
    await screen.findByText("readme.md", { selector: ".rb-file-path" });
    const headings = document.querySelectorAll(".cs-md-rendered .md-h");
    fireEvent.click(headings[3] as Element); // second "## Section" — source line 13
    expect(await screen.findByText(/line 13\b/i)).toBeInTheDocument();
  });

  it("an unresolvable heading click falls back to the whole-document anchor with a note, never guessing a line", async () => {
    stubMdFetch();
    mount("/code?path=readme.md");
    await screen.findByText("readme.md", { selector: ".rb-file-path" });
    const heading = document.querySelector(".cs-md-rendered .md-h") as HTMLElement;
    // simulate a resolver mismatch by editing the DOM text after render (the
    // click handler reads live textContent, so this reproduces "rendered
    // text doesn't match source" without needing a second real fixture).
    heading.textContent = "Something Else Entirely";
    fireEvent.click(heading);
    expect(await screen.findByText(/couldn.t match that heading/i)).toBeInTheDocument();
    expect(document.querySelector(".cs-composer-anchor")!.textContent).toMatch(/whole document/i);
  });

  it("clicking a thread in the rail while Rendered is active switches to Raw at the anchor, with a note", async () => {
    stubMdFetch([THREAD_ON_MD]);
    mount("/code?path=readme.md");
    await screen.findByText("readme.md", { selector: ".rb-file-path" });
    expect(document.querySelector(".cs-md-rendered")).not.toBeNull();

    const threadChip = await screen.findByText("Question", { selector: ".kind-tag" });
    fireEvent.click(threadChip.closest(".cs-thread-chip") as Element);

    expect(document.querySelector(".cs-md-rendered")).toBeNull(); // switched to Raw
    expect(screen.getByText("Raw").className).toContain("on");
    expect(await screen.findByText(/switched to raw/i)).toBeInTheDocument();
    expect(document.querySelector('[data-cs-line="5"] .cs-gutter')).not.toBeNull();
  });

  it("Raw-mode behavior is untouched: the gutter still opens a normal line-anchored composer", async () => {
    stubMdFetch();
    mount("/code?path=readme.md");
    await screen.findByText("readme.md", { selector: ".rb-file-path" });
    fireEvent.click(screen.getByText("Raw"));
    const gutter1 = document.querySelector('[data-cs-line="1"] .cs-gutter') as HTMLElement;
    fireEvent.click(gutter1);
    expect(await screen.findByText(/line 1\b/i)).toBeInTheDocument();
    expect(screen.queryByText(/whole document/i)).not.toBeInTheDocument();
  });
});

/* ---- Learn-tab black-screen regression + pane error boundaries ----------- */
describe("CodeSpacePage — Learn tab crash regression + error boundaries", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  const REPO_THREADS = {
    threads: [
      { id: "t1", ref: "HEAD", sha: "aaa", path: "a.ts", start_line: 1, end_line: 1, kind: "teach", status: "open", created_by_agent_id: "a1", created_at: "now", updated_at: "now" },
    ],
  };

  function stubFetchWithMalformedThreadDetail() {
    const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/containers/c1/github/browse/tree")) return json(TREE_ROOT);
      if (url.startsWith("/api/containers/c1/github/browse/file")) return json(FILE_A);
      // repo-wide Learn fetch (no ?path=) returns a teach thread; the
      // per-file fetch (Threads tab, ?path=a.ts) returns none.
      if (url.startsWith("/api/containers/c1/code/threads")) {
        if (url.includes("path=")) return json(THREADS_MD);
        return json(REPO_THREADS);
      }
      if (url.startsWith("/api/containers/c1/code/outline")) {
        return json({ available: true, ref: "HEAD", path: "a.ts", language: "typescript", symbols: [] });
      }
      if (url.startsWith("/api/containers/c1/code/symbols")) return json(SYMBOL_SEARCH_RESULT);
      if (url.startsWith("/api/containers/c1")) {
        return json({ container: { id: "c1", name: "Acme", status: "active", autonomy_level: "plan" }, agents: AGENTS, tasks: [], requests: [] });
      }
      if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
      // GET /api/code/threads/{tid} deliberately NOT stubbed — a thread-less
      // 200 body is exactly the malformed-response shape that used to throw
      // in ThreadView (destructuring detail.thread) and black-screen the
      // whole page with no boundary to catch it.
      return json({});
    }) as unknown as typeof fetch;
  }

  it("root cause repro: clicking Learn, then opening a thread whose detail response is malformed, degrades gracefully instead of blacking out the page", async () => {
    stubFetchWithMalformedThreadDetail();
    mount();
    await screen.findByText("a.ts", { selector: ".rb-file-path" });

    fireEvent.click(screen.getByRole("tab", { name: "Learn" }));
    const chip = await screen.findByText("a.ts", { selector: ".cs-learn-group-path" });
    const chipEl = chip.parentElement!.querySelector(".cs-thread-chip") as HTMLElement;
    fireEvent.click(chipEl);

    // ThreadView's own guard (the direct fix) now catches the malformed
    // response BEFORE it ever throws — the rail shows an inline "couldn't
    // load" message rather than tripping the boundary at all.
    expect(await screen.findByText(/couldn.t load this thread/i)).toBeInTheDocument();
    // and the REST of the page is fully alive: tree pane, content pane, and
    // the app shell around them never unmounted — this is the exact
    // repro path from the bug report (Learn tab -> open a teach/why thread
    // -> used to render a fully black page).
    expect(screen.getByText("a.ts", { selector: ".rb-file-path" })).toBeInTheDocument();
    expect(document.querySelector(".cs-tree-pane")).not.toBeNull();
    expect(document.querySelector(".sidebar")).not.toBeNull();
  });

  it("clicking Learn with normal data never crashes (baseline sanity for the regression above)", async () => {
    stubFetch();
    mount();
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    fireEvent.click(screen.getByRole("tab", { name: "Learn" }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("tab", { name: "Learn", selected: true })).toBeInTheDocument();
  });

  it("a content-pane crash is caught by its own boundary and the tree/rail keep working", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // a file payload whose content isn't a string trips the code body's
    // .split("\n") — simulate via a payload missing `content` entirely AND
    // marked non-binary/non-truncated so ContentPaneChrome renders children.
    const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/containers/c1/github/browse/tree")) return json(TREE_ROOT);
      if (url.startsWith("/api/containers/c1/github/browse/file")) {
        return json({ ref: "HEAD", path: "a.ts", size: 10 }); // content omitted, not marked binary
      }
      if (url.startsWith("/api/containers/c1/code/threads")) return json(THREADS_MD);
      if (url.startsWith("/api/containers/c1")) {
        return json({ container: { id: "c1", name: "Acme", status: "active", autonomy_level: "plan" }, agents: AGENTS, tasks: [], requests: [] });
      }
      if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
      return json({});
    }) as unknown as typeof fetch;
    mount();
    // the tree pane painted fine regardless of the content pane's fate.
    await screen.findByText("a.ts", { selector: ".dfv-nm" });
    expect(document.querySelector(".cs-tree-pane")).not.toBeNull();
  });
});

/* ---- landing state (item 2): recent threads, recent files, quick actions - */
describe("CodeSpacePage — no-file landing state", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  const REPO_THREADS = {
    threads: [
      { id: "t1", ref: "HEAD", sha: "aaa", path: "a.ts", start_line: 1, end_line: 1, kind: "teach", status: "open", first_message: "why is this here?", created_by_alias: "forge", created_at: "now", updated_at: "now" },
    ],
  };

  function stubFetchNoFile() {
    const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/containers/c1/github/browse/tree")) return json(TREE_ROOT);
      if (url.startsWith("/api/containers/c1/github/browse/file")) return json(FILE_A);
      if (url.includes("recent=")) return json(REPO_THREADS);
      if (url.startsWith("/api/containers/c1/code/threads")) return json(THREADS_MD);
      if (url.startsWith("/api/containers/c1")) {
        return json({ container: { id: "c1", name: "Acme", status: "active", autonomy_level: "plan" }, agents: AGENTS, tasks: [], requests: [] });
      }
      if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
      return json({});
    }) as unknown as typeof fetch;
  }

  it("shows a landing view (not the old empty-pane message) when no file is open", async () => {
    stubFetchNoFile();
    mount("/code");
    expect(await screen.findByText("Quick actions")).toBeInTheDocument();
    expect(screen.getByText("Recent threads")).toBeInTheDocument();
    expect(screen.getByText("Recent files")).toBeInTheDocument();
    expect(screen.queryByText(/select a file to view its contents/i)).not.toBeInTheDocument();
  });

  it("recent threads render richer rows: kind pill + author, and open the thread's file", async () => {
    stubFetchNoFile();
    mount("/code");
    // Note: the rail's OWN Threads tab also shows a repo-wide "Recent" list
    // when no file is open (pre-existing "item 3" behavior, out of this
    // ownership's scope to change) — the landing card renders the SAME data
    // a second time, so scope every assertion to the landing card specifically
    // rather than the page as a whole (papercut noted in the final report).
    await screen.findByText("Recent threads");
    const landingCard = document.querySelector(".cs-landing")!;
    const within = (sel: string) => landingCard.querySelector(sel);
    expect(within(".cs-recent-snippet")?.textContent).toBe("why is this here?");
    expect(within(".kind-tag")?.textContent).toBe("Teach");
    expect(within(".cs-recent-author")?.textContent).toBe("@forge");
    fireEvent.click(within(".cs-recent-row") as HTMLElement);
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
  });

  it("recent files card is empty until a file has been viewed, then lists it and reopens on click", async () => {
    stubFetchNoFile();
    const { router } = mountWithHistory("/code");
    await screen.findByText("Files you open will show up here.");

    fireEvent.click(await screen.findByText("a.ts", { selector: ".dfv-nm" }));
    await screen.findByText("a.ts", { selector: ".rb-file-path" });

    // back to the landing state via the browser back button (pushState per
    // file open, see the history describe block below) re-mounts the card
    // with the freshly-recorded entry.
    router.navigate(-1);
    await screen.findByText("Quick actions");
    expect(await screen.findByText("a.ts", { selector: ".cs-landing-file-path" })).toBeInTheDocument();

    fireEvent.click(screen.getByText("a.ts", { selector: ".cs-landing-file-path" }));
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
  });

  it("quick action 'Search symbols' focuses/opens the header symbol search", async () => {
    stubFetchNoFile();
    mount("/code");
    await screen.findByText("Quick actions");
    fireEvent.click(screen.getByText(/search symbols/i, { selector: ".cs-landing-action" }));
    const input = await screen.findByPlaceholderText(/search symbols/i) as HTMLInputElement;
    expect(document.activeElement).toBe(input);
  });

  it("Cmd/Ctrl+P works from the landing state (no file open) too", async () => {
    stubFetchNoFile();
    mount("/code");
    await screen.findByText("Quick actions");
    fireEvent.keyDown(document, { key: "p", ctrlKey: true });
    const input = await screen.findByPlaceholderText(/search symbols/i) as HTMLInputElement;
    expect(document.activeElement).toBe(input);
  });
});

/* ---- recently-viewed files: localStorage recording (item 2/3) ------------ */
describe("CodeSpacePage — recently-viewed files recording", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("records a file open in localStorage, namespaced per project (cid)", async () => {
    stubFetch();
    mount("/code?path=a.ts");
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    const raw = localStorage.getItem("orcha:cs:recentFiles:c1");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string);
    expect(parsed[0].path).toBe("a.ts");
    expect(typeof parsed[0].viewedAt).toBe("string");
  });

  it("opening a second file moves it to the front, de-duplicated", async () => {
    stubFetch();
    mount("/code?path=a.ts");
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    fireEvent.click(screen.getByText("readme.md"));
    await screen.findByText("readme.md", { selector: ".rb-file-path" });
    const parsed = JSON.parse(localStorage.getItem("orcha:cs:recentFiles:c1") as string);
    expect(parsed.map((e: { path: string }) => e.path)).toEqual(["readme.md", "a.ts"]);
  });

  it("switching tabs (not files) does not record a duplicate entry", async () => {
    stubFetch();
    mount("/code?path=a.ts");
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    fireEvent.click(screen.getByRole("tab", { name: "Live" }));
    fireEvent.click(screen.getByRole("tab", { name: "Threads" }));
    const parsed = JSON.parse(localStorage.getItem("orcha:cs:recentFiles:c1") as string);
    expect(parsed).toHaveLength(1);
  });
});

/* ---- breadcrumb navigation (item 3) --------------------------------------- */
describe("CodeSpacePage — breadcrumb path navigation", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  const NESTED_FILE = { ref: "HEAD", path: "src/lib/util.ts", content: "export const y = 2;", size: 20 };
  const NESTED_TREE_ROOT = {
    ref: "HEAD", path: "",
    entries: [{ name: "src", path: "src", type: "dir" }],
  };
  const NESTED_TREE_SRC = {
    ref: "HEAD", path: "src",
    entries: [{ name: "lib", path: "src/lib", type: "dir" }],
  };
  const NESTED_TREE_LIB = {
    ref: "HEAD", path: "src/lib",
    entries: [{ name: "util.ts", path: "src/lib/util.ts", type: "file" }],
  };

  function stubFetchNested() {
    const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/containers/c1/github/browse/tree")) {
        if (url.includes("path=src%2Flib") || url.includes("path=src/lib")) return json(NESTED_TREE_LIB);
        if (url.includes("path=src")) return json(NESTED_TREE_SRC);
        return json(NESTED_TREE_ROOT);
      }
      if (url.startsWith("/api/containers/c1/github/browse/file")) return json(NESTED_FILE);
      if (url.startsWith("/api/containers/c1/code/threads")) return json(THREADS_MD);
      if (url.startsWith("/api/containers/c1")) {
        return json({ container: { id: "c1", name: "Acme", status: "active", autonomy_level: "plan" }, agents: AGENTS, tasks: [], requests: [] });
      }
      if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
      return json({});
    }) as unknown as typeof fetch;
  }

  it("renders a clickable segment per path component, plus a root crumb, with the file segment non-interactive", async () => {
    stubFetchNested();
    mount("/code?path=src/lib/util.ts");
    await screen.findByText("src/lib/util.ts", { selector: ".rb-file-path" });
    const crumbs = document.querySelector(".cs-breadcrumbs")!;
    expect(crumbs.textContent).toContain("root");
    expect(crumbs.textContent).toContain("src");
    expect(crumbs.textContent).toContain("lib");
    expect(crumbs.textContent).toContain("util.ts");
    // the final (file) segment is a span, not a button — nothing to click to.
    const fileCrumb = crumbs.querySelector(".cs-crumb-file")!;
    expect(fileCrumb.tagName).toBe("SPAN");
  });

  it("clicking an intermediate segment expands that directory in the tree", async () => {
    stubFetchNested();
    mount("/code?path=src/lib/util.ts");
    await screen.findByText("src/lib/util.ts", { selector: ".rb-file-path" });
    // ancestor auto-expand already opens src/ and src/lib/ for the deep link
    // — collapse "src" first so the crumb click has visible work to do.
    const srcRow = document.querySelector('.dfv-dir[title="src"]') as HTMLElement;
    fireEvent.click(srcRow); // collapses
    expect(document.querySelector('.dfv-dir[title="src/lib"]')).toBeNull();

    const srcCrumb = screen.getByText("src", { selector: ".cs-crumb:not(.cs-crumb-file)" });
    fireEvent.click(srcCrumb);
    expect(await screen.findByText("lib", { selector: ".dfv-nm" })).toBeInTheDocument();
  });
});

/* ---- header "Recent files" dropdown (item 3) ------------------------------ */
describe("CodeSpacePage — header Recent files dropdown", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("lists other recently-viewed files (excluding the current one) and opens on click", async () => {
    stubFetch();
    mount("/code?path=a.ts");
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    fireEvent.click(screen.getByText("readme.md"));
    await screen.findByText("readme.md", { selector: ".rb-file-path" });

    fireEvent.click(screen.getByText("Recent files", { selector: ".cs-recentfiles-btn" }));
    const panel = document.querySelector(".cs-recentfiles-panel")!;
    expect(panel.textContent).toContain("a.ts");
    expect(panel.textContent).not.toContain("readme.md");

    fireEvent.click(screen.getByText("a.ts", { selector: ".cs-recentfiles-path" }));
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
  });

  it("Escape closes the open dropdown", async () => {
    stubFetch();
    mount("/code?path=a.ts");
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    fireEvent.click(screen.getByText("readme.md"));
    await screen.findByText("readme.md", { selector: ".rb-file-path" });
    fireEvent.click(screen.getByText("Recent files", { selector: ".cs-recentfiles-btn" }));
    expect(document.querySelector(".cs-recentfiles-panel")).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.querySelector(".cs-recentfiles-panel")).toBeNull();
  });

  // Usability sweep papercut: opening a file via the TREE (bypassing the
  // dropdown entirely) while the dropdown happened to be open used to leave
  // it dangling open over the newly-opened file.
  it("opening a file via the tree (not the dropdown itself) closes an already-open dropdown", async () => {
    stubFetch();
    mount("/code?path=a.ts");
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    fireEvent.click(screen.getByText("Recent files", { selector: ".cs-recentfiles-btn" }));
    expect(document.querySelector(".cs-recentfiles-panel")).not.toBeNull();

    fireEvent.click(screen.getByText("readme.md", { selector: ".dfv-nm" }));
    await screen.findByText("readme.md", { selector: ".rb-file-path" });
    expect(document.querySelector(".cs-recentfiles-panel")).toBeNull();
  });
});

/* ---- browser history behavior (item 3) ------------------------------------ */
describe("CodeSpacePage — history: pushState per file open, no spam on tab switches", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("opening a file pushes history — back returns to the previous file", async () => {
    stubFetch();
    const { router } = mountWithHistory("/code?path=a.ts");
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    fireEvent.click(screen.getByText("readme.md"));
    await screen.findByText("readme.md", { selector: ".rb-file-path" });

    router.navigate(-1);
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
  });

  it("switching rail tabs replaces (no history entry) — back from a tab switch skips straight past it to the previous FILE", async () => {
    stubFetch();
    const { router } = mountWithHistory("/code?path=a.ts");
    await screen.findByText("a.ts", { selector: ".rb-file-path" });

    // one file-open push (readme.md), then a tab switch that must NOT push.
    fireEvent.click(screen.getByText("readme.md"));
    await screen.findByText("readme.md", { selector: ".rb-file-path" });
    fireEvent.click(screen.getByRole("tab", { name: "Live" }));
    await act(async () => { await Promise.resolve(); });

    router.navigate(-1);
    // if the tab switch had pushed its own entry, back would land on
    // readme.md with the Live tab still selected instead of a.ts.
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
  });

  it("jumping to a line (deep-link driven) replaces rather than pushing", async () => {
    stubFetch();
    const { router } = mountWithHistory("/code?path=a.ts");
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    const gutter1 = document.querySelector('[data-cs-line="1"] .cs-gutter') as HTMLElement;
    fireEvent.click(gutter1);
    await screen.findByText(/line 1/i);
    // composer opening from a gutter click didn't navigate to a new file, so
    // back from here should leave Code Space's file entirely (there's no
    // separate "line jump" history frame to walk back through first).
    fireEvent.click(screen.getByText("readme.md"));
    await screen.findByText("readme.md", { selector: ".rb-file-path" });
    router.navigate(-1);
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
  });
});

/* ---- resizable panes (Code Space panel improvements) --------------------- */
describe("CodeSpacePage — resizable panes", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  // jsdom has no PointerEvent constructor AT ALL — @testing-library/dom's
  // fireEvent.pointerDown/Move/Up silently fall back to a plain `Event`
  // that never picks up a `clientX` option (verified: the dispatched event
  // has no own `clientX` property). A hand-built Event with clientX forced
  // on via defineProperty is the only way to get a real coordinate through
  // in this environment — React's synthetic event system reads `clientX`
  // straight off the native event it wraps, so this reaches onPointerDown
  // correctly; a plain `document.addEventListener("pointermove", ...)`
  // reads the same native event directly, so both paths see the value.
  function firePointer(el: Element | Document, type: "pointerdown" | "pointermove" | "pointerup", clientX: number) {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clientX", { value: clientX, configurable: true });
    Object.defineProperty(ev, "pointerId", { value: 1, configurable: true });
    // a raw dispatchEvent (unlike RTL's fireEvent.* helpers) does NOT
    // auto-wrap in act() — the pointermove/up handlers are plain
    // document.addEventListener callbacks (not React synthetic events), so
    // their setState calls need an explicit act() to flush synchronously
    // before the test's next assertion reads the DOM.
    act(() => { el.dispatchEvent(ev); });
  }

  it("renders a divider between the tree and code panes, and between code and rail", async () => {
    stubFetch();
    mount();
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    expect(document.querySelector(".cs-divider-tree")).not.toBeNull();
    expect(document.querySelector(".cs-divider-rail")).not.toBeNull();
  });

  it("dragging the tree divider changes the tree pane's width and persists it", async () => {
    stubFetch();
    mount();
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    const treePane = document.querySelector(".cs-tree-pane") as HTMLElement;
    const before = treePane.style.width;
    const divider = document.querySelector(".cs-divider-tree") as HTMLElement;

    firePointer(divider, "pointerdown", 280);
    firePointer(document, "pointermove", 340); // +60px right
    firePointer(document, "pointerup", 340);

    expect(treePane.style.width).not.toBe(before);
    expect(treePane.style.width).toBe("340px");
    const raw = localStorage.getItem("orcha:cs:panes");
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string).tree).toBe(340);
  });

  it("restores a persisted width on mount", async () => {
    localStorage.setItem("orcha:cs:panes", JSON.stringify({ tree: 200, rail: 260 }));
    stubFetch();
    mount();
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    const treePane = document.querySelector(".cs-tree-pane") as HTMLElement;
    const railPane = document.querySelector(".cs-rail") as HTMLElement;
    expect(treePane.style.width).toBe("200px");
    expect(railPane.style.width).toBe("260px");
  });

  it("double-clicking the tree divider resets just the tree pane to its default width", async () => {
    localStorage.setItem("orcha:cs:panes", JSON.stringify({ tree: 200, rail: 260 }));
    stubFetch();
    mount();
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    const divider = document.querySelector(".cs-divider-tree") as HTMLElement;
    fireEvent.doubleClick(divider);
    const treePane = document.querySelector(".cs-tree-pane") as HTMLElement;
    const railPane = document.querySelector(".cs-rail") as HTMLElement;
    expect(treePane.style.width).toBe("280px"); // DEFAULT_WIDTHS.tree
    expect(railPane.style.width).toBe("260px"); // untouched
  });

  it("dragging the rail divider left grows the rail pane", async () => {
    stubFetch();
    mount();
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    const railPane = document.querySelector(".cs-rail") as HTMLElement;
    const beforeWidth = parseInt(railPane.style.width || "340", 10);
    const divider = document.querySelector(".cs-divider-rail") as HTMLElement;

    firePointer(divider, "pointerdown", 900);
    firePointer(document, "pointermove", 860); // dragged 40px LEFT
    firePointer(document, "pointerup", 860);

    expect(parseInt(railPane.style.width, 10)).toBe(beforeWidth + 40);
  });

  it("a plain click on the code pane (not a drag) still selects text normally — no stray preventDefault", async () => {
    stubFetch();
    mount();
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    // sanity: clicking a line's text span (not the gutter) doesn't throw and
    // doesn't open the composer — regression guard against a global
    // pointerdown handler swallowing normal code-pane interaction.
    const lineText = document.querySelector('[data-cs-line="1"] .cs-line-text') as HTMLElement;
    fireEvent.mouseDown(lineText);
    expect(screen.queryByText(/line 1/i)).not.toBeInTheDocument();
  });
});

/* ---- BUG 3: stale file content during file-switch loading ---------------- */
describe("CodeSpacePage — bug 3: no stale content while switching files", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  const FILE_B = { ref: "HEAD", path: "b.ts", content: "const z = 9;", size: 12 };
  const TREE_ROOT_B = {
    ref: "HEAD", path: "",
    entries: [{ name: "a.ts", path: "a.ts", type: "file" }, { name: "b.ts", path: "b.ts", type: "file" }],
  };

  // A fetch stub whose file-content responses can be held open (resolved
  // manually) so the test can inspect the DOM MID-transition, exactly the
  // race window the live repro caught.
  function stubFetchWithControllableFileLoad() {
    const fileResolvers: Record<string, (v: unknown) => void> = {};
    const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/containers/c1/github/browse/tree")) return json(TREE_ROOT_B);
      if (url.startsWith("/api/containers/c1/github/browse/file")) {
        const isB = url.includes("path=b.ts");
        const key = isB ? "b.ts" : "a.ts";
        return new Promise((resolve) => { fileResolvers[key] = () => resolve(json(isB ? FILE_B : FILE_A)); });
      }
      if (url.startsWith("/api/containers/c1/code/threads")) return json(THREADS_MD);
      if (url.startsWith("/api/containers/c1")) {
        return json({ container: { id: "c1", name: "Acme", status: "active", autonomy_level: "plan" }, agents: AGENTS, tasks: [], requests: [] });
      }
      if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
      return json({});
    }) as unknown as typeof fetch;
    return fileResolvers;
  }

  it("does not render the PREVIOUS file's lines while the NEW file is still loading", async () => {
    const resolvers = stubFetchWithControllableFileLoad();
    mount();
    await vi.waitFor(() => expect(resolvers["a.ts"]).toBeTypeOf("function"));
    resolvers["a.ts"]({});
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    // a.ts's real content is 3 lines; confirm it painted before switching.
    expect(document.querySelector('[data-cs-line="3"]')).not.toBeNull();

    fireEvent.click(screen.getByText("b.ts", { selector: ".dfv-nm" }));
    // b.ts's fetch is still pending (resolver not called yet) — the pane
    // must NOT still show "a.ts" as the active file path, and must show a
    // loading skeleton rather than a.ts's stale content.
    expect(document.querySelector(".rb-file-path")?.textContent).not.toBe("a.ts");
  });

  it("gutter clicks during the loading window do nothing (no composer opens for stale content)", async () => {
    const resolvers = stubFetchWithControllableFileLoad();
    mount();
    await vi.waitFor(() => expect(resolvers["a.ts"]).toBeTypeOf("function"));
    resolvers["a.ts"]({});
    await screen.findByText("a.ts", { selector: ".rb-file-path" });

    fireEvent.click(screen.getByText("b.ts", { selector: ".dfv-nm" }));
    // still mid-load — there should be NO clickable .cs-gutter at all right
    // now (the skeleton has no gutter), so no stray composer can open.
    expect(document.querySelector(".cs-gutter")).toBeNull();

    resolvers["b.ts"]({});
    await screen.findByText("b.ts", { selector: ".rb-file-path" });
    // once loaded, b.ts's own single line IS clickable and anchors correctly.
    const gutter1 = document.querySelector('[data-cs-line="1"] .cs-gutter') as HTMLElement;
    fireEvent.click(gutter1);
    expect(await screen.findByText(/line 1/i)).toBeInTheDocument();
  });

  it("flow (a): after opening an existing thread, clicking a DIFFERENT line in the SAME file reopens the composer", async () => {
    stubFetch();
    mount();
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    const chip = await screen.findByText("Question");
    fireEvent.click(chip.closest(".cs-thread-chip") as HTMLElement);
    expect(await screen.findByText(/back to threads/i)).toBeInTheDocument();

    const gutter3 = document.querySelector('[data-cs-line="3"] .cs-gutter') as HTMLElement;
    fireEvent.click(gutter3);
    expect(await screen.findByText(/line 3/i)).toBeInTheDocument();
    expect(screen.queryByText(/back to threads/i)).not.toBeInTheDocument();
  });

  it("flow (b): after opening a thread, switching file and clicking a line reopens the composer AND the rail shows the new file's own context", async () => {
    stubFetch();
    mount();
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    const chip = await screen.findByText("Question");
    fireEvent.click(chip.closest(".cs-thread-chip") as HTMLElement);
    expect(await screen.findByText(/back to threads/i)).toBeInTheDocument();

    fireEvent.click(screen.getByText("readme.md"));
    await screen.findByText("readme.md", { selector: ".rb-file-path" });
    fireEvent.click(screen.getByText("Raw")); // readme.md defaults to Rendered — need Raw for a gutter

    const gutter1 = document.querySelector('[data-cs-line="1"] .cs-gutter') as HTMLElement;
    fireEvent.click(gutter1);
    expect(await screen.findByText(/line 1/i)).toBeInTheDocument();
    // rail must NOT be stuck on the repo-wide Recent list.
    expect(screen.queryByText(/recent threads \(all files\)/i)).not.toBeInTheDocument();
  });
});
