/**
 * SymbolSearch — the Code Space header's workspace symbol search: debounced
 * GET .../code/symbols?ref=&q=, results grouped by path, click navigates to
 * that file at the symbol's line. Cmd/Ctrl+P opens it from anywhere on the
 * page; Escape closes it.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SymbolSearch } from "./SymbolSearch";

function stubFetch(data: unknown, status = 200) {
  global.fetch = vi.fn(async () => ({ ok: status < 400, status, json: async () => data }) as unknown as Response) as unknown as typeof fetch;
}

describe("SymbolSearch", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it("renders a search input closed by default", () => {
    render(<SymbolSearch cid="c1" gitRef="HEAD" onNavigate={vi.fn()} />);
    expect(screen.getByPlaceholderText(/search symbols/i)).toBeInTheDocument();
    expect(screen.queryByText(/results grouped by file/i)).not.toBeInTheDocument();
  });

  it("debounces the query before fetching, grouped by path", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubFetch({
      available: true, ref: "HEAD",
      results: [
        { name: "Widget", kind: "class", path: "b.ts", line: 1 },
        { name: "widgetHelper", kind: "function", path: "a.ts", line: 4 },
      ],
    });
    render(<SymbolSearch cid="c1" gitRef="HEAD" onNavigate={vi.fn()} />);
    const input = screen.getByPlaceholderText(/search symbols/i);
    fireEvent.change(input, { target: { value: "widget" } });
    // not fetched immediately
    expect(global.fetch).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const calledUrl = String((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(calledUrl).toBe("/api/containers/c1/code/symbols?ref=HEAD&q=widget");
    expect(await screen.findByText("Widget")).toBeInTheDocument();
    expect(screen.getByText("widgetHelper")).toBeInTheDocument();
    expect(screen.getByText("b.ts")).toBeInTheDocument();
    expect(screen.getByText("a.ts")).toBeInTheDocument();
  });

  it("clicking a result navigates to its file at its line", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubFetch({ available: true, ref: "HEAD", results: [{ name: "Widget", kind: "class", path: "b.ts", line: 7 }] });
    const onNavigate = vi.fn();
    render(<SymbolSearch cid="c1" gitRef="HEAD" onNavigate={onNavigate} />);
    fireEvent.change(screen.getByPlaceholderText(/search symbols/i), { target: { value: "Widget" } });
    await act(async () => { vi.advanceTimersByTime(300); });
    const row = await screen.findByText("Widget");
    fireEvent.click(row.closest(".cs-symsearch-row") as HTMLElement);
    expect(onNavigate).toHaveBeenCalledWith("b.ts", 7);
  });

  it("shows an empty state when the query has no matches", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubFetch({ available: true, ref: "HEAD", results: [] });
    render(<SymbolSearch cid="c1" gitRef="HEAD" onNavigate={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/search symbols/i), { target: { value: "nope" } });
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(await screen.findByText(/no symbols match/i)).toBeInTheDocument();
  });

  it("shows a truncated notice when the backend caps results", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubFetch({ available: true, ref: "HEAD", results: [{ name: "x", kind: "var", path: "a.ts", line: 1 }], truncated: true });
    render(<SymbolSearch cid="c1" gitRef="HEAD" onNavigate={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/search symbols/i), { target: { value: "x" } });
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(await screen.findByText(/more results/i)).toBeInTheDocument();
  });

  it("renders the not-connected degrade state via the shared error ladder", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubFetch({ available: false, reason: "repo_not_connected", detail: "no repo" });
    render(<SymbolSearch cid="c1" gitRef="HEAD" onNavigate={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/search symbols/i), { target: { value: "x" } });
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(await screen.findByText(/no github repo connected/i)).toBeInTheDocument();
  });

  it("renders the rate-limited degrade state", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubFetch({ available: false, reason: "rate_limited", detail: "backing off" });
    render(<SymbolSearch cid="c1" gitRef="HEAD" onNavigate={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/search symbols/i), { target: { value: "x" } });
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(await screen.findByText(/rate limit/i)).toBeInTheDocument();
  });

  it("Cmd/Ctrl+P focuses the search input from anywhere on the page", () => {
    render(<SymbolSearch cid="c1" gitRef="HEAD" onNavigate={vi.fn()} />);
    const input = screen.getByPlaceholderText(/search symbols/i) as HTMLInputElement;
    expect(document.activeElement).not.toBe(input);
    fireEvent.keyDown(document, { key: "p", metaKey: true });
    expect(document.activeElement).toBe(input);
  });

  it("supports a prefilled initial query (identifier-click hookup)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubFetch({ available: true, ref: "HEAD", results: [{ name: "helper", kind: "function", path: "a.ts", line: 2 }] });
    render(<SymbolSearch cid="c1" gitRef="HEAD" onNavigate={vi.fn()} prefill="helper" prefillToken={1} />);
    const input = screen.getByPlaceholderText(/search symbols/i) as HTMLInputElement;
    expect(input.value).toBe("helper");
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(await screen.findByText("helper")).toBeInTheDocument();
  });

  it("BUG 4: closes when the current file path changes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubFetch({ available: true, ref: "HEAD", results: [{ name: "helper", kind: "function", path: "a.ts", line: 2 }] });
    const { rerender } = render(<SymbolSearch cid="c1" gitRef="HEAD" onNavigate={vi.fn()} path="a.ts" />);
    fireEvent.change(screen.getByPlaceholderText(/search symbols/i), { target: { value: "helper" } });
    fireEvent.focus(screen.getByPlaceholderText(/search symbols/i));
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(await screen.findByText("helper")).toBeInTheDocument();

    rerender(<SymbolSearch cid="c1" gitRef="HEAD" onNavigate={vi.fn()} path="b.ts" />);
    expect(screen.queryByText("helper")).not.toBeInTheDocument();
  });

  it("BUG 4: closes on scroll (capture-phase, any scrollable ancestor)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubFetch({ available: true, ref: "HEAD", results: [{ name: "helper", kind: "function", path: "a.ts", line: 2 }] });
    render(<SymbolSearch cid="c1" gitRef="HEAD" onNavigate={vi.fn()} path="a.ts" />);
    fireEvent.change(screen.getByPlaceholderText(/search symbols/i), { target: { value: "helper" } });
    fireEvent.focus(screen.getByPlaceholderText(/search symbols/i));
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(await screen.findByText("helper")).toBeInTheDocument();

    fireEvent.scroll(window);
    expect(screen.queryByText("helper")).not.toBeInTheDocument();
  });

  it("does NOT close on scroll while the panel is already closed (no-op guard)", () => {
    render(<SymbolSearch cid="c1" gitRef="HEAD" onNavigate={vi.fn()} path="a.ts" />);
    expect(() => fireEvent.scroll(window)).not.toThrow();
  });
});
