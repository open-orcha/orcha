import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowHide } from "./WorkflowHide";
import type { VisibilityCheck, WorkflowDetail } from "./workflowContract.generated";
import { exampleWorkflow, jsonResponse, writeCapability } from "./workflowTestFixtures";
const scope = () => ({ origin: "https://orcha.example", project: "project", identity: crypto.randomUUID() });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const visibility = (patch: Partial<VisibilityCheck> = {}): VisibilityCheck =>
  ({ revision: 7, title: "Mobile release", status: "completed", hidden: false, task_count: 8, live_turns: 0, can_hide: true, can_restore: false, blockers: [], ...patch });
const detailFor = (action: "hide" | "restore", patch: Partial<WorkflowDetail> = {}) =>
  exampleWorkflow({ status: "completed", capability: writeCapability, available_actions: [{ action, enabled: true }], ...patch });

it("runs the server's visibility check on open and requires a new check once the workflow revision moves", async () => {
  const calls: [string, RequestInit | undefined][] = []; const checks = [visibility(), visibility({ revision: 8 })];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => { calls.push([url, init]); return jsonResponse(checks.shift() ?? visibility({ revision: 8 })); }));
  const detail = detailFor("hide"); const control = { open: true, onOpenChange: vi.fn() };
  const view = render(<WorkflowHide detail={detail} scope={scope()} verified stale={false} mode="hide" control={control} onSaved={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Hide workflow" })).toBeEnabled());
  expect(calls).toEqual([["/api/workflows/release/visibility-check", expect.objectContaining({ method: "GET" })]]);
  expect(screen.getByText("Mobile release")).toBeVisible(); expect(screen.getByText(/8 tasks/)).toBeVisible();
  expect(screen.getByText(/Removes this workflow from the usual list/)).toBeVisible();
  view.rerender(<WorkflowHide detail={{ ...detail, revision: 8 }} scope={scope()} verified stale={false} mode="hide" control={control} onSaved={vi.fn()} />);
  expect(screen.getByText("The workflow changed. Check again.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Hide workflow" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Hide workflow" })).toBeEnabled()); expect(calls).toHaveLength(2);
});

it("keeps Hide unavailable when the server refuses and shows its blocker without offering cancellation here", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(visibility({ status: "active", live_turns: 1, can_hide: false, blockers: [{ code: "live_turns", message: "A worker turn is still running" }] }))));
  const onOpenChange = vi.fn();
  render(<WorkflowHide detail={detailFor("hide", { status: "active" })} scope={scope()} verified stale={false} mode="hide" control={{ open: true, onOpenChange }} onSaved={vi.fn()} />);
  expect(await screen.findByText("A worker turn is still running")).toBeVisible();
  expect(screen.getByText("Review cancellation from the workflow menu first.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Hide workflow" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Keep visible" })); expect(onOpenChange).toHaveBeenCalledWith(false);
});

it("sends POST /hide with the checked revision, reports the saved workflow and closes", async () => {
  const writes: [string, Record<string, unknown>][] = []; const saved = vi.fn(); const onOpenChange = vi.fn();
  const result = exampleWorkflow({ status: "completed", hidden: true, revision: 8 });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") { writes.push([url, JSON.parse(String(init.body))]); return jsonResponse(result); }
    return jsonResponse(visibility());
  }));
  render(<WorkflowHide detail={detailFor("hide")} scope={scope()} verified stale={false} mode="hide" control={{ open: true, onOpenChange }} onSaved={saved} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Hide workflow" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Hide workflow" }));
  await waitFor(() => expect(saved).toHaveBeenCalledWith(result));
  expect(writes).toEqual([["/api/workflows/release/hide", expect.objectContaining({ expected_revision: 7 })]]);
  expect(Object.keys(writes[0][1]).sort()).toEqual(["expected_revision", "idempotency_key"]); expect(writes[0][1].idempotency_key).toBeTruthy();
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it("uses restore copy and sends POST /restore when the server allows it", async () => {
  const writes: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") { writes.push(url); return jsonResponse(exampleWorkflow({ status: "completed" })); }
    return jsonResponse(visibility({ hidden: true, can_hide: false, can_restore: true }));
  }));
  render(<WorkflowHide detail={detailFor("restore", { hidden: true })} scope={scope()} verified stale={false} mode="restore" control={{ open: true, onOpenChange: vi.fn() }} onSaved={vi.fn()} />);
  expect(await screen.findByText(/Puts this workflow back in the usual list/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Keep hidden" })).toBeEnabled(); expect(screen.queryByRole("button", { name: "Hide workflow" })).toBeNull();
  await waitFor(() => expect(screen.getByRole("button", { name: "Restore workflow" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Restore workflow" }));
  await waitFor(() => expect(writes).toEqual(["/api/workflows/release/restore"]));
});
