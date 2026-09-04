/**
 * RepoBrowser — mounted standalone (no GitHubPage/SnapshotProvider needed:
 * it only takes cid/ref/path/onNavigate as props and talks to the browse/*
 * endpoints directly), fetch stubbed per-URL like GitHubPage.test.tsx.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RepoBrowser } from "./RepoBrowser";

interface Call { url: string }

function stubFetch(handlers: Record<string, unknown | ((url: string) => unknown)>): Call[] {
  const calls: Call[] = [];
  const json = (data: unknown, status = 200) =>
    ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push({ url });
    for (const key of Object.keys(handlers)) {
      if (url.includes(key)) {
        const h = handlers[key];
        const data = typeof h === "function" ? (h as (u: string) => unknown)(url) : h;
        if (data && typeof data === "object" && "__status" in (data as Record<string, unknown>)) {
          const d = data as { __status: number; body: unknown };
          return json(d.body, d.__status);
        }
        return json(data);
      }
    }
    return json({});
  }) as unknown as typeof fetch;
  return calls;
}

function mount(props: Partial<Parameters<typeof RepoBrowser>[0]> = {}) {
  const onNavigate = props.onNavigate || vi.fn();
  return {
    onNavigate,
    ...render(
      <RepoBrowser
        cid="c1"
        gitRef="HEAD"
        path=""
        htmlUrlBase="https://github.com/acme/app"
        onNavigate={onNavigate}
        {...props}
      />,
    ),
  };
}

describe("RepoBrowser tree", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("lazy-loads the root dir on mount and renders entries", async () => {
    const calls = stubFetch({
      "/browse/tree": (url: string) => {
        if (url.includes("path=src")) {
          return { ref: "HEAD", path: "src", entries: [{ name: "index.ts", path: "src/index.ts", type: "file" }] };
        }
        return {
          ref: "HEAD",
          path: "",
          entries: [
            { name: "src", path: "src", type: "dir" },
            { name: "README.md", path: "README.md", type: "file", size: 120 },
          ],
        };
      },
    });
    mount();
    expect(await screen.findByText("src")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes("/browse/tree") && c.url.includes("path=") && !c.url.includes("path=src"))).toBe(true);
    // child dir not fetched yet (lazy)
    expect(calls.some((c) => c.url.includes("path=src"))).toBe(false);
  });

  it("expands a dir on click and lazy-loads its children exactly once", async () => {
    const calls = stubFetch({
      "/browse/tree": (url: string) => {
        if (url.includes("path=src")) {
          return { ref: "HEAD", path: "src", entries: [{ name: "index.ts", path: "src/index.ts", type: "file" }] };
        }
        return { ref: "HEAD", path: "", entries: [{ name: "src", path: "src", type: "dir" }] };
      },
    });
    mount();
    const dirRow = await screen.findByText("src");
    fireEvent.click(dirRow);
    expect(await screen.findByText("index.ts")).toBeInTheDocument();
    const childCalls = calls.filter((c) => c.url.includes("/browse/tree") && c.url.includes("path=src"));
    expect(childCalls.length).toBe(1);
    // collapse then re-expand should NOT refetch (already cached)
    fireEvent.click(screen.getByText("src"));
    fireEvent.click(screen.getByText("src"));
    await waitFor(() => expect(screen.getByText("index.ts")).toBeInTheDocument());
    expect(calls.filter((c) => c.url.includes("/browse/tree") && c.url.includes("path=src")).length).toBe(1);
  });

  it("clicking a file calls onNavigate with its path", async () => {
    stubFetch({
      "/browse/tree": { ref: "HEAD", path: "", entries: [{ name: "README.md", path: "README.md", type: "file" }] },
      "/browse/file": { ref: "HEAD", path: "README.md", content: "hi", size: 2 },
    });
    const onNavigate = vi.fn();
    mount({ onNavigate });
    const fileRow = await screen.findByText("README.md");
    fireEvent.click(fileRow);
    expect(onNavigate).toHaveBeenCalledWith({ path: "README.md" });
  });

  it("degrades through the not_connected ladder when the root tree 404s", async () => {
    stubFetch({ "/browse/tree": { __status: 404, body: { detail: "no repo" } } });
    mount();
    expect(await screen.findByText("No GitHub repo connected")).toBeInTheDocument();
  });

  it("degrades through the rate_limited ladder on a 403", async () => {
    stubFetch({ "/browse/tree": { __status: 403, body: { detail: "slow down" } } });
    mount();
    expect(await screen.findByText("GitHub rate limit hit")).toBeInTheDocument();
  });

  // Folder-expand failure caching regression — a transient dir-load failure
  // (e.g. a GitHub rate-limit blip on ONE nested folder, root already fine)
  // must not get cached forever: the error row is itself a click-to-retry
  // affordance, and re-expanding after collapsing also retries.
  it("a failed dir expand shows a click-to-retry row, and retrying re-fetches successfully", async () => {
    let call = 0;
    const calls = stubFetch({
      "/browse/tree": (url: string) => {
        if (url.includes("path=src")) {
          call++;
          if (call === 1) return { __status: 403, body: { detail: "slow down" } };
          return { ref: "HEAD", path: "src", entries: [{ name: "index.ts", path: "src/index.ts", type: "file" }] };
        }
        return { ref: "HEAD", path: "", entries: [{ name: "src", path: "src", type: "dir" }] };
      },
    });
    mount();
    const dirRow = await screen.findByText("src");
    fireEvent.click(dirRow);
    const retryRow = await screen.findByText(/couldn.t load this folder — tap to retry/i);

    fireEvent.click(retryRow);
    expect(await screen.findByText("index.ts")).toBeInTheDocument();
    expect(calls.filter((c) => c.url.includes("/browse/tree") && c.url.includes("path=src")).length).toBe(2);
  });

  it("collapsing and re-expanding a failed dir retries instead of re-showing the same cached error", async () => {
    let call = 0;
    stubFetch({
      "/browse/tree": (url: string) => {
        if (url.includes("path=src")) {
          call++;
          if (call === 1) return { __status: 403, body: { detail: "slow down" } };
          return { ref: "HEAD", path: "src", entries: [{ name: "index.ts", path: "src/index.ts", type: "file" }] };
        }
        return { ref: "HEAD", path: "", entries: [{ name: "src", path: "src", type: "dir" }] };
      },
    });
    mount();
    const dirRow = await screen.findByText("src");
    fireEvent.click(dirRow); // expand: fails
    await screen.findByText(/couldn.t load this folder/i);

    fireEvent.click(screen.getByText("src")); // collapse
    fireEvent.click(screen.getByText("src")); // re-expand: must retry, not reuse the cached error
    expect(await screen.findByText("index.ts")).toBeInTheDocument();
    expect(call).toBe(2);
  });
});

describe("RepoBrowser content pane", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("renders file content with line numbers", async () => {
    stubFetch({
      "/browse/tree": { ref: "HEAD", path: "", entries: [] },
      "/browse/file": { ref: "HEAD", path: "a.js", content: "const x = 1;\nconsole.log(x);", size: 30 },
    });
    mount({ path: "a.js" });
    expect(await screen.findByText("a.js")).toBeInTheDocument();
    expect(document.querySelector('[data-browse-line="1"] .rb-lineno')).toHaveTextContent("1");
    expect(document.querySelector('[data-browse-line="2"] .rb-lineno')).toHaveTextContent("2");
    expect(screen.getByText("const")).toBeInTheDocument(); // keyword token rendered as its own span
  });

  it("shows a truncated notice with a view-on-GitHub link", async () => {
    stubFetch({
      "/browse/tree": { ref: "HEAD", path: "", entries: [] },
      "/browse/file": { ref: "HEAD", path: "big.txt", content: "partial", size: 999999, truncated: true },
    });
    mount({ path: "big.txt", gitRef: "main" });
    expect(await screen.findByText(/truncated/i)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /view on github/i });
    expect(link).toHaveAttribute("href", "https://github.com/acme/app/blob/main/big.txt");
  });

  it("shows a binary placeholder instead of content", async () => {
    stubFetch({
      "/browse/tree": { ref: "HEAD", path: "", entries: [] },
      "/browse/file": { ref: "HEAD", path: "logo.png", content: "", size: 5000, binary: true },
    });
    mount({ path: "logo.png" });
    expect(await screen.findByText(/binary file not shown/i)).toBeInTheDocument();
  });

  it("shows the empty-pane hint when no file is selected", () => {
    stubFetch({ "/browse/tree": { ref: "HEAD", path: "", entries: [] } });
    mount({ path: "" });
    expect(screen.getByText(/select a file/i)).toBeInTheDocument();
  });

  it("degrades through not_found for a missing file", async () => {
    stubFetch({
      "/browse/tree": { ref: "HEAD", path: "", entries: [] },
      "/browse/file": { __status: 404, body: { reason: "not_found" } },
    });
    mount({ path: "ghost.ts" });
    expect(await screen.findByText("File not found")).toBeInTheDocument();
  });
});

describe("RepoBrowser search", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("names mode: debounces then lists matching paths, clicking navigates", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubFetch({
      "/browse/tree": { ref: "HEAD", path: "", entries: [] },
      "/browse/search": { results: [{ path: "src/App.tsx", type: "file" }] },
    });
    const onNavigate = vi.fn();
    mount({ onNavigate });
    const input = screen.getByLabelText(/search repo files/i);
    fireEvent.change(input, { target: { value: "App" } });
    // not yet fired before the 300ms debounce
    expect(screen.queryByText("src/App.tsx")).not.toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(320);
    vi.useRealTimers();
    expect(await screen.findByText("src/App.tsx")).toBeInTheDocument();
    fireEvent.click(screen.getByText("src/App.tsx"));
    expect(onNavigate).toHaveBeenCalledWith({ path: "src/App.tsx" });
  });

  it("contents mode: shows per-file match lines and a default_branch_only note", async () => {
    stubFetch({
      "/browse/tree": { ref: "HEAD", path: "", entries: [] },
      "/browse/search": {
        results: [{ path: "src/App.tsx", matches: [{ line: 12, text: "  const foo = 1;" }] }],
        default_branch_only: true,
      },
    });
    const onNavigate = vi.fn();
    mount({ onNavigate });
    fireEvent.click(screen.getByRole("tab", { name: "Contents" }));
    fireEvent.change(screen.getByLabelText(/search repo files/i), { target: { value: "foo" } });
    expect(await screen.findByText(/default branch only/i)).toBeInTheDocument();
    const matchText = await screen.findByText((_, el) => el?.className === "rb-result-text mono");
    fireEvent.click(matchText.closest(".rb-result-match") as HTMLElement);
    expect(onNavigate).toHaveBeenCalledWith({ path: "src/App.tsx" });
  });

  it("shows a no-matches message when the search returns empty", async () => {
    stubFetch({
      "/browse/tree": { ref: "HEAD", path: "", entries: [] },
      "/browse/search": { results: [] },
    });
    mount();
    fireEvent.change(screen.getByLabelText(/search repo files/i), { target: { value: "zzz-nope" } });
    expect(await screen.findByText(/no matches/i)).toBeInTheDocument();
  });

  it("degrades through the error ladder when search fails", async () => {
    stubFetch({
      "/browse/tree": { ref: "HEAD", path: "", entries: [] },
      "/browse/search": { __status: 500, body: { detail: "boom" } },
    });
    mount();
    fireEvent.change(screen.getByLabelText(/search repo files/i), { target: { value: "x" } });
    expect(await screen.findByText(/couldn.t load/i)).toBeInTheDocument();
  });
});

describe("RepoBrowser ref change", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("re-fetches the tree when ref changes", async () => {
    const calls = stubFetch({ "/browse/tree": { ref: "HEAD", path: "", entries: [] } });
    const { rerender } = render(
      <RepoBrowser cid="c1" gitRef="HEAD" path="" onNavigate={() => {}} />,
    );
    await waitFor(() => expect(calls.some((c) => c.url.includes("ref=HEAD"))).toBe(true));
    rerender(<RepoBrowser cid="c1" gitRef="pr/12" path="" onNavigate={() => {}} />);
    await waitFor(() => expect(calls.some((c) => c.url.includes("ref=pr%2F12"))).toBe(true));
  });
});
