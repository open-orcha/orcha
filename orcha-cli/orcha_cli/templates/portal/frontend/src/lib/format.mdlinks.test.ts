/**
 * Screen review r3 (Code Space, major): rendered Markdown showed
 * "See [docs/architecture.md](docs/architecture.md)." literally — mdText only
 * linked bare http URLs. [text](href) now renders, with a strict scheme policy.
 */
import { describe, expect, it } from "vitest";
import { mdLinkPath, mdText } from "./format";
import type { Task } from "../types";

const dom = (html: string) => {
  const d = document.createElement("div");
  d.innerHTML = html;
  return d;
};

describe("mdText — [text](href) links", () => {
  it("renders a relative repo path as an in-app Code Space link carrying the written path", () => {
    const d = dom(mdText("See [docs/architecture.md](docs/architecture.md)."));
    const a = d.querySelector("a")!;
    expect(a).not.toBeNull();
    expect(a.textContent).toBe("docs/architecture.md");
    expect(a.getAttribute("href")).toBe("/code?path=docs%2Farchitecture.md");
    expect(a.getAttribute("data-md-path")).toBe("docs/architecture.md");
    expect(a.classList.contains("md-rel")).toBe(true);
    expect(a.getAttribute("target")).toBeNull(); // in-app, same tab
    expect(d.textContent).toBe("See docs/architecture.md.");
  });

  it("normalizes ./ and leading / and drops #fragment/?query from the Code Space path", () => {
    expect(dom(mdText("[a](./docs/a.md#setup)")).querySelector("a")!.getAttribute("href")).toBe("/code?path=docs%2Fa.md");
    expect(dom(mdText("[r](/README.md)")).querySelector("a")!.getAttribute("href")).toBe("/code?path=README.md");
    // the written path survives for renderers that resolve relative to the open file
    expect(dom(mdText("[up](../x.md)")).querySelector("a")!.getAttribute("data-md-path")).toBe("../x.md");
    expect(mdLinkPath("./a&amp;b.md?x=1")).toBe("a&b.md");
  });

  it("http(s) links open externally; mailto links stay same-tab", () => {
    const a = dom(mdText("[Linear](https://linear.app/docs)")).querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://linear.app/docs");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    expect(a.textContent).toBe("Linear");
    const m = dom(mdText("[mail us](mailto:hi@example.com)")).querySelector("a")!;
    expect(m.getAttribute("href")).toBe("mailto:hi@example.com");
    expect(m.getAttribute("target")).toBeNull();
  });

  it("the href inside a markdown link is not linkified a second time", () => {
    const d = dom(mdText("[docs](https://example.com/a)"));
    expect(d.querySelectorAll("a")).toHaveLength(1);
    expect(d.textContent).toBe("docs");
  });

  it("drops dangerous and unknown schemes, keeping only the text", () => {
    // (a paren inside the href never matches the link syntax at all)
    expect(dom(mdText("[click](javascript:alert(1))")).querySelector("a")).toBeNull();
    for (const href of ["javascript:alert%281%29", "JaVaScRiPt:void0", "data:text/html;base64,PHNjcmlwdD4=", "vbscript:x", "file:///etc/passwd", "//evil.example/x"]) {
      const html = mdText(`[click](${href})`);
      const d = dom(html);
      expect(d.querySelector("a"), href).toBeNull();
      expect(d.textContent, href).toBe("click");
    }
  });

  it("a bare #fragment renders as text, not a dead link", () => {
    const d = dom(mdText("[see below](#usage)"));
    expect(d.querySelector("a")).toBeNull();
    expect(d.textContent).toBe("see below");
  });

  it("stays escape-proof: markup in the text or href is never emitted raw", () => {
    const html = mdText('[<img src=x onerror=alert(1)>](docs/"onmouseover=alert(1).md)');
    expect(html).not.toContain("<img");
    const d = dom(html);
    const a = d.querySelector("a");
    // whatever is rendered, no injected attribute survives
    expect(d.querySelector("[onmouseover]")).toBeNull();
    expect(d.querySelector("img")).toBeNull();
    if (a) expect(a.getAttribute("href")!.startsWith("/code?path=")).toBe(true);
  });

  it("leaves images, inline code and plain brackets alone", () => {
    expect(dom(mdText("![logo](img/logo.png)")).querySelector("a")).toBeNull();
    const code = dom(mdText("`[a](b.md)`"));
    expect(code.querySelector("a")).toBeNull();
    expect(code.querySelector("code")!.textContent).toBe("[a](b.md)");
    expect(dom(mdText("an array [1, 2] (not a link)")).querySelector("a")).toBeNull();
  });

  it("ignores an optional link title", () => {
    const a = dom(mdText('[Guide](docs/guide.md "The guide")')).querySelector("a")!;
    expect(a.getAttribute("href")).toBe("/code?path=docs%2Fguide.md");
    expect(a.textContent).toBe("Guide");
  });

  it("task refs are not rewritten inside a markdown link", () => {
    const tasks = [{ id: "abcdef12-0000-4000-8000-000000000000", title: "T" } as unknown as Task];
    const d = dom(mdText("[abcdef12](docs/a.md) and abcdef12", tasks));
    const as = d.querySelectorAll("a");
    expect(as[0].textContent).toBe("abcdef12");
    expect(as[1].classList.contains("tref")).toBe(true);
  });
});
