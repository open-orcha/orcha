/**
 * Reply style (mig 102): Settings → Execution › Agent replies sets the project style
 * (Normal / Caveman / ASD-STE100, owner or manage_agents), and the chip by a composer
 * overrides it for one conversation / task ("Project default" clears the override).
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplyStyleChip, replyStyleChipText } from "../../components/ReplyStyleChip";
import { ToastProvider } from "../../components/ui";
import { extensions, type Identity } from "../../extensions";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { resetIdentity } from "../../cloud/identity";
import { SettingsPage } from "./SettingsPage";
import { SETTINGS_GRANT_REASON } from "./grantAuthority";
import { replyStyleDesc } from "./ReplyStyleRow";

interface Call { url: string; method: string; body: unknown }
let calls: Call[] = [];
let project = "normal";
let override: string | null = null;
let hasRoute = true;
const AGENTS = [
  { id: "h1", alias: "kedar", kind: "human", status: "active" },
  { id: "a1", alias: "atlas", kind: "ai", status: "idle" },
];
const ORIG_IDENTITY = extensions.identity;
const ORIG_TRUSTED = extensions.identityTrusted;

function install() {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const res = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
    const thread = () => res({
      thread_kind: "task", thread_id: "t1", container_id: "c1", override,
      project_reply_style: project, effective_reply_style: override ?? project,
    });
    if (url === "/api/containers") return res([{ id: "c1", status: "active" }]);
    if (url === "/api/containers/c1/reply-style") {
      if (!hasRoute) return res({ detail: "Not Found" }, 404);
      if (method === "PUT") project = (body as { reply_style: string }).reply_style;
      return res({ container_id: "c1", reply_style: project });
    }
    if (url === "/api/tasks/t1/reply-style") {
      if (method === "PUT") override = (body as { reply_style: string | null }).reply_style;
      return thread();
    }
    if (url === "/api/containers/c1") {
      return res({
        container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
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
const puts = () => calls.filter((c) => c.method === "PUT");

beforeEach(() => {
  delete extensions.settingsSections;
  delete extensions.settingsGeneral;
  localStorage.clear();
  resetIdentity();
  extensions.identity = undefined;
  extensions.identityTrusted = undefined;
  project = "normal";
  override = null;
  hasRoute = true;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  extensions.identity = ORIG_IDENTITY;
  extensions.identityTrusted = ORIG_TRUSTED;
});

describe("Settings → Execution › Agent replies", () => {
  it("replyStyleDesc names the style and the fixed rules", () => {
    expect(replyStyleDesc("caveman")).toMatch(/^Terse, no filler/);
    expect(replyStyleDesc("asd_ste100")).toMatch(/Simplified Technical English/);
    expect(replyStyleDesc("normal")).toMatch(/file paths and quotes stay exact; GitHub posts stay normal/);
  });

  it("an owner switches the project to Caveman", async () => {
    install();
    asIdentity({ agent_id: "h1", alias: "kedar", member_role: "owner", grants: [] });
    renderExecution();
    expect(await radio("Normal")).toHaveAttribute("aria-checked", "true");
    const caveman = await radio("Caveman");
    await waitFor(() => expect(caveman.disabled).toBe(false));
    await act(async () => { fireEvent.click(caveman); });
    await waitFor(() => expect(puts()).toEqual([
      { url: "/api/containers/c1/reply-style", method: "PUT", body: { reply_style: "caveman", actor_agent_id: "h1" } },
    ]));
    expect(await screen.findByText("Agents now reply in Caveman style.")).toBeInTheDocument();
    expect(await radio("Caveman")).toHaveAttribute("aria-checked", "true");
  });

  it("a member without manage_agents gets the grant reason and writes nothing", async () => {
    install();
    asIdentity({ agent_id: "h1", alias: "kedar", member_role: "member", grants: [] });
    renderExecution();
    const ste = await radio("ASD-STE100");
    await waitFor(() => expect(screen.getByTestId("reply-style-reason")).toHaveTextContent(SETTINGS_GRANT_REASON.manage_agents));
    expect(ste.disabled).toBe(true);
    fireEvent.click(ste);
    expect(puts()).toEqual([]);
  });

  it("an older backend without the route shows nothing", async () => {
    install();
    hasRoute = false;
    renderExecution();
    await screen.findByRole("spinbutton", { name: "Agent limit" }).catch(() => null);
    expect(screen.queryByRole("radio", { name: "Caveman" })).toBeNull();
  });
});

describe("Reply style chip by the composer", () => {
  function renderChip() {
    return render(
      <ToastProvider><SnapshotProvider><MemoryRouter><ReplyStyleChip kind="task" id="t1" /></MemoryRouter></SnapshotProvider></ToastProvider>,
    );
  }

  it("chip text shows the style in use and where it comes from", () => {
    expect(replyStyleChipText({ override: null, project_reply_style: "caveman", effective_reply_style: "caveman" }))
      .toBe("Style: Caveman (project)");
    expect(replyStyleChipText({ override: "normal", project_reply_style: "caveman", effective_reply_style: "normal" }))
      .toBe("Style: Normal");
  });

  it("overrides the project style for this task only, then goes back to the project default", async () => {
    install();
    project = "caveman";
    asIdentity({ agent_id: "h1", alias: "kedar", member_role: "member", grants: [] });
    renderChip();
    const select = await screen.findByRole("combobox", { name: "Reply style for this task" }) as HTMLSelectElement;
    expect(screen.getByTestId("reply-style-chip")).toHaveTextContent("Style: Caveman (project)");
    await waitFor(() => expect(select.disabled).toBe(false));
    await act(async () => { fireEvent.change(select, { target: { value: "asd_ste100" } }); });
    await waitFor(() => expect(puts()).toEqual([
      { url: "/api/tasks/t1/reply-style", method: "PUT", body: { reply_style: "asd_ste100", actor_agent_id: "h1" } },
    ]));
    await waitFor(() => expect(screen.getByTestId("reply-style-chip")).toHaveTextContent("Style: ASD-STE100"));
    await act(async () => { fireEvent.change(select, { target: { value: "" } }); });
    await waitFor(() => expect(puts()[1]?.body).toEqual({ reply_style: null, actor_agent_id: "h1" }));
    await waitFor(() => expect(screen.getByTestId("reply-style-chip")).toHaveTextContent("Style: Caveman (project)"));
    // no project-wide write from the chip
    expect(puts().some((c) => c.url === "/api/containers/c1/reply-style")).toBe(false);
  });

  it("a viewer sees the chip but cannot change it", async () => {
    install();
    asIdentity({ agent_id: "h1", alias: "kedar", member_role: "viewer", grants: [] });
    renderChip();
    const select = await screen.findByRole("combobox", { name: "Reply style for this task" }) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(true));
    expect(puts()).toEqual([]);
  });
});
