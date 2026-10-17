/**
 * SettingsPage tests — fetch is stubbed (jsdom has no EventSource; the
 * SnapshotProvider tolerates that), rendering goes through the real
 * ToastProvider + SnapshotProvider so the page reads cid/acting-human exactly
 * as it does in production.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { extensions } from "../../extensions";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import {
  buildOverrides,
  currentSel,
  isOverride,
  keyState,
  looksLikeKey,
  maskOptimistic,
  rowDirty,
  SettingsPage,
  type UseCase,
} from "./SettingsPage";

/* ---- fetch stub ----------------------------------------------------------- */
interface Call {
  url: string;
  method: string;
  body: unknown;
}
let calls: Call[] = [];
let keyStatus: Record<string, unknown> = { configured: true, masked: "sk-...abcd", source: "db" };
let rawAgents: unknown[] = [];

function installFetch() {
  calls = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init && init.method) || "GET";
    const body = init && init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const json = (data: unknown) =>
      ({ ok: true, status: 200, json: async () => data }) as unknown as Response;

    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    if (url === "/api/containers/c1")
      return json({
        container: {
          id: "c1",
          name: "Orcha",
          autonomy_level: "plan",
        },
        agents: rawAgents,
        tasks: [],
        requests: [],
      });
    if (url.endsWith("/settings/llm-key") && method === "GET") return json(keyStatus);
    if (url.endsWith("/settings/llm-key") && method === "PUT")
      return json({ configured: true, masked: "sk-...9999" });
    if (url.endsWith("/settings/models") && method === "GET") return json({ use_cases: [] });
    if (url.endsWith("/settings/providers")) return json({ providers: [] });
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
  // downstream-proof: a distribution's extensions.ts populates the registry
  // at import time — reset so these tests always exercise the OPEN layout.
  delete extensions.settingsSections;
  delete extensions.settingsGeneral;
  localStorage.clear();
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/* ---- rendering ------------------------------------------------------------ */
describe("SettingsPage key card", () => {
  it("renders the configured-key banner and masked key from the GET", async () => {
    keyStatus = { configured: true, masked: "sk-...abcd", source: "db" };
    rawAgents = [{ id: "h1", alias: "kedar", kind: "human", status: "active" }];
    renderPage();
    await waitFor(() => expect(calls.some((c) => c.url === "/api/containers/c1")).toBe(true));
    await waitFor(() => expect(screen.getByText("(Anthropic API key)")).toBeInTheDocument());
    expect(screen.getByText("sk-...abcd")).toBeInTheDocument();
    // db mode → editable with a Replace affordance + Remove
    expect(screen.getByText("Replace key")).toBeInTheDocument();
    expect(screen.getByText("Remove")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Paste a new key to replace…")).toBeInTheDocument();
  });

  it("renders the warn banner when no key is configured", async () => {
    keyStatus = { configured: false, masked: null, source: null };
    rawAgents = [{ id: "h1", alias: "kedar", kind: "human", status: "active" }];
    renderPage();
    await waitFor(() => expect(screen.getByText("(No Anthropic API key)")).toBeInTheDocument());
    expect(await screen.findByText("Save key")).toBeInTheDocument();
    expect(screen.queryByText("Remove")).not.toBeInTheDocument();
  });

  it("renders read-only with the reason when there is no acting human (PR #315 gate)", async () => {
    keyStatus = { configured: true, masked: "sk-...abcd", source: "db" };
    rawAgents = [{ id: "a1", alias: "forge", kind: "ai", status: "active" }]; // no human registered
    renderPage();
    await waitFor(() => expect(screen.getByText("(Anthropic API key)")).toBeInTheDocument());
    // the status still shows; no field / Replace / Remove to press, and the
    // reason is said once for the section
    await waitFor(() => expect(document.querySelector("#keysLocked")).toHaveTextContent(/Pick an acting human first/));
    expect(screen.queryByPlaceholderText("Paste a new key to replace…")).toBeNull();
    expect(screen.queryByText("Replace key")).toBeNull();
    expect(screen.queryByText("Remove")).toBeNull();
    expect(calls.some((c) => c.method === "PUT" && c.url.endsWith("/settings/llm-key"))).toBe(false);
  });

  it("sends the acting human's id with the PUT when one exists", async () => {
    keyStatus = { configured: true, masked: "sk-...abcd", source: "db" };
    rawAgents = [
      { id: "a1", alias: "forge", kind: "ai", status: "active" },
      { id: "h1", alias: "kedar", kind: "human", status: "active" },
    ];
    renderPage();
    await waitFor(() => expect(screen.getByText("(Anthropic API key)")).toBeInTheDocument());
    // the snapshot (and thus the acting human) must have arrived before mutating
    await waitFor(() => expect(calls.some((c) => c.url === "/api/containers/c1")).toBe(true));

    fireEvent.change(screen.getByPlaceholderText("Paste a new key to replace…"), {
      target: { value: "sk-ant-test-1234" },
    });
    fireEvent.click(screen.getByText("Replace key"));

    await waitFor(() => {
      const put = calls.find((c) => c.method === "PUT" && c.url.endsWith("/settings/llm-key"));
      expect(put).toBeTruthy();
      expect((put!.body as { actor_agent_id: string }).actor_agent_id).toBe("h1");
      expect((put!.body as { api_key: string }).api_key).toBe("sk-ant-test-1234");
    });
    await waitFor(() => expect(screen.getByText("API key saved.")).toBeInTheDocument());
  });

  it("env-sourced keys are read-only: Test only, no Save/Remove", async () => {
    keyStatus = { configured: true, masked: "sk-...envk", source: "env" };
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/from the environment/)).toBeInTheDocument(),
    );
    // the key controls live in the Anthropic row's expand panel (image-33 rows)
    fireEvent.click(screen.getByRole("button", { name: "Show Anthropic settings" }));
    expect(screen.getByText("Test stored key")).toBeInTheDocument();
    expect(screen.queryByText("Save key")).not.toBeInTheDocument();
    expect(screen.queryByText("Replace key")).not.toBeInTheDocument();
    expect(screen.queryByText("Remove")).not.toBeInTheDocument();
    // D12 (review r2): how to change the env key is a tooltip beside Test,
    // not a boilerplate sentence under the status line
    expect(screen.queryByText(/To change it, update/)).toBeNull();
    const help = screen.getByRole("button", { name: "About changing the environment key" });
    expect(help.closest(".sc-acts")).toContainElement(screen.getByText("Test stored key"));
  });
});

