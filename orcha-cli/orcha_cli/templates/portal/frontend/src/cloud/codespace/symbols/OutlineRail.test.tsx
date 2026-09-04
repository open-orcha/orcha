/**
 * OutlineRail — the Outline tab: fetches GET .../code/outline?ref=&path= for
 * the currently open file, groups by kind, and jumps the viewer to a
 * symbol's line on click.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutlineRail } from "./OutlineRail";

function stubFetch(data: unknown, status = 200) {
  global.fetch = vi.fn(async () => ({ ok: status < 400, status, json: async () => data }) as unknown as Response) as unknown as typeof fetch;
}

describe("OutlineRail", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("shows a prompt when no file is open", () => {
    render(<OutlineRail cid="c1" gitRef="HEAD" path="" onJumpToLine={vi.fn()} />);
    expect(screen.getByText(/select a file/i)).toBeInTheDocument();
  });

  it("fetches the outline and renders symbols grouped by kind", async () => {
    stubFetch({
      available: true, ref: "HEAD", path: "a.ts", language: "typescript",
      symbols: [
        { name: "helper", kind: "function", line: 10 },
        { name: "Widget", kind: "class", line: 1 },
        { name: "MAX", kind: "const", line: 5 },
      ],
    });
    render(<OutlineRail cid="c1" gitRef="HEAD" path="a.ts" onJumpToLine={vi.fn()} />);
    expect(await screen.findByText("Widget")).toBeInTheDocument();
    expect(screen.getByText("helper")).toBeInTheDocument();
    expect(screen.getByText("MAX")).toBeInTheDocument();
    // section headers follow the design doc's kind order: function, class,
    // interface, type, const, var — regardless of file order.
    const headers = document.querySelectorAll(".cs-outline-group-head");
    expect(Array.from(headers).map((h) => h.textContent)).toEqual(["Function", "Class", "Const"]);
    const calledUrl = String((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(calledUrl).toBe("/api/containers/c1/code/outline?path=a.ts&ref=HEAD");
  });

  it("clicking a symbol jumps the viewer to its line", async () => {
    stubFetch({
      available: true, ref: "HEAD", path: "a.ts", language: "typescript",
      symbols: [{ name: "helper", kind: "function", line: 42 }],
    });
    const onJumpToLine = vi.fn();
    render(<OutlineRail cid="c1" gitRef="HEAD" path="a.ts" onJumpToLine={onJumpToLine} />);
    const row = await screen.findByText("helper");
    fireEvent.click(row.closest(".cs-outline-row") as HTMLElement);
    expect(onJumpToLine).toHaveBeenCalledWith(42);
  });

  it("shows an honest empty state when the file has no supported language", async () => {
    stubFetch({ available: true, ref: "HEAD", path: "a.bin", language: null, symbols: [] });
    render(<OutlineRail cid="c1" gitRef="HEAD" path="a.bin" onJumpToLine={vi.fn()} />);
    expect(await screen.findByText(/no outline available/i)).toBeInTheDocument();
  });

  it("shows an empty state when a supported file has no symbols", async () => {
    stubFetch({ available: true, ref: "HEAD", path: "a.ts", language: "typescript", symbols: [] });
    render(<OutlineRail cid="c1" gitRef="HEAD" path="a.ts" onJumpToLine={vi.fn()} />);
    expect(await screen.findByText(/no symbols found/i)).toBeInTheDocument();
  });

  it("renders the not-connected degrade state via the shared error ladder", async () => {
    stubFetch({ available: false, reason: "repo_not_connected", detail: "no repo" });
    render(<OutlineRail cid="c1" gitRef="HEAD" path="a.ts" onJumpToLine={vi.fn()} />);
    expect(await screen.findByText(/no github repo connected/i)).toBeInTheDocument();
  });

  it("re-fetches when the path changes", async () => {
    stubFetch({ available: true, ref: "HEAD", path: "a.ts", language: "typescript", symbols: [] });
    const { rerender } = render(<OutlineRail cid="c1" gitRef="HEAD" path="a.ts" onJumpToLine={vi.fn()} />);
    await screen.findByText(/no symbols found/i);
    stubFetch({ available: true, ref: "HEAD", path: "b.ts", language: "typescript", symbols: [{ name: "x", kind: "var", line: 1 }] });
    rerender(<OutlineRail cid="c1" gitRef="HEAD" path="b.ts" onJumpToLine={vi.fn()} />);
    expect(await screen.findByText("x")).toBeInTheDocument();
  });
});
