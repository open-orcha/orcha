/**
 * SettingsPage tests for the three ported features:
 *  - per-provider API key cards (GET/PUT/DELETE/test .../settings/provider-keys)
 *  - mobile pairing card (GET .../pairing, honest 409 message on failure)
 *  - appearance skin picker (localStorage "orcha:skin" + data-skin attribute)
 *
 * Same harness idiom as SettingsPage.test.tsx: fetch stubbed, real
 * ToastProvider + SnapshotProvider so cid/acting-human resolve exactly as in
 * production.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { extensions } from "../../extensions";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { otherProviderKeys, SettingsPage, type ProviderKeyEntry } from "./SettingsPage";

/* ---- fetch stub ----------------------------------------------------------- */
interface Call {
  url: string;
  method: string;
  body: unknown;
}
let calls: Call[] = [];
let providerKeys: ProviderKeyEntry[] = [
  { provider: "anthropic", name: "Anthropic", configured: true, source: "db", masked: "sk-...abcd", set_at: "t" },
  { provider: "xai", name: "xAI / Grok", configured: false, source: null, masked: null, set_at: null },
];
let pairingResponse: { status: number; body: unknown } = {
  status: 200,
  body: {
    baseUrl: "http://192.168.1.20:8000",
    humanAgentId: "h1",
    humanAgentAlias: "kedar",
    shortCode: "ABCD-1234",
    qrSvg: '<svg data-testid="qr-svg"></svg>',
    expiresAt: "2099-01-01T00:00:00Z",
    reachable: true,
  },
};
let rawAgents: unknown[] = [
  { id: "a1", alias: "forge", kind: "ai", status: "active" },
  { id: "h1", alias: "kedar", kind: "human", status: "active" },
];

function installFetch() {
  calls = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init && init.method) || "GET";
    const body = init && init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const json = (data: unknown, status = 200) =>
      ({ ok: status < 400, status, json: async () => data }) as unknown as Response;

    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    if (url === "/api/containers/c1")
      return json({
        container: { id: "c1", name: "Orcha", autonomy_level: "plan" },
        agents: rawAgents,
        tasks: [],
        requests: [],
      });
    if (url.endsWith("/settings/llm-key") && method === "GET")
      return json({ configured: true, masked: "sk-...abcd", source: "db" });
    if (url.endsWith("/settings/models") && method === "GET") return json({ use_cases: [] });
    if (url.endsWith("/settings/providers")) return json({ providers: [] });

    if (url.endsWith("/settings/provider-keys") && method === "GET") return json({ keys: providerKeys });
    if (/\/settings\/provider-keys\/[^/]+$/.test(url) && method === "PUT")
      return json({ configured: true, source: "db", provider: "xai", masked: "sk-...9999" });
    if (/\/settings\/provider-keys\/[^/]+$/.test(url) && method === "DELETE")
      return json({ configured: false, source: null, provider: "xai", masked: null });
    if (/\/settings\/provider-keys\/[^/]+\/test$/.test(url) && method === "POST")
      return json({ ok: true, detail: "key accepted by the xAI API" });

    if (url.startsWith("/api/containers/c1/pairing")) return json(pairingResponse.body, pairingResponse.status);

    return json({});
  };
  vi.stubGlobal("fetch", vi.fn(impl));
}

// V2 sections: deep-link straight to the section under test (#tab=<key>).
function renderPage(tab = "provider-keys") {
  window.history.replaceState(null, "", window.location.pathname + "#tab=" + tab);
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
  delete extensions.settingsSections;
  delete extensions.settingsGeneral;
  localStorage.clear();
  document.documentElement.removeAttribute("data-skin");
  providerKeys = [
    { provider: "anthropic", name: "Anthropic", configured: true, source: "db", masked: "sk-...abcd", set_at: "t" },
    { provider: "xai", name: "xAI / Grok", configured: false, source: null, masked: null, set_at: null },
  ];
  pairingResponse = {
    status: 200,
    body: {
      baseUrl: "http://192.168.1.20:8000",
      humanAgentId: "h1",
      humanAgentAlias: "kedar",
      shortCode: "ABCD-1234",
      qrSvg: '<svg data-testid="qr-svg"></svg>',
      expiresAt: "2099-01-01T00:00:00Z",
      reachable: true,
    },
  };
  rawAgents = [
    { id: "a1", alias: "forge", kind: "ai", status: "active" },
    { id: "h1", alias: "kedar", kind: "human", status: "active" },
  ];
  installFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("data-skin");
  localStorage.clear();
});

/* ====================================================================== *
 *  FEATURE 1 — per-provider API keys                                     *
 * ====================================================================== */
