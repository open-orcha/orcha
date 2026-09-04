/**
 * Cloud settings-tab ARRANGEMENT — renders the open SettingsPage with the
 * REAL cloud extension registry (src/extensions.ts untouched) and pins the
 * vanilla settings.html grouping it mirrors:
 *
 *   Workspace (Anthropic key + xAI key + models) → Collaboration (Members,
 *   Phone pairing) → Appearance
 *
 * becomes, on the React tab strip:
 *
 *   General (models) | Provider keys (Anthropic first, then xAI) | Members |
 *   Phone pairing (inline QR) | Appearance
 *
 * with settingsGeneral.key:false so the Anthropic key card has exactly ONE
 * home — the Provider keys tab — never duplicated on General.
 */
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { extensions } from "../../extensions";
import { SettingsPage } from "../../pages/settings/SettingsPage";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { resetIdentity } from "../identity";

function installFetch() {
  const json = (data: unknown, status = 200) =>
    ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init && init.method) || "GET";
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/me")) return json({ identity: null, trusted: false });
    if (url === "/api/containers/c1/settings/llm-key" && method === "GET")
      return json({ configured: true, masked: "sk-...anth", source: "db" });
    if (url === "/api/containers/c1/settings/provider-keys")
      return json({ keys: [
        { provider: "anthropic", name: "Anthropic", configured: true, masked: "sk-...anth", source: "db" },
        { provider: "xai", name: "xAI (Grok)", configured: false, masked: null, source: null },
      ] });
    if (url === "/api/containers/c1/settings/github-pat")
      return json({ configured: false, source: null, masked: null, set_at: null });
    if (url === "/api/github/repos") return json({ available: false, repos: [] });
    if (url.endsWith("/settings/models")) return json({ use_cases: [] });
    if (url.endsWith("/settings/providers")) return json({ providers: [] });
    if (url === "/api/containers/c1/members")
      return json({ members: [
        { agent_id: "h1", alias: "kedar", github_login: "kedar-gh", member_role: "owner", grants: [], pending: false },
      ], restricted: false });
    if (url.startsWith("/api/containers/c1/pairing"))
      return json({
        baseUrl: "http://192.168.1.20:80", humanAgentId: "h1", humanAgentAlias: "kedar",
        qrSvg: "<svg></svg>", shortCode: "ABCD-1234",
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      });
    if (url === "/api/containers/c1")
      return json({
        container: { id: "c1", name: "Orcha", autonomy_level: "plan" },
        agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }],
        tasks: [],
        requests: [],
      });
    return json({});
  };
  vi.stubGlobal("fetch", vi.fn(impl));
}

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

beforeEach(() => {
  localStorage.clear();
  resetIdentity();
  window.history.replaceState(null, "", window.location.pathname);
  installFetch();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("cloud settings tabs (vanilla settings.html arrangement, real registry)", () => {
  it("registers the mirrored tab order and hides the open key card from General", () => {
    expect((extensions.settingsSections || []).map((s) => [s.key, s.title])).toEqual([
      ["provider-keys", "Provider keys"],
      ["github-access", "GitHub access"],
      ["members", "Members"],
      ["pairing", "Phone pairing"],
      ["appearance", "Appearance"],
    ]);
    // one home for every key: the open General copy of the Anthropic card is off
    expect(extensions.settingsGeneral).toEqual({ key: false });
  });

  it("General keeps the models card but NOT a duplicate Anthropic key card", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Universal model selection")).toBeInTheDocument());
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).toEqual(["General", "Provider keys", "GitHub access", "Members", "Phone pairing", "Appearance"]);
    // the key card lives ONLY under Provider keys now
    expect(screen.queryByText("Anthropic API key")).not.toBeInTheDocument();
    expect(document.querySelector("#keyCard")).toBeNull();
  });

  it("Provider keys tab renders the Anthropic card first, then the other providers", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Universal model selection")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("tab", { name: "Provider keys" }));
    await waitFor(() => expect(screen.getByText("Anthropic API key configured")).toBeInTheDocument());
    const titles = Array.from(document.querySelectorAll(".set-card .card-h h2")).map((h) => h.textContent);
    expect(titles).toEqual(["Anthropic API key", "xAI / Grok API key"]);
    expect(await screen.findByText("No xAI (Grok) API key configured.")).toBeInTheDocument();
  });

  it("Members tab renders the members card (roster + invite) inside Settings", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Universal model selection")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("tab", { name: "Members" }));
    expect(await screen.findByText("kedar-gh")).toBeInTheDocument();
    const titles = Array.from(document.querySelectorAll(".set-card .card-h h2")).map((h) => h.textContent);
    expect(titles).toEqual(["Members"]);
    expect(screen.getByPlaceholderText("GitHub username to invite…")).toBeInTheDocument();
  });

  it("Phone pairing tab shows the QR inline immediately (no button press)", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Universal model selection")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("tab", { name: "Phone pairing" }));
    expect(await screen.findByText("ABCD-1234")).toBeInTheDocument();
    expect(document.querySelector("#pairingCard .pair-qr")).not.toBeNull();
    // the card body carries the panel, not a launcher button (the topbar's own
    // Pair phone button still exists — that one opens the modal)
    expect(document.querySelector("#pairingCard button#settingsPairPhone")).toBeNull();
    expect(document.querySelectorAll("#pairingCard button").length).toBe(0);
    expect(document.querySelector(".overlay")).toBeNull();
  });
});
