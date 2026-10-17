/**
 * Settings › General › Objective — inline editor over containers.description.
 * Owner / manage_autonomy edits in place (PUT /objective, snapshot refreshed so the
 * Overview follows); viewers and plain members see it read-only with the reason;
 * failures are said in plain words and keep the draft.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { extensions, type Identity } from "../../extensions";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { resetIdentity } from "../../cloud/identity";
import { SettingsPage } from "./SettingsPage";
import { HomePage } from "../home/HomePage";
import { SETTINGS_GRANT_REASON } from "./grantAuthority";
import { objectiveSaveError } from "./ObjectiveRow";

interface Call { url: string; method: string; body: unknown }
let calls: Call[] = [];
let objective: string | null = "Ship the new marketing site";
let putStatus = 200;
const HUMAN = { id: "h1", alias: "kedar", kind: "human", status: "active" };
const ORIG_IDENTITY = extensions.identity;
const ORIG_TRUSTED = extensions.identityTrusted;

function install() {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const res = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data) }) as unknown as Response;
    if (url === "/api/containers") return res([{ id: "c1", status: "active" }]);
    if (url === "/api/containers/c1/objective" && method === "PUT") {
      if (putStatus !== 200) return res({ detail: "this action requires the owner role or the 'manage_autonomy' permission" }, putStatus);
      objective = ((body as { objective: string | null }).objective || "").trim() || null;
      return res({ container_id: "c1", objective });
    }
    if (url === "/api/containers/c1") {
      return res({
        container: { id: "c1", name: "Website", description: objective, status: "active", autonomy_level: "plan" },
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

function renderGeneral(withOverview = false) {
  window.history.replaceState(null, "", window.location.pathname + "#tab=general");
  return render(
    <ToastProvider><SnapshotProvider><MemoryRouter>
      <SettingsPage />
      {withOverview ? <HomePage /> : null}
    </MemoryRouter></SnapshotProvider></ToastProvider>,
  );
}

const puts = () => calls.filter((c) => c.method === "PUT");
const openBtn = () => screen.findByRole("button", { name: /^(Edit objective|Add an objective)/ });

beforeEach(() => {
  delete extensions.settingsSections;
  delete extensions.settingsGeneral;
  localStorage.clear();
  resetIdentity();
  extensions.identity = undefined;
  extensions.identityTrusted = undefined;
  objective = "Ship the new marketing site";
  putStatus = 200;
  install();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  extensions.identity = ORIG_IDENTITY;
  extensions.identityTrusted = ORIG_TRUSTED;
});

describe("objectiveSaveError", () => {
  it("names the failure in plain words", () => {
    expect(objectiveSaveError(Object.assign(new Error("/x → 403: nope"), { status: 403 }))).toBe("Couldn't save the objective — nope.");
    expect(objectiveSaveError(Object.assign(new Error("/x → 403"), { status: 403 }))).toBe("Couldn't save the objective — you don't have permission to change this.");
    expect(objectiveSaveError(Object.assign(new Error("/x → 405"), { status: 405 }))).toMatch(/can't edit objectives yet/);
    expect(objectiveSaveError(Object.assign(new Error("/x → 413"), { status: 413 }))).toMatch(/too long/);
    expect(objectiveSaveError(Object.assign(new Error("/x → 500: Internal Server Error"), { status: 500 }))).toBe("Couldn't save the objective — Embodent hit an error. Try again.");
    expect(objectiveSaveError(new TypeError("Failed to fetch"))).toBe("Couldn't save the objective — couldn't reach Embodent.");
  });
});

describe("Settings › General › Objective", () => {
  it("an owner edits in place: click, type, Save → one PUT, snapshot refreshed, Saved", async () => {
    asIdentity({ agent_id: "h1", alias: "kedar", member_role: "owner", grants: [] });
    renderGeneral();
    const btn = await openBtn();
    expect(btn).toHaveTextContent("Ship the new marketing site");
    fireEvent.click(btn);
    const ta = (await screen.findByRole("textbox", { name: "Project objective" })) as HTMLTextAreaElement;
    expect(ta.value).toBe("Ship the new marketing site");
    fireEvent.change(ta, { target: { value: "  Launch the site by October  " } });
    const snapsBefore = calls.filter((c) => c.url === "/api/containers/c1").length;
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    await waitFor(() => expect(puts()).toEqual([
      { url: "/api/containers/c1/objective", method: "PUT", body: { objective: "Launch the site by October", actor_agent_id: "h1" } },
    ]));
    expect(calls.filter((c) => c.url === "/api/containers/c1").length).toBeGreaterThan(snapsBefore);
    expect(await openBtn()).toHaveTextContent("Launch the site by October");
    expect(document.querySelector(".set-obj-saved")).toHaveTextContent("Saved");
  });

  it("⌘Enter saves, Esc cancels without writing, and an unchanged draft never PUTs", async () => {
    renderGeneral(); // trust off: any acting human may act, as the server allows
    fireEvent.click(await openBtn());
    let ta = await screen.findByRole("textbox", { name: "Project objective" });
    fireEvent.change(ta, { target: { value: "draft I abandon" } });
    fireEvent.keyDown(ta, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Project objective" })).toBeNull();
    expect(await openBtn()).toHaveTextContent("Ship the new marketing site");

    fireEvent.click(await openBtn());
    ta = await screen.findByRole("textbox", { name: "Project objective" });
    await act(async () => { fireEvent.keyDown(ta, { key: "Enter", metaKey: true }); });
    expect(screen.queryByRole("textbox", { name: "Project objective" })).toBeNull();
    expect(puts()).toEqual([]);

    fireEvent.click(await openBtn());
    ta = await screen.findByRole("textbox", { name: "Project objective" });
    fireEvent.change(ta, { target: { value: "Keyboard objective" } });
    await act(async () => { fireEvent.keyDown(ta, { key: "Enter", ctrlKey: true }); });
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect((puts()[0].body as { objective: string }).objective).toBe("Keyboard objective");
  });

  it("saving an empty draft clears the objective; an empty project offers 'Add an objective'", async () => {
    renderGeneral();
    fireEvent.click(await openBtn());
    const ta = await screen.findByRole("textbox", { name: "Project objective" });
    fireEvent.change(ta, { target: { value: "   " } });
    expect(screen.getByText(/Saving empty clears it/)).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    await waitFor(() => expect(puts()[0]?.body).toEqual({ objective: null, actor_agent_id: "h1" }));
    expect(await screen.findByRole("button", { name: "Add an objective" })).toHaveTextContent("Add an objective…");
  });

  it("a refused save keeps the draft open and says why in plain words", async () => {
    putStatus = 403;
    renderGeneral();
    fireEvent.click(await openBtn());
    const ta = await screen.findByRole("textbox", { name: "Project objective" });
    fireEvent.change(ta, { target: { value: "Not allowed" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't save the objective — this action requires the owner role or the 'manage_autonomy' permission.",
    );
    expect((screen.getByRole("textbox", { name: "Project objective" }) as HTMLTextAreaElement).value).toBe("Not allowed");
    expect(screen.getByRole("textbox", { name: "Project objective" })).toHaveAttribute("aria-invalid", "true");
  });

  it("a viewer sees the objective read-only with the reason, and can't open the editor", async () => {
    asIdentity({ agent_id: "h1", alias: "kedar", member_role: "viewer", grants: [] });
    renderGeneral();
    await waitFor(() => expect(screen.getByTestId("objective-reason")).toHaveTextContent("Your role is viewer (read-only)"));
    expect(document.querySelector("#setObjectiveText")).toHaveTextContent("Ship the new marketing site");
    expect(screen.queryByRole("button", { name: /Edit objective/ })).toBeNull();
    expect(puts()).toEqual([]);
  });

  it("a member without manage_autonomy gets the grant reason; with it, can edit", async () => {
    asIdentity({ agent_id: "h1", alias: "kedar", member_role: "member", grants: ["manage_agents"] });
    renderGeneral();
    await waitFor(() => expect(screen.getByTestId("objective-reason")).toHaveTextContent(SETTINGS_GRANT_REASON.manage_autonomy));
    cleanup();
    resetIdentity();
    asIdentity({ agent_id: "h1", alias: "kedar", member_role: "member", grants: ["manage_autonomy"] });
    renderGeneral();
    expect(await openBtn()).toBeInTheDocument();
  });

  it("the Overview summary follows the edit without a reload", async () => {
    asIdentity({ agent_id: "h1", alias: "kedar", member_role: "owner", grants: [] });
    renderGeneral(true);
    await waitFor(() => expect(document.querySelector(".ov-obj")).toHaveTextContent("Ship the new marketing site"));
    fireEvent.click(await openBtn());
    fireEvent.change(await screen.findByRole("textbox", { name: "Project objective" }), { target: { value: "Grow signups 20%" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    await waitFor(() => expect(document.querySelector(".ov-obj")).toHaveTextContent("Grow signups 20%"));
  });
});
