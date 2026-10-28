import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { TaskMessageDelivery, type MessageDelivery } from "./TaskMessageDelivery";
import { WorkflowDiscussion } from "../workflows/WorkflowDiscussion";

vi.mock("../../state/SnapshotProvider", () => ({
  useSnapshot: () => ({ cid: "project", identity: { agent_id: "kedar" }, identityTrusted: true, identityPending: false }),
  useActingAuthority: () => ({ human: { id: "kedar", kind: "human" } }),
}));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); });
const response = (data: unknown) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
function guidance(state: MessageDelivery["state"]): MessageDelivery {
  return { task_id: "task", state, reason: "Server explanation", task_href: "/tasks?cid=project&task=task",
    recipients: state === "no_assignee" ? [] : [{ agent_id: "ann", alias: "Ann", state, reason: "Current server reason", direct_chat_href: "/agents?cid=project&agent=Ann&tab=conversation" }] };
}
it.each(["deliverable_now", "deferred_until_eligible", "worker_running", "no_assignee", "task_finished", "wake_disabled_or_paused", "unknown"] as const)("shows %s with server guidance without promising a reply", async (state) => {
  vi.stubGlobal("fetch", vi.fn(async () => response(guidance(state))));
  render(<MemoryRouter><TaskMessageDelivery taskId="task" sent={1} /></MemoryRouter>);
  expect(await screen.findByText(state === "no_assignee" ? /Server explanation/ : /Current server reason/)).toBeVisible();
  expect(screen.getByText("Message saved. Saving does not mean the agent has answered.")).toBeVisible();
  if (state !== "no_assignee") {
    expect(screen.getByRole("link", { name: "Open Ann’s direct chat" })).toHaveAttribute("href", "/agents?cid=project&agent=Ann&tab=conversation");
    expect(screen.getByRole("link", { name: "this task’s link" })).toHaveAttribute("href", "/tasks?cid=project&task=task");
  }
});
it("refreshes after sending and never hardcodes a waiting-workflow policy", async () => {
  let state: MessageDelivery["state"] = "deferred_until_eligible";
  const fetch = vi.fn(async () => response(guidance(state))); vi.stubGlobal("fetch", fetch);
  const view = render(<MemoryRouter><TaskMessageDelivery taskId="task" /></MemoryRouter>);
  await screen.findByText(/Message waits/);
  state = "deliverable_now";
  view.rerender(<MemoryRouter><TaskMessageDelivery taskId="task" sent={1} /></MemoryRouter>);
  await screen.findByText(/Can request a wake/);
  expect(fetch).toHaveBeenCalledTimes(2);
  view.rerender(<MemoryRouter><TaskMessageDelivery taskId="task" sent={1} /></MemoryRouter>);
  expect(fetch).toHaveBeenCalledTimes(2);
});
it("clears another task's guidance and gives a safe fallback on failure", async () => {
  const fetch = vi.fn(async () => response(guidance("deferred_until_eligible"))); vi.stubGlobal("fetch", fetch);
  const view = render(<MemoryRouter><TaskMessageDelivery taskId="task" /></MemoryRouter>);
  await screen.findByRole("link", { name: "Open Ann’s direct chat" });
  fetch.mockRejectedValue(new Error("offline"));
  view.rerender(<MemoryRouter><TaskMessageDelivery taskId="other" /></MemoryRouter>);
  expect(screen.queryByRole("link", { name: "Open Ann’s direct chat" })).toBeNull();
  await screen.findByText(/Delivery could not be checked/);
});
it("workflow composer refreshes the shared guidance after a successful save", async () => {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/delivery")) return response(guidance("deferred_until_eligible"));
    if (init?.method === "POST") return response({ message_id: "saved" });
    return response({ task_id: "task", messages: [] });
  }); vi.stubGlobal("fetch", fetch);
  render(<MemoryRouter><WorkflowDiscussion taskId="task" scope={{ origin: "http://localhost", project: "project", identity: "kedar" }} /></MemoryRouter>);
  await screen.findByText(/Message waits/);
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "What is waiting?" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText("Message saved. Saving does not mean the agent has answered.");
  await waitFor(() => expect(fetch.mock.calls.filter(([url]) => url.endsWith("/delivery"))).toHaveLength(2));
  expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});
