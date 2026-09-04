import { describe, expect, it } from "vitest";
import { isLineSelected, rangeFrom, singleLine } from "./gutter";

describe("singleLine", () => {
  it("selects exactly one line", () => {
    expect(singleLine(5)).toEqual({ start: 5, end: 5 });
  });
});

describe("rangeFrom", () => {
  it("normalizes anchor/line into a start<=end range regardless of click order", () => {
    expect(rangeFrom(3, 8)).toEqual({ start: 3, end: 8 });
    expect(rangeFrom(8, 3)).toEqual({ start: 3, end: 8 });
  });
  it("collapses to a single line when anchor === line", () => {
    expect(rangeFrom(4, 4)).toEqual({ start: 4, end: 4 });
  });
});

describe("isLineSelected", () => {
  it("is false when there is no selection", () => {
    expect(isLineSelected(null, 5)).toBe(false);
  });
  it("is true for any line within [start,end] inclusive", () => {
    const sel = { start: 3, end: 6 };
    expect(isLineSelected(sel, 3)).toBe(true);
    expect(isLineSelected(sel, 5)).toBe(true);
    expect(isLineSelected(sel, 6)).toBe(true);
  });
  it("is false outside the range", () => {
    const sel = { start: 3, end: 6 };
    expect(isLineSelected(sel, 2)).toBe(false);
    expect(isLineSelected(sel, 7)).toBe(false);
  });
});
