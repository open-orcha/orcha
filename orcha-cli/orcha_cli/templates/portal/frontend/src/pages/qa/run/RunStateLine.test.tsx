import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { QaSession } from "../qaApi";
import { RunStateLine } from "./RunStateLine";

vi.mock("../../../state/SnapshotProvider", () => ({ useSnapshot: () => ({ cid: "c1", snap: { agents: [{ id: "a1", alias: "tess" }] } }) }));

const session = (over: object = {}) => ({ id: "s1", status: "running", task_id: "t1", agent_alias: "tess", ...over }) as unknown as QaSession;
const answer = (requests: object[]) => { global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ requests }) })) as unknown as typeof fetch; };
const mount = (s: QaSession, from: string | null = null, onContinue = () => undefined) => render(<MemoryRouter><RunStateLine session={s} from={from} onContinue={onContinue} /></MemoryRouter>);

afterEach(cleanup);

describe("RunStateLine", () => {
  it("reads a queued place off the session, where GET .../run keeps it", async () => {
    answer([]);
    mount(session({ queue: { position: 1, waiting: "tess", device: "iPhone 17 Pro", used_by: "Checkout map" } }));
    expect(await screen.findByText(/Waiting for iPhone 17 Pro · used by Checkout map/)).toBeInTheDocument();
    expect(screen.getByText(/Next in line/)).toBeInTheDocument();
  });

  it("shows the question a blocked agent asked, and a link, from the server rather than the snapshot", async () => {
    answer([
      { id: "r9", status: "open", originating_task_id: "other", created_at: "2026-11-05T11:00:00Z", payload: "Not this one", requester_id: "a1" },
      { id: "r1", status: "open", originating_task_id: "t1", created_at: "2026-11-05T10:00:00Z", payload: "Which staging login?", requester_id: "a1" },
    ]);
    mount(session());
    expect(await screen.findByText("tess is waiting for an answer: Which staging login?")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the request" })).toHaveAttribute("href", "/requests?req=r1");
  });

  it("a blocked agent comes before a place in line", async () => {
    answer([{ id: "r1", status: "open", originating_task_id: "t1", created_at: "2026-11-05T10:00:00Z", payload: "Which login?", requester_id: "a1" }]);
    mount(session({ queue: { position: 1, waiting: "tess" } }));
    await waitFor(() => expect(document.querySelector("[data-run-line]")?.getAttribute("data-run-line")).toBe("blocked"));
  });

  it("an ended run from onboarding offers Continue; elsewhere it says nothing", async () => {
    answer([]);
    const go = vi.fn();
    mount(session({ status: "done" }), "?step=map&after=live", go);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(go).toHaveBeenCalled();
    cleanup();
    mount(session({ status: "done" }), "?view=map");
    expect(document.querySelector("[data-run-line]")).toBeNull();
  });
});
