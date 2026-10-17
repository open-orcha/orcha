/**
 * Settings → General › Template: export (owner / manage_agents only, download + what
 * was scrubbed), import into this project (preview → collision choice → confirm with
 * the preview digest), import into a NEW project (virtual preview → create → real
 * preview → import; a differing real plan is shown again instead of importing), and the
 * template library (list / add / delete; read-only without the grant).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../../components/ui";
import { extensions, type Identity } from "../../../extensions";
import { SnapshotProvider } from "../../../state/SnapshotProvider";
import { resetIdentity } from "../../../cloud/identity";
import { SettingsPage } from "../SettingsPage";
import { SETTINGS_GRANT_REASON } from "../grantAuthority";

interface Call { url: string; method: string; body: any }
let calls: Call[] = [];
const HUMAN = { id: "h1", alias: "kedar", kind: "human", status: "active" };
const ORIG_IDENTITY = extensions.identity;
const ORIG_TRUSTED = extensions.identityTrusted;

const BUNDLE = {
  format: "orcha.project-template", version: 1, exported_at: "2026-09-29T08:00:00Z",
  source: { project_name: "orcha-web" },
  roster: [{ alias: "Atlas", system_prompt: "You lead. Ask [member] before merging." }, { alias: "Forge", system_prompt: "Backend." }], routines: [{ title: "Audit" }], dod_presets: [], skills: [],
  scrub: { redactions: [{ field: "roster[Atlas].system_prompt", kinds: ["secret"] }], never_exported: [] },
  digest: "sha256:abc",
};

function plan(opts: any = {}, over: any = {}) {
  const forge = opts.collisions?.Forge;
  const renamed = forge?.action === "rename";
  const forgeItem = {
    alias: "Forge", final_alias: renamed ? (forge.rename_to || "Forge-2") : "Forge",
    action: renamed ? "rename" : "skip", collision: true, suggested_alias: "Forge-2",
    notes: renamed ? [] : ["'Forge' already exists here — kept as is"], role: "backend", model: "gpt-5.6-sol",
  };
  const roster = [
    { alias: "Atlas", final_alias: "Atlas", action: "create", collision: false, suggested_alias: null, notes: [], role: "lead", model: "claude-opus-5" },
    forgeItem,
  ];
  const create = 1 + (renamed ? 1 : 0);
  return {
    bundle: { format: "orcha.project-template", version: 1, project_name: "orcha-web", exported_at: "2026-09-29T08:00:00Z",
      digest_ok: true, has_budgets: false, counts: { roster: 2, routines: 1, dod_presets: 0, skills: 0, budgets: 0 } },
    sections: {
      roster, reporting_lines: [],
      routines: [{ title: "Audit", action: "create", assignee: null, enabled: !!opts.enable_routines, cron: "0 9 * * 1", timezone: "UTC", notes: ["imported paused — turn it on when ready"] }],
      dod_presets: [], skills: [], budgets: [],
    },
    included: { roster: true, routines: true, dod_presets: true, skills: true, budgets: false },
    counts: { roster: { create, skip: 2 - create }, reporting_lines: { create: 0, skip: 0 }, routines: { create: 1, skip: 0 },
      dod_presets: { create: 0, skip: 0 }, skills: { create: 0, skip: 0 }, budgets: { create: 0, skip: 0 } },
    errors: [], warnings: [], changes: create + 1, human_seat_lines: 0,
    preview_digest: "sha256:plan-" + (renamed ? "rename" : "skip"),
    ...over,
  };
}

let realPlanOverride: any = null;
let createProjectFail: string | null = null;
let libItems: any[] = [];

function install() {
  calls = [];
  libItems = [{ id: "p1", name: "Web feature done", body: "Tests pass", source: "manual", updated_at: "2026-09-29T08:00:00Z" }];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const res = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
    if (url === "/api/containers" && method === "GET") return res([{ id: "c1", status: "active" }]);
    if (url === "/api/containers" && method === "POST" && createProjectFail) return res({ detail: createProjectFail }, 409);
    if (url === "/api/containers" && method === "POST") return res({ container_id: "c2", root_task_id: "r2", name: body.name, human_agent_id: "h2" }, 201);
    if (url === "/api/containers/c1") {
      return res({ container: { id: "c1", name: "Orcha", status: "active" }, agents: [HUMAN], tasks: [], requests: [] });
    }
    if (url === "/api/containers/c1/template/export") return res(BUNDLE);
    if (url === "/api/containers/c1/template/preview") return res(plan(body.options));
    if (url === "/api/template/preview-new") return res(plan(body.options, { preview_digest: null, target: "new" }));
    if (url === "/api/containers/c2/template/preview") return res(realPlanOverride || plan(body.options, { preview_digest: "sha256:real" }));
    if (url.endsWith("/template/import")) {
      return res({ applied: {}, agents: [{ alias: "Atlas", agent_id: "a1", from_alias: "Atlas" }],
        routines: [{ routine_id: "r1", title: "Audit", enabled: false }], dod_presets: [], skills: [], budgets: [], reporting_lines: [] });
    }
    if (url === "/api/containers/c1/dod-presets" && method === "GET") return res({ items: libItems });
    if (url === "/api/containers/c1/dod-presets" && method === "POST") {
      const it = { id: "p2", name: body.name, body: body.body, source: "manual", updated_at: "2026-09-29T09:00:00Z" };
      libItems = [...libItems, it];
      return res(it, 201);
    }
    if (url.startsWith("/api/dod-presets/p1") && method === "DELETE") { libItems = libItems.filter((x) => x.id !== "p1"); return res({ deleted: true }); }
    if (url === "/api/containers/c1/skills") return res({ items: [] });
    if (url.startsWith("/api/me")) return res({ identity: null, trusted: false });
    if (url === "/api/prefs") return res({ prefs: null });
    if (url === "/api/models") return res({ models: [{ id: "claude-opus-5", name: "Opus 5" }, { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" }] });
    return res({});
  }));
}

function asIdentity(id: Identity | null, trusted = true) {
  extensions.identity = async () => id;
  extensions.identityTrusted = () => trusted;
}

function renderGeneral() {
  window.history.replaceState(null, "", window.location.pathname + "#tab=general");
  return render(<ToastProvider><SnapshotProvider><MemoryRouter><SettingsPage /></MemoryRouter></SnapshotProvider></ToastProvider>);
}

const owner = () => asIdentity({ agent_id: "h1", alias: "kedar", member_role: "owner", grants: [] });
const byUrl = (u: string, m = "POST") => calls.filter((c) => c.url === u && c.method === m);

async function pickFile(dialog: HTMLElement, content: unknown = BUNDLE) {
  const input = within(dialog).getByLabelText("Template file") as HTMLInputElement;
  const file = new File([typeof content === "string" ? content : JSON.stringify(content)], "orcha-web-template.json", { type: "application/json" });
  await act(async () => { fireEvent.change(input, { target: { files: [file] } }); });
}

beforeEach(() => {
  delete extensions.settingsSections;
  delete extensions.settingsGeneral;
  localStorage.clear();
  resetIdentity();
  extensions.identity = undefined;
  extensions.identityTrusted = undefined;
  realPlanOverride = null;
  createProjectFail = null;
  (URL as any).createObjectURL = vi.fn(() => "blob:x");
  (URL as any).revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {}); // jsdom can't navigate to a blob
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  extensions.identity = ORIG_IDENTITY;
  extensions.identityTrusted = ORIG_TRUSTED;
});

describe("Settings → General › Template", () => {
  it("an owner exports with the acting human and sees what was scrubbed", async () => {
    install();
    owner();
    renderGeneral();
    const btn = await screen.findByRole("button", { name: "Export…" });
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(screen.getByLabelText("Include budgets"));
    await act(async () => { fireEvent.click(btn); });
    await waitFor(() => expect(byUrl("/api/containers/c1/template/export")).toHaveLength(1));
    expect(byUrl("/api/containers/c1/template/export")[0].body).toEqual({ actor_agent_id: "h1", include_budgets: true });
    expect(await screen.findByText(/Exported orcha-template-\d{4}-\d\d-\d\d\.json — 2 agents · 1 routine · 1 field scrubbed\./)).toBeTruthy();
    expect((URL as any).createObjectURL).toHaveBeenCalled();
  });

  it("a member without manage_agents can't export, and can only import into a new project", async () => {
    install();
    asIdentity({ agent_id: "h1", alias: "kedar", member_role: "member", grants: [] });
    renderGeneral();
    const btn = await screen.findByRole("button", { name: "Export…" });
    await waitFor(() => expect(btn).toBeDisabled());
    expect(screen.getByTestId("pt-export-reason").textContent).toBe(SETTINGS_GRANT_REASON.manage_agents);
    fireEvent.click(btn);
    expect(byUrl("/api/containers/c1/template/export")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Import…" }));
    const dialog = await screen.findByRole("dialog", { name: "Import template" });
    await pickFile(dialog);
    const here = await within(dialog).findByRole("radio", { name: "Orcha" });
    expect(here).toBeDisabled();
    expect(within(dialog).getByRole("radio", { name: "A new project" })).toHaveAttribute("aria-checked", "true");
    expect(within(dialog).getByLabelText(SETTINGS_GRANT_REASON.manage_agents)).toBeTruthy();
    await waitFor(() => expect(byUrl("/api/template/preview-new")).toHaveLength(1));
    expect(byUrl("/api/containers/c1/template/preview")).toHaveLength(0);
  });

  it("imports into this project: preview, rename a collision, confirm with the digest", async () => {
    install();
    owner();
    renderGeneral();
    fireEvent.click(await screen.findByRole("button", { name: "Import…" }));
    const dialog = await screen.findByRole("dialog", { name: "Import template" });
    await pickFile(dialog);
    await within(dialog).findByText("orcha-web");
    await waitFor(() => expect(byUrl("/api/containers/c1/template/preview").length).toBeGreaterThan(0));
    expect(byUrl("/api/containers/c1/template/preview")[0].body.actor_agent_id).toBe("h1");
    // Forge collides: kept by default; switch to "Import as…" with the suggested name
    const seg = within(dialog).getByRole("radiogroup", { name: "Forge already exists here" });
    expect(within(seg).getByRole("radio", { name: "Keep existing" })).toHaveAttribute("aria-checked", "true");
    expect(within(dialog).getByText("GPT-5.6 Sol", { exact: false })).toBeTruthy();
    // the prompt the file carries is reviewable before import (created agents only)
    expect(within(dialog).getByText("You lead. Ask [member] before merging.")).toBeTruthy();
    expect(within(dialog).queryByText("Backend.")).toBeNull();
    fireEvent.click(within(seg).getByRole("radio", { name: "Import as…" }));
    const rename = within(dialog).getByLabelText("New name for Forge") as HTMLInputElement;
    expect(rename.value).toBe("Forge-2");
    fireEvent.change(rename, { target: { value: "Forge-eu" } });
    await waitFor(() => {
      const last = byUrl("/api/containers/c1/template/preview").at(-1)!;
      expect(last.body.options.collisions.Forge).toEqual({ action: "rename", rename_to: "Forge-eu" });
    });
    const go = await within(dialog).findByRole("button", { name: "Import 3 changes" });
    await waitFor(() => expect(go).not.toBeDisabled());
    await act(async () => { fireEvent.click(go); });
    await waitFor(() => expect(byUrl("/api/containers/c1/template/import")).toHaveLength(1));
    const imp = byUrl("/api/containers/c1/template/import")[0].body;
    expect(imp.confirm).toBe(true);
    expect(imp.preview_digest).toBe("sha256:plan-rename");
    expect(imp.options.collisions.Forge.rename_to).toBe("Forge-eu");
    expect(await within(dialog).findByText("Imported 1 agent, 1 routine (paused).")).toBeTruthy();
  });

  it("rejects a file that isn't a template without calling the server", async () => {
    install();
    owner();
    renderGeneral();
    fireEvent.click(await screen.findByRole("button", { name: "Import…" }));
    const dialog = await screen.findByRole("dialog", { name: "Import template" });
    await pickFile(dialog, { hello: "world" });
    expect(await within(dialog).findByText("This file isn't a Embodent project template.")).toBeTruthy();
    expect(calls.filter((c) => c.url.includes("template/preview"))).toHaveLength(0);
  });

  it("imports into a new project: virtual preview, then create + real preview + import", async () => {
    install();
    owner();
    renderGeneral();
    fireEvent.click(await screen.findByRole("button", { name: "Import…" }));
    const dialog = await screen.findByRole("dialog", { name: "Import template" });
    await pickFile(dialog);
    fireEvent.click(await within(dialog).findByRole("radio", { name: "A new project" }));
    const name = within(dialog).getByLabelText("Project name") as HTMLInputElement;
    expect(name.value).toBe("orcha-web copy");
    fireEvent.change(name, { target: { value: "Client B" } });
    await waitFor(() => expect(byUrl("/api/template/preview-new").length).toBeGreaterThan(0));
    const go = await within(dialog).findByRole("button", { name: /Create project and import 2 changes/ });
    await waitFor(() => expect(go).not.toBeDisabled());
    await act(async () => { fireEvent.click(go); });
    await waitFor(() => expect(byUrl("/api/containers/c2/template/import")).toHaveLength(1));
    expect(byUrl("/api/containers")[0].body).toEqual({ name: "Client B", additional: true });
    expect(byUrl("/api/containers/c2/template/preview")[0].body.actor_agent_id).toBe("h2");
    const imp = byUrl("/api/containers/c2/template/import")[0].body;
    expect(imp.preview_digest).toBe("sha256:real");
    expect(imp.actor_agent_id).toBe("h2");
    expect(await within(dialog).findByRole("button", { name: "Open Client B" })).toBeTruthy();
    expect(byUrl("/api/containers/c1/template/import")).toHaveLength(0);
  });

  it("a new project whose real plan differs is shown again instead of importing", async () => {
    install();
    owner();
    realPlanOverride = plan({}, { preview_digest: "sha256:real2", counts: { ...plan().counts, roster: { create: 0, skip: 2 } } });
    renderGeneral();
    fireEvent.click(await screen.findByRole("button", { name: "Import…" }));
    const dialog = await screen.findByRole("dialog", { name: "Import template" });
    await pickFile(dialog);
    fireEvent.click(await within(dialog).findByRole("radio", { name: "A new project" }));
    const go = await within(dialog).findByRole("button", { name: /Create project and import/ });
    await waitFor(() => expect(go).not.toBeDisabled());
    await act(async () => { fireEvent.click(go); });
    expect(await within(dialog).findByText(/was created\. Its plan differs slightly/)).toBeTruthy();
    expect(calls.filter((c) => c.url.endsWith("/template/import"))).toHaveLength(0);
    expect(within(dialog).getByText("orcha-web copy (new)")).toBeTruthy();
  });

  it("the template library lists, adds and deletes presets", async () => {
    install();
    owner();
    renderGeneral();
    expect(await screen.findByText("1 DoD preset · 0 skills")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Manage…" }));
    const dialog = await screen.findByRole("dialog", { name: "Template library" });
    expect(await within(dialog).findByText("Web feature done")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "New preset" }));
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Doc reviewed" } });
    fireEvent.change(within(dialog).getByLabelText("Definition of done"), { target: { value: "Two approvals" } });
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Add preset" })); });
    await waitFor(() => expect(byUrl("/api/containers/c1/dod-presets")).toHaveLength(1));
    expect(byUrl("/api/containers/c1/dod-presets")[0].body).toEqual({ actor_agent_id: "h1", name: "Doc reviewed", body: "Two approvals" });
    expect(await within(dialog).findByText("Doc reviewed")).toBeTruthy();
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Delete Web feature done" })); });
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/dod-presets/p1?actor_agent_id=h1")).toBe(true));
  });

  it("the library is read-only without manage_agents", async () => {
    install();
    asIdentity({ agent_id: "h1", alias: "kedar", member_role: "member", grants: [] });
    renderGeneral();
    fireEvent.click(await screen.findByRole("button", { name: "Manage…" }));
    const dialog = await screen.findByRole("dialog", { name: "Template library" });
    expect(await within(dialog).findByText("Web feature done")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "New preset" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Delete Web feature done" })).toBeNull();
    expect(within(dialog).getByText(SETTINGS_GRANT_REASON.manage_agents)).toBeTruthy();
  });

  it("a taken new-project name says so — not 'this project changed while you were reviewing' (QA portdeliv)", async () => {
    install();
    owner();
    createProjectFail = "a project named 'Client B' already exists in this stack";
    renderGeneral();
    fireEvent.click(await screen.findByRole("button", { name: "Import…" }));
    const dialog = await screen.findByRole("dialog", { name: "Import template" });
    await pickFile(dialog);
    fireEvent.click(await within(dialog).findByRole("radio", { name: "A new project" }));
    fireEvent.change(within(dialog).getByLabelText("Project name"), { target: { value: "Client B" } });
    const go = await within(dialog).findByRole("button", { name: /Create project and import/ });
    await waitFor(() => expect(go).not.toBeDisabled());
    await act(async () => { fireEvent.click(go); });
    expect(await within(dialog).findByText(/Couldn't create the project — a project named 'Client B' already exists in this stack\./)).toBeTruthy();
    expect(within(dialog).queryByText(/changed while you were reviewing/)).toBeNull();
    expect(calls.filter((c) => c.url.endsWith("/template/import"))).toHaveLength(0);
    // still editable: pick another name and the button comes back
    expect(within(dialog).getByLabelText("Project name")).toBeTruthy();
  });
});
