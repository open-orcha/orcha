/**
 * Settings — parity round 1 regressions:
 *  e2e-permissions-15 / MP-PERM-VIEWER  keys + models are read-only without manage_keys (reason said once)
 *  models-providers extra                error toasts carry the server detail, never "(403)"
 *  SET-009                               an untouched retired row never blocks a save
 *  EX-12                                 worktree switch locked without manage_autonomy (reason tooltip), no POST
 *  EX-14 / SG-12                         no project data → the failure named (not "Loading…" forever)
 *  SG-06                                 project status is a project status chip (Paused), not the task glyph
 *  SG-09                                 icon button disabled with the reason for a viewer; no picker
 *  DP-ERR-1                              pairing errors: friendly copy by status, Wi-Fi hint only for LAN reasons
 *  IF-RAIL-COLLAPSE                      sidebar storage copy says "account" when prefs sync is on
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { extensions, type Identity } from "../../extensions";
import { SnapshotProvider, type ActingAuthority } from "../../state/SnapshotProvider";
import type { Agent } from "../../types";
import { resetIdentity } from "../../cloud/identity";
import { SettingsPage, buildOverrides, projectLoadState, type Provider, type UseCase } from "./SettingsPage";
import { grantAuthority, SETTINGS_GRANT_REASON } from "./grantAuthority";
import { settingsErrText } from "./settingsUi";
import { sidebarStorageNote } from "./InterfaceSection";

interface Call { url: string; method: string; body: unknown }
let calls: Call[] = [];
type Route = (url: string, method: string, body: unknown) => { status: number; data: unknown } | null;

const HUMAN = { id: "h1", alias: "kedar", kind: "human", status: "active" };
const ORIG_IDENTITY = extensions.identity;
const ORIG_TRUSTED = extensions.identityTrusted;
const ORIG_ROUTES = extensions.routes;

function install(opts: { container?: Record<string, unknown> | null; snapStatus?: number; route?: Route } = {}) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const res = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
    const hit = opts.route ? opts.route(url, method, body) : null;
    if (hit) return res(hit.data, hit.status);
    if (url === "/api/containers") return res([{ id: "c1", status: "active" }]);
    if (url === "/api/containers/c1") {
      if (opts.snapStatus) return res({ detail: "nope" }, opts.snapStatus);
      return res({
        container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan", ...(opts.container || {}) },
        agents: [HUMAN], tasks: [], requests: [],
      });
    }
    if (url.endsWith("/settings/llm-key")) return res({ configured: true, masked: "sk-...abcd", source: "db" });
    if (url.endsWith("/settings/provider-keys")) return res({ keys: [] });
    if (url.endsWith("/settings/models")) return res({ use_cases: [{ key: "triage", label: "Wake triage", purpose: "p", default_provider: "anthropic", default_model: "m1", is_set: false }] });
    if (url.endsWith("/settings/providers")) return res({ providers: [{ id: "anthropic", name: "Anthropic", available: true, models: [{ id: "m1", name: "M1" }, { id: "m2", name: "M2" }] }] });
    if (url.startsWith("/api/me")) return res({ identity: null, trusted: false });
    if (url === "/api/prefs") return res({ prefs: null });
    return res({});
  }));
}

function asIdentity(id: Identity | null, trusted = true) {
  extensions.identity = async () => id;
  extensions.identityTrusted = () => trusted;
}

function renderAt(tab: string) {
  window.history.replaceState(null, "", window.location.pathname + "#tab=" + tab);
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter><SettingsPage /></MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

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
  extensions.routes = ORIG_ROUTES;
});

describe("pure helpers", () => {
  it("settingsErrText: the server detail, else words — never the URL or a bare code", () => {
    expect(settingsErrText(new Error("/api/containers/c1/settings/llm-key → 403: this action requires the owner role or the 'manage_keys' permission")))
      .toBe("this action requires the owner role or the 'manage_keys' permission");
    expect(settingsErrText(new Error("/api/containers/c1/settings/models → 422: [{\"type\":\"x\",\"msg\":\"model is retired\"}]"))).toBe("model is retired");
    expect(settingsErrText(new Error("/api/containers/c1/worktrees → 500"))).toBe("Embodent hit an error — try again");
    expect(settingsErrText(new Error("Failed to fetch"))).toBe("couldn't reach Embodent");
    expect(settingsErrText(new Error("/api/x → 403"))).not.toMatch(/\/api|403/);
  });

  it("grantAuthority: owner / grant holder may; member without the grant, viewer, nobody may not", () => {
    const h = HUMAN as unknown as Agent;
    const ok: ActingAuthority = { human: h, readOnly: false, pending: false, reason: null };
    expect(grantAuthority(ok, null, "manage_keys").can).toBe(true); // trust off
    expect(grantAuthority(ok, { member_role: "owner" }, "manage_keys").can).toBe(true);
    expect(grantAuthority(ok, { member_role: "member", grants: ["manage_keys"] }, "manage_keys").can).toBe(true);
    expect(grantAuthority(ok, { member_role: "member", grants: ["manage_keys"] }, "manage_autonomy"))
      .toMatchObject({ can: false, reason: SETTINGS_GRANT_REASON.manage_autonomy });
    const viewer: ActingAuthority = { human: null, readOnly: true, pending: false, reason: "Your role is viewer (read-only)" };
    expect(grantAuthority(viewer, { member_role: "viewer" }, "manage_keys")).toMatchObject({ can: false, reason: "Your role is viewer (read-only)" });
    expect(grantAuthority({ human: null, readOnly: false, pending: true, reason: "…" }, null, "manage_keys").pending).toBe(true);
  });

  it("SET-009 buildOverrides omits an untouched retired row (so the save isn't refused) but keeps a live override", () => {
    const catalog: Provider[] = [{ id: "anthropic", name: "Anthropic", available: true, models: [{ id: "m1", name: "M1" }, { id: "m2", name: "M2" }] }];
    const ucs: UseCase[] = [
      { key: "a", label: "A", purpose: "", default_provider: "anthropic", default_model: "m1", is_set: true, provider: "anthropic", model: "old-retired" },
      { key: "b", label: "B", purpose: "", default_provider: "anthropic", default_model: "m1", is_set: true, provider: "anthropic", model: "m2" },
    ];
    const out = buildOverrides({}, ucs, catalog);
    expect(out).toEqual([{ key: "b", provider: "anthropic", model: "m2" }]);
    // without a catalog (legacy callers) nothing changes
    expect(buildOverrides({}, ucs).map((r) => r.key)).toEqual(["a", "b"]);
  });

  it("projectLoadState names the snapshot failure", () => {
    expect(projectLoadState("/api/containers/c1 → 403")).toMatchObject({ text: "You're not a member of this project.", retry: false });
    expect(projectLoadState("/api/containers/c1 → 404").text).toBe("This project couldn't be found.");
    expect(projectLoadState("/api/containers/c1 → 503")).toMatchObject({ text: "Couldn't load this project.", retry: true });
    expect(projectLoadState("Failed to fetch")).toMatchObject({ text: "Can't reach Embodent.", retry: true });
    expect(projectLoadState(null).text).toBe("Loading project…");
  });

  it("sidebarStorageNote reflects account prefs", () => {
    expect(sidebarStorageNote(true)).toMatch(/saved to your account/);
    expect(sidebarStorageNote(false)).toBe("Saved in this browser");
  });
});

describe("Models & providers: manage_keys gate", () => {
  it("a member without manage_keys sees the keys + models read-only with ONE reason line", async () => {
    install();
    asIdentity({ agent_id: "h1", alias: "kedar", member_role: "member", grants: ["assign_reviewers"] });
    renderAt("provider-keys");
    await waitFor(() => expect(document.querySelector("#keysLocked")).toHaveTextContent(SETTINGS_GRANT_REASON.manage_keys));
    expect(document.querySelectorAll("#keysLocked").length).toBe(1);
    await screen.findByText("sk-...abcd");
    expect(screen.queryByPlaceholderText(/Paste a new key/)).toBeNull();
    expect(screen.queryByText("Remove")).toBeNull();
    await waitFor(() => expect(document.querySelector("select.uc-prov")).not.toBeNull());
    expect(document.querySelector("select.uc-prov")).toBeDisabled();
    expect(document.querySelector("select.uc-model")).toBeDisabled();
    expect(document.querySelector("#mdlSave")).toBeNull();
  });

  it("a viewer's reason is the viewer reason", async () => {
    install();
    asIdentity({ agent_id: "h1", alias: "kedar", member_role: "viewer", grants: [] });
    renderAt("provider-keys");
    await waitFor(() => expect(document.querySelector("#keysLocked")).toHaveTextContent("Your role is viewer (read-only)"));
  });

  it("a member WITH manage_keys can edit; a refused save toasts the server detail, not the status", async () => {
    install({ route: (url, method) => (url.endsWith("/settings/llm-key") && method === "PUT"
      ? { status: 503, data: { detail: "encrypted key storage is disabled: ORCHA_SECRET_KEY is not set" } } : null) });
    asIdentity({ agent_id: "h1", alias: "kedar", member_role: "member", grants: ["manage_keys"] });
    renderAt("provider-keys");
    const input = await screen.findByPlaceholderText("Paste a new key to replace…");
    expect(document.querySelector("#keysLocked")).toBeNull();
    fireEvent.change(input, { target: { value: "sk-ant-new-1234" } });
    fireEvent.click(screen.getByText("Replace key"));
    expect(await screen.findByText(/Couldn't save the key — encrypted key storage is disabled: ORCHA_SECRET_KEY is not set/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\(503\)/);
  });
});

describe("Execution", () => {
  it("EX-12: a member without manage_autonomy gets a locked switch with the reason and no POST", async () => {
    install();
    asIdentity({ agent_id: "h1", alias: "kedar", member_role: "member", grants: ["manage_keys"] });
    renderAt("execution");
    const sw = await screen.findByRole("switch", { name: "Isolated worktrees" });
    await waitFor(() => expect(sw).toHaveAttribute("aria-disabled", "true"));
    fireEvent.click(sw);
    expect(screen.queryByText("Turn off isolated worktrees?")).toBeNull();
    fireEvent.pointerEnter(sw);
    fireEvent.focus(sw);
    await waitFor(() => expect(screen.getByRole("tooltip")).toHaveTextContent(SETTINGS_GRANT_REASON.manage_autonomy));
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/worktrees"))).toBe(false);
  });

  it("EX-12: a refused toggle toasts the server detail", async () => {
    install({
      container: { worktrees_disabled: true },
      route: (url, method) => (url.endsWith("/worktrees") && method === "POST"
        ? { status: 403, data: { detail: "this action requires the owner role or the 'manage_autonomy' permission" } } : null),
    });
    renderAt("execution");
    const sw = await screen.findByRole("switch", { name: "Isolated worktrees" });
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "false"));
    await waitFor(() => expect(sw).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(sw);
    expect(await screen.findByText("Couldn't change worktree routing — this action requires the owner role or the 'manage_autonomy' permission.")).toBeInTheDocument();
  });

  it("EX-14: an unreachable project shows the failure + Retry, and no worktree switch", async () => {
    install({ snapStatus: 503 });
    renderAt("execution");
    await waitFor(() => expect(document.querySelector("#execLoad")).toHaveTextContent("Couldn't load this project."));
    expect(document.querySelector("#execLoad button")).toHaveTextContent("Retry");
    expect(screen.queryByRole("switch", { name: "Isolated worktrees" })).toBeNull();
    expect(document.querySelector("#setOpenExec")).toBeNull();
  });
});

describe("General", () => {
  it("SG-12: a non-member sees 'not a member', never an endless 'Loading project…'", async () => {
    install({ snapStatus: 403 });
    renderAt("general");
    await waitFor(() => expect(document.querySelector("#generalLoad")).toHaveTextContent("You're not a member of this project."));
    expect(document.querySelector("#generalLoad button")).toBeNull();
  });

  it("SG-06: a paused project reads 'Paused' (project status chip), not a task status", async () => {
    install({ container: { status: "paused" } });
    renderAt("general");
    const chip = await waitFor(() => {
      const el = document.querySelector(".set-proj-status");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(chip).toHaveTextContent("Paused");
    expect(chip.querySelector(".v2-tone-warn")).not.toBeNull();
  });

  it("SG-09: a viewer's Change icon… is disabled with the reason and opens no picker", async () => {
    install();
    asIdentity({ agent_id: "h1", alias: "kedar", member_role: "viewer", grants: [] });
    renderAt("general");
    const btn = await screen.findByRole("button", { name: /Change icon for Orcha/ });
    await waitFor(() => expect(btn).toHaveAttribute("aria-disabled", "true"));
    fireEvent.click(btn);
    expect(screen.queryByRole("dialog", { name: /Change icon/ })).toBeNull();
    fireEvent.pointerEnter(btn);
    fireEvent.focus(btn);
    await waitFor(() => expect(screen.getByRole("tooltip")).toHaveTextContent("Your role is viewer (read-only)"));
  });
});

describe("Devices & pairing (open build PairingCard) — DP-ERR-1", () => {
  it("a 403 is 'No access' with no Wi-Fi hint and no retry; raw text only under Details", async () => {
    install({ route: (url) => (url.startsWith("/api/containers/c1/pairing") ? { status: 403, data: { detail: "GitHub user 'x' is not a member" } } : null) });
    renderAt("pairing");
    expect(await screen.findByText("You don't have access to pair a phone for this project.")).toBeInTheDocument();
    expect(screen.queryByText(/Both devices must be on the same Wi-Fi/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Check again|Try again/ })).toBeNull();
    expect(document.querySelector(".pair-details code")).toHaveTextContent("GitHub user 'x' is not a member");
  });

  it("the structured 409 reachability warning keeps its title, the Wi-Fi hint (LAN reason) and Check again", async () => {
    install({ route: (url) => (url.startsWith("/api/containers/c1/pairing")
      ? { status: 409, data: { detail: { reachable: false, reason: "no_lan_address", title: "Phones can't reach this Embodent yet", message: "No LAN address." } } } : null) });
    renderAt("pairing");
    expect(await screen.findByText("Phones can't reach this Embodent yet")).toBeInTheDocument();
    expect(screen.getByText(/Both devices must be on the same Wi-Fi/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Check again/ })).toBeInTheDocument();
  });

  it("a 500 is 'Couldn't load the pairing code' + Try again, not the reachability title", async () => {
    install({ route: (url) => (url.startsWith("/api/containers/c1/pairing") ? { status: 500, data: { detail: "Not implemented in mock" } } : null) });
    renderAt("pairing");
    expect(await screen.findByText("Couldn't load the pairing code")).toBeInTheDocument();
    expect(screen.queryByText("Phones can't reach this Embodent yet")).toBeNull();
    expect(screen.getByRole("button", { name: /Try again/ })).toBeInTheDocument();
  });
});
