import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MdRenderedPane } from "./MdRenderedPane";
import { classifyHref, headingLevels, renderMdDoc, resolveRepoPath } from "./mdDoc";

describe("mdDoc — [text](href) links", () => {
  it("renders a relative path link as a Code Space path anchor, not literal syntax", () => {
    const html = renderMdDoc("See [docs/architecture.md](docs/architecture.md).", "README.md");
    expect(html).not.toContain("](");
    expect(html).toContain('data-md-path="docs/architecture.md"');
    expect(html).toContain(">docs/architecture.md</a>.");
  });

  it("resolves ./ and ../ against the document's directory; escaping the root yields text only", () => {
    expect(resolveRepoPath("docs/guide/intro.md", "../api.md")).toBe("docs/api.md");
    expect(resolveRepoPath("docs/intro.md", "./img/a.png#frag")).toBe("docs/img/a.png");
    expect(resolveRepoPath("docs/intro.md", "/ROOT.md")).toBe("ROOT.md");
    expect(resolveRepoPath("a.md", "../../etc/passwd")).toBeNull();
    const html = renderMdDoc("[up](../../x)", "a.md");
    expect(html).toBe("up");
  });

  it("http(s) and mailto open externally; javascript:, data: and #fragments become plain text", () => {
    expect(classifyHref("a.md", "https://x.dev/a")).toEqual({ kind: "external", href: "https://x.dev/a" });
    expect(classifyHref("a.md", "mailto:me@x.dev")).toEqual({ kind: "external", href: "mailto:me@x.dev" });
    const html = renderMdDoc("[a](https://x.dev/a) [b](javascript:alert(1)) [c](data:text/html,x) [d](#top)", "a.md");
    expect(html).toContain('<a class="lnk" href="https://x.dev/a" target="_blank" rel="noopener noreferrer">a</a>');
    expect(html).not.toMatch(/javascript:|data:text/);
    expect(html).toContain(" c ");
    expect(html).toMatch(/ d$/);
  });

  it("escapes link text and never lifts links inside code", () => {
    const html = renderMdDoc("[<img src=x onerror=1>](a.md) `[x](y.md)`\n```\n[z](z.md)\n```", "r.md");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=1&gt;</a>");
    expect(html).toContain('<code class="md-code">[x](y.md)</code>');
    expect(html).not.toContain('data-md-path="z.md"');
    expect(html).not.toContain('data-md-path="y.md"');
  });
});

describe("mdDoc — heading levels", () => {
  it("tags each heading with its source level, skipping fenced code", () => {
    const src = "# Title\n\ntext\n\n## Section\n```\n# not a heading\n```\n### Sub";
    expect(headingLevels(src)).toEqual([1, 2, 3]);
    const html = renderMdDoc(src, "README.md");
    expect(html).toContain('<span class="md-h md-h1" data-level="1">Title</span>');
    expect(html).toContain('<span class="md-h md-h2" data-level="2">Section</span>');
    expect(html).toContain('<span class="md-h md-h3" data-level="3">Sub</span>');
  });
});

describe("MdRenderedPane links", () => {
  afterEach(cleanup);

  it("clicking a relative link opens the resolved path and does not start a heading thread", () => {
    const onOpenPath = vi.fn();
    const onDiscussHeading = vi.fn();
    const { container } = render(
      <MdRenderedPane
        content={"# See [the API](api.md)\n\nBody [guide](../guide.md)"}
        path="docs/sub/README.md"
        onOpenPath={onOpenPath}
        onDiscussHeading={onDiscussHeading}
        onAmbiguousHeading={vi.fn()}
      />,
    );
    const links = container.querySelectorAll("a[data-md-path]");
    expect(links).toHaveLength(2);
    fireEvent.click(links[0]);
    expect(onOpenPath).toHaveBeenCalledWith("docs/sub/api.md");
    expect(onDiscussHeading).not.toHaveBeenCalled();
    fireEvent.click(links[1]);
    expect(onOpenPath).toHaveBeenLastCalledWith("docs/guide.md");
  });

  it("a heading containing a link still resolves to its source line when the heading text is clicked", () => {
    const onDiscussHeading = vi.fn();
    const { container } = render(
      <MdRenderedPane content={"intro\n## See [the API](api.md)"} path="README.md" onDiscussHeading={onDiscussHeading} onAmbiguousHeading={vi.fn()} />,
    );
    fireEvent.click(container.querySelector(".md-h")!);
    expect(onDiscussHeading).toHaveBeenCalledWith(2);
  });
});
