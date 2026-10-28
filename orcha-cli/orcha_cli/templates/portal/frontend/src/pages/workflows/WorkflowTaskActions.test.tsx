import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowTaskActions } from "./WorkflowTaskActions";
import { exampleTask, exampleWorkflow, exampleImpact, jsonResponse, writeCapability } from "./workflowTestFixtures";
const scope = () => ({ origin: "https://orcha.example", project: "project", identity: crypto.randomUUID() });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function taskCase(action: string, enabled = true) {
  const task = exampleTask({ available_actions: [{ action, enabled }] });
  return { task, detail: exampleWorkflow({ capability: writeCapability, tasks: [task] }) };
}
it("prepares current task criteria and assignment without releasing holds or starting work", async () => {
  const { detail, task } = taskCase("prepare"); const onSaved = vi.fn();
  const fetch = vi.fn(async () => jsonResponse(detail)); vi.stubGlobal("fetch", fetch);
  render(<WorkflowTaskActions detail={detail} task={task} scope={scope()} verified stale={false} agents={[{ id: "andrew", alias: "Andrew" }]} onSaved={onSaved} />);
  fireEvent.click(screen.getByRole("button", { name: "Manage Build Android" }));
  fireEvent.click(screen.getByRole("button", { name: "Prepare task" }));
  await screen.findByLabelText("Done when");
  fireEvent.change(screen.getByLabelText("Done when"), { target: { value: "Pairing and recovery checks pass" } });
  const buttons = screen.getAllByRole("button", { name: "Prepare task" }); fireEvent.click(buttons.at(-1)!);
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  const calls = fetch.mock.calls as unknown as [string, RequestInit][];
  const post = calls.find(([url]) => url.endsWith("/prepare"))!;
  expect(JSON.parse(post[1].body as string)).toMatchObject({ expected_revision: 7, expected_work_revision: 3, definition_of_done: "Pairing and recovery checks pass", assignee_id: "andrew" });
  expect(calls.some(([url, options]) => options.method === "POST" && (url.endsWith("/start") || url.endsWith("/release")))).toBe(false);
});
it("tells the owner that preparing releases a hold only where the server will release it", async () => {
  // mirrors op_prepare: the FIRST prepare of a start-held task in an already-started Workflow releases it
  const cases = [
    { started: true, state: "draft" as const, hold: true, releases: true },
    { started: true, state: "prepared" as const, hold: true, releases: false },
    { started: true, state: "draft" as const, hold: false, releases: false },
    { started: false, state: "draft" as const, hold: true, releases: false },
  ];
  for (const c of cases) {
    const task = exampleTask({ preparation_state: c.state, start_hold: c.hold, available_actions: [{ action: "prepare", enabled: true }] });
    const detail = exampleWorkflow({ capability: writeCapability, launch_enabled: c.started, tasks: [task] });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(detail)));
    const view = render(<WorkflowTaskActions detail={detail} task={task} scope={scope()} verified stale={false} agents={[]} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Manage Build Android" }));
    fireEvent.click(screen.getByRole("button", { name: "Prepare task" }));
    await screen.findByLabelText("Done when");
    expect(!!screen.queryByText(/already started, so preparing this task also releases its start hold/), JSON.stringify(c)).toBe(c.releases);
    expect(!!screen.queryByText("Preparing does not start this task or release any hold."), JSON.stringify(c)).toBe(!c.releases);
    view.unmount();
  }
});
it("uses the generated stop route with exact revisions and never claims shutdown from a request", async () => {
  const { detail, task } = taskCase("stop"); const fetch = vi.fn(async (url: string) => jsonResponse(url.includes("release-check") ? exampleImpact(detail, url) : detail)); const onSaved = vi.fn(); vi.stubGlobal("fetch", fetch);
  render(<WorkflowTaskActions detail={detail} task={task} scope={scope()} verified stale={false} agents={[]} onSaved={onSaved} />);
  fireEvent.click(screen.getByRole("button", { name: "Manage Build Android" }));
  fireEvent.click(screen.getByRole("button", { name: "Stop this task" }));
  fireEvent.change(await screen.findByLabelText("Reason"), { target: { value: "The worker has stopped responding" } });
  expect(screen.getByText(/requesting a stop is not confirmation/)).toBeVisible();
  fireEvent.click(screen.getAllByRole("button", { name: "Stop this task" }).at(-1)!);
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  const posts = (fetch.mock.calls as unknown as [string, RequestInit][]).filter(([, options]) => options.method === "POST");
  expect(posts).toHaveLength(1); expect(posts[0][0]).toBe("/api/tasks/build/stop");
  expect(JSON.parse(String(posts[0][1].body))).toMatchObject({ expected_revision: 7, expected_work_revision: 3, reason: "The worker has stopped responding" });
});
it("releases only explicitly selected holds and leaves unrelated holds to the server", async () => {
  const { detail, task } = taskCase("release"); task.available_actions[0].holds = ["start", "human"]; task.human_hold_by = "kedar"; task.human_hold_reason = "Review scope";
  const fetch = vi.fn(async (url: string) => jsonResponse(url.includes("release-check") ? exampleImpact(detail, url) : detail)); const onSaved = vi.fn(); vi.stubGlobal("fetch", fetch);
  render(<WorkflowTaskActions detail={detail} task={task} scope={scope()} verified stale={false} agents={[]} onSaved={onSaved} />);
  fireEvent.click(screen.getByRole("button", { name: "Manage Build Android" })); fireEvent.click(screen.getByRole("button", { name: "Release holds" }));
  fireEvent.change(await screen.findByLabelText("Reason"), { target: { value: "Ready for the next step" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "Release start hold" }));
  fireEvent.click(screen.getAllByRole("button", { name: "Release holds" }).at(-1)!); await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  const post = (fetch.mock.calls as unknown as [string, RequestInit][]).find(([url]) => url.endsWith("/release"))!;
  expect(JSON.parse(String(post[1].body))).toMatchObject({ holds: ["start"], task_ids: ["build"], task_revisions: { build: 3 } });
  expect(JSON.parse(String(post[1].body))).not.toHaveProperty("expected_work_revision");
});
it("requires the server's release verdict and explicit risk acceptance, regardless of local elapsed time", async () => {
  const { detail, task } = taskCase("release_lost_worker"); task.display_state.release_available_at = "2020-01-01T00:00:00Z"; task.display_state.release_available = false;
  const fetch = vi.fn(async () => jsonResponse(detail)); vi.stubGlobal("fetch", fetch);
  render(<WorkflowTaskActions detail={detail} task={task} scope={scope()} verified stale={false} agents={[]} onSaved={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Manage Build Android" })); fireEvent.click(screen.getByRole("button", { name: "Release lost worker" }));
  fireEvent.change(await screen.findByLabelText("Reason"), { target: { value: "Worker remains unreachable" } });
  fireEvent.click(screen.getByRole("checkbox", { name: /I understand/ }));
  expect(screen.getAllByRole("button", { name: "Release lost worker" }).at(-1)).toBeDisabled(); expect(fetch).toHaveBeenCalledTimes(1);
});
it("keeps a newly denied task action disabled after refreshing the review", async () => {
  const { detail, task } = taskCase("hold"); const denied = exampleWorkflow({ capability: { workflow_read: true, workflow_human_write: false, reason: "workflow_owner_required" }, tasks: [{ ...task, available_actions: [{ action: "hold", enabled: false, reason: "workflow_owner_required" }] }] });
  const fetch = vi.fn(async () => jsonResponse(denied)); vi.stubGlobal("fetch", fetch);
  render(<WorkflowTaskActions detail={detail} task={task} scope={scope()} verified stale={false} agents={[]} onSaved={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Manage Build Android" })); fireEvent.click(screen.getByRole("button", { name: "Put on hold" }));
  fireEvent.change(await screen.findByLabelText("Reason"), { target: { value: "Pause for review" } });
  const dialog = within(screen.getByRole("dialog")); expect(dialog.getAllByRole("button", { name: "Put on hold" }).at(-1)).toBeDisabled();
  expect(screen.getByText(/Only this workflow’s owner/)).toBeVisible(); expect(fetch).toHaveBeenCalledTimes(1);
});
it("allows a project owner's safety hold from the per-action permission, without granting Stop", async () => {
  const { task, detail } = taskCase("hold"); detail.capability = { workflow_read: true, workflow_human_write: false, reason: "workflow_owner_required" };
  task.available_actions[0].permission = "workflow_or_project_owner";
  const saved = vi.fn(); const posts: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => { if (init?.method === "POST") posts.push(url); return jsonResponse(detail); }));
  render(<WorkflowTaskActions detail={detail} task={task} scope={scope()} verified stale={false} agents={[]} onSaved={saved} />);
  fireEvent.click(screen.getByRole("button", { name: "Manage Build Android" }));
  expect(screen.getByRole("button", { name: "Stop this task" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Put on hold" }));
  fireEvent.change(await screen.findByLabelText("Reason"), { target: { value: "Safety review" } });
  fireEvent.click(screen.getAllByRole("button", { name: "Put on hold" }).at(-1)!);
  await waitFor(() => expect(saved).toHaveBeenCalledOnce()); expect(posts).toEqual(["/api/tasks/build/hold"]);
});
it("offers only the holds the server says this reader may release", async () => {
  const { task, detail } = taskCase("release"); task.human_hold_by = "owner"; task.available_actions[0].holds = ["human"];
  detail.capability = { workflow_read: true, workflow_human_write: false, reason: "workflow_owner_required" };
  const posts: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => { if (init?.method === "POST") posts.push(JSON.parse(String(init.body))); return jsonResponse(url.includes("release-check") ? exampleImpact(detail, url) : detail); }));
  render(<WorkflowTaskActions detail={detail} task={task} scope={scope()} verified stale={false} agents={[]} onSaved={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Manage Build Android" })); fireEvent.click(screen.getByRole("button", { name: "Release holds" }));
  fireEvent.change(await screen.findByLabelText("Reason"), { target: { value: "My hold is resolved" } });
  expect(screen.getByRole("checkbox", { name: /Release start hold/ })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: /Release human hold/ }));
  expect(screen.getAllByRole("button", { name: "Release holds" }).at(-1)).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Check selected holds" }));
  await waitFor(() => expect(screen.getAllByRole("button", { name: "Release holds" }).at(-1)).toBeEnabled());
  fireEvent.click(screen.getAllByRole("button", { name: "Release holds" }).at(-1)!);
  await waitFor(() => expect(posts).toHaveLength(1)); expect(posts[0].holds).toEqual(["human"]);
});
it("calls withdrawn outside evidence Let worker start without automatically retrying", async () => {
  const { task, detail } = taskCase("retry"); task.awaiting_owner_decision = "evidence_withdrawn";
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  render(<WorkflowTaskActions detail={detail} task={task} scope={scope()} verified stale={false} agents={[]} onSaved={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Manage Build Android" }));
  expect(screen.getByRole("button", { name: "Let worker start" })).toBeEnabled(); expect(fetch).not.toHaveBeenCalled();
});

it("invalidates a dependency review after an edit and freezes it during an uncertain save", async () => {
  const { detail, task } = taskCase("dependencies");
  detail.tasks.push(exampleTask({ id: "prerequisite", title: "Prepare release" }));
  const writes: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "PUT") { writes.push(String(init.body)); throw new TypeError("Lost response"); }
    return jsonResponse(detail);
  }));
  render(<WorkflowTaskActions detail={detail} task={task} scope={scope()} verified stale={false} agents={[]} onSaved={vi.fn()} inline request={{ action: "dependencies", seq: 1 }} />);
  fireEvent.change(await screen.findByLabelText("Reason"), { target: { value: "Require release preparation" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "Prepare release" }));
  const dialog = within(screen.getByRole("dialog"));
  expect(dialog.getByRole("button", { name: "Edit dependencies" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Review dependency change" }));
  await waitFor(() => expect(dialog.getByRole("button", { name: "Edit dependencies" })).toBeEnabled());
  fireEvent.click(dialog.getByRole("button", { name: "Edit dependencies" }));
  await screen.findByRole("button", { name: "Check saved result" });
  expect(screen.getByLabelText("Reason")).toBeDisabled();
  expect(screen.getByRole("checkbox", { name: "Prepare release" })).toBeDisabled();
  expect(JSON.parse(writes[0])).toMatchObject({ depends_on: ["prerequisite"], expected_revision: 7, expected_work_revision: 3 });
});
