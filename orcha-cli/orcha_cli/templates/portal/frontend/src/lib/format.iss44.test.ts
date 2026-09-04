/**
 * ISS-44 linkify safety/behavior tests, ported from the pytest node harness
 * that used to eval static/app.js (tests/test_iss44_linkify.py). The security
 * invariant: esc() FIRST, then linkify the escaped text; ONLY http(s)://;
 * anchors carry target=_blank rel="noopener noreferrer".
 */
import { describe, expect, it } from "vitest";
import { linkify } from "./format";

describe("ISS-44 linkify is safe and correct", () => {
  it("esc-first: embedded HTML is neutralized, never emitted raw", () => {
    const r = linkify("hi <b>bold</b> http://a.com/x?y=1&z=2 end");
    expect(r).not.toContain("<b>");
    expect(r).toContain("&lt;b&gt;");
    expect(r).toContain('<a class="lnk" href="http://a.com/x?y=1&amp;z=2" target="_blank" rel="noopener noreferrer">');
    expect(r).toContain(">http://a.com/x?y=1&amp;z=2</a>"); // query amp escaped in the text too
  });

  it("https works; exactly one anchor for one url", () => {
    const r = linkify("see https://example.org/path");
    expect(r.match(/<a /g) || []).toHaveLength(1);
    expect(r).toContain('href="https://example.org/path"');
  });

  it("non-http schemes are NOT linkified (no javascript:/ftp: anchors)", () => {
    expect(linkify("javascript:alert(1)")).not.toContain("<a ");
    expect(linkify("ftp://host/file")).not.toContain("<a ");
  });

  it("trailing sentence punctuation stays OUTSIDE the link", () => {
    expect(linkify("go http://a.com. now")).toContain(">http://a.com</a>. now");
    expect(linkify("(ref http://a.com)")).toContain(">http://a.com</a>)");
  });

  it("plain text without a url is just escaped, unchanged otherwise", () => {
    expect(linkify('no links "here" & <ok>')).not.toContain("<a ");
    expect(linkify("a & b")).toContain("a &amp; b");
  });

  it("null/undefined safe", () => {
    expect(linkify(null)).toBe("");
    expect(linkify(undefined)).toBe("");
  });
});
