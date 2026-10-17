/**
 * GH #288 — BringInDialog: a dry run first (the plan is shown, nothing confirmed yet); the
 * real request carries the human's choices (result form, stash + its name, other-branch
 * confirmation); conflicts block the run and can be handed to the agent as a direct prompt.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { extensions } from "../../extensions";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { resetIdentity } from "../../cloud/identity";
import { BringInDialog, planVerdict, type BringInPlan } from "./BringInDialog";
import type { WorktreeItem } from "./AgentWorktreesSection";

const WT = "/Users/dev/acme/.orcha-worktrees";
const ITEM: WorktreeItem = { path: `${WT}/task-Atlas-eecc`, name: "task-Atlas-eecc", branch: "orcha/task-Atlas-eecc3b74-ed6",
  kind: "task", agent: "Atlas", task_id: "t1", task_title: "Prod QA run", state: "has-output" };
const HUMAN = { id: "h1", alias: "kedar", kind: "human", status: "active", role: "owner" };
const ATLAS = { id: "a1", alias: "Atlas", kind: "ai", status: "idle", role: "worker" };

interface Call { url: string; method: string; body: Record<string, unknown> | undefined }
let calls: Call[] = [];
let plan: Partial<BringInPlan> = {};
let runResult: Partial<BringInPlan> = {};

function basePlan(): BringInPlan {
  return { direction: "bring_in", mode: "apply", name: "task-Atlas-eecc", branch: "orcha/task-Atlas-eecc3b74-ed6", base_branch: "main",
    main_branch: "main", main_ahead: false, other_branch: false, main_dirty: [], agent_dirty: [], needs_stash: false,
    files: [{ status: "M", path: "app.py" }, { status: "A", path: "new.md" }], file_count: 2, conflicts: [], error: null, nothing_to_do: false };
}

function install() {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const res = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
    if (url === "/api/containers") return res([{ id: "c1", status: "active" }]);
    if (url === "/api/containers/c1") return res({ container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" }, agents: [HUMAN, ATLAS], tasks: [], requests: [] });
    if (url === "/api/containers/c1/agent-worktrees/actions" && method === "POST") {
      const dry = (body?.options as { dry_run?: boolean } | undefined)?.dry_run !== false;
      return res({ id: dry ? "dry" : "real", action: body?.action, path: body?.path, status: "done",
        result: dry ? { ...basePlan(), ...plan } : { ...basePlan(), ...plan, outcome: "done", ...runResult }, error: null, created_at: "" }, 201);
    }
    if (url === "/api/agents/a1/prompt" && method === "POST") return res({ delivered: true }, 201);
    if (url.startsWith("/api/me")) return res({ identity: null, trusted: false });
    if (url === "/api/prefs") return res({ prefs: null });
    return res({});
  }));
}

function renderDialog(direction: "bring_in" | "update_from_main" = "bring_in") {
  const onClose = vi.fn();
  const onDone = vi.fn();
  render(
    <ToastProvider>
      <SnapshotProvider>
        <BringInDialog cid="c1" item={ITEM} direction={direction} onClose={onClose} onDone={onDone} />
      </SnapshotProvider>
    </ToastProvider>,
  );
  return { onClose, onDone };
}

const realRequests = () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/actions") && (c.body?.options as { dry_run?: boolean }).dry_run === false);

beforeEach(() => {
  extensions.identity = async () => ({ agent_id: "h1", alias: "kedar", kind: "human", member_role: "owner", trusted: true } as never);
  extensions.identityTrusted = () => true;
  resetIdentity();
  plan = {};
  runResult = {};
  install();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("planVerdict", () => {
  const opts = { stash: false, allowOther: false, mode: "apply" as const };
  it("blocks on conflicts, errors, nothing to do, an unconfirmed other branch and a needed stash", () => {
    expect(planVerdict(null, "bring_in", opts).ok).toBe(false);
    expect(planVerdict({ ...basePlan(), conflicts: ["a.py"] }, "bring_in", opts)).toEqual({ ok: false, note: "Conflicts — nothing is applied until they are resolved." });
    expect(planVerdict({ ...basePlan(), error: "boom" }, "bring_in", opts).note).toBe("boom");
    expect(planVerdict({ ...basePlan(), nothing_to_do: true, files: [] }, "bring_in", opts).note).toMatch(/already has everything/);
    expect(planVerdict({ ...basePlan(), other_branch: true, main_branch: "feature" }, "bring_in", opts).note).toMatch(/checked out on feature/);
    expect(planVerdict({ ...basePlan(), other_branch: true }, "bring_in", { ...opts, allowOther: true }).ok).toBe(true);
    expect(planVerdict({ ...basePlan(), needs_stash: true }, "bring_in", opts).ok).toBe(true);               // apply: merges on top
    expect(planVerdict({ ...basePlan(), needs_stash: true }, "bring_in", { ...opts, mode: "merge" }).ok).toBe(false); // merge: stash first
    expect(planVerdict({ ...basePlan(), direction: "update", needs_stash: true }, "update_from_main", opts).ok).toBe(false);
    expect(planVerdict({ ...basePlan(), direction: "update", needs_stash: true }, "update_from_main", { ...opts, stash: true }).ok).toBe(true);
  });
});

describe("BringInDialog", () => {
  it("rehearses first, shows the plan, then sends the real request with the human's choices", async () => {
    plan = { needs_stash: true, main_dirty: ["notes.md"], main_ahead: true, last_applied_at: new Date(Date.now() - 7200_000).toISOString() };
    const { onDone } = renderDialog();
    expect(await screen.findByText(/Rehearsing in a temporary worktree/)).toBeInTheDocument();
    await screen.findByText(/Would change 2 files/);
    expect(screen.getByText("M app.py")).toBeInTheDocument();
    expect(screen.getByText(/Main moved ahead/)).toBeInTheDocument();
    expect(screen.getByText(/Last brought in/)).toBeInTheDocument();
    // only the dry run has gone out
    expect(realRequests()).toHaveLength(0);
    const dry = calls.find((c) => c.method === "POST" && c.url.endsWith("/actions"))!;
    expect(dry.body).toMatchObject({ action: "bring_in", path: ITEM.path, actor_agent_id: "h1", options: { dry_run: true, mode: "apply" } });
    // the stash is offered (checked) with a name the human can set
    const stashBox = screen.getByRole("checkbox", { name: /Stash the 1 uncommitted file in main first/ });
    expect(stashBox).toBeChecked();
    fireEvent.change(screen.getByRole("textbox", { name: "Stash name" }), { target: { value: "my wip" } });
    fireEvent.click(screen.getByRole("button", { name: "Bring in" }));
    await waitFor(() => expect(realRequests()).toHaveLength(1));
    expect(realRequests()[0].body).toMatchObject({ action: "bring_in", path: ITEM.path,
      options: { dry_run: false, mode: "apply", stash: true, stash_message: "my wip", allow_other_branch: false } });
    expect(await screen.findByText(/The changes are in main's working tree, uncommitted/)).toBeInTheDocument();
    expect(onDone).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("merge form re-rehearses, needs the stash when main is dirty, and says so", async () => {
    plan = { needs_stash: true, main_dirty: ["notes.md"] };
    renderDialog();
    await screen.findByText(/Would change 2 files/);
    fireEvent.click(screen.getByRole("radio", { name: /Merge branch/ }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/actions")).length).toBe(2));
    expect(calls[calls.length - 1].body).toMatchObject({ options: { dry_run: true, mode: "merge" } });
    await screen.findByText(/Would change 2 files/);
    fireEvent.click(screen.getByRole("checkbox", { name: /Stash the 1 uncommitted file/ }));   // untick
    expect(screen.getByText(/A merge needs main's uncommitted files stashed first/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Merge into main" })).toBeDisabled();
  });

  it("an other-branch main needs an explicit confirmation", async () => {
    plan = { other_branch: true, main_branch: "feature" };
    renderDialog();
    await screen.findByText(/Would change 2 files/);
    const btn = screen.getByRole("button", { name: "Bring in" });
    expect(btn).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /apply there anyway/ }));
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    await waitFor(() => expect(realRequests()[0]?.body).toMatchObject({ options: { allow_other_branch: true } }));
  });

  it("conflicts block the run and can be handed to the agent", async () => {
    plan = { conflicts: ["app.py"], files: [] };
    const { onClose } = renderDialog();
    expect(await screen.findByText(/Conflicts in 1 file — nothing was changed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bring in" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Ask Atlas to resolve them" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/agents/a1/prompt" && c.method === "POST")).toBe(true));
    const prompt = calls.find((c) => c.url === "/api/agents/a1/prompt")!.body as { message: string; from_agent_id: string };
    expect(prompt.message).toMatch(/conflicts in: app.py/);
    expect(prompt.message).toMatch(/Do not touch the main checkout/);
    expect(prompt.from_agent_id).toBe("h1");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(realRequests()).toHaveLength(0);
  });

  it("a kept stash is reported after the run", async () => {
    plan = { needs_stash: true, main_dirty: ["notes.md"] };
    runResult = { stash: "orcha-bring-in/task-Atlas-eecc/20261016T020000Z", stash_restore: "kept" };
    renderDialog();
    await screen.findByText(/Would change 2 files/);
    fireEvent.click(screen.getByRole("button", { name: "Bring in" }));
    expect(await screen.findByText(/could not be re-applied cleanly/)).toBeInTheDocument();
    expect(screen.getByText("orcha-bring-in/task-Atlas-eecc/20261016T020000Z")).toBeInTheDocument();
  });

  it("update from main: the reverse direction, its own wording and stash rule", async () => {
    plan = { direction: "update", needs_stash: true, agent_dirty: ["wip.py"], commits_behind: 3, files: [{ status: "M", path: "lib.py" }], file_count: 1 };
    renderDialog("update_from_main");
    expect(await screen.findByText(/Would bring 1 file \(and 3 commits from main\)/)).toBeInTheDocument();
    const box = screen.getByRole("checkbox", { name: /Stash the 1 uncommitted file in task-Atlas-eecc first/ });
    fireEvent.click(box);  // untick → the update can't run
    expect(screen.getByRole("button", { name: "Update worktree" })).toBeDisabled();
    fireEvent.click(box);
    fireEvent.click(screen.getByRole("button", { name: "Update worktree" }));
    await waitFor(() => expect(realRequests()[0]?.body).toMatchObject({ action: "update_from_main", options: { dry_run: false, stash: true } }));
    expect(await screen.findByText(/The worktree now carries main's changes/)).toBeInTheDocument();
  });
});
