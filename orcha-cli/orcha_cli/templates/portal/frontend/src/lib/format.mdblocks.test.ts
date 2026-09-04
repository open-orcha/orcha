/**
 * mdText block structure (2026-08-30): GitHub issue/PR bodies use ordered
 * lists and task-lists heavily — both previously rendered as literal text
 * ("1. **x**…", "[ ] item") inside one unbroken paragraph. These pin the new
 * rules and the esc-first invariant across them.
 */
import { describe, expect, it } from "vitest";
import { mdText } from "./format";

describe("mdText ordered lists", () => {
  it("renders 1. / 2) items as numbered block items", () => {
    const html = mdText("1. FDC adapter\n2) Rate-limit posture");
    expect(html).toContain('<span class="md-li md-oli"><span class="md-num">1.</span>FDC adapter</span>');
    expect(html).toContain('<span class="md-li md-oli"><span class="md-num">2.</span>Rate-limit posture</span>');
  });

  it("keeps inline markdown working inside ordered items", () => {
    const html = mdText("1. **FDC adapter** (per-tenant)");
    expect(html).toContain("<strong>FDC adapter</strong>");
    expect(html).toContain("md-oli");
  });
});

describe("mdText task lists", () => {
  it("renders unchecked and checked boxes", () => {
    const html = mdText("- [ ] Per-tenant config\n- [x] Shared durable cache");
    expect(html).toContain('md-cb"');
    expect(html).toContain('md-cb on"');
    expect(html).toContain("Per-tenant config");
    expect(html).toContain("Shared durable cache");
    // the raw brackets never leak through as text
    expect(html).not.toContain("[ ]");
    expect(html).not.toContain("[x]");
  });

  it("task rule wins over the generic bullet rule", () => {
    const html = mdText("- [ ] gated");
    expect(html).toContain("md-task");
    expect(html.match(/md-li/g)?.length).toBe(1);
  });
});

describe("mdText block safety", () => {
  it("escapes html inside list items (esc-first invariant)", () => {
    const html = mdText('1. <img src=x onerror=alert(1)>');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("plain bullets still render as before", () => {
    const html = mdText("- plain item");
    expect(html).toContain('<span class="md-li">plain item</span>');
  });
});
