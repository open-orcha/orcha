/**
 * Cmd/Ctrl+K command palette (arch §6): real scoped results, safe inside
 * editors/terminals/text entry, inline provider errors, no-match state,
 * permission-aware actions, Escape restores focus.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HashRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { _resetProjectsForTests } from "../../state/projects";
import { HomePage } from "../../pages/home/HomePage";
import { registerSearchProvider } from "./providers";

function rawSnapshot(humans = true) {
  return {
    container: { id: "c1", name: "Website", status: "active", autonomy_level: "plan", wakes_enabled: true },
    agents: [
      ...(humans ? [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }] : []),
      { id: "a2", alias: "Mira", kind: "ai", status: "working", role: "frontend engineer" },
    ],
    tasks: [
      { id: "7f3a9c21-0000-4000-8000-000000000001", title: "Ship login page", status: "in_progress", assignees: ["Mira"] },
      { id: "8b000000-0000-4000-8000-000000000002", title: "Fix checkout", status: "blocked", assignees: [] },
    ],
    requests: [{ id: "r1", type: "question", status: "open", requester_id: "a2", target_id: null, payload: "Which login provider?" }],
  };
}

function stubFetch(humans = true) {
  const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/containers") return json({ containers: [{ id: "c1", name: "Website", status: "active" }, { id: "c2", name: "API service", status: "active" }] });
    if (url.startsWith("/api/containers/c1")) return json(rawSnapshot(humans));
    return json({});
  }) as unknown as typeof fetch;
}

function mount(extra?: React.ReactNode) {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <HashRouter>
          <HomePage />
          {extra}
        </HashRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

const cmdK = (target: Element | Document = document) => fireEvent.keyDown(target, { key: "k", metaKey: true });
const palette = () => screen.queryByRole("dialog", { name: "Search and commands" });

async function ready() {
  await waitFor(() => expect(document.getElementById("execBtn")).toBeTruthy()); // snapshot loaded
}

describe("command palette", () => {
  beforeEach(() => { localStorage.clear(); _resetProjectsForTests(); window.location.hash = ""; stubFetch(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("Cmd/Ctrl+K opens it with a visible project scope chip; Escape closes and restores focus", async () => {
    mount(<button id="opener">opener</button>);
    await ready();
    const opener = document.getElementById("opener")!;
    opener.focus();
    cmdK(opener);
    const dlg = await screen.findByRole("dialog", { name: "Search and commands" });
    expect(within(dlg).getByText("in Website")).toBeInTheDocument();
    const input = within(dlg).getByRole("combobox");
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(palette()).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it("Ctrl+K works too, and the sidebar Search button opens it", async () => {
    mount();
    await ready();
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    await screen.findByRole("dialog", { name: "Search and commands" });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    await waitFor(() => expect(palette()).toBeNull());
    fireEvent.click(document.getElementById("globalSearch")!);
    await screen.findByRole("dialog", { name: "Search and commands" });
  });

  it("never hijacks CodeMirror or xterm; '/' only opens outside text entry", async () => {
    mount(
      <>
        <div className="cm-editor"><div id="cm" tabIndex={0} contentEditable suppressContentEditableWarning /></div>
        <div className="xterm"><textarea id="xt" /></div>
        <input id="plain" />
      </>,
    );
    await ready();
    cmdK(document.getElementById("cm")!);
    cmdK(document.getElementById("xt")!);
    fireEvent.keyDown(document.getElementById("plain")!, { key: "/" });
    await new Promise((r) => setTimeout(r, 50));
    expect(palette()).toBeNull();
    fireEvent.keyDown(document.body, { key: "/" });
    await screen.findByRole("dialog", { name: "Search and commands" });
  });

  it("returns real current-project tasks, requests and agents; Enter opens the entity URL", async () => {
    mount();
    await ready();
    cmdK();
    const dlg = await screen.findByRole("dialog", { name: "Search and commands" });
    const input = within(dlg).getByRole("combobox");
    fireEvent.change(input, { target: { value: "login" } });
    await within(dlg).findByText("Ship login page");
    expect(within(dlg).getByText("Which login provider?")).toBeInTheDocument();
    expect(within(dlg).getByRole("group", { name: "Tasks" })).toBeInTheDocument();
    expect(within(dlg).getByRole("group", { name: "Requests" })).toBeInTheDocument();
    // short id match with a leading '#'
    fireEvent.change(input, { target: { value: "#8b000000" } });
    await within(dlg).findByText("Fix checkout");
    fireEvent.change(input, { target: { value: "mira" } });
    const agentsGroup = await within(dlg).findByRole("group", { name: "Agents" });
    expect(within(agentsGroup).getByText("Mira")).toBeInTheDocument();
    // move the active row onto the agent and open it
    const opts = within(dlg).getAllByRole("option");
    const idx = opts.findIndex((o) => o.textContent?.includes("frontend engineer"));
    for (let i = 0; i < idx; i++) fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(window.location.hash).toBe("#/agents?agent=Mira&cid=c1")); // multi-project stack keeps scope
    await waitFor(() => expect(palette()).toBeNull());
  });

  it("projects group lists real projects (switching is a full ?cid= navigation)", async () => {
    mount();
    await ready();
    cmdK();
    const dlg = await screen.findByRole("dialog", { name: "Search and commands" });
    fireEvent.change(within(dlg).getByRole("combobox"), { target: { value: "api" } });
    const grp = await within(dlg).findByRole("group", { name: "Projects" });
    expect(within(grp).getByText("API service")).toBeInTheDocument();
  });

  it("no matches → explicit empty state naming the scope", async () => {
    mount();
    await ready();
    cmdK();
    const dlg = await screen.findByRole("dialog", { name: "Search and commands" });
    fireEvent.change(within(dlg).getByRole("combobox"), { target: { value: "zzqqxx" } });
    expect(await within(dlg).findByText("No matches in Website")).toBeInTheDocument();
  });

  it("a failing provider shows an inline error row while other groups still render", async () => {
    const off = registerSearchProvider({ id: "files-test", group: "Files", minQuery: 2, search: () => Promise.reject(new Error("repo not bound")) });
    try {
      mount();
      await ready();
      cmdK();
      const dlg = await screen.findByRole("dialog", { name: "Search and commands" });
      fireEvent.change(within(dlg).getByRole("combobox"), { target: { value: "login" } });
      expect(await within(dlg).findByText("Files search unavailable: repo not bound")).toBeInTheDocument();
      expect(within(dlg).getByText("Ship login page")).toBeInTheDocument();
    } finally { off(); }
  });

  it("actions that need an acting human show the reason instead of executing", async () => {
    stubFetch(false); // no human registered
    mount();
    await ready();
    cmdK();
    const dlg = await screen.findByRole("dialog", { name: "Search and commands" });
    const input = within(dlg).getByRole("combobox");
    fireEvent.change(input, { target: { value: "new task" } });
    const row = await within(dlg).findByText("New task");
    await act(async () => { fireEvent.click(row); });
    expect(within(dlg).getByRole("alert").textContent).toMatch(/Pick an acting human first/);
    expect(window.location.hash).not.toContain("new=1");
  });

  it("the Execution controls action opens the header popover", async () => {
    mount();
    await ready();
    cmdK();
    const dlg = await screen.findByRole("dialog", { name: "Search and commands" });
    fireEvent.change(within(dlg).getByRole("combobox"), { target: { value: "execution" } });
    fireEvent.click(await within(dlg).findByText("Execution controls"));
    await screen.findByRole("dialog", { name: "Execution controls" });
    expect(document.getElementById("notifTop")).toBeTruthy();
  });
});
