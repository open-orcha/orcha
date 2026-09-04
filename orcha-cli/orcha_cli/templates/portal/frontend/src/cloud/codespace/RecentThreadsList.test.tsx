/**
 * RecentThreadsList — the shared repo-wide "Recent threads" rows (extracted
 * out of ThreadRail.tsx so the landing state can reuse it verbatim): richer
 * rows (kind pill + author, on top of the original glyph/loc/snippet/time),
 * empty state, click-to-open, and keyboard activation (Enter/Space).
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodeThreadSummary } from "./codespaceTypes";
import { RecentThreadsList } from "./RecentThreadsList";

const THREAD: CodeThreadSummary = {
  id: "t1", ref: "HEAD", sha: "aaa", path: "src/a.ts", start_line: 3, end_line: 5,
  kind: "why", status: "open", first_message: "why does this exist?",
  created_by_alias: "forge", created_at: "now", updated_at: "now",
};

describe("RecentThreadsList", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("shows the default empty label when there are no threads", () => {
    render(<RecentThreadsList threads={[]} />);
    expect(screen.getByText("No threads yet.")).toBeInTheDocument();
  });

  it("accepts a custom empty label", () => {
    render(<RecentThreadsList threads={[]} emptyLabel="Nothing here yet." />);
    expect(screen.getByText("Nothing here yet.")).toBeInTheDocument();
  });

  it("renders a richer row: glyph, path:lines, snippet, kind pill, author, relative time", () => {
    render(<RecentThreadsList threads={[THREAD]} />);
    expect(screen.getByText("src/a.ts:3-5")).toBeInTheDocument();
    expect(screen.getByText("why does this exist?")).toBeInTheDocument();
    expect(screen.getByText("Why")).toBeInTheDocument();
    expect(screen.getByText("@forge")).toBeInTheDocument();
  });

  it("falls back to the kind label when first_message is absent", () => {
    render(<RecentThreadsList threads={[{ ...THREAD, first_message: undefined }]} />);
    expect(screen.getByText("Why", { selector: ".cs-recent-snippet" })).toBeInTheDocument();
  });

  it("omits the author chip when created_by_alias is absent", () => {
    render(<RecentThreadsList threads={[{ ...THREAD, created_by_alias: undefined }]} />);
    expect(document.querySelector(".cs-recent-author")).toBeNull();
  });

  it("clicking a row calls onOpen with the thread", () => {
    const onOpen = vi.fn();
    render(<RecentThreadsList threads={[THREAD]} onOpen={onOpen} />);
    fireEvent.click(screen.getByText("src/a.ts:3-5"));
    expect(onOpen).toHaveBeenCalledWith(THREAD);
  });

  it("Enter/Space activates a row when onOpen is provided (keyboard access)", () => {
    const onOpen = vi.fn();
    render(<RecentThreadsList threads={[THREAD]} onOpen={onOpen} />);
    const row = document.querySelector(".cs-recent-row") as HTMLElement;
    fireEvent.keyDown(row, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(row, { key: " " });
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("rows are not focusable/keyboard-actionable when onOpen is omitted", () => {
    render(<RecentThreadsList threads={[THREAD]} />);
    const row = document.querySelector(".cs-recent-row") as HTMLElement;
    expect(row.getAttribute("role")).toBeNull();
    expect(row.getAttribute("tabindex")).toBeNull();
  });
});
