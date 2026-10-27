import { describe, expect, it } from "vitest";
import { availableActionReason } from "./workflowApi";

type Capability = Parameters<typeof availableActionReason>[0];
type Actions = NonNullable<Parameters<typeof availableActionReason>[1]>;

const capability = { workflow_read: true, workflow_human_write: true, reason: null } as Capability;
const disabled = (action: string, reason: string) => [{ action, enabled: false, reason, permission: "workflow_owner", holds: null }] as unknown as Actions;

describe("disabled workflow actions explain what to do", () => {
  it("tells a local human that Start needs a prepared task", () => {
    const reason = availableActionReason(capability, disabled("start", "prepared_selection_required"), "start", true);
    expect(reason).toMatch(/Prepare at least one task/);
    expect(reason).not.toMatch(/Refresh to check/);
  });

  it("names the other Start and Resume states instead of the generic fallback", () => {
    expect(availableActionReason(capability, disabled("start", "already_started"), "start", true)).toBe("This workflow has already started.");
    expect(availableActionReason(capability, disabled("resume", "workflow_not_paused"), "resume", true)).toBe("The workflow is not paused.");
  });

  it("keeps the generic message for a reason it does not know", () => {
    expect(availableActionReason(capability, disabled("start", "something_new"), "start", true)).toMatch(/Refresh to check/);
  });
});
