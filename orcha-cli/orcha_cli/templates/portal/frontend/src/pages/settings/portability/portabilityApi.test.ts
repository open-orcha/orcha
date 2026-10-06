/** Portable templates — pure helpers (file names, summaries, parsing, labels). */
import { describe, expect, it } from "vitest";
import {
  actionLabel, bundleSummary, importButtonLabel, importResultText, parseBundleText, sameCounts, templateFileName,
  type ImportResult,
} from "./portabilityApi";
import { exportedText } from "./PortabilitySection";
import { draftError } from "./TemplateLibraryDialog";

describe("portability helpers", () => {
  it("templateFileName is filesystem-safe and dated", () => {
    const d = new Date("2026-09-29T10:00:00Z");
    expect(templateFileName("Orcha Web / v2!", d)).toBe("orcha-web-v2-template-2026-09-29.json");
    expect(templateFileName("", d)).toBe("project-template-2026-09-29.json");
    expect(templateFileName("***", d)).toBe("project-template-2026-09-29.json");
  });

  it("bundleSummary counts sections and drops empty ones", () => {
    expect(bundleSummary({ roster: [1, 2, 3], routines: [1], dod_presets: [], skills: [1, 2] }))
      .toBe("3 agents · 1 routine · 2 skills");
    expect(bundleSummary({ roster: [1], routines: [], dod_presets: [1], skills: [], budgets: {} }))
      .toBe("1 agent · 1 DoD preset · budgets");
    expect(bundleSummary({})).toBe("nothing to carry yet");
  });

  it("parseBundleText accepts templates and names everything else plainly", () => {
    const ok = parseBundleText(JSON.stringify({ format: "orcha.project-template", version: 1 }));
    expect(ok.error).toBeNull();
    expect(ok.bundle?.version).toBe(1);
    expect(parseBundleText("{nope").error).toBe("This file isn't valid JSON.");
    expect(parseBundleText("[1,2]").error).toBe("This file isn't a Embodent project template.");
    expect(parseBundleText(JSON.stringify({ format: "x", version: 1 })).error).toBe("This file isn't a Embodent project template.");
    expect(parseBundleText(JSON.stringify({ format: "orcha.project-template" })).error).toBe("This template has no version.");
  });

  it("actionLabel / importButtonLabel", () => {
    expect(actionLabel("create")).toEqual({ text: "New", tone: "ok" });
    expect(actionLabel("set")).toEqual({ text: "New", tone: "ok" });
    expect(actionLabel("rename", "Forge-2", "Forge")).toEqual({ text: "As Forge-2", tone: "warn" });
    expect(actionLabel("skip")).toEqual({ text: "Skip", tone: "neutral" });
    expect(importButtonLabel(1)).toBe("Import 1 change");
    expect(importButtonLabel(7)).toBe("Import 7 changes");
    expect(importButtonLabel(0)).toBe("Nothing to import");
  });

  it("importResultText says what landed, and that routines are paused", () => {
    const base: ImportResult = { applied: {}, agents: [], routines: [], dod_presets: [], skills: [], budgets: [], reporting_lines: [] };
    expect(importResultText(base)).toBe("Nothing was imported — everything was already here.");
    expect(importResultText({
      ...base,
      agents: [{ alias: "A", agent_id: "1", from_alias: "A" }, { alias: "B", agent_id: "2", from_alias: "B" }],
      routines: [{ routine_id: "r", title: "t", enabled: false }],
      skills: [{ id: "s", name: "x" }],
    })).toBe("Imported 2 agents, 1 routine (paused), 1 skill.");
    expect(importResultText({
      ...base,
      routines: [{ routine_id: "r", title: "t", enabled: false }, { routine_id: "q", title: "u", enabled: true }],
    })).toBe("Imported 2 routines (1 paused).");
  });

  it("sameCounts compares plans", () => {
    const a = { roster: { create: 1, skip: 0 } } as never;
    expect(sameCounts(a, { roster: { create: 1, skip: 0 } } as never)).toBe(true);
    expect(sameCounts(a, { roster: { create: 0, skip: 1 } } as never)).toBe(false);
  });

  it("exportedText reports what was scrubbed", () => {
    const b = { format: "orcha.project-template", version: 1, roster: [1, 2], routines: [], dod_presets: [], skills: [],
      scrub: { redactions: [{ field: "x", kinds: ["secret"] }, { field: "y", kinds: ["email"] }], never_exported: [] } };
    expect(exportedText(b, "p.json")).toBe("Exported p.json — 2 agents · 2 fields scrubbed.");
    expect(exportedText({ ...b, scrub: { redactions: [], never_exported: [] } }, "p.json")).toBe("Exported p.json — 2 agents.");
  });

  it("draftError mirrors the server's library rules", () => {
    const d = { id: null, name: "", description: "", body: "" };
    expect(draftError("dod-presets", d)).toBe("Give it a name.");
    expect(draftError("dod-presets", { ...d, name: "Done" })).toBe("Write the definition of done.");
    expect(draftError("dod-presets", { ...d, name: "Done", body: "x" })).toBeNull();
    expect(draftError("skills", { ...d, name: "Release Checklist", body: "x" })).toMatch(/lowercase/);
    expect(draftError("skills", { ...d, name: "release-checklist", body: " " })).toBe("Write the skill's instructions.");
    expect(draftError("skills", { ...d, name: "release-checklist", body: "x" })).toBeNull();
  });
});
