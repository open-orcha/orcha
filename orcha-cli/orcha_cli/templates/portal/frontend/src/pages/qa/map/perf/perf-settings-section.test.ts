// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { PERF_DEFAULTS, validatePerfChange } from "./perf-settings";

const toast = vi.fn();
vi.mock("../kit/toast", () => ({ useToast: () => ({ toast }) }));

vi.mock("./api", () => ({ loadSlowest: vi.fn(async () => ({ screens: [] })), savePerfSettings: vi.fn() }));

const api = await import("./api");
const { PerfSettingsSection, errorWords, fieldError, rangeWords } = await import("./perf-settings-section");

afterEach(() => {
  cleanup();
  toast.mockReset();
  vi.unstubAllGlobals();
});

describe("The budgets say what is wrong in its own words (D4)", () => {
  it("names the field and its range, never the stored key", () => {
    const refused = validatePerfChange({ regression_pct: 9999 });
    expect(refused.ok).toBe(false);
    expect(errorWords(refused.ok ? "" : refused.error)).toBe("Slower than usual by must be 5 to 1000 %.");
    expect(errorWords("regression_min_ms must be a number from 0 to 60000.")).toBe("And by at least must be 0 to 60 s.");
    expect(errorWords("web_lcp_ms must be a number from 100 to 60000.")).toBe("Web: main content shows (LCP) must be 0.1 to 60 s.");
    expect(errorWords("Send at least one setting.")).toBe("Send at least one setting.");
    expect(rangeWords({ key: "confirm_runs", unit: "runs" })).toBe("1 to 10 runs");
    expect(fieldError({ key: "regression_pct", unit: "%" }, "9999")).toBe("Enter 5 to 1000 %.");
    expect(fieldError({ key: "regression_pct", unit: "%" }, "abc")).toBe("Enter a number from 5 to 1000 %.");
    expect(fieldError({ key: "regression_pct", unit: "%" }, "80")).toBeNull();
  });

  it("flags a typed value out of range beside the field, saves nothing, and Esc puts the saved one back", () => {
    render(createElement(MemoryRouter, null, createElement(PerfSettingsSection, { cid: "p", slowestHref: "/qa", initial: PERF_DEFAULTS, actor: "h1", can: true, reason: null })));
    const field = document.querySelector<HTMLInputElement>('[data-perf-field="regression_pct"]')!;
    fireEvent.change(field, { target: { value: "9999" } });
    fireEvent.blur(field);
    const alert = document.querySelector('[data-perf-error="regression_pct"]')!;
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toBe("Enter 5 to 1000 %. Esc puts back 50 %.");
    expect(alert.textContent).not.toContain("regression_pct");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toContain("perf-regression_pct-error");
    expect(field.value).toBe("9999");
    expect(api.savePerfSettings).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Escape" });
    expect(document.querySelector('[data-perf-error="regression_pct"]')).toBeNull();
    expect(field.value).toBe("50");
    expect(field.getAttribute("aria-invalid")).toBeNull();
  });

  it("is a person's to change: for anyone else every control is disabled with the reason", () => {
    render(createElement(MemoryRouter, null, createElement(PerfSettingsSection, { cid: "p", slowestHref: "/qa", initial: PERF_DEFAULTS, actor: null, can: false, reason: "Only a person can change this" })));
    expect(document.querySelector("[data-perf-gate]")?.textContent).toBe("Only a person can change this");
    expect(document.querySelector<HTMLInputElement>('[data-perf-field="regression_pct"]')!.disabled).toBe(true);
  });
});
