import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PauseNoticeResume } from "./PauseNoticeResume";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const paused = { agent_id: "a1", alias: "Builder", wake_key: "run_failure", paused: true, notice_request_id: "r1" };
const ok = (data: unknown) => ({ ok: true, json: async () => data } as Response);

describe("resume from the pause notice", () => {
  it("offers Resume only on the notice that owns the pause and calls the notice endpoint", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok({ backoffs: [paused] }));
    const resumed = vi.fn();
    render(<PauseNoticeResume cid="c1" requestId="r1" humanId="h1" onResumed={resumed} />);
    const button = await screen.findByRole("button", { name: "Resume automatic work" });
    expect(screen.getByRole("status").textContent).toContain("Answering or nudging won't restart it");
    fireEvent.click(button);
    await waitFor(() => expect(resumed).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledWith("/api/requests/r1/resume-automatic-work", expect.objectContaining({ method: "POST", body: JSON.stringify({ actor_agent_id: "h1" }) }));
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("shows nothing on other requests, even from the same paused agent", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok({ backoffs: [paused] }));
    render(<PauseNoticeResume cid="c1" requestId="r2" humanId="h1" onResumed={vi.fn()} />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("keeps a failed resume visible, and never lets a read-only viewer resume", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(ok({ backoffs: [paused] })).mockRejectedValue(new Error("offline"));
    const resumed = vi.fn();
    const view = render(<PauseNoticeResume cid="c1" requestId="r1" humanId={null} onResumed={resumed} />);
    const button = await screen.findByRole("button", { name: "Resume automatic work" });
    expect(button).toBeDisabled();
    view.rerender(<PauseNoticeResume cid="c1" requestId="r1" humanId="h1" onResumed={resumed} />);
    fireEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't resume automatic work");
    expect(resumed).not.toHaveBeenCalled();
  });
});
