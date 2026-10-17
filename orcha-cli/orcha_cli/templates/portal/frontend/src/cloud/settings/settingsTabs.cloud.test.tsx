/**
 * Cloud settings ARRANGEMENT (V2) — renders SettingsPage with the REAL cloud
 * extension registry (src/extensions.ts untouched) and pins how the
 * registered sections land in the V2 groups (arch §2.3, parity PI-07):
 *
 *   General | Execution | Models & providers (Agent runtimes, then the
 *   Providers rows — Anthropic + xAI — then models) | Integrations (GitHub access) | Members & access |
 *   Devices & pairing (inline QR) | Interface (registered `appearance`)
 *
 * settingsGeneral.key:false keeps ONE home for the Anthropic key card: the
 * registered Provider keys section, never the open copy.
 */
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { extensions, type Identity } from "../../extensions";
import { SettingsPage } from "../../pages/settings/SettingsPage";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { resetIdentity } from "../identity";

// /api/me envelope (trust off by default: the self-hosted portal)
let meBody: unknown = { identity: null, trusted: false };
function installFetch() {
  const json = (data: unknown, status = 200) =>
    ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init && init.method) || "GET";
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/me")) return json(meBody);
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
    if (url === "/api/models")
      return json({ default: "claude-opus-5", models: [{ id: "claude-opus-5", name: "Opus 5", runtime: "claude", reasoning_efforts: [] }] });
    if (url === "/api/reasoning-efforts") return json({ efforts: [] });
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

  it("maps the registered sections into the V2 groups", async () => {
    renderPage();
    await screen.findByText("Details");
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).toEqual([
      "General", "Execution", "Models & providers", "Integrations", "Members & access", "Devices & pairing", "Notifications", "Voice", "Interface",
    ]);
  });

  it("Models & providers renders the shared image-33 rows: runtimes, Anthropic first, then xAI, then models — no duplicate open key card", async () => {
    renderPage();
    await screen.findByText("Details");
    fireEvent.click(screen.getByRole("tab", { name: "Models & providers" }));
    const row = (id: string) => document.querySelector<HTMLElement>(`.mp-row[data-provider="${id}"]`);
    await waitFor(() => expect(row("xai")).not.toBeNull());
    await waitFor(() => expect(row("claude")).not.toBeNull()); // Agent runtimes group
    await waitFor(() => expect(row("anthropic")!.querySelector(".mp-row-detail")).toHaveTextContent("sk-...anth"));
    const ids = Array.from(document.querySelectorAll("#providerKeys .mp-row")).map((r) => r.getAttribute("data-provider"));
    expect(ids).toEqual(["anthropic", "xai"]);
    expect(row("xai")!.querySelector('svg[data-brand="xai"]')).not.toBeNull();
    expect(row("xai")!.querySelector(".mp-row-detail")).toHaveTextContent("No API key");
    // the old per-provider "… API key" cards are gone: the same groups as the open layout
    const titles = Array.from(document.querySelectorAll(".set-card .card-h h2")).map((h) => h.textContent);
    expect(titles).toEqual(["Agent runtimes", "Providers", "Universal model selection"]);
    expect(document.querySelectorAll("#keyCard").length).toBe(1); // ONE Anthropic key row (the section's), no open copy
    expect(document.querySelectorAll("#providerKeys").length).toBe(1);
    expect(document.querySelectorAll('.mp-row[data-provider="anthropic"]').length).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Show xAI (Grok) settings" }));
    expect(await screen.findByText("(No xAI (Grok) API key)")).toBeVisible();
  });

  it("a member without manage_keys sees the rows read-only with the reason once (MP-PERM-VIEWER)", async () => {
    const origId = extensions.identity;
    const origTrusted = extensions.identityTrusted;
    extensions.identity = async () => ({ agent_id: "h1", alias: "kedar", member_role: "member", grants: [] }) as Identity;
    extensions.identityTrusted = () => true;
    try {
      renderPage();
      await screen.findByText("Details");
      fireEvent.click(screen.getByRole("tab", { name: "Models & providers" }));
      await waitFor(() => expect(document.querySelector("#keysLocked")).toHaveTextContent(/manage_keys/));
      await waitFor(() => expect(document.querySelector('.mp-row[data-provider="xai"]')).not.toBeNull());
      fireEvent.click(screen.getByRole("button", { name: "Show Anthropic settings" }));
      fireEvent.click(screen.getByRole("button", { name: "Show xAI (Grok) settings" }));
      expect(document.querySelectorAll(".mp-row-panel input")).toHaveLength(0);
      expect(screen.queryByRole("button", { name: /Remove .* API key|Replace key|Save key/ })).toBeNull();
      expect(document.querySelectorAll("#keysLocked")).toHaveLength(1);
    } finally {
      extensions.identity = origId;
      extensions.identityTrusted = origTrusted;
    }
  });

  it("old #tab=github-access still opens GitHub access (now under Integrations)", async () => {
    window.history.replaceState(null, "", window.location.pathname + "#tab=github-access");
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Integrations" })).toHaveAttribute("aria-selected", "true"));
    // no repo bound in this snapshot: the row says so truthfully, and links to connect one
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Connect on GitHub" })).toHaveAttribute("href", "/github");
  });

  it("Members & access renders the members card (roster + invite) inside Settings", async () => {
    renderPage();
    await screen.findByText("Details");
    fireEvent.click(screen.getByRole("tab", { name: "Members & access" }));
    expect(await screen.findByText("kedar-gh")).toBeInTheDocument();
    const titles = Array.from(document.querySelectorAll(".set-card .card-h h2")).map((h) => h.textContent);
    expect(titles).toEqual([]); // the section header is the one title (no repeated "Members" h2)
    expect(screen.getByPlaceholderText("GitHub username to invite…")).toBeInTheDocument();
  });

  it("Devices & pairing shows the QR inline immediately (no button press)", async () => {
    renderPage();
    await screen.findByText("Details");
    fireEvent.click(screen.getByRole("tab", { name: "Devices & pairing" }));
    expect(await screen.findByText("ABCD-1234")).toBeInTheDocument();
    expect(document.querySelector("#pairingCard .pair-qr")).not.toBeNull();
    // the card body carries the panel, not a launcher button (the topbar's own
    // Pair phone button still exists — that one opens the modal)
    expect(document.querySelector("#pairingCard button#settingsPairPhone")).toBeNull();
    expect(document.querySelectorAll("#pairingCard button").length).toBe(0);
    expect(document.querySelector(".overlay")).toBeNull();
    // DEV-SELFHOST: trust off (self-hosted) — device sign-in needs GitHub
    // sign-in, so one muted line replaces the desktop row + devices card
    expect(await screen.findByText(/Device sign-in needs GitHub sign-in/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Sign in the desktop app…" })).toBeNull();
    expect(document.querySelector("#deviceTokens")).toBeNull();
  });

  it("DEV-SELFHOST: behind GitHub sign-in (trusted) the desktop row and Signed-in devices show", async () => {
    meBody = { identity: { agent_id: "h1", alias: "kedar", github_login: "kedar-gh", member_role: "owner", grants: [] }, trusted: true };
    try {
      window.history.replaceState(null, "", window.location.pathname + "#tab=pairing");
      renderPage();
      expect(await screen.findByRole("link", { name: "Sign in the desktop app…" })).toHaveAttribute("href", "/auth/device?client=desktop");
      expect(document.querySelector("#deviceTokens")).not.toBeNull();
    } finally {
      meBody = { identity: null, trusted: false };
    }
  });

  it("GAP-06: #tab=pairing and the #tab=devices alias both land on Devices & pairing", async () => {
    window.history.replaceState(null, "", window.location.pathname + "#tab=devices");
    renderPage();
    expect(await screen.findByText("ABCD-1234")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Devices & pairing" })).toHaveAttribute("aria-selected", "true");
  });
});
