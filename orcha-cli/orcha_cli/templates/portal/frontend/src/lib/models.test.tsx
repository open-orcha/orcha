import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { fetchModelCatalog, modelLabel, prettyModelId, resetModelCatalog, useModelName } from "./models";
import { modelLabel as onboardingModelLabel } from "../pages/onboarding/logic";

afterEach(() => {
  vi.unstubAllGlobals();
  resetModelCatalog();
});

const okModels = () =>
  vi.fn(async () => new Response(JSON.stringify({ models: [{ id: "claude-opus-5-5", name: "Claude Opus 5.5" }, "gpt-5"], default: "claude-opus-5-5" }), { status: 200, headers: { "Content-Type": "application/json" } }));

describe("lib/models — one display name per model id", () => {
  it("catalog name wins; otherwise a readable fallback", () => {
    const models = [{ id: "claude-opus-5-5", name: "Claude Opus 5.5" }];
    expect(modelLabel("claude-opus-5-5", models)).toBe("Claude Opus 5.5");
    expect(modelLabel("gpt-5", models)).toBe("GPT-5");
    expect(prettyModelId("claude-sonnet")).toBe("Sonnet");
    expect(modelLabel(null, models)).toBe("");
  });

  it("onboarding re-exports the same helper (no second copy)", () => {
    expect(onboardingModelLabel).toBe(modelLabel);
  });

  it("fetches /api/models once per page, shared by every caller", async () => {
    const f = okModels();
    vi.stubGlobal("fetch", f);
    const [a, b] = await Promise.all([fetchModelCatalog(), fetchModelCatalog()]);
    expect(a).toBe(b);
    expect(a.defaultId).toBe("claude-opus-5-5");
    expect(a.models.map((m) => m.id)).toEqual(["claude-opus-5-5", "gpt-5"]);
    await fetchModelCatalog();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("a failed catalog is not cached — the next ask retries", async () => {
    const f = vi.fn(async () => { throw new TypeError("offline"); });
    vi.stubGlobal("fetch", f);
    const c = await fetchModelCatalog();
    expect(c.loaded).toBe(true);
    expect(c.models).toEqual([]);
    vi.stubGlobal("fetch", okModels());
    expect((await fetchModelCatalog()).models).toHaveLength(2);
  });

  it("useModelName shows a readable fallback first, then the catalog name", async () => {
    vi.stubGlobal("fetch", okModels());
    function Probe() {
      const name = useModelName();
      return <span data-testid="n" title="claude-opus-5-5">{name("claude-opus-5-5")}</span>;
    }
    render(<Probe />);
    expect(screen.getByTestId("n").textContent).toBe("Opus 5.5"); // never the raw id
    await waitFor(() => expect(screen.getByTestId("n").textContent).toBe("Claude Opus 5.5"));
  });
});
