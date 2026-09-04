import { describe, expect, it } from "vitest";
import { highlightLine, langForPath, tokenizeLine } from "./highlight";

describe("langForPath", () => {
  it("maps common extensions to a language spec", () => {
    expect(langForPath("src/App.tsx")).not.toBeNull();
    expect(langForPath("main.py")).not.toBeNull();
    expect(langForPath("server.go")).not.toBeNull();
    expect(langForPath("lib.rs")).not.toBeNull();
    expect(langForPath("data.json")).not.toBeNull();
    expect(langForPath("styles.css")).not.toBeNull();
    expect(langForPath("deploy.sh")).not.toBeNull();
    expect(langForPath("Main.java")).not.toBeNull(); // C-family fallback
  });
  it("returns null for unknown or missing extensions", () => {
    expect(langForPath("README")).toBeNull();
    expect(langForPath("Makefile")).toBeNull();
    expect(langForPath("notes.xyz123")).toBeNull();
  });
});

describe("tokenizeLine", () => {
  it("returns a single plain token when the language is unknown", () => {
    const tokens = tokenizeLine("hello world", null);
    expect(tokens).toEqual([{ kind: "plain", text: "hello world" }]);
  });
  it("returns no tokens for an empty line", () => {
    expect(tokenizeLine("", langForPath("a.js"))).toEqual([]);
  });
  it("classifies a line comment as a single comment token to end of line", () => {
    const tokens = tokenizeLine("// a comment here", langForPath("a.js"));
    expect(tokens).toEqual([{ kind: "comment", text: "// a comment here" }]);
  });
  it("classifies a python comment", () => {
    const tokens = tokenizeLine("# a comment", langForPath("a.py"));
    expect(tokens).toEqual([{ kind: "comment", text: "# a comment" }]);
  });
  it("classifies a single-line block comment fully", () => {
    const tokens = tokenizeLine("/* block */ x", langForPath("a.js"));
    expect(tokens[0]).toEqual({ kind: "comment", text: "/* block */" });
    expect(tokens.some((t) => t.kind === "plain" && t.text.includes("x"))).toBe(true);
  });
  it("classifies an unterminated block comment to end of line", () => {
    const tokens = tokenizeLine("/* start of block", langForPath("a.js"));
    expect(tokens).toEqual([{ kind: "comment", text: "/* start of block" }]);
  });
  it("classifies double- and single-quoted strings, handling escapes", () => {
    const tokens = tokenizeLine('x = "a \\"b\\" c" + \'d\'', langForPath("a.js"));
    const strings = tokens.filter((t) => t.kind === "string").map((t) => t.text);
    expect(strings).toEqual(['"a \\"b\\" c"', "'d'"]);
  });
  it("classifies template literals as strings for JS/TS", () => {
    const tokens = tokenizeLine("const s = `hi ${x}`;", langForPath("a.ts"));
    expect(tokens.some((t) => t.kind === "string" && t.text === "`hi ${x}`")).toBe(true);
  });
  it("classifies integer and float numbers, not as part of identifiers", () => {
    const tokens = tokenizeLine("x = 42 + 3.14 + a1", langForPath("a.js"));
    const numbers = tokens.filter((t) => t.kind === "number").map((t) => t.text);
    expect(numbers).toEqual(["42", "3.14"]);
    // a1 is an identifier (starts with a letter), never split into "a" + number "1"
    expect(tokens.some((t) => t.text === "a1")).toBe(true);
  });
  it("classifies hex numbers", () => {
    const tokens = tokenizeLine("x = 0xFF", langForPath("a.js"));
    expect(tokens.some((t) => t.kind === "number" && t.text === "0xFF")).toBe(true);
  });
  it("classifies known keywords, and only known keywords", () => {
    const tokens = tokenizeLine("function foo() { return true; }", langForPath("a.js"));
    const keywords = tokens.filter((t) => t.kind === "keyword").map((t) => t.text);
    expect(keywords).toContain("function");
    expect(keywords).toContain("return");
    expect(keywords).toContain("true");
    expect(keywords).not.toContain("foo");
  });
  it("classifies python keywords distinctly from JS", () => {
    const tokens = tokenizeLine("def foo(): return None", langForPath("a.py"));
    const keywords = tokens.filter((t) => t.kind === "keyword").map((t) => t.text);
    expect(keywords).toEqual(expect.arrayContaining(["def", "return", "None"]));
  });
  it("round-trips: concatenating all token texts reproduces the original line", () => {
    const samples = [
      'const x = "hi" + 42; // done',
      "def f(a, b): return a + b  # sum",
      "func main() { fmt.Println(0x1A) }",
      "",
      "   plain text, no special tokens!! ",
    ];
    samples.forEach((line) => {
      const lang = langForPath("a.js");
      const tokens = tokenizeLine(line, lang);
      expect(tokens.map((t) => t.text).join("")).toBe(line);
    });
  });
});

describe("highlightLine", () => {
  it("dispatches on the path's extension", () => {
    const tokens = highlightLine("# comment", "script.py");
    expect(tokens).toEqual([{ kind: "comment", text: "# comment" }]);
  });
  it("falls back to plain text for unrecognized extensions", () => {
    const tokens = highlightLine("whatever # not a comment here", "file.xyz");
    expect(tokens).toEqual([{ kind: "plain", text: "whatever # not a comment here" }]);
  });
});
