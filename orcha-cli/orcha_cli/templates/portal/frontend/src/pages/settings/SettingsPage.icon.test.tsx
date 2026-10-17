/**
 * D14 — Settings › General › Icon: the project-icon slot. The row shows the
 * current icon (the neutral cube by default — never initials) and opens the
 * SAME picker as the sidebar ⋯ "Change icon…", writing the shared per-project
 * store (cloud/projects/projectIcons.ts setProjectIcon → PUT /api/containers/{cid}/icon).
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectIconRow } from "./SettingsPage";
import * as prefs from "../../cloud/projects/prefs";
import * as icons from "../../cloud/projects/projectIcons";

function mount() {
  return render(<dl><ProjectIconRow cid="c1" name="orcha-web" /></dl>);
}

describe("Settings › General › Icon (D14)", () => {
  beforeEach(() => {
    localStorage.clear();
    prefs._resetForTests();
    // PUT /api/containers/{cid}/icon echoes the stored icon (glyph colour normalized to null)
    global.fetch = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      const icon = init?.method === "PUT" ? JSON.parse(String(init.body)).icon : null;
      return { ok: true, status: 200, json: async () => ({ prefs: null, icon: icon && icon.kind === "glyph" ? { color: null, ...icon } : icon }) } as unknown as Response;
    }) as unknown as typeof fetch;
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("shows the default glyph (not initials) and a Change icon… button", () => {
    mount();
    const btn = screen.getByRole("button", { name: "Change icon for orcha-web (current: default)" });
    expect(btn).toHaveTextContent("Change icon…");
    expect(btn.querySelector(".v2-picon")).toHaveAttribute("data-icon", "default");
    expect(screen.getByText("Icon")).toBeInTheDocument();
  });

  it("opens the shared picker and a pick is stored for this project", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Change icon for orcha-web/ }));
    const dlg = await screen.findByRole("dialog", { name: "Change icon for orcha-web" });
    fireEvent.click(dlg.querySelector('[role="tab"]:nth-child(2)')!); // Icons
    fireEvent.click(await screen.findByRole("button", { name: "database" }));
    // a glyph pick saves and keeps the picker open so a colour can follow (D14)
    await waitFor(() => expect(icons.projectIcons().c1).toEqual({ kind: "glyph", value: "database", color: null }));
    expect(document.querySelector("#setProjectIcon .v2-picon")).toHaveAttribute("data-icon", "glyph:database");
  });

  it("reflects an icon set elsewhere (sidebar) live", () => {
    mount();
    act(() => { icons.setProjectIcon("c1", { kind: "emoji", value: "🚀" }); });
    expect(document.querySelector("#setProjectIcon .v2-picon")).toHaveAttribute("data-icon", "emoji:🚀");
    expect(screen.getByRole("button", { name: "Change icon for orcha-web (current: 🚀)" })).toBeInTheDocument();
  });
});