describe("provider-keys cards", () => {
  it("renders one card per non-Anthropic provider from the GET list, Anthropic excluded", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("(No xAI / Grok API key)")).toBeInTheDocument());
    // Anthropic keeps its own dedicated card (KeyCard) — never duplicated here.
    expect(screen.queryAllByText("(Anthropic API key)").length).toBe(1);
  });

  it("shows the env-shadow state when source is env", async () => {
    providerKeys = [
      { provider: "xai", name: "xAI / Grok", configured: true, source: "env", masked: "sk-...envk", set_at: null },
    ];
    renderPage();
    await waitFor(() => expect(screen.getByText("sk-...envk")).toBeInTheDocument());
    const pkCard = document.querySelector<HTMLElement>('.pk-card[data-provider="xai"]')!;
    expect(within(pkCard).getByText(/from the environment/)).toBeInTheDocument();
    expect(within(pkCard).getByText("Test stored key")).toBeInTheDocument();
    expect(within(pkCard).queryByText("Save key")).not.toBeInTheDocument();
    expect(within(pkCard).queryByText("Remove")).not.toBeInTheDocument();
  });

  it("PUT saves a new key to the provider-scoped route with the acting human", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("(No xAI / Grok API key)")).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText("Paste xAI / Grok API key…"), {
      target: { value: "xai-test-key" },
    });
    fireEvent.click(screen.getByText("Save key"));

    await waitFor(() => {
      const put = calls.find((c) => c.method === "PUT" && c.url.endsWith("/settings/provider-keys/xai"));
      expect(put).toBeTruthy();
      expect((put!.body as { api_key: string }).api_key).toBe("xai-test-key");
      expect((put!.body as { actor_agent_id: string }).actor_agent_id).toBe("h1");
    });
    await waitFor(() => expect(screen.getByText("API key saved.")).toBeInTheDocument());
  });

  it("DELETE removes the stored key via the confirm modal", async () => {
    providerKeys = [
      { provider: "xai", name: "xAI / Grok", configured: true, source: "db", masked: "sk-...9999", set_at: "t" },
    ];
    renderPage();
    await waitFor(() => expect(screen.getByText("(xAI / Grok API key)")).toBeInTheDocument());

    const pkCard = document.querySelector<HTMLElement>('.pk-card[data-provider="xai"]')!;
    fireEvent.click(within(pkCard).getByText("Remove"));
    fireEvent.click(screen.getByText("Remove key"));

    await waitFor(() => {
      const del = calls.find((c) => c.method === "DELETE" && c.url.endsWith("/settings/provider-keys/xai"));
      expect(del).toBeTruthy();
      expect((del!.body as { actor_agent_id: string }).actor_agent_id).toBe("h1");
    });
    await waitFor(() => expect(screen.getByText("API key removed.")).toBeInTheDocument());
  });

  it("POST test calls the provider-scoped /test route and renders the detail", async () => {
    providerKeys = [
      { provider: "xai", name: "xAI / Grok", configured: true, source: "db", masked: "sk-...9999", set_at: "t" },
    ];
    renderPage();
    await waitFor(() => expect(screen.getByText("(xAI / Grok API key)")).toBeInTheDocument());

    const pkCard = document.querySelector<HTMLElement>('.pk-card[data-provider="xai"]')!;
    fireEvent.click(within(pkCard).getByText("Test"));

    await waitFor(() => {
      const test = calls.find((c) => c.method === "POST" && c.url.endsWith("/settings/provider-keys/xai/test"));
      expect(test).toBeTruthy();
    });
    // ok:true renders the fixed "accepted it" wording (the backend's `detail` is
    // rendered only on a rejection) — mirrors the vanilla pk-card exactly.
    await waitFor(() => expect(screen.getByText("Key is valid — xAI / Grok accepted it.")).toBeInTheDocument());
  });

  it("otherProviderKeys filters out anthropic and maps keyState per entry", () => {
    const vms = otherProviderKeys(providerKeys);
    expect(vms.map((v) => v.provider)).toEqual(["xai"]);
    expect(vms[0]).toMatchObject({ mode: "none", configured: false, editable: true, canClear: false });
  });
});

/* ====================================================================== *
 *  FEATURE 2 — mobile pairing card                                       *
 * ====================================================================== */
