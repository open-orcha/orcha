/**
 * ProviderKeysSection — ONE home for every provider key, now in the shared
 * image-33 rows (Agent runtimes, then Providers): the open Anthropic KeyCard
 * renders as the FIRST provider row, then the masked render
 * from the provider-keys GET (Anthropic filtered out of the pk list) and the
 * exact human-gated mutation bodies against the provider-scoped routes.
 * fetch is stubbed; snapshot flows through the real SnapshotProvider +
 * mapSnapshot, matching MembersPage.test.tsx style.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { resetIdentity } from "../identity";
import { ProviderKeysSection } from "./ProviderKeysSection";

interface Call { url: string; method: string; body: unknown }

const rawSnap = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [
    { id: "h1", alias: "kedar", kind: "human", status: "idle" },
    { id: "a1", alias: "forge", kind: "ai", status: "working" },
  ],
  tasks: [],
  requests: [],
};

const keys = {
  keys: [
    { provider: "anthropic", name: "Anthropic", configured: true, masked: "sk-...zzzz", source: "db" },
    { provider: "xai", name: "xAI (Grok)", configured: true, masked: "sk-...abcd", source: "db" },
  ],
};

interface Overrides { keys?: unknown; llmKey?: unknown; agents?: unknown[]; keysStatus?: number; putStatus?: number }
function stubFetch(overrides: Overrides = {}): Call[] {
  const calls: Call[] = [];
  const json = (data: unknown, status = 200) =>
    ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method || "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/me")) return json({ identity: null, trusted: false });
    // the re-homed open KeyCard's own status GET (#294 llm-key routes)
    if (url === "/api/containers/c1/settings/llm-key")
      return json(overrides.llmKey ?? { configured: true, masked: "sk-...anth", source: "db" });
    if (url === "/api/models")
      return json({ default: "claude-opus-5", models: [{ id: "claude-opus-5", name: "Opus 5", runtime: "claude", reasoning_efforts: [] }] });
    if (url === "/api/reasoning-efforts") return json({ efforts: [] });
    if (url === "/api/containers/c1/settings/models")
      return json({ use_cases: [{ key: "triage", label: "t", purpose: "p", default_provider: "anthropic", default_model: "m1", is_set: false }] });
    if (url === "/api/containers/c1/settings/providers")
      return json({ providers: [{ id: "anthropic", name: "Anthropic", available: true }, { id: "xai", name: "xAI (Grok)", available: true }, { id: "openai", name: "OpenAI", available: false }] });
    if (url === "/api/containers/c1/settings/provider-keys") {
      if (overrides.keysStatus) return json({ detail: "Traceback: boom" }, overrides.keysStatus);
      return json(overrides.keys ?? keys);
    }
    if (url === "/api/containers/c1/settings/provider-keys/xai" && init?.method === "PUT" && overrides.putStatus)
      return json({ detail: "key is not an xAI key" }, overrides.putStatus);
    if (url.startsWith("/api/containers/c1/settings/provider-keys/")) return json({ ok: true });
    if (url.startsWith("/api/containers/c1")) return json({ ...rawSnap, agents: overrides.agents ?? rawSnap.agents });
    return json({});
  }) as unknown as typeof fetch;
  return calls;
}

function mount() {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <ProviderKeysSection />
      </SnapshotProvider>
    </ToastProvider>,
  );
}

const row = (id: string) => document.querySelector<HTMLElement>(`.mp-row[data-provider="${id}"]`)!;
const head = (id: string) => row(id).querySelector<HTMLElement>(".mp-row-head")!;

/** Expand the xAI row and scope queries to its panel's key body (the
 *  Anthropic KeyCard shares placeholder/button copy). */
async function xaiCard() {
  await waitFor(() => expect(row("xai")).not.toBeNull());
  const chev = within(row("xai")).getByRole("button", { name: /(Show|Hide) xAI \(Grok\) settings/ });
  if (chev.getAttribute("aria-expanded") !== "true") fireEvent.click(chev);
  const el = row("xai").querySelector(".mp-row-panel .pk-card");
  expect(el).not.toBeNull();
  expect(el).toBeVisible();
  return within(el as HTMLElement);
}