/* ---- pure view-model helpers (OrchaSettings parity) ----------------------- */
describe("settings view-model helpers", () => {
  it("keyState maps the three sources", () => {
    expect(keyState({ source: "db", masked: "sk-...1" })).toMatchObject({
      mode: "db", configured: true, editable: true, canClear: true,
    });
    expect(keyState({ source: "env", masked: "sk-...2" })).toMatchObject({
      mode: "env", configured: true, editable: false, canClear: false,
    });
    expect(keyState({ source: null, configured: false })).toMatchObject({
      mode: "none", configured: false, editable: true, canClear: false,
    });
  });

  it("looksLikeKey nudges only on non-Anthropic shapes; maskOptimistic mirrors sk-...tail", () => {
    expect(looksLikeKey("sk-ant-abc123")).toBe(true);
    expect(looksLikeKey("hunter2")).toBe(false);
    expect(maskOptimistic("sk-ant-abcd1234")).toBe("sk-...1234");
    expect(maskOptimistic("xy")).toBe(null);
  });

  it("override/dirty/buildOverrides follow the staged-vs-default contract", () => {
    const uc: UseCase = {
      key: "triage", label: "Wake triage", purpose: "p",
      default_provider: "anthropic", default_model: "haiku",
      provider: "anthropic", model: "sonnet", is_set: true,
    };
    expect(currentSel(uc)).toEqual({ provider: "anthropic", model: "sonnet" });
    expect(isOverride({ provider: "anthropic", model: "sonnet" }, uc)).toBe(true);
    expect(isOverride({ provider: "anthropic", model: "haiku" }, uc)).toBe(false);
    expect(rowDirty({ provider: "anthropic", model: "sonnet" }, uc)).toBe(false);
    expect(rowDirty({ provider: "anthropic", model: "opus" }, uc)).toBe(true);
    // default-valued rows are omitted from the PUT (⇒ reset), overridden rows sent
    expect(buildOverrides({ triage: { provider: "anthropic", model: "haiku" } }, [uc])).toEqual([]);
    expect(buildOverrides({ triage: { provider: "anthropic", model: "opus" } }, [uc])).toEqual([
      { key: "triage", provider: "anthropic", model: "opus" },
    ]);
  });
});
