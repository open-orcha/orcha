import { describe, expect, it } from "vitest";
import { isRunTab, withRunTab } from "./run-tabs";

describe("run tabs", () => {
  it("writes every tab to the URL, Steps included, so a reload keeps it (#176)", () => {
    expect(withRunTab("http://x/runs/1", "steps")).toBe("http://x/runs/1?tab=steps");
    expect(withRunTab("http://x/runs/1?tab=report", "steps")).toBe("http://x/runs/1?tab=steps");
    expect(withRunTab("http://x/runs/1?tab=steps&scenario=a", "report")).toBe("http://x/runs/1?tab=report&scenario=a");
  });

  it("knows its tabs", () => {
    expect(isRunTab("steps")).toBe(true);
    expect(isRunTab("nope")).toBe(false);
  });
});
