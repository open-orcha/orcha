/** Send to QA: a person picks the scenarios a check runs. */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { SendToQaDialog } from "./SendToQaDialog";

vi.mock("../../../state/SnapshotProvider", () => ({
  useSnapshot: () => ({ cid: "c1", snap: { agents: [{ id: "qa", alias: "QAEngineer", kind: "ai", status: "idle", role: "qa" }] } }),
  useActingAuthority: () => ({ human: { id: "h1", kind: "human", member_role: "owner" }, pending: false }),
}));

const sent: unknown[] = [];
const json = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;

function stub() {
  sent.length = 0;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") { sent.push(JSON.parse(String(init.body))); return json({ request: { id: "r1" }, qa_task_id: "t2" }, 201); }
    if (url.includes("/qa/targets")) return json({ targets: [{ platform: "ios", app_id: "com.acme" }] });
    if (url.includes("/qa/settings")) return json({ agent_id: "qa", default_platform: "ios", trigger: "manual", on_fail: "report", max_rounds: 3 });
    if (url.includes("/qa/overview")) return json({ ios: { scenarios: { validated: 2 } }, android: { scenarios: {} }, web: { scenarios: {} } });
    if (url.includes("/qa/scenarios")) return json({ scenarios: [{ id: "s1", name: "Sign in", status: "validated", platform: "ios" }, { id: "s2", name: "Pay", status: "validated", platform: "ios" }, { id: "s3", name: "A draft", status: "draft", platform: "ios" }] });
    return json({});
  }) as unknown as typeof fetch;
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("sends only the approved scenarios a person picked", async () => {
  stub();
  render(<MemoryRouter><SendToQaDialog task={{ id: "t1", title: "A task", definition_of_done: "It works" }} onClose={() => {}} /></MemoryRouter>);
  const group = await screen.findByRole("group", { name: "Scenarios to check" });
  fireEvent.click(await within(group).findByRole("checkbox", { name: "Pay" }));
  expect(within(group).queryByRole("checkbox", { name: "A draft" })).toBeNull();
  fireEvent.click(screen.getAllByRole("button", { name: "Send to QA" }).at(-1)!);
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]).toMatchObject({ kind: "check", platform: "ios", scenario_ids: ["s2"] });
});
