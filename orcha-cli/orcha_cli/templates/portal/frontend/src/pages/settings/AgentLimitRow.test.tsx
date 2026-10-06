/**
 * Settings → Execution › Agent limit (mig 056): the row reads the snapshot's
 * max_auto_agents + auto_agents_in_use, the stepper PUTs /limits for an owner /
 * manage_agents holder, and a viewer (or member without manage_agents) gets it
 * disabled with the reason and never writes.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { extensions, type Identity } from "../../extensions";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { resetIdentity } from "../../cloud/identity";
import { SettingsPage } from "./SettingsPage";
import { SETTINGS_GRANT_REASON } from "./grantAuthority";
import { agentLimitDesc } from "./AgentLimitRow";

interface Call { url: string; method: string; body: unknown }
let calls: Call[] = [];
let limit = 3;
const HUMAN = { id: "h1", alias: "kedar", kind: "human", status: "active" };
const ORIG_IDENTITY = extensions.identity;
const ORIG_TRUSTED = extensions.identityTrusted;

function install(putStatus = 200) {
  calls = [];
  limit = 3;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const res = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
    if (url === "/api/containers") return res([{ id: "c1", status: "active" }]);
    if (url === "/api/containers/c1/limits" && method === "PUT") {
      if (putStatus !== 200) return res({ detail: "this action requires the owner role or the 'manage_agents' permission" }, putStatus);
      limit = (body as { max_auto_agents: number }).max_auto_agents;
      return res({ container_id: "c1", max_auto_agents: limit, auto_agents_in_use: 3 });
    }
    if (url === "/api/containers/c1") {
      return res({
        container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan", max_auto_agents: limit, auto_agents_in_use: 3 },
        agents: [HUMAN], tasks: [], requests: [],
      });
    }
    if (url.startsWith("/api/me")) return res({ identity: null, trusted: false });
    if (url === "/api/prefs") return res({ prefs: null });
    return res({});
  }));
}

function asIdentity(id: Identity | null, trusted = true) {
  extensions.identity = async () => id;
  extensions.identityTrusted = () => trusted;
}

function renderExecution() {
  window.history.replaceState(null, "", window.location.pathname + "#tab=execution");
  return render(
    <ToastProvider><SnapshotProvider><MemoryRouter><SettingsPage /></MemoryRouter></SnapshotProvider></ToastProvider>,
  );
}

const input = () => screen.findByRole("spinbutton", { name: "Agent limit" }) as Promise<HTMLInputElement>;

beforeEach(() => {
  delete extensions.settingsSections;
  delete extensions.settingsGeneral;
  localStorage.clear();
  resetIdentity();
  extensions.identity = undefined;
  extensions.identityTrusted = undefined;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  extensions.identity = ORIG_IDENTITY;
  extensions.identityTrusted = ORIG_TRUSTED;
});

describe("Settings → Execution › Agent limit", () => {
  it("agentLimitDesc says what it is and how many are in use", () => {
    expect(agentLimitDesc(3)).toBe("Suggested agents that can be created in this project — 3 in use");
    expect(agentLimitDesc(undefined)).toBe("Suggested agents that can be created in this project");
  });

  it("an owner steps the limit up and saves it with one PUT", async () => {
    install();
    asIdentity({ agent_id: "h1", alias: "kedar", member_role: "owner", grants: [] });
    renderExecution();
    const n = await input();
    await waitFor(() => expect(n.value).toBe("3"));
    expect(screen.getByText("Suggested agents that can be created in this project — 3 in use")).toBeInTheDocument();
    await waitFor(() => expect(n.disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Increase agent limit" }));
    fireEvent.click(screen.getByRole("button", { name: "Increase agent limit" }));
    expect(n.value).toBe("5");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toEqual([
      { url: "/api/containers/c1/limits", method: "PUT", body: { max_auto_agents: 5, actor_agent_id: "h1" } },
    ]));
    expect(await screen.findByText("Agent limit set to 5.")).toBeInTheDocument();
  });

  it("out-of-range input is flagged and never saved", async () => {
    install();
    renderExecution(); // trust off: any acting human may act, as the server allows
    const n = await input();
    await waitFor(() => expect(n.disabled).toBe(false));
    fireEvent.change(n, { target: { value: "51" } });
    expect(n).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByText(/Enter a whole number from 1 to 50/)).toBeInTheDocument();
  });

  it("a viewer sees it read-only with the reason, and nothing is written", async () => {
    install();
    asIdentity({ agent_id: "h1", alias: "kedar", member_role: "viewer", grants: [] });
    renderExecution();
    const n = await input();
    await waitFor(() => expect(n.disabled).toBe(true));
    expect((screen.getByRole("button", { name: "Increase agent limit" }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(screen.getByTestId("agent-limit-reason")).toHaveTextContent("Your role is viewer (read-only)"));
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("a member without manage_agents gets the grant reason", async () => {
    install();
    asIdentity({ agent_id: "h1", alias: "kedar", member_role: "member", grants: ["manage_autonomy"] });
    renderExecution();
    const n = await input();
    await waitFor(() => expect(n.disabled).toBe(true));
    await waitFor(() => expect(screen.getByTestId("agent-limit-reason")).toHaveTextContent(SETTINGS_GRANT_REASON.manage_agents));
  });

  it("a refused save toasts the server's words, never the status", async () => {
    install(403);
    renderExecution();
    const n = await input();
    await waitFor(() => expect(n.disabled).toBe(false));
    fireEvent.change(n, { target: { value: "8" } });
    await act(async () => { fireEvent.keyDown(n, { key: "Enter" }); });
    expect(await screen.findByText("Couldn't change the agent limit — this action requires the owner role or the 'manage_agents' permission.")).toBeInTheDocument();
  });
});
