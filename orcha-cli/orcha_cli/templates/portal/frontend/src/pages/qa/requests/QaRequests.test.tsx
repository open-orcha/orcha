/** The Requests view, Send to QA and QA settings, against a stubbed API: reads, sends, the human gate. */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ToastProvider } from "../../../components/ui";
import { SnapshotProvider } from "../../../state/SnapshotProvider";
import { installFlowEnv, removeFlowEnv } from "../map/kit/testEnv";
import { QaPage } from "../QaPage";
import { FINISH_ALONE_LABEL } from "../runTask/finishing";
import { TaskQaSection } from "../TaskQaSection";

interface Call { url: string; method: string; body: any }
let calls: Call[] = [];

const HUMAN = { id: "h1", alias: "kedar", kind: "human", role: "Founder", status: "idle" };
const TESS = { id: "a1", alias: "tess", kind: "ai", role: "QA", status: "idle" };
const FORGE = { id: "a2", alias: "forge", kind: "ai", role: "Builder", status: "idle" };
const TASK = { id: "t1", title: "Fix the reset flow", status: "in_progress", definition_of_done: "- Reset email arrives\n- Link opens the app" };

const snap = (withHuman: boolean) => ({
  container: { id: "c1", name: "Acme", status: "active", autonomy_level: "plan" },
  agents: withHuman ? [HUMAN, TESS, FORGE] : [TESS, FORGE],
  tasks: [TASK],
  requests: [],
});

const FAILED = {
  id: "r1", kind: "check", platform: "ios", origin: "handoff", source_task_id: "t1", source_workflow_id: "w1", source_workflow_title: "Release 2.1", requested_by_agent_id: "a2", qa_task_id: "q1", round: 2, max_rounds: 3,
  scenario_ids: ["sc1"], tags: ["auth"], focus: "Password reset", acceptance: ["Reset email arrives", "Link opens the app"], build: { branch: "feat/reset", commit: "abc1234", notes: "Use the staging mailbox" },
  on_fail: "reopen", status: "failed", created_at: "2026-11-05T10:00:00Z", finished_at: "2026-11-05T10:20:00Z",
  result: {
    summary: "The reset email never arrives.",
    lines: [{ line_index: 0, verdict: "fail", note: "Nothing after two minutes", frame_ids: ["fr1"], session_id: "s1" }, { line_index: 1, verdict: "pass", note: null, frame_ids: ["fr2"], session_id: "s1" }],
    scenarios: [{ scenario_id: "sc1", scenario_name: "Reset a password", verdict: "fail" }],
    finding_ids: ["fd1"], draft_ids: [], session_ids: ["s1"],
  },
};
const RUNNING = { id: "r2", kind: "explore", platform: "web", origin: "workflow", source_task_id: null, source_workflow_id: "w1", source_workflow_title: "Release 2.1", round: 1, acceptance: [], on_fail: "report", status: "running", result: null, session_id: "s2", created_at: "2026-11-05T11:00:00Z" };
const DETAIL = { ...FAILED, session_id: "s1", findings: [{ id: "fd1", session_id: "s1", severity: "major", title: "Reset email never arrives", actual: "Nothing in the inbox", status: "open", frame_ids: ["fr3"] }],
  rounds: [{ id: "r0", round: 1, status: "failed", summary: "First try failed" }, { id: "r1", round: 2, status: "failed", summary: "Still failing" }] };

let requests: unknown[] = [];
let settings: Record<string, unknown> = {};

function stub(withHuman = true) {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : null;
    if (method !== "GET") calls.push({ url, method, body });
    const json = (data: unknown, status = 200) => ({ ok: status < 300, status, json: async () => data }) as Response;
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1/qa/requests")) return json({ requests });
    if (url.startsWith("/api/qa/requests/") && url.endsWith("/cancel")) return json({ ...RUNNING, status: "cancelled" });
    if (url === "/api/qa/requests/r1") return json(DETAIL);
    if (url.startsWith("/api/qa/requests/")) return json(requests.find((r) => url.endsWith((r as { id: string }).id)) ?? {}, 200);
    if (url.endsWith("/qa/settings") && method === "PUT") return json(body);
    if (url.endsWith("/qa/settings")) return json(settings);
    if (url.endsWith("/qa/targets")) return json({ targets: [{ platform: "ios", app_id: "com.acme.app" }, { platform: "web", app_id: "https://acme.test" }] });
    if (url === "/api/tasks/t1/qa/requests") return json({ request: { ...RUNNING, id: "r9", status: "requested" }, qa_task_id: "q9" });
    if (url === "/api/tasks/t1/qa") return json({ sessions: [], findings: [], scenarios: [], verdicts: [], requests: requests.filter((r) => (r as { source_task_id?: string }).source_task_id === "t1") });
    if (url.startsWith("/api/containers/c1/qa/")) return json({});
    if (url.startsWith("/api/containers/c1")) return json(snap(withHuman));
    return json({});
  }) as unknown as typeof fetch;
}

