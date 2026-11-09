import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImportedReportView } from "./ImportedReportView";
import { rerunIds, reportFrameSrc, tallyWords, type ImportedReport } from "./api";
import type { QaNav } from "../QaPage";
import type { QaAuthority } from "../authority";

const report: ImportedReport = {
  id: "r1", title: "Fix checkout", file_name: "x.zip", imported_by: "Hussein", created_at: "2026-11-07T10:00:00Z", matched: { s1: "here1", s2: null },
  data: {
    schema: "orcha-quality-report", version: 1, generated_at: "2026-11-07T09:00:00Z",
    task: { id: "t1", title: "Fix checkout", status: "needs_verification", project: "nyumba" }, result: "fail",
    build: { branch: "fix/checkout", commit: "abc1234" },
    runs: [{ id: "q1", kind: "check", platform: "ios", device: "iPhone 17 Pro", app_build: "1.0 (14)", status: "done", conditions: { locale: "sw-KE" } }],
    setup: { platforms: ["ios"], apps: { ios: { app_id: "com.x", app_name: "X" } }, devices: ["iPhone 17 Pro"], accounts: [{ persona: "A guest", needs: "a card" }] },
    lines: [{ index: 0, text: "Paying shows the confirmation", verdict: "fail", note: "nothing", frame_ids: ["f1"] }],
    scenarios: [
      { id: "s1", name: "Guest checkout", platform: "ios", tags: [], verdict: "fail", checks: [{ index: 0, text: "Cart shows the item", verdict: "pass", frame_ids: ["f1"] }] },
      { id: "s2", name: "Saved card", platform: "ios", tags: [], verdict: "pass", checks: [] },
    ],
    findings: [{ id: "x", severity: "major", title: "No confirmation", status: "open", frame_ids: [] }],
    screens: [{ platform: "ios", key: "cart", label: "Cart", feature: "Checkout", frame_id: "f1" }, { platform: "ios", key: "home", label: "Home", feature: null, frame_id: "f9" }],
    features: ["Checkout"], gaps: [{ id: "g", name: "Refund", platform: "ios" }], gaps_total: 1,
    tally: { scenarios: 2, passed: 1, failed: 1, blocked: 0, findings: 1 }, frames: ["f1"],
  },
};

const auth = { can: true, human: { id: "h1", alias: "Hussein" }, reason: null } as unknown as QaAuthority;
const nav = (runQa = vi.fn(), set = vi.fn()) => ({ get: () => null, set, runQa, refresh: vi.fn(), nonce: 0 } as unknown as QaNav);

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("an imported report", () => {
  it("says what it covered in plain words", () => {
    expect(tallyWords(report.data.tally)).toBe("2 scenarios: 1 passed, 1 failed · 1 finding");
    expect(rerunIds(report)).toEqual([{ platform: "ios", ids: ["here1"], conditions: { locale: "sw-KE" } }]);
    expect(reportFrameSrc(report, "f1")).toBe("/api/qa/reports/r1/frames/f1");
    expect(reportFrameSrc(report, "f9")).toBeNull();
  });

  it("reads as reported, re-runs what this project has, and offers the rest as drafts", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify(report), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const runQa = vi.fn();
    const { container } = render(<ImportedReportView rid="r1" nav={nav(runQa)} auth={auth} />);
    await waitFor(() => expect(screen.getByText("Fix checkout")).toBeTruthy());
    expect(container.querySelector("[data-qa-report-reported]")?.textContent).toContain("proves nothing here until it is re-run");
    fireEvent.click(container.querySelector("[data-qa-report-rerun='ios']")!);
    expect(runQa).toHaveBeenCalledWith("check", null, { scenarioIds: ["here1"], platform: "ios", conditions: { locale: "sw-KE" } });
    expect(container.querySelector("[data-qa-report-conditions='q1']")?.textContent).toBe("Swahili (Kenya)");
    expect(container.querySelector("[data-qa-report-drafts]")?.textContent).toBe("Add 1 missing scenario as drafts");
    expect(container.querySelector("[data-qa-report-map]")?.textContent).toContain("Checkout");
    expect(screen.getByText("Refund")).toBeTruthy();
    expect(container.querySelectorAll("img[src='/api/qa/reports/r1/frames/f1']").length).toBeGreaterThan(0);
  });
});
