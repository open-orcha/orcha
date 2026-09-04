/**
 * usePaneWidths — pure width-state management for the three-pane resize
 * system (tree | code | rail). No DOM measurement here: the hook only owns
 * numbers (px widths) + localStorage persistence + drag-delta application.
 * CodeSpacePage.tsx wires pointer events and applies the returned widths as
 * inline styles.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_WIDTHS, MIN_WIDTHS, usePaneWidths } from "./usePaneWidths";

describe("usePaneWidths", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { localStorage.clear(); });

  it("starts at the default widths when localStorage is empty", () => {
    const { result } = renderHook(() => usePaneWidths());
    expect(result.current.widths).toEqual(DEFAULT_WIDTHS);
  });

  it("restores persisted widths from localStorage on mount", () => {
    localStorage.setItem("orcha:cs:panes", JSON.stringify({ tree: 220, rail: 300 }));
    const { result } = renderHook(() => usePaneWidths());
    expect(result.current.widths).toEqual({ tree: 220, rail: 300 });
  });

  it("ignores corrupt localStorage and falls back to defaults", () => {
    localStorage.setItem("orcha:cs:panes", "not json");
    const { result } = renderHook(() => usePaneWidths());
    expect(result.current.widths).toEqual(DEFAULT_WIDTHS);
  });

  it("ignores a persisted shape with non-numeric values", () => {
    localStorage.setItem("orcha:cs:panes", JSON.stringify({ tree: "wide", rail: 300 }));
    const { result } = renderHook(() => usePaneWidths());
    expect(result.current.widths).toEqual(DEFAULT_WIDTHS);
  });

  it("dragTree applies a delta clamped to the tree pane's min width", () => {
    const { result } = renderHook(() => usePaneWidths());
    act(() => { result.current.dragTree(-1000); }); // huge negative delta
    expect(result.current.widths.tree).toBe(MIN_WIDTHS.tree);
  });

  it("dragRail applies a delta in the correct direction (dragging left grows the rail)", () => {
    const { result } = renderHook(() => usePaneWidths());
    const before = result.current.widths.rail;
    act(() => { result.current.dragRail(-40); }); // drag left = rail grows
    expect(result.current.widths.rail).toBe(before + 40);
  });

  it("dragTree grows the tree when dragging right", () => {
    const { result } = renderHook(() => usePaneWidths());
    const before = result.current.widths.tree;
    act(() => { result.current.dragTree(30); });
    expect(result.current.widths.tree).toBe(before + 30);
  });

  it("persists to localStorage after a drag", () => {
    const { result } = renderHook(() => usePaneWidths());
    act(() => { result.current.dragTree(30); });
    const raw = localStorage.getItem("orcha:cs:panes");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string);
    expect(parsed.tree).toBe(result.current.widths.tree);
  });

  it("resetTree restores just the tree pane's default width, leaving rail untouched", () => {
    const { result } = renderHook(() => usePaneWidths());
    act(() => { result.current.dragTree(30); result.current.dragRail(-40); });
    act(() => { result.current.resetTree(); });
    expect(result.current.widths.tree).toBe(DEFAULT_WIDTHS.tree);
    expect(result.current.widths.rail).not.toBe(DEFAULT_WIDTHS.rail);
  });

  it("resetRail restores just the rail pane's default width", () => {
    const { result } = renderHook(() => usePaneWidths());
    act(() => { result.current.dragRail(-40); });
    act(() => { result.current.resetRail(); });
    expect(result.current.widths.rail).toBe(DEFAULT_WIDTHS.rail);
  });
});
