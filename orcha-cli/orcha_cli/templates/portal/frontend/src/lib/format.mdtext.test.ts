/**
 * mdText truth table, ported from the pytest node harness that used to eval
 * static/app.js (tests/test_rich_conversation_markdown.py). The security
 * invariant is the same as linkify: esc() FIRST, then format the escaped
 * string — authored text can never inject HTML. Formats the curated subset
 * (bold/italic/code/fences/links/headings/bullets + GFM tables) with no false
 * positives on prose (snake_case, digits, lone stars, pipes).
 */
import { describe, expect, it } from "vitest";
import { mdText } from "./format";

const M = (s: unknown) => mdText(s);

describe("mdText — safety (esc first, never raw HTML)", () => {
  it("escapes html — authored markup is neutralized, never emitted raw", () => {
    expect(M("<img src=x onerror=alert(1)>")).not.toContain("<img");
    expect(M("<b>x</b>")).toContain("&lt;b&gt;");
  });
  it("null safe", () => {
    expect(M(null)).toBe("");
    expect(M(undefined)).toBe("");
  });
});

describe("mdText — the curated inline subset", () => {
  it("bold", () => expect(M("hi **there**")).toBe("hi <strong>there</strong>"));
  it("bold underscore", () => expect(M("__x__")).toBe("<strong>x</strong>"));
  it("italic", () => expect(M("a *word* b")).toBe("a <em>word</em> b"));
  it("inline code keeps stars (stashed before emphasis runs)", () =>
    expect(M("use `a * b`")).toContain('<code class="md-code">a * b</code>'));
  it("fenced block", () => expect(M("```\nx*y\n```")).toContain('<pre class="md-pre"><code>x*y</code></pre>'));
  it("link", () => expect(M("see https://x.io/a.")).toContain('<a class="lnk" href="https://x.io/a"'));
  it("heading", () => expect(M("# Title")).toContain('<span class="md-h">Title</span>'));
  it("bullet", () => expect(M("- item")).toContain('<span class="md-li">item</span>'));
});

describe("mdText — GFM tables", () => {
  const TBL = M("| Name | Role |\n|------|:----:|\n| **Frame** | `eng` |\n| Tim | pm |");
  it("table rendered with thead + tbody", () => {
    expect(TBL).toContain('<table class="md-table">');
    expect(TBL).toContain("<thead>");
    expect(TBL).toContain("<tbody>");
  });
  it("table header cells", () => expect(TBL).toContain("<th>Name</th>"));
  it("table alignment", () => expect(TBL).toContain("text-align:center"));
  it("inline formatting inside cells", () => {
    expect(TBL).toContain("<strong>Frame</strong>");
    expect(TBL).toContain('class="md-code">eng</code>');
  });
  it("ragged row padded", () => expect(M("| a | b |\n|---|---|\n| 1 |")).toContain("<td></td>"));
  it("table is one line (no inner newlines)", () => expect(TBL).not.toContain("\n"));
});

describe("mdText — no false positives on prose", () => {
  it("snake_case untouched", () => expect(M("call my_func_name")).toBe("call my_func_name"));
  it("digits not clobbered", () => expect(M("I have 3 apples and 5 pears")).toBe("I have 3 apples and 5 pears"));
  it("lone star untouched", () => expect(M("2 * 3 = 6")).toBe("2 * 3 = 6"));
  it("pipe in prose is not a table", () => expect(M("use a | b for OR")).toBe("use a | b for OR"));
});