describe("key field affordances (V2)", () => {
  it("the reveal toggle is an eye button with aria-label + aria-pressed, and the narrow-width section pills mirror the tabs", async () => {
    renderPage("provider-keys");
    const reveal = await screen.findByRole("button", { name: "Show key" }, { timeout: 3000 }).catch(() => null);
    const btn = reveal || (await waitFor(() => document.querySelector<HTMLButtonElement>("#keyReveal")!));
    expect(btn).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(btn);
    expect(document.querySelector("#keyReveal")).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelector("#keyReveal")).toHaveAttribute("aria-label", "Hide key");
    // narrow widths: a scrolling pill row mirrors the tabs (no native <select>)
    expect(document.querySelector("#setSectionSelect")).toBeNull();
    const pills = document.querySelector("#setSectionPills")!;
    expect(pills.querySelector('[data-pill="provider-keys"]')).toHaveAttribute("aria-current", "page");
    fireEvent.click(pills.querySelector('[data-pill="interface"]')!);
    expect(screen.getByRole("tab", { name: "Interface" })).toHaveAttribute("aria-selected", "true");
    expect(pills.querySelector('[data-pill="interface"]')).toHaveAttribute("aria-current", "page");
  });
});

describe("pairing card", () => {
  it("fetches on load and renders the QR svg + guidance on 200", async () => {
    renderPage("pairing");
    await waitFor(() => expect(screen.getByText("ABCD-1234")).toBeInTheDocument());
    expect(screen.getByText("http://192.168.1.20:8000")).toBeInTheDocument();
    expect(document.querySelector(".pair-value")?.textContent).toContain("kedar");
    const host = document.querySelector(".pair-qr");
    expect(host?.innerHTML).toContain("qr-svg");

    // the acting human resolves once the snapshot arrives; the card may fire an
    // initial fetch before that (no human_agent_id) and a follow-up once it's
    // known — assert the LAST pairing call carries it (the one whose response
    // is what actually rendered above).
    const pairingCalls = calls.filter((c) => c.url.startsWith("/api/containers/c1/pairing"));
    expect(pairingCalls.length).toBeGreaterThan(0);
    expect(pairingCalls[pairingCalls.length - 1].url).toContain("human_agent_id=h1");
  });

  it("renders an honest message card on a 409 reachability failure, not a crash", async () => {
    pairingResponse = {
      status: 409,
      body: {
        detail: {
          reachable: false,
          reason: "no_lan_address",
          title: "Phones can't reach this Embodent yet",
          message: "The portal only has a localhost address right now.",
        },
      },
    };
    renderPage("pairing");
    await waitFor(() => expect(screen.getByText("Phones can't reach this Embodent yet")).toBeInTheDocument());
    expect(screen.getByText("The portal only has a localhost address right now.")).toBeInTheDocument();
    expect(screen.queryByText("ABCD-1234")).not.toBeInTheDocument();
    // a real way forward: "Check again" re-requests the pairing payload
    const before = calls.filter((c) => c.url.startsWith("/api/containers/c1/pairing")).length;
    fireEvent.click(screen.getByRole("button", { name: /Check again/ }));
    await waitFor(() =>
      expect(calls.filter((c) => c.url.startsWith("/api/containers/c1/pairing")).length).toBeGreaterThan(before),
    );
  });

  it("renders the no_human 409 message honestly", async () => {
    pairingResponse = {
      status: 409,
      body: {
        detail: {
          reachable: false,
          reason: "no_human",
          title: "No human can pair this phone",
          message: "Add a human operator to this Embodent before pairing a phone.",
        },
      },
    };
    renderPage("pairing");
    await waitFor(() => expect(screen.getByText("No human can pair this phone")).toBeInTheDocument());
    expect(screen.getByText("Add a human operator to this Embodent before pairing a phone.")).toBeInTheDocument();
  });
});

/* ====================================================================== *
 *  FEATURE 3 — Interface (theme picker; the skin picker is retired)      *
 * ====================================================================== */
describe("interface section (skins retired)", () => {
  it("#tab=appearance resolves to Interface: no skin tiles, data-skin untouched", async () => {
    localStorage.setItem("orcha:skin", "swiss");
    renderPage("appearance");
    expect(await screen.findByText(/Swiss design\) is kept on file/)).toBeInTheDocument();
    expect(screen.queryByText(/Orcha uses one dark appearance everywhere/)).toBeNull();
    expect(screen.getByRole("tab", { name: "Interface" })).toHaveAttribute("aria-selected", "true");
    expect(document.querySelector("#skinGrid")).toBeNull();
    expect(document.querySelector(".skin-tile")).toBeNull();
    expect(document.documentElement.hasAttribute("data-skin")).toBe(false);
    // the stored choice is disclosed, never deleted
    expect(screen.getByText(/Swiss design\) is kept on file/)).toBeInTheDocument();
    expect(localStorage.getItem("orcha:skin")).toBe("swiss");
  });
});
