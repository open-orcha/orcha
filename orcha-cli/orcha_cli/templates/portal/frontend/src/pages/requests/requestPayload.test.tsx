/** requestPayload — short field values still linkify (ISS-44), esc-first. */
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PayloadView } from "./requestPayload";

describe("PayloadView", () => {
  it("linkifies a short URL field value instead of rendering it as dead text", () => {
    const { container } = render(<PayloadView value={{ question: "Merge it?", pr: "https://github.com/o/r/pull/7" }} />);
    const a = container.querySelector('a[href="https://github.com/o/r/pull/7"]');
    expect(a).not.toBeNull();
    expect(a!.getAttribute("rel")).toContain("noopener");
  });

  it("escapes authored HTML in a short value (esc-first)", () => {
    const { container } = render(<PayloadView value={{ question: "Q", note: "<img src=x onerror=alert(1)>" }} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});
