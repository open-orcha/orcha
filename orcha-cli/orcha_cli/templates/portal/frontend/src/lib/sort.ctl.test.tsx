import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SortCtl, sortState } from "./sort";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("SortCtl — compact menu button (D2)", () => {
  it("shows the current choice and persists a new pick", () => {
    const onChange = vi.fn();
    const { container } = render(<SortCtl name="t-sort" onChange={onChange} />);
    const btn = screen.getByRole("button", { name: /Sort\s+Newest/ });
    expect(btn).toHaveAttribute("aria-haspopup", "menu");
    expect(btn.className).toContain("v2-btn-ghost");
    expect(container.querySelector("[data-sort='t-sort']")).not.toBeNull();
    fireEvent.click(btn);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Highest priority first/ }));
    expect(sortState("t-sort")).toEqual({ key: "priority", dir: "asc" });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /Sort\s+Priority/ })).toBeInTheDocument();
  });

  it("re-picking the active choice is a no-op", () => {
    const onChange = vi.fn();
    render(<SortCtl name="t-sort2" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /Sort/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Newest first/ }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
