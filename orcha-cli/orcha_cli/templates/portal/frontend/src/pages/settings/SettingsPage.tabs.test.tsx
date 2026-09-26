/**
 * SettingsPage tab-strip tests — the React port of the vanilla settings-tabs
 * contract (cloud static/modules/settings-tabs.js + settings.html #setTabs):
 *
 *  - NO registered extension sections → today's untabbed layout, no tablist,
 *    no data-tab on .set-wrap (zero visual change for open Orcha).
 *  - Registered sections → the #setTabs pill bar renders (topbar .aut/.seg
 *    idiom), first tab "General" (the open key + models cards), then one tab
 *    per section using its `title`.
 *  - Persistence is the URL hash: #tab=<name> deep-links on load and on
 *    hashchange; an unknown #tab falls back to General; loading writes NO
 *    hash; clicking a pill rewrites it via history.replaceState.
 *
 * MemoryRouter (not HashRouter) hosts the page so the router never fights the
 * page for window.location.hash — production mounts under BrowserRouter where
 * the hash is likewise free.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { extensions, type SettingsSection } from "../../extensions";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { SettingsPage, tabFromHash } from "./SettingsPage";

/* ---- fetch stub (same minimal backend as SettingsPage.test.tsx) ----------- */
function installFetch() {
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init && init.method) || "GET";
    const json = (data: unknown) =>
      ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    if (url === "/api/containers/c1")
      return json({
        container: { id: "c1", name: "Orcha", autonomy_level: "plan" },
        agents: [],
        tasks: [],
        requests: [],
      });
    if (url.endsWith("/settings/llm-key") && method === "GET")
      return json({ configured: true, masked: "sk-...abcd", source: "db" });
    if (url.endsWith("/settings/models") && method === "GET") return json({ use_cases: [] });
    if (url.endsWith("/settings/providers")) return json({ providers: [] });
    return json({});
  };
  vi.stubGlobal("fetch", vi.fn(impl));
}

const SECTIONS: SettingsSection[] = [
  {
    key: "members",
    title: "Members",
    element: () => <div className="card set-card">Members section body</div>,
  },
  {
    key: "appearance",
    title: "Appearance",
    element: () => <div className="card set-card">Appearance section body</div>,
  },
];

