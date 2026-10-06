/**
 * Settings → Execution › Agent worktrees (mig 067): the switch + grace period PUT the
 * settings for an owner / manage_autonomy holder; the list shows each worktree with its state,
 * size and age; Remove asks to confirm (an unmerged branch must be typed, "Keep branch" is on);
 * "Clean up existing worktrees…" previews every group with sizes and the files it will save,
 * then files one request and reports what was freed; a viewer gets it all read-only.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { extensions, type Identity } from "../../extensions";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { resetIdentity } from "../../cloud/identity";
import { formatSize } from "../../lib/format";
import { SettingsPage } from "./SettingsPage";
import { cleanupPlan, filesToSave, type WorktreeItem } from "./AgentWorktreesSection";

interface Call { url: string; method: string; body: Record<string, unknown> | undefined }
let calls: Call[] = [];
let settings = { auto_cleanup: true, grace_days: 7 };
const HUMAN = { id: "h1", alias: "kedar", kind: "human", status: "active" };
const ORIG_IDENTITY = extensions.identity;
const ORIG_TRUSTED = extensions.identityTrusted;
const WT = "/Users/dev/acme/.orcha-worktrees";
const recent = new Date(Date.now() - 3 * 3600 * 1000).toISOString();

const ITEMS: WorktreeItem[] = [
  { path: `${WT}/Atlas-1`, name: "Atlas-1", branch: "orcha/wk-Atlas-1", kind: "wake", agent: "Atlas", state: "clean",
    size_bytes: 21_000_000, last_activity_at: recent, reason: "only Embodent scaffolding — safe to remove" },
  { path: `${WT}/Probe-1`, name: "Probe-1", branch: "orcha/wk-Probe-1", kind: "wake", agent: "Probe", state: "clean",
    size_bytes: 2_400_000_000, last_activity_at: recent },
  { path: `${WT}/task-Atlas-eecc`, name: "task-Atlas-eecc", branch: "orcha/task-Atlas-eecc3b74-ed6", kind: "task", agent: "Atlas",
    task_id: "t1", task_title: "Prod QA run", state: "has-output", size_bytes: 22_000_000, last_activity_at: recent,
    output: ["qa-runs/report.md", "qa-runs/shot.png"], output_count: 2 },
  { path: `${WT}/Ferry-1`, name: "Ferry-1", branch: "orcha/wk-Ferry-1", kind: "wake", agent: "Ferry", state: "unmerged",
    size_bytes: 300_000, unmerged_commits: 2, last_activity_at: recent },
  { path: `${WT}/live-Atlas`, name: "live-Atlas", branch: "orcha/live-Atlas", kind: "live", agent: "Atlas", state: "in-use",
    size_bytes: 19_000_000, last_activity_at: recent },
];

function install({ items = ITEMS, actionResult = { removed: [{}, {}, {}], kept: [{}], freed_bytes: 2_443_000_000 } } = {}) {
  calls = [];
  settings = { auto_cleanup: true, grace_days: 7 };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const res = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
    if (url === "/api/containers") return res([{ id: "c1", status: "active" }]);
    if (url === "/api/containers/c1/agent-worktrees" && method === "GET") {
      return res({ settings, actions: [], inventory: {
        host: "mac", scanned_at: recent, items,
        reclaimable_bytes: items.filter((i) => i.state === "clean" || i.state === "has-output").reduce((n, i) => n + (i.size_bytes || 0), 0),
        total_bytes: items.reduce((n, i) => n + (i.size_bytes || 0), 0) } });
    }
    if (url === "/api/containers/c1/agent-worktrees/settings") {
      settings = { ...settings, ...Object.fromEntries(Object.entries(body || {}).filter(([k]) => k !== "actor_agent_id")) } as typeof settings;
      return res(settings);
    }
    if (url === "/api/containers/c1/agent-worktrees/actions" && method === "POST") {
      return res({ id: "a1", action: body?.action, path: body?.path ?? null, status: "done", result: actionResult, error: null, created_at: recent }, 201);
    }
    if (url === "/api/containers/c1") {
      return res({ container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" }, agents: [HUMAN], tasks: [], requests: [] });
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
  return render(<ToastProvider><SnapshotProvider><MemoryRouter><SettingsPage /></MemoryRouter></SnapshotProvider></ToastProvider>);
}

const table = () => screen.findByRole("list", { name: "Agent worktrees" });
const posts = () => calls.filter((c) => c.method !== "GET" && c.url.includes("agent-worktrees"));

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

describe("Settings → Execution › Agent worktrees", () => {
  it("plans a clean-up group by group (pure)", () => {
    const plan = cleanupPlan(ITEMS, new Set([`${WT}/Ferry-1`]));
    expect(plan.remove.map((i) => i.name)).toEqual(["Atlas-1", "Probe-1"]);
    expect(plan.save.map((i) => i.name)).toEqual(["task-Atlas-eecc"]);
    expect(plan.optIn.map((i) => i.name)).toEqual(["Ferry-1"]);
    expect(plan.skipped.map((i) => i.name)).toEqual(["live-Atlas"]);
    expect(plan.freed).toBe(21_000_000 + 2_400_000_000 + 22_000_000 + 300_000);
    expect(filesToSave(ITEMS[2])).toEqual(["qa-runs/report.md", "qa-runs/shot.png"]);
    expect(formatSize(2_400_000_000)).toBe("2.2 GB");
  });

  it("lists every worktree with its state, size and age, and the reclaimable total", async () => {
    install();
    renderExecution();
    const t = await table();
    const rows = within(t).getAllByRole("listitem");
    expect(rows.map((r) => r.getAttribute("data-state"))).toEqual(["clean", "clean", "has-output", "unmerged", "in-use"]);
    expect(within(rows[0]).getByText("orcha/wk-Probe-1")).toBeInTheDocument(); // biggest clean first
    expect(within(rows[0]).getByText("2.2 GB")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Has output")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Prod QA run")).toBeInTheDocument();
    expect(within(rows[3]).getByText("Unmerged commits")).toBeInTheDocument();
    expect(within(rows[4]).getByText("In use")).toBeInTheDocument();
    expect(within(rows[4]).queryByRole("button", { name: "Remove" })).toBeNull();
    expect(within(rows[2]).getByRole("button", { name: "Save output to task" })).toBeInTheDocument();
    expect(within(rows[0]).getByText("3h ago")).toBeInTheDocument();
    expect(screen.getByText("2.3 GB")).toBeInTheDocument(); // reclaimable
  });

  it("an owner turns automatic clean-up off and changes the grace period", async () => {
    install();
    asIdentity({ agent_id: "h1", alias: "kedar", member_role: "owner", grants: [] });
    renderExecution();
    const sw = await screen.findByRole("switch", { name: "Clean up agent worktrees automatically" });
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "true"));
    await waitFor(() => expect(sw).not.toHaveAttribute("aria-disabled"));
    await act(async () => { fireEvent.click(sw); });
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "false"));
    const grace = screen.getByRole("spinbutton", { name: "Grace period" });
    fireEvent.change(grace, { target: { value: "14" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    expect(posts().map((c) => c.body)).toEqual([
      { auto_cleanup: false, actor_agent_id: "h1" },
      { grace_days: 14, actor_agent_id: "h1" },
    ]);
  });

  it("removing an unmerged worktree needs the branch typed and keeps the branch by default", async () => {
    install();
    renderExecution();
    const t = await table();
    const row = within(t).getAllByRole("listitem").find((r) => r.getAttribute("data-state") === "unmerged")!;
    await waitFor(() => expect(within(row).getByRole("button", { name: "Remove" })).not.toBeDisabled());
    fireEvent.click(within(row).getByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/has 2 commits that aren't on the base branch/)).toBeInTheDocument();
    expect(within(dialog).getByRole("checkbox")).toBeChecked();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove worktree" }));
    expect(posts()).toEqual([]); // not typed → nothing sent
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Branch name" }), { target: { value: "orcha/wk-Ferry-1" } });
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Remove worktree" })); });
    await waitFor(() => expect(posts()[0]?.body).toEqual({
      action: "remove", path: `${WT}/Ferry-1`, keep_branch: true, confirm_branch: "orcha/wk-Ferry-1", actor_agent_id: "h1",
    }));
  });

  it("'Clean up existing worktrees…' previews by state, then runs once and reports what was freed", async () => {
    install();
    renderExecution();
    await table();
    await waitFor(() => expect(screen.getByRole("button", { name: "Clean up existing worktrees…" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Clean up existing worktrees…" }));
    const preview = await screen.findByTestId("wtg-preview");
    expect(within(preview).getByRole("region", { name: "Clean" })).toHaveTextContent("2 · 2.3 GB · remove");
    const out = within(preview).getByRole("region", { name: "Has output" });
    expect(out).toHaveTextContent("save output to the task, then remove");
    expect(within(out).getByText("qa-runs/report.md")).toBeInTheDocument();
    expect(within(preview).getByRole("region", { name: "Unmerged commits" })).toHaveTextContent("keep");
    expect(within(preview).getByRole("region", { name: "In use / not Embodent" })).toHaveTextContent("skipped");
    expect(posts()).toEqual([]); // the preview sends nothing
    fireEvent.click(within(preview).getByRole("checkbox", { name: "Remove Ferry-1, keep branch" }));
    const go = screen.getByRole("button", { name: /^Clean up 4 · free / });
    await act(async () => { fireEvent.click(go); });
    await waitFor(() => expect(posts()[0]?.body).toEqual({
      action: "clean_up", include_output: true, unmerged_paths: [`${WT}/Ferry-1`], actor_agent_id: "h1",
    }));
    expect(await screen.findAllByText(/Removed 3 worktrees · 2\.3 GB freed · 1 kept/)).not.toHaveLength(0);
  });

  it("'Clean up now' only touches the clean ones", async () => {
    install();
    renderExecution();
    await table();
    const btn = screen.getByRole("button", { name: "Clean up now (2)" });
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);
    const preview = await screen.findByTestId("wtg-preview");
    expect(within(preview).queryByRole("region", { name: "Has output" })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Clean up 2 · free / })); });
    await waitFor(() => expect(posts()[0]?.body).toMatchObject({ action: "clean_up", include_output: false, unmerged_paths: [] }));
  });

  it("a viewer sees the list read-only and nothing is written", async () => {
    install();
    asIdentity({ agent_id: "h1", alias: "kedar", member_role: "viewer", grants: [] });
    renderExecution();
    await table();
    const sw = screen.getByRole("switch", { name: "Clean up agent worktrees automatically" });
    await waitFor(() => expect(sw).toHaveAttribute("aria-disabled", "true"));
    expect(screen.getByRole("button", { name: "Clean up existing worktrees…" })).toBeDisabled();
    fireEvent.click(sw);
    expect(posts()).toEqual([]);
  });

  it("is hidden on a portal without the feature", async () => {
    install();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const res = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
      if (url === "/api/containers") return res([{ id: "c1", status: "active" }]);
      if (url === "/api/containers/c1") return res({ container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" }, agents: [HUMAN], tasks: [], requests: [] });
      if (url.includes("agent-worktrees")) return res({ detail: "Not Found" }, 404);
      if (url.startsWith("/api/me")) return res({ identity: null, trusted: false });
      return res({});
    }));
    renderExecution();
    await screen.findByText("Agent workspace");
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("Agent worktrees")).toBeNull();
  });
});
