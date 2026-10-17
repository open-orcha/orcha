/**
 * Models & providers — image-33 row redesign.
 *  - rendering: runtime rows (real logo, mono launch command, Default badge,
 *    verified docs link), provider rows (masked key detail, Default = the
 *    shipped use-case default provider), "Coming soon" catalog stubs without
 *    controls, "N connected" count.
 *  - expand / collapse: panels start collapsed, the chevron toggles them
 *    (aria-expanded), a typed draft survives a collapse.
 *  - gating: a viewer / member without manage_keys sees status only, one reason.
 *  - every existing action posts exactly the same API call as before.
 *  - load failures are friendly lines, never raw.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { extensions, type Identity } from "../../extensions";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { resetIdentity } from "../../cloud/identity";
import { SettingsPage } from "./SettingsPage";
import { groupRuntimes } from "./providerRows";

interface Call { url: string; method: string; body: unknown }
let calls: Call[] = [];
let agents: unknown[] = [];
let llmKey: Record<string, unknown> = {};
let pkeys: unknown[] = [];
let modelsFail = false;

const HUMAN = { id: "h1", alias: "kedar", kind: "human", status: "active" };
const ORIG_IDENTITY = extensions.identity;
const ORIG_TRUSTED = extensions.identityTrusted;

const API_MODELS = {
  default: "claude-opus-5",
  models: [
    { id: "claude-opus-5", name: "Opus 5", runtime: "claude", reasoning_efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5", runtime: "claude", reasoning_efforts: [] },
    { id: "gpt-5.5", name: "GPT-5.5", runtime: "codex", reasoning_efforts: ["low", "medium", "high", "xhigh"] },
  ],
};
const EFFORTS = {
  default: "medium",
  efforts: [
    { id: "low", name: "Low" }, { id: "medium", name: "Medium" }, { id: "high", name: "High" },
    { id: "xhigh", name: "Extra-high" }, { id: "max", name: "Maximum" },
  ],
};
const USE_CASES = [
  { key: "triage", label: "Wake eligibility", purpose: "p", default_provider: "anthropic", default_model: "m1", is_set: false },
];
const CATALOG = [
  { id: "anthropic", name: "Anthropic", available: true, models: [{ id: "m1", name: "M1" }, { id: "m2", name: "M2" }] },
  { id: "xai", name: "xAI", available: true, models: [{ id: "g1", name: "Grok 4.3" }] },
  { id: "openai", name: "OpenAI", available: false, models: [] },
  { id: "gemini", name: "Gemini", available: false, models: [] },
];

function install() {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const res = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
    if (url === "/api/containers") return res([{ id: "c1", status: "active" }]);
    if (url === "/api/containers/c1") {
      return res({ container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" }, agents, tasks: [], requests: [] });
    }
    if (url === "/api/models") return modelsFail ? res({ detail: "boom" }, 500) : res(API_MODELS);
    if (url === "/api/reasoning-efforts") return res(EFFORTS);
    const base = "/api/containers/c1/settings/";
    if (url === base + "llm-key" && method === "GET") return res(llmKey);
    if (url === base + "llm-key" && method === "PUT") return res({ configured: true, masked: "sk-...9999" });
    if (url === base + "llm-key" && method === "DELETE") return res({ configured: false, source: null, masked: null });
    if (url === base + "llm-key/test") return res({ ok: true });
    if (url === base + "provider-keys" && method === "GET") return res({ keys: pkeys });
    if (/provider-keys\/xai$/.test(url) && method === "PUT") return res({ configured: true, source: "db", provider: "xai", masked: "sk-...7777" });
    if (/provider-keys\/xai$/.test(url) && method === "DELETE") return res({ configured: false, source: null, provider: "xai", masked: null });
    if (/provider-keys\/xai\/test$/.test(url)) return res({ ok: false, detail: "key rejected by the xAI API" });
    if (url === base + "models" && method === "GET") return res({ use_cases: USE_CASES });
    if (url === base + "models" && method === "PUT") return res({ use_cases: USE_CASES.map((u) => ({ ...u, is_set: true, provider: "anthropic", model: "m2" })) });
    if (url === base + "providers") return res({ providers: CATALOG });
    if (url.startsWith("/api/me")) return res({ identity: null, trusted: false });
    if (url === "/api/prefs") return res({ prefs: null });
    return res({});
  }));
}

function renderPage() {
  window.history.replaceState(null, "", window.location.pathname + "#tab=models"); // legacy alias → provider-keys
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter><SettingsPage /></MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

const row = (id: string) => document.querySelector<HTMLElement>(`.mp-row[data-provider="${id}"]`)!;
const head = (id: string) => row(id).querySelector<HTMLElement>(".mp-row-head")!;
const panel = (id: string) => row(id).querySelector<HTMLElement>(".mp-row-panel")!;
async function ready() {
  await waitFor(() => expect(calls.some((c) => c.url === "/api/containers/c1")).toBe(true));
  await waitFor(() => expect(row("anthropic")).not.toBeNull());
  await waitFor(() => expect(row("xai")).not.toBeNull());
}
function expand(name: string) {
  fireEvent.click(screen.getByRole("button", { name: "Show " + name + " settings" }));
}

beforeEach(() => {
  delete extensions.settingsSections;
  delete extensions.settingsGeneral;
  localStorage.clear();
  resetIdentity();
  extensions.identity = undefined;
  extensions.identityTrusted = undefined;
  agents = [HUMAN];
  llmKey = { configured: true, masked: "sk-...abcd", source: "db" };
  pkeys = [
    { provider: "anthropic", name: "Anthropic", configured: true, source: "db", masked: "sk-...abcd" },
    { provider: "xai", name: "xAI", configured: false, source: null, masked: null },
  ];
  modelsFail = false;
  install();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  extensions.identity = ORIG_IDENTITY;
  extensions.identityTrusted = ORIG_TRUSTED;
});

describe("Models & providers — rows", () => {
  it("renders runtime rows with the real logo, launch command, Default and docs link", async () => {
    renderPage();
    await waitFor(() => expect(row("claude")).not.toBeNull());
    const claude = row("claude");
    expect(within(claude).getByText("Claude Code")).toBeInTheDocument();
    expect(claude.querySelector('svg[data-brand="claude"]')).not.toBeNull();
    expect(within(claude).getByText("claude --dangerously-skip-permissions")).toHaveClass("mp-mono");
    expect(within(head("claude")).getByText("Default")).toBeInTheDocument(); // hosts DEFAULT_MODEL
    expect(within(claude).getByRole("link", { name: "Open Claude Code docs" })).toHaveAttribute("href", "https://code.claude.com/docs/en/overview");

    const codex = row("codex");
    expect(codex.querySelector('svg[data-brand="openai"]')).not.toBeNull();
    expect(within(codex).getByText("codex exec --dangerously-bypass-approvals-and-sandbox")).toBeInTheDocument();
    expect(within(head("codex")).queryByText("Default")).toBeNull();
    expect(within(codex).getByRole("link", { name: "Open Codex docs" })).toHaveAttribute("target", "_blank");
    expect(screen.getByText("2 runtimes")).toBeInTheDocument();
    // no invented state
    expect(screen.queryByText("Enabled")).toBeNull();
    expect(screen.queryByText("Set default")).toBeNull();
  });

  it("runtime panels list the models with their effort levels (read-only)", async () => {
    renderPage();
    await waitFor(() => expect(row("claude")).not.toBeNull());
    expect(panel("claude")).not.toBeVisible();
    expand("Claude Code");
    const p = panel("claude");
    expect(p).toBeVisible();
    expect(within(p).getByText("Opus 5")).toBeInTheDocument();
    expect(within(p).getByText("Effort: Low · Medium · High · Extra-high · Maximum")).toBeInTheDocument();
    expect(within(p).getByText("No effort levels")).toBeInTheDocument();
    expect(within(p).getByText("curl -fsSL https://claude.ai/install.sh | bash")).toBeInTheDocument();
    expect(within(p).queryByRole("combobox")).toBeNull();
  });

  it("renders provider rows: masked key detail, Default, docs, coming-soon stubs and the connected count", async () => {
    renderPage();
    await ready();
    const a = row("anthropic");
    expect(a.querySelector('svg[data-brand="anthropic"]')).not.toBeNull();
    expect(within(a).getByText("sk-...abcd")).toHaveClass("mp-mono");
    expect(within(head("anthropic")).getByText(/stored encrypted/)).toBeInTheDocument();
    await waitFor(() => expect(within(head("anthropic")).getByText("Default")).toBeInTheDocument());
    expect(within(a).getByRole("link", { name: "Open Anthropic docs" })).toHaveAttribute("href", "https://platform.claude.com/docs/en/api/overview");

    const x = row("xai");
    expect(x.querySelector('svg[data-brand="xai"]')).not.toBeNull();
    expect(within(x).getByText("No API key")).toBeInTheDocument();
    expect(within(head("xai")).queryByText("Default")).toBeNull();
    expect(within(x).getByRole("link", { name: "Open xAI docs" })).toHaveAttribute("href", "https://docs.x.ai/overview");

    await waitFor(() => expect(row("openai")).not.toBeNull());
    expect(within(row("openai")).getByText("Not supported yet")).toBeInTheDocument();
    expect(within(row("openai")).queryByRole("button")).toBeNull(); // no chevron, no controls
    expect(row("gemini").querySelector('svg[data-brand="gemini"]')).not.toBeNull();
    expect(screen.getByText("2 providers")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("1 connected")).toBeInTheDocument());
  });

  it("the env-managed key reads 'set via ORCHA_LLM_API_KEY' and is Test-only inside the panel", async () => {
    llmKey = { configured: true, masked: "sk-...envk", source: "env" };
    renderPage();
    await ready();
    expect(within(row("anthropic")).getByText(/set via/)).toBeInTheDocument();
    expand("Anthropic");
    const p = panel("anthropic");
    expect(within(p).getByRole("button", { name: "Test stored key" })).toBeVisible();
    expect(within(p).queryByText("Save key")).toBeNull();
    expect(within(p).queryByText("Remove")).toBeNull();
    // D12: the masked key is said once (the row detail), not again in the panel
    expect(screen.getAllByText("sk-...envk")).toHaveLength(1);
  });
});

describe("Models & providers — expand / collapse", () => {
  it("panels start collapsed; the chevron toggles them and a typed draft survives a collapse", async () => {
    renderPage();
    await ready();
    const chev = screen.getByRole("button", { name: "Show xAI settings" });
    expect(chev).toHaveAttribute("aria-expanded", "false");
    expect(panel("xai")).not.toBeVisible();
    fireEvent.click(chev);
    expect(screen.getByRole("button", { name: "Hide xAI settings" })).toHaveAttribute("aria-expanded", "true");
    expect(panel("xai")).toBeVisible();
    const input = within(panel("xai")).getByLabelText("xAI API key");
    fireEvent.change(input, { target: { value: "xai-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Hide xAI settings" }));
    expect(panel("xai")).not.toBeVisible();
    expand("xAI");
    expect(within(panel("xai")).getByLabelText("xAI API key")).toHaveValue("xai-secret");
    // other rows are independent
    expect(panel("anthropic")).not.toBeVisible();
  });

  it("clicking the row's name area toggles too", async () => {
    renderPage();
    await ready();
    fireEvent.click(within(row("anthropic")).getByText("Anthropic"));
    expect(panel("anthropic")).toBeVisible();
  });
});

describe("Models & providers — same API calls as before", () => {
  it("Anthropic: Replace (PUT llm-key), Test (POST llm-key/test), Remove (DELETE llm-key) with the acting human", async () => {
    renderPage();
    await ready();
    expand("Anthropic");
    const p = panel("anthropic");
    fireEvent.change(within(p).getByPlaceholderText("Paste a new key to replace…"), { target: { value: "sk-ant-new-1" } });
    fireEvent.click(within(p).getByRole("button", { name: "Test" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST" && c.url === "/api/containers/c1/settings/llm-key/test")?.body)
      .toEqual({ api_key: "sk-ant-new-1", actor_agent_id: "h1" }));
    await waitFor(() => expect(within(p).getByRole("button", { name: "Replace key" })).not.toBeDisabled());
    fireEvent.click(within(p).getByRole("button", { name: "Replace key" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT" && c.url === "/api/containers/c1/settings/llm-key")?.body)
      .toEqual({ api_key: "sk-ant-new-1", actor_agent_id: "h1" }));
    await screen.findByText("API key saved.");

    fireEvent.click(await within(panel("anthropic")).findByRole("button", { name: "Remove Anthropic API key" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove key" }));
    await waitFor(() => expect(calls.find((c) => c.method === "DELETE" && c.url === "/api/containers/c1/settings/llm-key")?.body)
      .toEqual({ actor_agent_id: "h1" }));
  });

  it("xAI: Save (PUT provider-keys/xai), Test (POST …/test) — a rejected key shows the friendly verdict", async () => {
    renderPage();
    await ready();
    expand("xAI");
    const p = panel("xai");
    fireEvent.change(within(p).getByLabelText("xAI API key"), { target: { value: "xai-abc" } });
    fireEvent.click(within(p).getByRole("button", { name: "Test" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST" && c.url === "/api/containers/c1/settings/provider-keys/xai/test")?.body)
      .toEqual({ api_key: "xai-abc", actor_agent_id: "h1" }));
    expect(await within(p).findByText("key rejected by the xAI API")).toBeInTheDocument();
    fireEvent.click(within(p).getByRole("button", { name: "Save key" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT" && c.url === "/api/containers/c1/settings/provider-keys/xai")?.body)
      .toEqual({ api_key: "xai-abc", actor_agent_id: "h1" }));
  });

  it("xAI stored key: Remove confirms then DELETEs provider-keys/xai", async () => {
    pkeys = [{ provider: "xai", name: "xAI", configured: true, source: "db", masked: "sk-...7777" }];
    renderPage();
    await ready();
    expand("xAI");
    fireEvent.click(within(panel("xai")).getByRole("button", { name: "Remove xAI API key" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove key" }));
    await waitFor(() => expect(calls.find((c) => c.method === "DELETE" && c.url === "/api/containers/c1/settings/provider-keys/xai")?.body)
      .toEqual({ actor_agent_id: "h1" }));
  });

  it("universal model selection still PUTs settings/models", async () => {
    renderPage();
    await ready();
    const sel = await waitFor(() => {
      const s = document.querySelector<HTMLSelectElement>('select.uc-model[data-key="triage"]');
      expect(s).not.toBeNull();
      return s!;
    });
    fireEvent.change(sel, { target: { value: "m2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT" && c.url === "/api/containers/c1/settings/models")?.body)
      .toEqual({ actor_agent_id: "h1", use_cases: [{ key: "triage", provider: "anthropic", model: "m2" }] }));
  });

  it("Refresh re-reads both key sources", async () => {
    renderPage();
    await ready();
    const n = (u: string) => calls.filter((c) => c.method === "GET" && c.url === u).length;
    const before = [n("/api/containers/c1/settings/llm-key"), n("/api/containers/c1/settings/provider-keys")];
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => {
      expect(n("/api/containers/c1/settings/llm-key")).toBe(before[0] + 1);
      expect(n("/api/containers/c1/settings/provider-keys")).toBe(before[1] + 1);
    });
  });
});

describe("Models & providers — gating and failures", () => {
  it("a member without manage_keys: rows + status visible, no key fields in any panel, ONE reason", async () => {
    extensions.identity = async () => ({ agent_id: "h1", alias: "kedar", member_role: "member", grants: ["assign_reviewers"] }) as Identity;
    extensions.identityTrusted = () => true;
    renderPage();
    await ready();
    await waitFor(() => expect(document.querySelector("#keysLocked")).toHaveTextContent(/manage_keys/));
    expand("Anthropic");
    expand("xAI");
    expect(within(panel("anthropic")).getByText("Configured")).toBeInTheDocument();
    expect(within(panel("anthropic")).queryByRole("textbox")).toBeNull();
    expect(document.querySelectorAll(".mp-row-panel input")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /Remove .* API key/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    expect(document.querySelectorAll("#keysLocked")).toHaveLength(1);
  });

  it("no acting human (viewer lane): read-only rows and the reason once", async () => {
    agents = [{ id: "a1", alias: "forge", kind: "ai", status: "active" }];
    renderPage();
    await ready();
    await waitFor(() => expect(document.querySelector("#keysLocked")).toHaveTextContent(/Pick an acting human first/));
    expand("Anthropic");
    expect(within(panel("anthropic")).queryByText("Replace key")).toBeNull();
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
  });

  it("a runtime-catalog failure is a friendly line with Retry, never the raw error", async () => {
    modelsFail = true;
    renderPage();
    expect(await screen.findByText("Couldn't load the agent runtimes.")).toBeInTheDocument();
    expect(screen.queryByText(/boom|500/)).toBeNull();
    modelsFail = false;
    fireEvent.click(within(document.querySelector<HTMLElement>("#runtimeRows")!).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(row("codex")).not.toBeNull());
  });
});

describe("groupRuntimes", () => {
  it("groups by runtime in server order and marks the runtime hosting the default model", () => {
    const g = groupRuntimes(API_MODELS.models, "gpt-5.5");
    expect(g.map((x) => [x.runtime, x.models.length, x.isDefault])).toEqual([["claude", 2, false], ["codex", 1, true]]);
    expect(groupRuntimes([{ id: "x" }], null)[0].runtime).toBe("claude"); // absent runtime = the worker default
  });
});
