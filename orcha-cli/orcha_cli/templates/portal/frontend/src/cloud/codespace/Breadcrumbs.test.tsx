/**
 * Breadcrumbs — path-segment math (breadcrumbSegments) plus the rendered
 * nav: clickable dir segments, non-interactive final (file) segment, root
 * crumb always opens "".
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Breadcrumbs, breadcrumbSegments } from "./Breadcrumbs";

describe("breadcrumbSegments", () => {
  it("returns [] for an empty path", () => {
    expect(breadcrumbSegments("")).toEqual([]);
  });

  it("a root-level file is a single isFile segment, no leading dir crumb", () => {
    expect(breadcrumbSegments("a.ts")).toEqual([{ name: "a.ts", dirPath: "a.ts", isFile: true }]);
  });

  it("a nested file produces one segment per path component, dirPath accumulating", () => {
    expect(breadcrumbSegments("src/lib/util.ts")).toEqual([
      { name: "src", dirPath: "src", isFile: false },
      { name: "lib", dirPath: "src/lib", isFile: false },
      { name: "util.ts", dirPath: "src/lib/util.ts", isFile: true },
    ]);
  });
});

describe("Breadcrumbs", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("renders nothing for an empty path", () => {
    const { container } = render(<Breadcrumbs path="" onOpenDir={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("root crumb click opens the repo root (dirPath '')", () => {
    const onOpenDir = vi.fn();
    render(<Breadcrumbs path="src/util.ts" onOpenDir={onOpenDir} />);
    fireEvent.click(screen.getByText("root"));
    expect(onOpenDir).toHaveBeenCalledWith("");
  });

  it("clicking an intermediate dir segment opens ITS accumulated path", () => {
    const onOpenDir = vi.fn();
    render(<Breadcrumbs path="src/lib/util.ts" onOpenDir={onOpenDir} />);
    fireEvent.click(screen.getByText("src", { selector: "button" }));
    expect(onOpenDir).toHaveBeenCalledWith("src");
    fireEvent.click(screen.getByText("lib", { selector: "button" }));
    expect(onOpenDir).toHaveBeenCalledWith("src/lib");
  });

  it("the final (file) segment is non-interactive — a span, not a button", () => {
    render(<Breadcrumbs path="src/util.ts" onOpenDir={vi.fn()} />);
    const fileSeg = screen.getByText("util.ts");
    expect(fileSeg.tagName).toBe("SPAN");
    expect(fileSeg.className).toContain("cs-crumb-file");
  });

  it("a root-level file still renders the root crumb plus the (non-interactive) file segment", () => {
    render(<Breadcrumbs path="a.ts" onOpenDir={vi.fn()} />);
    expect(screen.getByText("root")).toBeInTheDocument();
    expect(screen.getByText("a.ts").tagName).toBe("SPAN");
  });
});
