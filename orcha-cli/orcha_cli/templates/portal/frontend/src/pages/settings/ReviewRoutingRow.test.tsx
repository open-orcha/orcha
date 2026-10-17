/**
 * Settings → Execution › Review (mig 057): "Finished work goes to" (manager chain /
 * project owner / anyone) + "AI managers pre-review". An owner / assign_reviewers
 * holder PUTs /review-routing; a viewer or a member without the grant sees the
 * reason and never writes; an older backend (no review_route) shows nothing.
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
import { reviewRouteDesc } from "./ReviewRoutingRow";

interface Call { url: string; method: string; body: unknown }
let calls: Call[] = [];
let state: { review_route?: string; ai_manager_prereview?: boolean } = {};
const AGENTS = [
  { id: "h1", alias: "kedar", kind: "human", status: "active" },
  { id: "a1", alias: "atlas", kind: "ai", status: "idle", reports_to: "h1" },
];
const ORIG_IDENTITY = extensions.identity;
const ORIG_TRUSTED = extensions.identityTrusted;

function install(initial: typeof state = { review_route: "manager_chain", ai_manager_prereview: true }) {
  calls = [];
  state = { ...initial };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const res = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
    if (url === "/api/containers") return res([{ id: "c1", status: "active" }]);
    if (url === "/api/containers/c1/review-routing" && method === "PUT") {
      state = { ...state, ...Object.fromEntries(Object.entries(body as object).filter(([k]) => k !== "actor_agent_id")) };
      return res({ container_id: "c1", ...state, reporting_lines: 1, reviewers: [] });
    }
    if (url === "/api/containers/c1") {
      return res({
        container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan", ...state },
        agents: AGENTS, tasks: [], requests: [],
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

const radio = (name: string) => screen.findByRole("radio", { name }) as Promise<HTMLButtonElement>;

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

describe("Settings → Execution › Review", () => {
  it("reviewRouteDesc explains each choice", () => {
    expect(reviewRouteDesc("manager_chain", 2)).toMatch(/nearest human manager on the org chart verifies/);
    expect(reviewRouteDesc("manager_chain", 0)).toMatch(/set reporting lines on the Org chart/);
    expect(reviewRouteDesc("owner", 0)).toBe("The project owner verifies all finished work.");
    expect(reviewRouteDesc("anyone", 0)).toMatch(/any member may verify/);
  });

  it("an owner switches finished work to the project owner, then turns pre-review off", async () => {
    install();
    asIdentity({ agent_id: "h1", alias: "kedar", member_role: "owner", grants: [] });
    renderExecution();
    const chain = await radio("Manager chain");
    expect(chain).toHaveAttribute("aria-checked", "true");
    const owner = await radio("Project owner");
    await waitFor(() => expect(owner.disabled).toBe(false));
    await act(async () => { fireEvent.click(owner); });
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toEqual([
      { url: "/api/containers/c1/review-routing", method: "PUT", body: { review_route: "owner", actor_agent_id: "h1" } },
    ]));
    expect(await screen.findByText("Finished work now goes to: Project owner.")).toBeInTheDocument();
    const sw = screen.getByRole("switch", { name: "AI managers pre-review" });
    expect(sw).toHaveAttribute("aria-checked", "true");
    await act(async () => { fireEvent.click(sw); });
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT")[1]?.body).toEqual({ ai_manager_prereview: false, actor_agent_id: "h1" }));
  });

  it("a viewer sees it read-only with the reason, and nothing is written", async () => {
    install();
    asIdentity({ agent_id: "h1", alias: "kedar", member_role: "viewer", grants: [] });
    renderExecution();
    const owner = await radio("Project owner");
    await waitFor(() => expect(owner.disabled).toBe(true));
    await waitFor(() => expect(screen.getByTestId("review-route-reason")).toHaveTextContent("Your role is viewer (read-only)"));
    fireEvent.click(screen.getByRole("switch", { name: "AI managers pre-review" }));
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("a member without assign_reviewers gets the grant reason", async () => {
    install();
    asIdentity({ agent_id: "h1", alias: "kedar", member_role: "member", grants: ["manage_agents"] });
    renderExecution();
    await radio("Project owner");
    await waitFor(() => expect(screen.getByTestId("review-route-reason")).toHaveTextContent(SETTINGS_GRANT_REASON.assign_reviewers));
  });

  it("an older backend without the setting shows nothing", async () => {
    install({});
    renderExecution();
    await screen.findByRole("spinbutton", { name: "Agent limit" }).catch(() => null);
    expect(screen.queryByRole("radio", { name: "Manager chain" })).toBeNull();
  });
});
