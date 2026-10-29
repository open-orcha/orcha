import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowRunAgain } from "./WorkflowRunAgain";
import { pendingOperation } from "./workflowOperations";
import { exampleWorkflow, jsonResponse, writeCapability } from "./workflowTestFixtures";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("recovers the NEW draft from a lost response without creating or starting another run", async () => {
  const scope = { origin: "https://orcha.example", project: "project", identity: crypto.randomUUID() };
  const source = exampleWorkflow({ status: "completed", capability: writeCapability, available_actions: [{ action: "run_again", enabled: true }] });
  const draft = exampleWorkflow({ id: "copied-workflow", launch_enabled: false });
  const saved = vi.fn(); const writes: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") { writes.push(url); throw new TypeError("response lost"); }
    const op = pendingOperation(scope, `workflow:${source.id}`)!;
    return jsonResponse({ status: "saved", operation: "run_again", idempotency_key: op.key, result: draft });
  }));
  render(<WorkflowRunAgain detail={source} scope={scope} verified stale={false} control={{ open: true, onOpenChange: vi.fn() }} onSaved={saved} />);
  fireEvent.click(screen.getByRole("button", { name: "Create editable draft" }));
  await screen.findByRole("button", { name: "Check saved result" });
  expect(pendingOperation(scope, `workflow:${source.id}`)?.expectedWorkflowId).toBeUndefined();
  expect(screen.getByRole("button", { name: "Create editable draft" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Check saved result" }));
  await waitFor(() => expect(saved).toHaveBeenCalledWith(draft));
  expect(writes).toEqual(["/api/workflows/release/run_again"]);
});
