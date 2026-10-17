/**
 * Parity round 2 (sidebar):
 *  · branch rows ellipsize in the MIDDLE (head yields, tail stays) so a long
 *    branch keeps its recognisable end (wave-4 review minor).
 *  · the icon picker's colour swatches are named by hue ("Blue"), not "Colour 8".
 */
import { describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { splitBranch } from "./Sidebar";
import { EmojiPicker, HUE_NAMES } from "../components/primitives/EmojiPicker";

describe("splitBranch (middle ellipsis)", () => {
  it("does not split short names", () => {
    expect(splitBranch("main")).toEqual(["main", ""]);
    expect(splitBranch("mira/login")).toEqual(["mira/login", ""]);
  });
  it("keeps the longest separator-led tail of ≤ 16 chars", () => {
    const b = "feat/dark-tokens-and-collapsed-rail";
    const [head, tail] = splitBranch(b);
    expect(head + tail).toBe(b);
    expect(tail).toBe("-collapsed-rail");
  });
  it("falls back to the last 12 chars when no separator fits", () => {
    const b = "averyveryverylongbranchnamewithoutseparators";
    const [head, tail] = splitBranch(b);
    expect(head + tail).toBe(b);
    expect(tail).toHaveLength(12);
  });
  it("never produces a tiny tail", () => {
    const [, tail] = splitBranch("infrastructure-oom-watchdog-x");
    expect(tail.length).toBeGreaterThanOrEqual(4);
  });
});

describe("icon picker colour swatches", () => {
  it("are named by hue for assistive tech", () => {
    const anchor = createRef<HTMLButtonElement>();
    render(<><button ref={anchor}>a</button>
      <EmojiPicker anchor={anchor} open onClose={vi.fn()} label="Change icon for x" value={{ kind: "glyph", value: "box", color: null }} onPick={vi.fn()} onReset={vi.fn()} /></>);
    const dlg = screen.getByRole("dialog", { name: /Change icon/ });
    fireEvent.click(within(dlg).getByRole("tab", { name: "Icons" }));
    const group = within(dlg).getByRole("radiogroup", { name: "Icon colour" });
    const names = within(group).getAllByRole("radio").map((r) => r.getAttribute("aria-label"));
    expect(names).toEqual(["No colour", ...HUE_NAMES]);
    expect(names.some((n) => /^Colour \d/.test(n || ""))).toBe(false);
  });
});
