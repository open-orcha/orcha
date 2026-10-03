/**
 * Full-QA round 1 (KG-2 / R14 / PS-21 / VD-03): the Routines list, inspector
 * and switch label show the RESOLVED title, never the raw {{date}} template.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { RoutinesPage } from "./RoutinesPage";
import { hasTemplateTokens, renderTemplate, routineTitle } from "./routinesApi";

const base = {
  id: "r1", container_id: "c1", description: null, definition_of_done: "Done.",
  assignee_agent_id: null, assignee_alias: null, assignee_retired: false, priority: 10,
  cron: "0 9 * * *", timezone: "UTC", schedule_text: "Every day at 09:00 UTC",
  enabled: true, skip_if_open: true, last_run_at: null,
  created_by_alias: "k", updated_by_alias: "k", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
  last_run: null,
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("routineTitle", () => {
  it("resolves {{date}}/{{weekday}} at next_run_at in the routine's zone", () => {
    const r = { title: "Daily triage — {{date}} ({{ weekday }})", timezone: "Africa/Nairobi", next_run_at: "2026-09-29T22:30:00Z", enabled: true };
    // 22:30Z is 01:30 on the 30th in Nairobi (UTC+3)
    expect(routineTitle(r)).toBe("Daily triage — 2026-09-30 (Wednesday)");
  });
  it("prefers the server preview, leaves token-less titles alone, falls back to now when paused", () => {
    expect(routineTitle({ title: "X {{date}}", timezone: "UTC", next_run_at: null, enabled: true, title_preview: "X server" })).toBe("X server");
    expect(routineTitle({ title: "Plain", timezone: "UTC", next_run_at: null, enabled: false })).toBe("Plain");
    const now = new Date("2026-09-29T10:00:00Z");
    expect(routineTitle({ title: "{{date}} {{time}}", timezone: "UTC", next_run_at: null, enabled: false }, now)).toBe("2026-09-29 10:00");
    expect(routineTitle({ title: "{{date}}", timezone: "Not/AZone", next_run_at: "2026-09-29T10:00:00Z", enabled: true })).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it("helpers", () => {
    expect(hasTemplateTokens("a {{date}}")).toBe(true);
    expect(hasTemplateTokens("a {{nope}}")).toBe(false);
    expect(renderTemplate("{{routine}}!", { routine: "R" })).toBe("R!");
  });
});

describe("RoutinesPage resolved titles", () => {
  it("row + switch label show the resolved title; the template stays as a tooltip", async () => {
    const routine = { ...base, title: "Daily triage {{date}}", next_run_at: "2026-09-30T09:00:00Z" };
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const j = (d: unknown) => ({ ok: true, status: 200, json: async () => d }) as Response;
      if (url === "/api/containers") return j([{ id: "c1", status: "active" }]);
      if (url === "/api/containers/c1/routines") return j({ routines: [routine], scheduler: { last_tick_at: new Date().toISOString() } });
      if (url.startsWith("/api/containers/c1")) return j({ container: { id: "c1", name: "A", status: "active" }, agents: [{ id: "h1", alias: "k", kind: "human", status: "idle" }], tasks: [], requests: [] });
      return j({});
    }) as unknown as typeof fetch;
    render(
      <ToastProvider><SnapshotProvider><MemoryRouter initialEntries={["/routines"]}>
        <Routes><Route path="/routines" element={<RoutinesPage />} /></Routes>
      </MemoryRouter></SnapshotProvider></ToastProvider>,
    );
    const title = await screen.findByText("Daily triage 2026-09-30");
    expect(title.getAttribute("title")).toBe("Template: Daily triage {{date}}");
    await waitFor(() => expect(screen.getByRole("switch", { name: /Pause Daily triage 2026-09-30/ })).toBeTruthy());
    expect(document.body.textContent).not.toContain("{{date}}");
  });
});
