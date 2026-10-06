/**
 * BrandLogo — the vendored marks stay byte-identical to their upstream
 * packages (sha256 of each `d` attribute taken from the npm-packed files named
 * in BrandLogo.tsx), brand colours come from the source, and an unknown brand
 * gets the neutral initial — never a lookalike.
 */
import { createHash } from "node:crypto";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BRAND_MARKS, BrandLogo, brandFor, type BrandId } from "./BrandLogo";

afterEach(cleanup);

const UPSTREAM_SHA256: Record<BrandId, string> = {
  anthropic: "b60ac0305fabf78a3ea4982844bb5306360d284962bee2c6594de87d9062d468", // simple-icons 16.33.0
  claude: "0442033dcc3824e52ffb0a07849c46becbeeacd75d1287f9081c00510e3bbf84", // simple-icons 16.33.0
  openai: "3fae9b38d571a5ab5aa662bc279dcda580855d6ca6b35330e4b4ba171367ffb1", // simple-icons 15.22.0
  xai: "87ae7fb842f7b61b028a686ea7d4b6ae659058a5859c2959b96a9f773c38fd5f", // @lobehub/icons-static-svg 1.95.1
  gemini: "a27790dcbe07c23d88893d72097191599ebac4883fba370ea021f952fb75237f", // simple-icons 16.33.0
};

describe("BrandLogo", () => {
  it("vendors every mark verbatim from its licensed source", () => {
    for (const id of Object.keys(UPSTREAM_SHA256) as BrandId[]) {
      const sha = createHash("sha256").update(BRAND_MARKS[id].path).digest("hex");
      expect(sha, id).toBe(UPSTREAM_SHA256[id]);
    }
  });

  it("uses the source's brand hex where it has one, currentColor otherwise", () => {
    expect(BRAND_MARKS.claude.hex).toBe("#D97757");
    expect(BRAND_MARKS.gemini.hex).toBe("#8E75B2");
    expect(BRAND_MARKS.openai.hex).toBeNull();
    const { container } = render(<><BrandLogo brand="claude" /><BrandLogo brand="openai" /></>);
    const [claude, openai] = Array.from(container.querySelectorAll("svg"));
    expect(claude.getAttribute("style")).toMatch(/color: (#d97757|rgb\(217, 119, 87\))/i);
    expect(openai.getAttribute("style")).toBeNull();
    expect(claude.querySelector("path")!.getAttribute("fill")).toBe("currentColor");
  });

  it("maps backend provider / runtime ids to marks", () => {
    expect(brandFor("anthropic")).toBe("anthropic");
    expect(brandFor("claude")).toBe("claude");
    expect(brandFor("codex")).toBe("openai");
    expect(brandFor("xai")).toBe("xai");
    expect(brandFor("gemini")).toBe("gemini");
    expect(brandFor("mistral")).toBeNull();
  });

  it("is decorative by default and named when given a title", () => {
    const { container, getByRole } = render(<><BrandLogo brand="xai" /><BrandLogo brand="anthropic" title="Anthropic" /></>);
    expect(container.querySelector('svg[data-brand="xai"]')).toHaveAttribute("aria-hidden", "true");
    expect(getByRole("img", { name: "Anthropic" })).toHaveAttribute("data-brand", "anthropic");
  });

  it("falls back to a neutral initial for a brand with no licensed mark", () => {
    const { container } = render(<BrandLogo brand="mistral" name="Mistral" />);
    expect(container.querySelector("svg")).toBeNull();
    const el = container.querySelector('[data-brand="none"]')!;
    expect(el).toHaveTextContent("M");
  });
});