describe("ProviderKeysSection (one home for every key, image-33 rows)", () => {
  beforeEach(() => { localStorage.clear(); resetIdentity(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("renders Agent runtimes, then the Anthropic KeyCard row FIRST, then the xAI row — all ProviderRows", async () => {
    const calls = stubFetch();
    mount();
    await waitFor(() => expect(row("xai")).not.toBeNull());
    // the open KeyCard, re-homed here, loads its own llm-key status
    expect(calls.some((c) => c.url === "/api/containers/c1/settings/llm-key")).toBe(true);
    await waitFor(() => expect(within(row("anthropic")).getByText("sk-...anth")).toHaveClass("mp-mono"));
    // group order: runtimes, then providers; provider row order Anthropic → xAI
    const groups = Array.from(document.querySelectorAll(".mp-group")).map((g) => g.querySelector("h2, h3")?.textContent);
    expect(groups).toEqual(["Agent runtimes", "Providers"]);
    await waitFor(() => expect(row("claude")).not.toBeNull());
    const ids = Array.from(document.querySelectorAll("#providerKeys .mp-row")).map((r) => r.getAttribute("data-provider"));
    expect(ids).toEqual(["anthropic", "xai"]);
    // the Anthropic row hosts the open #keyCard mount (exactly one)
    expect(document.querySelectorAll("#keyCard").length).toBe(1);
    expect(document.querySelector("#keyCard .mp-row[data-provider=anthropic]")).not.toBeNull();
    // real logos + verified docs link
    expect(row("xai").querySelector('svg[data-brand="xai"]')).not.toBeNull();
    expect(within(row("xai")).getByRole("link", { name: "Open xAI (Grok) docs" })).toHaveAttribute("href", "https://docs.x.ai/overview");
    // Default = the shipped use-case default provider; catalog stubs are "Coming soon"
    await waitFor(() => expect(within(head("anthropic")).getByText("Default")).toBeInTheDocument());
    expect(within(head("xai")).queryByText("Default")).toBeNull();
    await waitFor(() => expect(within(row("openai")).getByText("Not supported yet")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("2 connected")).toBeInTheDocument());
  });

  it("renders the masked DB key from GET …/settings/provider-keys (row detail, once) and filters Anthropic out of the pk list", async () => {
    stubFetch();
    mount();
    // db-mode detail line: masked form straight from the GET
    expect(await screen.findByText("sk-...abcd")).toHaveClass("mp-mono");
    expect(within(head("xai")).getByText(/stored encrypted/)).toBeInTheDocument();
    // Anthropic renders through the open KeyCard row — never as a pk-card
    expect(screen.queryByText("sk-...zzzz")).not.toBeInTheDocument();
    expect(document.querySelectorAll(".pk-card").length).toBe(1);
    expect(document.querySelector(".pk-card")!.getAttribute("data-provider")).toBe("xai");
    // panel collapsed until the chevron opens it
    expect(row("xai").querySelector(".mp-row-panel")).not.toBeVisible();
    const card = await xaiCard();
    expect(card.getByText("(xAI (Grok) API key)")).toBeInTheDocument();
    // db mode affordances: replace + test + remove, input in replace mode
    expect(card.getByPlaceholderText("Paste a new key to replace…")).toBeInTheDocument();
    expect(card.getByRole("button", { name: /Replace key/ })).toBeInTheDocument();
    expect(card.getByRole("button", { name: /Remove/ })).toBeInTheDocument();
    expect(screen.getAllByText("sk-...abcd")).toHaveLength(1); // D12: masked once
  });

  it("unset provider renders the warn detail, banner and Save affordance", async () => {
    stubFetch({ keys: { keys: [{ provider: "xai", name: "xAI (Grok)", configured: false, masked: null, source: null }] } });
    mount();
    await waitFor(() => expect(within(row("xai")).getByText("No API key")).toBeInTheDocument());
    expect(row("xai").querySelector(".mp-row-detail")).toHaveClass("is-warn");
    const card = await xaiCard();
    expect(card.getByText("(No xAI (Grok) API key)")).toBeInTheDocument();
    expect(card.getByPlaceholderText("Paste xAI (Grok) API key…")).toBeInTheDocument();
    expect(card.getByRole("button", { name: /Save key/ })).toBeInTheDocument();
    expect(card.queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
  });

  it("env-managed key is read-only: 'set via ORCHA_LLM_API_KEY', Test only, no Save/Remove", async () => {
    stubFetch({ keys: { keys: [{ provider: "xai", name: "xAI (Grok)", configured: true, masked: "xai-...envv", source: "env" }] } });
    mount();
    await waitFor(() => expect(within(head("xai")).getByText(/set via/)).toBeInTheDocument());
    const card = await xaiCard();
    expect(card.queryByRole("textbox")).toBeNull();
    expect(card.queryByRole("button", { name: /Save key|Replace key|Remove/ })).toBeNull();
    expect(card.getByRole("button", { name: /Test/ })).toBeInTheDocument();
  });

  it("Save PUTs {api_key, actor_agent_id} to …/settings/provider-keys/xai (byte-exact body)", async () => {
    const calls = stubFetch();
    mount();
    await screen.findByText("sk-...abcd");
    const card = await xaiCard();
    fireEvent.change(card.getByPlaceholderText("Paste a new key to replace…"), {
      target: { value: "sk-xai-new-123" },
    });
    fireEvent.click(card.getByRole("button", { name: /Replace key/ }));
    await waitFor(() => {
      const put = calls.find(
        (c) => c.url === "/api/containers/c1/settings/provider-keys/xai" && c.method === "PUT",
      );
      expect(put).toBeTruthy();
      // exact vanilla body (actor = trust-off fallback human via memActor)
      expect(put!.body).toEqual({ api_key: "sk-xai-new-123", actor_agent_id: "h1" });
    });
    // success path reloads the key list from the server
    await waitFor(() => {
      const gets = calls.filter(
        (c) => c.url === "/api/containers/c1/settings/provider-keys" && c.method === "GET",
      );
      expect(gets.length).toBeGreaterThan(1);
    });
  });

  it("a failed Save keeps the typed key and says why in words (server detail, never raw)", async () => {
    stubFetch({ putStatus: 422 });
    mount();
    await screen.findByText("sk-...abcd");
    const card = await xaiCard();
    fireEvent.change(card.getByPlaceholderText("Paste a new key to replace…"), { target: { value: "nope" } });
    fireEvent.click(card.getByRole("button", { name: /Replace key/ }));
    expect(await screen.findByText("Couldn't save the key — key is not an xAI key. Your input is preserved.")).toBeInTheDocument();
    expect(card.getByPlaceholderText("Paste a new key to replace…")).toHaveValue("nope");
  });

  it("Test POSTs to …/provider-keys/xai/test — pasted key rides in the body, stored key omits api_key", async () => {
    const calls = stubFetch();
    mount();
    await screen.findByText("sk-...abcd");
    const card = await xaiCard();
    // no typed value + configured key: Test fires with actor only (server tests the stored key)
    fireEvent.click(card.getByRole("button", { name: /^Test$/ }));
    await waitFor(() => {
      const post = calls.find(
        (c) => c.url === "/api/containers/c1/settings/provider-keys/xai/test" && c.method === "POST",
      );
      expect(post).toBeTruthy();
      expect(post!.body).toEqual({ actor_agent_id: "h1" });
    });
    expect(await screen.findByText("Key is valid — xAI (Grok) accepted it.")).toBeInTheDocument();
  });

  it("Remove confirms, then DELETEs …/provider-keys/xai with the actor", async () => {
    const calls = stubFetch();
    mount();
    await screen.findByText("sk-...abcd");
    const card = await xaiCard();
    fireEvent.click(card.getByRole("button", { name: "Remove xAI (Grok) API key" }));
    expect(await screen.findByText("Remove xAI (Grok) API key")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove key" }));
    await waitFor(() => {
      const del = calls.find((c) => c.url === "/api/containers/c1/settings/provider-keys/xai" && c.method === "DELETE");
      expect(del!.body).toEqual({ actor_agent_id: "h1" });
    });
    expect(await screen.findByText("API key removed.")).toBeInTheDocument();
  });

  it("Use for agent runs: a switch on the Anthropic and OpenAI rows (never xAI), state from the GETs", async () => {
    stubFetch({
      llmKey: { configured: true, masked: "sk-...anth", source: "db", stored: true, use_for_agents: true, agent_runtime: "claude" },
      keys: {
        keys: [
          { provider: "anthropic", name: "Anthropic", configured: true, masked: "sk-...zzzz", source: "db", stored: true, use_for_agents: true, agent_runtime: "claude" },
          { provider: "xai", name: "xAI (Grok)", configured: true, masked: "sk-...abcd", source: "db", stored: true, use_for_agents: false, agent_runtime: null },
          { provider: "openai", name: "OpenAI", configured: false, masked: null, source: null, stored: false, use_for_agents: false, agent_runtime: "codex", agent_only: true },
        ],
      },
    });
    mount();
    await waitFor(() => expect(row("openai")).not.toBeNull());
    const anth = row("anthropic").querySelector(".ak-row")!;
    expect(anth).toHaveAttribute("data-agent-key", "on");
    expect(anth.querySelector(".ak-state.is-on")!.textContent).toBe("On — Claude Code runs on this project bill this API key.");
    expect(row("xai").querySelector(".ak-row")).toBeNull();
    const oa = row("openai").querySelector<HTMLElement>(".ak-row")!;
    expect(oa).toHaveAttribute("data-agent-key", "off");
    // panels stay mounted while collapsed (hidden), so query through the hidden tree
    expect(within(oa).getByRole("switch", { name: "Use for agent runs", hidden: true })).toHaveAttribute("aria-disabled", "true");
    expect(within(row("openai")).getByText(/Codex agents on the OpenAI API instead of a ChatGPT subscription/)).toBeInTheDocument();
  });

  it("Refresh re-reads both key sources", async () => {
    const calls = stubFetch();
    mount();
    await screen.findByText("sk-...abcd");
    const n = (u: string) => calls.filter((c) => c.method === "GET" && c.url === u).length;
    const before = [n("/api/containers/c1/settings/llm-key"), n("/api/containers/c1/settings/provider-keys")];
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => {
      expect(n("/api/containers/c1/settings/llm-key")).toBe(before[0] + 1);
      expect(n("/api/containers/c1/settings/provider-keys")).toBe(before[1] + 1);
    });
  });

  it("no acting human (viewer lane): rows + status visible, no key fields, no mutations", async () => {
    const calls = stubFetch({ agents: [{ id: "a1", alias: "forge", kind: "ai", status: "working" }] });
    mount();
    await screen.findByText("sk-...abcd");
    const card = await xaiCard();
    expect(card.getByText("Configured")).toBeInTheDocument();
    expect(document.querySelectorAll(".mp-row-panel input")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /Remove .* API key|Replace key|Save key/ })).toBeNull();
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
  });

  it("a key-list failure is a friendly line with Retry, never the raw error", async () => {
    stubFetch({ keysStatus: 500 });
    mount();
    expect(await screen.findByText("Couldn't load provider keys.")).toBeInTheDocument();
    expect(screen.queryByText(/Traceback|boom/)).toBeNull();
    expect(document.querySelector("#providerKeys #pkRetry")).not.toBeNull();
    expect(document.querySelector(".pk-card")).toBeNull();
  });
});
