import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(__dirname, "utilities.css"), "utf8");

describe("utilities.css", () => {
  it("defines the scale its spacing and sizing classes compute from", () => {
    expect(css).toMatch(/calc\(var\(--spacing\)/);
    expect(css).toMatch(/\.qa-port \{[^}]*--spacing:/);
  });
  it("is scoped to the QA screens", () => {
    expect(css).toMatch(/:where\(\.qa-port\) \.flex \{/);
    expect(css).not.toMatch(/^\.flex \{/m);
  });
});
