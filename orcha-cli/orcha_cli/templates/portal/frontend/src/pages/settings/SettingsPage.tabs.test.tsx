/**
 * SettingsPage — V2 sectioned navigation (parity R-06 / PI-07, arch §2.3).
 *
 *  - Sections: General · Execution · Models & providers · (Integrations,
 *    Members & access when registered) · Devices & pairing · Interface; any
 *    other downstream section keeps its own entry after them.
 *  - Persistence is the URL hash: #tab=<key> deep-links on load and on
 *    hashchange; every pre-V2 key and the V2 aliases resolve; an unknown key
 *    falls back to General; loading writes NO hash; selecting a section
 *    rewrites it via history.replaceState with the canonical key.
 *  - The section list is a vertical tablist with roving focus (↑/↓/Home/End).
 *
 * MemoryRouter hosts the page so the router never fights the page for
 * window.location.hash (production mounts under BrowserRouter).
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { extensions, type SettingsSection } from "../../extensions";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { resolveSettingsKey, SettingsPage, tabFromHash } from "./SettingsPage";

function installFetch() {
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init && init.method) || "GET";
    const json = (data: unknown) =>
      ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    if (url === "/api/containers/c1")
      return json({
        container: { id: "c1", name: "Orcha", description: "Ship the portal", status: "active", autonomy_level: "plan", wakes_enabled: false },
        agents: [],
        tasks: [],
        requests: [],
      });
    if (url.endsWith("/settings/llm-key") && method === "GET")
      return json({ configured: true, masked: "sk-...abcd", source: "db" });
    if (url.endsWith("/settings/models") && method === "GET") return json({ use_cases: [] });
    if (url.endsWith("/settings/providers")) return json({ providers: [] });
    if (url === "/api/prefs") return json({ prefs: null });
    return json({});
  };
  vi.stubGlobal("fetch", vi.fn(impl));
}

const SECTIONS: SettingsSection[] = [
  { key: "members", title: "Members", element: () => <div className="card set-card">Members section body</div> },
  { key: "appearance", title: "Appearance", element: () => <div className="card set-card">Appearance section body</div> },
  { key: "billing", title: "Billing", element: () => <div className="card set-card">Billing section body</div> },
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
const tabNames = () => screen.getAllByRole("tab").map((t) => t.textContent);

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

describe("SettingsPage V2 sections (open Orcha, no extension sections)", () => {
  it("renders the V2 section list with General selected and writes no hash on load", async () => {
    const { container } = renderPage();
    expect(await screen.findByText("Ship the portal")).toBeInTheDocument(); // General → project objective
    const bar = container.querySelector("#setTabs")!;
    expect(bar.getAttribute("role")).toBe("tablist");
    expect(bar.getAttribute("aria-orientation")).toBe("vertical");
    // Integrations appears because this build registers the /github route (repo link)
    expect(tabNames()).toEqual(["General", "Execution", "Models & providers", "Integrations", "Devices & pairing", "Notifications", "Voice", "Interface"]);
    expect(screen.getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { level: 1, name: "General" })).toBeInTheDocument();
    expect(container.querySelector('.set-wrap[data-tab="general"]')).not.toBeNull();
    expect(window.location.hash).toBe("");
  });

  it("every setting still has a home: keys + models under Models & providers, worktrees under Execution, pairing under Devices", async () => {
    renderPage();
    await screen.findByText("Ship the portal");
    fireEvent.click(screen.getByRole("tab", { name: "Models & providers" }));
    await waitFor(() => expect(screen.getByText("(Anthropic API key)")).toBeInTheDocument());
    // image-33 redesign: runtimes + providers as rows, then the use-case models
    expect(screen.getByText("Agent runtimes")).toBeInTheDocument();
    expect(screen.getByText("Providers")).toBeInTheDocument();
    expect(screen.getByText("Universal model selection")).toBeInTheDocument();
    expect(window.location.hash).toBe("#tab=provider-keys");

    fireEvent.click(screen.getByRole("tab", { name: "Execution" }));
    expect(await screen.findByRole("switch", { name: "Isolated worktrees" })).toBeInTheDocument();
    // notifier and autonomy are shown as independent facts, not merged
    // (worded like the header chip: execChipState; the config line under it)
    expect(document.querySelector("#setNotifierState")).toHaveTextContent("Paused");
    expect(screen.getByText(/Off — no agent wakes/)).toBeInTheDocument();
    expect(screen.getByText("Plan-only")).toBeInTheDocument();
    // the independence explanation moved into the group's "?" tooltip (D12)
    expect(screen.getByRole("button", { name: "About Notifier and autonomy" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Devices & pairing" }));
    expect(await screen.findByText("Phone pairing")).toBeInTheDocument();
    expect(window.location.hash).toBe("#tab=pairing");
  });

  it("legacy #tab=appearance opens Interface (Appearance + sidebar + keys)", async () => {
    setHash("#tab=appearance");
    renderPage();
    expect(await screen.findByRole("tab", { name: "Interface" })).toHaveAttribute("aria-selected", "true");
    // the Appearance group holds the System / Light / Dark picker
    expect(await screen.findByText("Keyboard shortcuts")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Theme" })).toBeInTheDocument();
  });

  it("arrow keys move between sections (roving focus) and select them", async () => {
    renderPage();
    await screen.findByText("Ship the portal");
    const general = screen.getByRole("tab", { name: "General" });
    general.focus();
    fireEvent.keyDown(general, { key: "ArrowDown" });
    expect(screen.getByRole("tab", { name: "Execution" })).toHaveAttribute("aria-selected", "true");
    expect(window.location.hash).toBe("#tab=execution");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Execution" }), { key: "End" });
    expect(screen.getByRole("tab", { name: "Interface" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("SettingsPage with extension sections", () => {
  beforeEach(() => { extensions.settingsSections = SECTIONS; });

  it("slots known sections into their V2 group and keeps unknown ones as their own entry", async () => {
    renderPage();
    await screen.findByText("Ship the portal");
    expect(tabNames()).toEqual([
      "General", "Execution", "Models & providers", "Integrations", "Members & access", "Devices & pairing", "Notifications", "Voice", "Interface", "Billing",
    ]);
  });

  it("selecting a section switches the rendered body and rewrites #tab= via replaceState", async () => {
    const { container } = renderPage();
    await screen.findByText("Ship the portal");
    fireEvent.click(screen.getByRole("tab", { name: "Members & access" }));
    expect(screen.getByText("Members section body")).toBeInTheDocument();
    expect(screen.queryByText("Ship the portal")).not.toBeInTheDocument();
    expect(window.location.hash).toBe("#tab=members");
    expect(container.querySelector('.set-wrap[data-tab="members"]')).not.toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Interface" }));
    expect(screen.getByText("Appearance section body")).toBeInTheDocument(); // the registered appearance element
    expect(window.location.hash).toBe("#tab=interface");

    fireEvent.click(screen.getByRole("tab", { name: "Billing" }));
    expect(screen.getByText("Billing section body")).toBeInTheDocument();
  });

  it("#tab=<old key> deep-links on load", async () => {
    setHash("#tab=members");
    renderPage();
    expect(await screen.findByText("Members section body")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Members & access" })).toHaveAttribute("aria-selected", "true");
  });

  it("an unknown #tab falls back to General", async () => {
    setHash("#tab=nonsense");
    renderPage();
    expect(await screen.findByText("Ship the portal")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "true");
  });

  it("hashchange (back/forward, manual edit) re-selects without a click", async () => {
    renderPage();
    await screen.findByText("Ship the portal");
    setHash("#tab=devices");
    fireEvent(window, new HashChangeEvent("hashchange"));
    expect(await screen.findByText("Phone pairing")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Devices & pairing" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("tabFromHash / resolveSettingsKey", () => {
  const names = ["general", "execution", "provider-keys", "github-access", "members", "pairing", "interface"];
  it("parses #tab= in first or joined position, validates against the section list", () => {
    expect(tabFromHash("#tab=members", names)).toBe("members");
    expect(tabFromHash("#foo=1&tab=pairing", names)).toBe("pairing");
    expect(tabFromHash("#tab=nope", names)).toBe("general");
    expect(tabFromHash("", names)).toBe("general");
    expect(tabFromHash(null, names)).toBe("general");
  });
  it("maps the V2 aliases onto the canonical (pre-V2) keys", () => {
    expect(resolveSettingsKey("appearance", names)).toBe("interface");
    expect(resolveSettingsKey("devices", names)).toBe("pairing");
    expect(resolveSettingsKey("models", names)).toBe("provider-keys");
    expect(resolveSettingsKey("integrations", names)).toBe("github-access");
    // an alias whose target is absent (open build without members) falls back
    expect(resolveSettingsKey("access", ["general", "pairing"])).toBe("general");
  });
});
