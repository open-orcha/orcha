import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TaskAuthority } from "./TaskAuthority";
import type { Task } from "../../types";
import { jsonResponse } from "../workflows/workflowTestFixtures";
let identity = "kedar";
let role: string | undefined = "owner";
let readOnly = false;
const refresh = vi.fn();
vi.mock("../../state/SnapshotProvider", () => ({
  useSnapshot: () => ({ cid: "project", identity: { agent_id: identity }, identityTrusted: true, identityPending: false, refresh }),
  useActingAuthority: () => ({ human: readOnly ? null : { id: identity, kind: "human", member_role: role }, reason: readOnly ? "Read-only connection" : null, readOnly, pending: false }),
}));
const spec = { paths: { "/api/tasks/{tid}/autonomy": { put: {} }, "/api/tasks/{tid}/approvals": { get: {} } } };
const task = { id: "build", status: "in_progress", autonomy: "off", autonomy_revision: 1, is_root: false } as Task;
beforeEach(() => { identity = "kedar"; role = "owner"; readOnly = false; refresh.mockClear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("offers only OFF/ON after discovery and records a deliberately confirmed owner choice", async () => {
  const writes: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/openapi.json") return jsonResponse(spec);
    writes.push(JSON.parse(String(init?.body))); return jsonResponse({ task_id: "build", autonomy: "on", autonomy_revision: 2, changed: true });
  }));
  render(<TaskAuthority task={task} />);
  await waitFor(() => expect(screen.getByRole("switch", { name: "Task autonomy", checked: false })).toBeEnabled());
  fireEvent.click(screen.getByRole("switch", { name: "Task autonomy", checked: false })); expect(writes).toEqual([]);
  expect(screen.getByText(/Completed work, dependencies, holds/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Save ON" }));
  await screen.findByText("Task autonomy ON saved. It applies to future actions.");
  expect(writes).toEqual([{ autonomy: "on", actor_agent_id: "kedar" }]);
  expect(screen.getByRole("switch", { name: "Task autonomy", checked: true })).toBeEnabled();
});
it.each(["viewer", "member", "unknown", "offline"])("never permits %s authority to change the task", async (kind) => {
  if (kind === "offline") readOnly = true; else role = kind === "unknown" ? undefined : kind;
  const fetch = vi.fn(async () => jsonResponse(spec)); vi.stubGlobal("fetch", fetch);
  render(<TaskAuthority task={task} />); await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  expect(screen.getByRole("switch", { name: "Task autonomy", checked: false })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Save ON" })).toBeNull();
});
it("keeps unsupported and failed discovery distinct and sends no setting change", async () => {
  const fetch = vi.fn(async () => jsonResponse({ paths: {} })); vi.stubGlobal("fetch", fetch);
  const view = render(<TaskAuthority task={task} />);
  await screen.findByText("Task autonomy changes are unavailable on this server.");
  expect(screen.getByRole("switch", { name: "Task autonomy", checked: false })).toBeDisabled();
  view.unmount(); fetch.mockImplementation(async () => { throw new Error("offline"); }); render(<TaskAuthority task={task} />);
  await screen.findByText("Task authority could not be checked. Refresh before changing it.");
  expect(screen.getByRole("switch", { name: "Task autonomy", checked: false })).toBeDisabled();
});
it.each(["lost", "malformed", "wrong task"])("reports a %s response as unconfirmed and never automatically repeats it", async (kind) => {
  let writes = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/openapi.json") return jsonResponse(spec);
    if (init?.method === "PUT") {
      writes++;
      if (kind === "lost") throw new Error("response lost");
      return jsonResponse(kind === "malformed" ? {} : { task_id: "wrong", autonomy: "on", autonomy_revision: 2, changed: true });
    }
    return jsonResponse({ container: { id: "project" }, tasks: [{ ...task, autonomy: "on", autonomy_revision: 2 }], agents: [], requests: [] });
  }));
  render(<TaskAuthority task={task} />);
  await waitFor(() => expect(screen.getByRole("switch", { name: "Task autonomy", checked: false })).toBeEnabled());
  fireEvent.click(screen.getByRole("switch", { name: "Task autonomy", checked: false })); fireEvent.click(screen.getByRole("button", { name: "Save ON" }));
  await screen.findByText(/The change is unconfirmed/);
  expect(screen.getByRole("switch", { name: "Task autonomy", checked: false })).toBeDisabled(); expect(writes).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: "Check current setting" }));
  await screen.findByText(/Current setting: ON. The earlier change has no save receipt/);
  expect(writes).toBe(1); expect(screen.queryByText(/autonomy ON saved/)).toBeNull();
});
it("keeps plan and completion approvals distinct, with recorded authority and fingerprints", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => jsonResponse(url === "/openapi.json" ? spec : { task_id: "build", approvals: [
    { id: "plan", phase: "plan", work_revision: 2, actor_id: "andrew", actor_kind: "ai", actor_alias: "Andrew", autonomy_at_approval: "on", autonomy_revision: 4, permission_source: "task_autonomy", requirements_sha256: "a".repeat(64), submission_sha256: "b".repeat(64), approved_at: "2026-10-25T10:00:00Z" },
  ] })));
  render(<TaskAuthority task={task} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Read approval history" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Read approval history" }));
  const history = await screen.findByLabelText("Recorded task approvals");
  expect(within(history).getByText(/Andrew \(agent\) approved work revision 2/)).toBeVisible();
  expect(within(history).getByText("No finished-work approval recorded.")).toBeVisible();
  expect(within(history).getByText(/Requirements:/)).toHaveTextContent("a".repeat(64));
});
it("clears prior approval reads and confirmations immediately when the identity changes", async () => {
  let delayed = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => delayed ? new Promise<Response>(() => {}) : jsonResponse(url === "/openapi.json" ? spec : { task_id: "build", approvals: [] })));
  const view = render(<TaskAuthority task={task} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Read approval history" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Read approval history" })); await screen.findByLabelText("Recorded task approvals");
  fireEvent.click(screen.getByRole("switch", { name: "Task autonomy", checked: false }));
  identity = "another-reader"; delayed = true; view.rerender(<TaskAuthority task={task} />);
  expect(screen.queryByLabelText("Recorded task approvals")).toBeNull(); expect(screen.queryByRole("button", { name: "Save ON" })).toBeNull();
});