function mount(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <SnapshotProvider>
          <Routes><Route path="/qa" element={<QaPage />} /></Routes>
        </SnapshotProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

function mountTask(withTask = true) {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <SnapshotProvider><TaskQaSection taskId="t1" task={withTask ? TASK : undefined} /></SnapshotProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => { installFlowEnv(); calls = []; requests = [FAILED, RUNNING]; settings = { agent_id: "a1", agent_alias: "tess", agent_source: "set", default_platform: "ios", trigger: "manual", on_fail: "report", max_rounds: 3 }; localStorage.clear(); });
afterEach(() => { cleanup(); removeFlowEnv(); vi.restoreAllMocks(); });

describe("Requests view", () => {
  it("lists what was asked, where it came from and what came back", async () => {
    stub();
    mount("/qa?view=requests");
    const list = await screen.findByRole("listbox", { name: "QA requests" });
    const rows = within(list).getAllByRole("option");
    expect(rows).toHaveLength(2);
    const failed = rows.find((r) => r.textContent?.includes("Password reset"))!;
    expect(failed.textContent).toContain("Release 2.1");
    expect(failed.textContent).toContain("Failed");
    expect(failed.textContent).toContain("Check scenarios");
    expect(failed.textContent).toContain("iOS");
    expect(failed.textContent).toContain("Round 2 of 3");
    expect(failed.textContent).toContain("1 of 2 lines passed");
    expect(screen.getByRole("tab", { name: "Requests" })).toHaveAttribute("aria-selected", "true");
  });

  it("narrows by status, and offers no platform switch: requests span platforms", async () => {
    stub();
    mount("/qa?view=requests&status=open");
    const list = await screen.findByRole("listbox", { name: "QA requests" });
    expect(within(list).getAllByRole("option")).toHaveLength(1);
    expect(screen.queryByRole("radiogroup", { name: "Platform" })).toBeNull();
  });

  it("shows the lines, verdicts, build, findings and links of one request", async () => {
    stub();
    mount("/qa?view=requests&request=r1");
    const detail = await screen.findByRole("region", { name: "QA request: Password reset" });
    await within(detail).findByText("Reset email never arrives");
    expect(within(detail).getByText("The reset email never arrives.")).toBeInTheDocument();
    expect(within(detail).getByText("feat/reset")).toBeInTheDocument();
    expect(within(detail).getByText("Use the staging mailbox")).toBeInTheDocument();
    const lines = within(detail).getByRole("list", { name: "Lines to prove" });
    expect(lines.querySelector("[data-line-verdict='fail']")?.textContent).toContain("Nothing after two minutes");
    expect(lines.querySelector("[data-line-verdict='pass']")?.textContent).toContain("Link opens the app");
    expect(within(detail).getByRole("link", { name: "Open the session" }).getAttribute("href")).toBe("/qa?view=sessions&session=s1");
    expect(within(detail).getByRole("link", { name: "Open the run page" }).getAttribute("href")).toBe("/qa?view=sessions&session=s1&sub=run");
    expect(within(detail).getByRole("link", { name: "Release 2.1" }).getAttribute("href")).toContain("/workflows/w1");
    expect(within(detail).getByRole("link", { name: "Reset a password" }).getAttribute("href")).toBe("/qa?view=scenarios&scenario=sc1");
    expect(within(within(detail).getByRole("list", { name: "Rounds" })).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["/qa?view=requests&request=r0", "/qa?view=requests&request=r1"]);
    expect(detail.textContent).not.toMatch(/[{}"]/);
  });

  it("cancels an open request, after asking", async () => {
    stub();
    mount("/qa?view=requests&request=r2");
    fireEvent.click(await screen.findByRole("button", { name: "Cancel request" }));
    const dialog = await screen.findByRole("dialog", { name: "Cancel this request?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel request" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/qa/requests/r2/cancel" && c.body.actor_agent_id === "h1")).toBe(true));
  });

  it("offers no cancel on a finished request, and disables it for anyone but a person", async () => {
    stub();
    const view = mount("/qa?view=requests&request=r1");
    await screen.findByRole("region", { name: "QA request: Password reset" });
    expect(screen.queryByRole("button", { name: "Cancel request" })).toBeNull();
    view.unmount();
    stub(false);
    mount("/qa?view=requests&request=r2");
    expect(await screen.findByRole("button", { name: "Cancel request" })).toBeDisabled();
  });

  it("explains an empty list", async () => {
    requests = [];
    stub();
    mount("/qa?view=requests");
    expect(await screen.findByText("No requests yet")).toBeInTheDocument();
  });
});

describe("QA settings", () => {
  const finishCard = async () => {
    stub();
    mount("/qa?view=targets");
    const card = within(await screen.findByRole("region", { name: "QA settings" }));
    await card.findByRole("button", { name: "Save" });
    return card;
  };

  const finishRadio = (card: ReturnType<typeof within>, name: string) => within(card.getByRole("radiogroup", { name: FINISH_ALONE_LABEL })).getByRole("radio", { name });

  it("keeps finishing work to a person by default, and asks before turning it on", async () => {
    const card = await finishCard();
    expect(finishRadio(card, "Off")).toBeChecked();
    fireEvent.click(finishRadio(card, "On"));
    const dialog = await screen.findByRole("dialog", { name: `Turn on “${FINISH_ALONE_LABEL}”?` });
    expect(within(dialog).getByText("Serious findings")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep a person verifying" }));
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("turns it on only after the confirm, sent as the project's setting", async () => {
    const card = await finishCard();
    fireEvent.click(finishRadio(card, "On"));
    fireEvent.click(within(await screen.findByRole("dialog", { name: `Turn on “${FINISH_ALONE_LABEL}”?` })).getByRole("button", { name: "Turn it on" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toMatchObject({ final_decision: "quality", actor_agent_id: "h1" }));
  });

  it("shows who turned it on, and goes straight back off", async () => {
    settings = { ...settings, final_decision: "quality", final_decision_by_alias: "kedar" };
    const card = await finishCard();
    expect(card.getByText(/Turned on by kedar/)).toBeInTheDocument();
    fireEvent.click(finishRadio(card, "Off"));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toMatchObject({ final_decision: "person" }));
  });

  it("lets nobody but a person change it", async () => {
    stub(false);
    mount("/qa?view=targets");
    const card = within(await screen.findByRole("region", { name: "QA settings" }));
    await card.findByRole("radiogroup", { name: FINISH_ALONE_LABEL });
    fireEvent.click(finishRadio(card, "On"));
    expect(screen.queryByRole("dialog", { name: `Turn on “${FINISH_ALONE_LABEL}”?` })).toBeNull();
  });

  it("saves the agent, trigger, on-fail and rounds under the acting person", async () => {
    stub();
    mount("/qa?view=targets");
    const card = await screen.findByRole("region", { name: "QA settings" });
    const save = await within(card).findByRole("button", { name: "Save" });
    await within(card).findByRole("spinbutton", { name: "Most rounds" });
    expect(save).toBeDisabled();
    fireEvent.click(within(card).getByRole("radio", { name: "UI changes" }));
    fireEvent.click(within(card).getByRole("radio", { name: "Send the task back" }));
    fireEvent.change(within(card).getByRole("spinbutton", { name: "Most rounds" }), { target: { value: "5" } });
    fireEvent.click(save);
    await waitFor(() => expect(calls.find((c) => c.method === "PUT" && c.url.endsWith("/qa/settings"))?.body).toMatchObject({ trigger: "ui_changes", on_fail: "reopen", max_rounds: 5, actor_agent_id: "h1" }));
  });

  it("keeps an agent found by its role found by its role", async () => {
    settings = { ...settings, agent_source: "role" };
    stub();
    mount("/qa?view=targets");
    const card = await screen.findByRole("region", { name: "QA settings" });
    expect(await within(card).findByRole("button", { name: /tess \(from its role\)/ })).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("radio", { name: "Every task" }));
    fireEvent.click(within(card).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toMatchObject({ agent_id: null, trigger: "always" }));
  });

  it("refuses rounds outside 1 to 10 and is read-only for anyone but a person", async () => {
    stub();
    const view = mount("/qa?view=targets");
    const card = await screen.findByRole("region", { name: "QA settings" });
    fireEvent.change(await within(card).findByRole("spinbutton", { name: "Most rounds" }), { target: { value: "11" } });
    expect(within(card).getByRole("button", { name: "Save" })).toBeDisabled();
    view.unmount();
    stub(false);
    mount("/qa?view=targets");
    const again = await screen.findByRole("region", { name: "QA settings" });
    expect(await within(again).findByRole("spinbutton", { name: "Most rounds" })).toBeDisabled();
  });
});

describe("Task detail", () => {
  it("shows the task's requests live, the lines QA proved, and each line's proof", async () => {
    requests = [{ ...FAILED, id: "r1" }, { ...RUNNING, id: "r3", source_task_id: "t1" }];
    stub();
    mountTask();
    const block = await screen.findByRole("region", { name: "QA" });
    const list = within(block).getByRole("list", { name: "QA requests" });
    expect(list.querySelector("[data-status='running']")?.textContent).toContain("Running");
    expect(within(list).getByRole("link", { name: "Watch" }).getAttribute("href")).toBe("/qa?view=sessions&platform=web&session=s2&sub=run");
    const lines = within(block).getByRole("list", { name: "Definition of done lines QA checked" });
    expect(lines.querySelector("[data-proved='true']")?.textContent).toContain("QA proved it");
    expect(lines.querySelector("[data-proved='false']")?.textContent).toContain("Nothing after two minutes");
  });

  it("shows the request a QA task serves, with nothing to send", async () => {
    requests = [{ ...RUNNING, source_task_id: "t1", qa_task_id: "t1" }];
    stub();
    mountTask();
    await screen.findByRole("list", { name: "QA requests" });
    expect(screen.queryByRole("button", { name: "Send to QA" })).toBeNull();
  });

  it("shows only Send to Quality when finished for a task with no QA data", async () => {
    requests = [];
    stub();
    const view = mountTask();
    expect(await screen.findByRole("switch", { name: "Send to Quality when finished" })).toBeInTheDocument();
    expect(view.container.querySelector("[aria-label='QA requests']")).toBeNull();
  });

  it("sends the task with its definition of done preloaded", async () => {
    requests = [{ ...FAILED }];
    stub();
    mountTask();
    await waitFor(() => expect(screen.getByRole("button", { name: "Send to QA" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Send to QA" }));
    const dialog = await screen.findByRole("dialog", { name: "Send to QA" });
    await within(dialog).findByRole("radio", { name: "iOS" });
    expect(within(dialog).getByLabelText("Line 1")).toHaveValue("Reset email arrives");
    expect(within(dialog).getByLabelText("Line 2")).toHaveValue("Link opens the app");
    expect(dialog.textContent).toContain("tess");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove line 2" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add line" }));
    fireEvent.change(within(dialog).getByLabelText("Line 2"), { target: { value: "Works offline" } });
    fireEvent.change(within(dialog).getByLabelText(/Focus/), { target: { value: "Reset flow" } });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Web" }));
    fireEvent.click(within(dialog).getByRole("radio", { name: "Send the task back" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Send to QA" }));
    await waitFor(() => expect(calls.find((c) => c.url === "/api/tasks/t1/qa/requests")?.body).toMatchObject({
      kind: "explore", platform: "web", focus: "Reset flow", acceptance: ["Reset email arrives", "Works offline"], on_fail: "reopen", build: null, actor_agent_id: "h1",
    }));
  });

  it("disables Send to QA for anyone but a person", async () => {
    requests = [{ ...FAILED }];
    stub(false);
    mountTask();
    expect(await screen.findByRole("button", { name: "Send to QA" })).toBeDisabled();
  });
});
