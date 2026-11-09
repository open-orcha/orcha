import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { osMeets, RunPreview } from "./RunPreview";

afterEach(cleanup);

describe("the run preview", () => {
  it("says what runs, where, and splits the conditions by who sets them", () => {
    const { container } = render(
      <RunPreview kind="check" platform="android" app={{ name: "Nyumbani", id: "com.nyumbani" }} agent="QAEngineer"
        device={{ title: "Pixel 9a", state: "Boots when the run starts", physical: false, os: "Android 16" }}
        scenarios={{ count: 6, names: ["Search by price", "Open a listing"], picked: false }} minutes={null} focus=""
        conditions={{ os: "13", locale: "sw-KE", account: "A subscribed user" }} inherited />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Check 6 approved scenarios");
    expect(text).toContain("and 4 more");
    expect([...container.querySelectorAll(".qa-rp-chips:not(.is-agent) [data-preview-condition]")].map((c) => c.getAttribute("data-preview-condition"))).toEqual(["os", "locale"]);
    expect([...container.querySelectorAll(".qa-rp-chips.is-agent [data-preview-condition]")].map((c) => c.getAttribute("data-preview-condition"))).toEqual(["account"]);
    expect(container.querySelector("[data-preview-os-warning]")?.textContent).toContain("Pixel 9a runs Android 16, not Android 13");
  });

  it("puts what a phone cannot take apart, never under the agent", () => {
    const { container } = render(
      <RunPreview kind="explore" platform="ios" app={null} agent="ProofQA" device={{ title: "My iPhone", state: "Ready", physical: true, os: "iOS 26.6.1" }}
        scenarios={null} minutes={5} focus="" conditions={{ locale: "fr-FR", text_size: "larger", account: "A new user" }} />,
    );
    expect([...container.querySelectorAll(".qa-rp-chips.is-off [data-preview-condition]")].map((c) => c.getAttribute("data-preview-condition"))).toEqual(["text_size"]);
    expect([...container.querySelectorAll(".qa-rp-chips.is-agent [data-preview-condition]")].map((c) => c.getAttribute("data-preview-condition"))).toEqual(["account"]);
  });

  it("matches versions on what was asked", () => {
    expect(osMeets("13", "Android 13")).toBe(true);
    expect(osMeets("iOS 26", "iOS 26.5")).toBe(true);
    expect(osMeets("13", "Android 16")).toBe(false);
    expect(osMeets("13", null)).toBeNull();
  });
});
