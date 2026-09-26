import { describe, expect, it } from "vitest";
import {
  groupByKind,
  groupByPath,
  isIdentifierLike,
  symbolKindLabel,
  type OutlineSymbol,
  type WorkspaceSymbol,
} from "./symbolsTypes";

describe("symbolKindLabel", () => {
  it("labels every kind", () => {
    expect(symbolKindLabel("function")).toBe("Function");
    expect(symbolKindLabel("class")).toBe("Class");
    expect(symbolKindLabel("interface")).toBe("Interface");
    expect(symbolKindLabel("type")).toBe("Type");
    expect(symbolKindLabel("const")).toBe("Const");
    expect(symbolKindLabel("var")).toBe("Var");
  });
});

describe("groupByKind", () => {
  it("groups in the design doc's kind order, dropping empty groups", () => {
    const symbols: OutlineSymbol[] = [
      { name: "b", kind: "var", line: 5 },
      { name: "a", kind: "function", line: 1 },
      { name: "c", kind: "function", line: 3 },
    ];
    const grouped = groupByKind(symbols);
    expect(grouped.map((g) => g.kind)).toEqual(["function", "var"]);
    expect(grouped[0].items.map((i) => i.name)).toEqual(["a", "c"]);
    expect(grouped[1].items.map((i) => i.name)).toEqual(["b"]);
  });

  it("returns an empty array for no symbols", () => {
    expect(groupByKind([])).toEqual([]);
  });

  it("preserves file order within a kind bucket", () => {
    const symbols: OutlineSymbol[] = [
      { name: "third", kind: "const", line: 30 },
      { name: "first", kind: "const", line: 3 },
      { name: "second", kind: "const", line: 12 },
    ];
    const grouped = groupByKind(symbols);
    expect(grouped[0].items.map((i) => i.name)).toEqual(["third", "first", "second"]);
  });
});

describe("groupByPath", () => {
  it("groups workspace results by path, preserving first-seen path order", () => {
    const results: WorkspaceSymbol[] = [
      { name: "Foo", kind: "class", path: "b.ts", line: 1 },
      { name: "bar", kind: "function", path: "a.ts", line: 4 },
      { name: "Baz", kind: "class", path: "b.ts", line: 9 },
    ];
    const grouped = groupByPath(results);
    expect(grouped.map((g) => g.path)).toEqual(["b.ts", "a.ts"]);
    expect(grouped[0].items.map((i) => i.name)).toEqual(["Foo", "Baz"]);
    expect(grouped[1].items.map((i) => i.name)).toEqual(["bar"]);
  });

  it("returns an empty array for no results", () => {
    expect(groupByPath([])).toEqual([]);
  });
});

describe("isIdentifierLike", () => {
  it("accepts identifier-shaped words", () => {
    expect(isIdentifierLike("fooBar")).toBe(true);
    expect(isIdentifierLike("_private")).toBe(true);
    expect(isIdentifierLike("$scope")).toBe(true);
    expect(isIdentifierLike("CONST_NAME")).toBe(true);
    expect(isIdentifierLike("a1")).toBe(true);
  });

  it("rejects punctuation, whitespace, and digit-led text", () => {
    expect(isIdentifierLike("1abc")).toBe(false);
    expect(isIdentifierLike("foo.bar")).toBe(false);
    expect(isIdentifierLike("() =>")).toBe(false);
    expect(isIdentifierLike("")).toBe(false);
    expect(isIdentifierLike("  ")).toBe(false);
    expect(isIdentifierLike("foo-bar")).toBe(false);
  });
});