function renderPage() {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter>
          <SettingsPage />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

function setHash(hash: string) {
  window.history.replaceState(null, "", window.location.pathname + hash);
}

beforeEach(() => {
  localStorage.clear();
  setHash("");
  installFetch();
  delete extensions.settingsSections;
  delete extensions.settingsGeneral;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete extensions.settingsSections;
  delete extensions.settingsGeneral;
});

/* ---- untabbed (open Orcha default) ---------------------------------------- */
describe("SettingsPage without extension sections", () => {
  it("keeps today's untabbed layout: no tablist, no data-tab on .set-wrap", async () => {
    const { container } = renderPage();
    await waitFor(() => expect(screen.getByText("Anthropic API key configured")).toBeInTheDocument());

    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(container.querySelector("#setTabs")).toBeNull();
    const wrap = container.querySelector(".set-wrap");
    expect(wrap).not.toBeNull();
    expect(wrap!.hasAttribute("data-tab")).toBe(false);
    // both open cards render
    expect(screen.getByText("Anthropic API key")).toBeInTheDocument();
    expect(screen.getByText("Universal model selection")).toBeInTheDocument();
  });
});

/* ---- tabbed (downstream registered sections) ------------------------------ */
describe("SettingsPage with extension sections", () => {
  beforeEach(() => {
    extensions.settingsSections = SECTIONS;
  });

  it("renders the vanilla pill bar: General first, then each section title", async () => {
    const { container } = renderPage();
    await waitFor(() => expect(screen.getByText("Anthropic API key configured")).toBeInTheDocument());

    const bar = container.querySelector("#setTabs");
    expect(bar).not.toBeNull();
    expect(bar!.getAttribute("role")).toBe("tablist");
    expect(bar!.className).toContain("aut");
    expect(bar!.className).toContain("set-tabs");

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["General", "Members", "Appearance"]);
    // pill idiom: .seg spans carrying data-tab, only the active one lit with .on
    tabs.forEach((t) => expect(t.className).toContain("seg"));
    expect(tabs[0].className).toContain("on");
    expect(tabs[1].className).not.toContain("on");
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[1].getAttribute("aria-selected")).toBe("false");
    expect(tabs.map((t) => t.getAttribute("data-tab"))).toEqual(["general", "members", "appearance"]);

    // General shows the open cards, not the section bodies
    expect(screen.getByText("Anthropic API key")).toBeInTheDocument();
    expect(screen.getByText("Universal model selection")).toBeInTheDocument();
    expect(screen.queryByText("Members section body")).not.toBeInTheDocument();

    // the wrap is keyed for CSS, and loading wrote NO hash (deep links only on user action)
    expect(container.querySelector('.set-wrap[data-tab="general"]')).not.toBeNull();
    expect(window.location.hash).toBe("");
  });

  it("clicking a pill switches the rendered section and rewrites #tab= via replaceState", async () => {
    const { container } = renderPage();
    await waitFor(() => expect(screen.getByText("Anthropic API key configured")).toBeInTheDocument());

    fireEvent.click(screen.getByText("Members"));
    expect(screen.getByText("Members section body")).toBeInTheDocument();
    expect(screen.queryByText("Anthropic API key")).not.toBeInTheDocument();
    expect(screen.queryByText("Universal model selection")).not.toBeInTheDocument();
    expect(window.location.hash).toBe("#tab=members");
    expect(container.querySelector('.set-wrap[data-tab="members"]')).not.toBeNull();
    expect(screen.getByText("Members").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("General").getAttribute("aria-selected")).toBe("false");

    // back to General restores the open cards
    fireEvent.click(screen.getByText("General"));
    await waitFor(() => expect(screen.getByText("Universal model selection")).toBeInTheDocument());
    expect(screen.queryByText("Members section body")).not.toBeInTheDocument();
    expect(window.location.hash).toBe("#tab=general");
  });

  it("Enter / Space on a pill selects it (vanilla keydown handler)", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Anthropic API key configured")).toBeInTheDocument());

    // scoped to the tab pill (role=tab) — the General tab also ships its own
    // native "Appearance" card (skin picker), so a plain text query is ambiguous.
    fireEvent.keyDown(screen.getByRole("tab", { name: "Appearance" }), { key: "Enter" });
    expect(screen.getByText("Appearance section body")).toBeInTheDocument();
    expect(window.location.hash).toBe("#tab=appearance");

    fireEvent.keyDown(screen.getByText("Members"), { key: " " });
    expect(screen.getByText("Members section body")).toBeInTheDocument();
    expect(window.location.hash).toBe("#tab=members");
  });

  it("#tab=<name> deep-links on load", async () => {
    setHash("#tab=appearance");
    renderPage();
    expect(await screen.findByText("Appearance section body")).toBeInTheDocument();
    expect(screen.queryByText("Universal model selection")).not.toBeInTheDocument();
    expect(screen.getByText("Appearance").getAttribute("aria-selected")).toBe("true");
  });

  it("an unknown #tab falls back to General", async () => {
    setHash("#tab=nonsense");
    renderPage();
    await waitFor(() => expect(screen.getByText("Universal model selection")).toBeInTheDocument());
    expect(screen.getByText("General").getAttribute("aria-selected")).toBe("true");
  });

  it("hashchange (back/forward, manual edit) re-selects without a click", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Anthropic API key configured")).toBeInTheDocument());

    setHash("#tab=members");
    fireEvent(window, new HashChangeEvent("hashchange"));
    expect(await screen.findByText("Members section body")).toBeInTheDocument();
    expect(screen.queryByText("Anthropic API key")).not.toBeInTheDocument();
  });
});

/* ---- pure hash helper ------------------------------------------------------ */
describe("tabFromHash", () => {
  const names = ["general", "members", "appearance"];
  it("parses #tab= in first or joined position, validates against the tab list", () => {
    expect(tabFromHash("#tab=members", names)).toBe("members");
    expect(tabFromHash("#foo=1&tab=appearance", names)).toBe("appearance");
    expect(tabFromHash("#tab=nope", names)).toBe("general");
    expect(tabFromHash("", names)).toBe("general");
    expect(tabFromHash(null, names)).toBe("general");
  });
});
