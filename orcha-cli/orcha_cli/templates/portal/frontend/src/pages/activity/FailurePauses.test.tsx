import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FailurePauses } from "./FailurePauses";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const paused = { agent_id: "a1", alias: "Builder", wake_key: "run_failure", paused: true };

describe("failure pause recovery", () => {
  it("shows the pause and uses the human release endpoint once", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, json: async () => ({ backoffs: [paused] }) } as Response);
    const resume = vi.fn();
    render(<FailurePauses cid="c1" humanId="h1" nonce={0} onResume={resume} />);
    const button = await screen.findByRole("button", { name: "Resume automatic work" });
    expect(screen.getByRole("status").textContent).toContain("Builder's automatic work is paused");
    fireEvent.click(button);
    await waitFor(() => expect(resume).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledWith("/api/containers/c1/agents/a1/wake-backoff/run_failure", expect.objectContaining({ method: "DELETE", body: JSON.stringify({ actor_agent_id: "h1" }) }));
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("keeps a failed resume visible, and never lets a read-only viewer resume", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({ ok: true, json: async () => ({ backoffs: [paused] }) } as Response)
      .mockRejectedValue(new Error("offline"));
    const resume = vi.fn();
    const view = render(<FailurePauses cid="c1" humanId={null} nonce={0} onResume={resume} />);
    const button = await screen.findByRole("button", { name: "Resume automatic work" });
    expect(button).toBeDisabled();
    view.rerender(<FailurePauses cid="c1" humanId="h1" nonce={0} onResume={resume} />);
    fireEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't resume automatic work");
    expect(screen.getByRole("button")).toBeEnabled();
    expect(resume).not.toHaveBeenCalled();
  });
});
