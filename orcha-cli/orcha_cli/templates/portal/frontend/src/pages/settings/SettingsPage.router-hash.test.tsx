/**
 * QA (R-06 / GAP-06): with Settings already open, a ROUTER navigation that
 * only changes `#tab=` (palette "Settings: X", desktop host "Pair phone" →
 * navigate('/settings?cid=…#tab=pairing')) must switch the section. pushState
 * never fires `hashchange`, so the page follows the router location.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, useNavigate, type NavigateFunction } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { extensions } from "../../extensions";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { SettingsPage } from "./SettingsPage";

function installFetch() {
  const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    if (url === "/api/containers/c1") {
      return json({ container: { id: "c1", name: "Orcha", description: "Ship the portal", status: "active", autonomy_level: "plan" }, agents: [], tasks: [], requests: [] });
    }
    if (url.endsWith("/settings/providers")) return json({ providers: [] });
    return json({});
  }));
}

let nav: NavigateFunction | null = null;
function NavGrab() { nav = useNavigate(); return null; }

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", window.location.pathname);
  installFetch();
  delete extensions.settingsSections;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); nav = null; });

describe("SettingsPage follows router hash navigations", () => {
  it("navigate('/settings#tab=pairing') while General is open selects Devices & pairing", async () => {
    render(
      <ToastProvider>
        <SnapshotProvider>
          <MemoryRouter initialEntries={["/settings#tab=general"]}>
            <NavGrab />
            <SettingsPage />
          </MemoryRouter>
        </SnapshotProvider>
      </ToastProvider>,
    );
    await screen.findByText("Ship the portal");
    expect(screen.getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "true");
    act(() => { nav!("/settings?cid=c1#tab=pairing"); });
    expect(await screen.findByText("Phone pairing")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Devices & pairing" })).toHaveAttribute("aria-selected", "true");
    // and back via an alias
    act(() => { nav!("/settings#tab=execution"); });
    expect(await screen.findByRole("switch", { name: "Isolated worktrees" })).toBeInTheDocument();
  });

  it("re-navigating to the router's last hash after a local tab click still switches back", async () => {
    render(
      <ToastProvider>
        <SnapshotProvider>
          <MemoryRouter initialEntries={["/settings#tab=general"]}>
            <NavGrab />
            <SettingsPage />
          </MemoryRouter>
        </SnapshotProvider>
      </ToastProvider>,
    );
    await screen.findByText("Ship the portal");
    act(() => { nav!("/settings#tab=pairing"); });
    expect(await screen.findByText("Phone pairing")).toBeInTheDocument();
    // local click selects General (replaceState only — router still says #tab=pairing)
    act(() => { screen.getByRole("tab", { name: "General" }).click(); });
    expect(screen.getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "true");
    // palette "Settings: Devices & pairing" again → same hash, new location key
    act(() => { nav!("/settings#tab=pairing"); });
    expect(screen.getByRole("tab", { name: "Devices & pairing" })).toHaveAttribute("aria-selected", "true");
  });
});
