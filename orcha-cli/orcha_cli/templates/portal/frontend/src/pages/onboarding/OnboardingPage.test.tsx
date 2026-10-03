/**
 * OnboardingPage — port-parity tests: first screen renders from an empty
 * workspace, the goal draft persists to the SAME localStorage key the vanilla
 * page uses, and an invalid_goal propose failure surfaces the retry path
 * (feeding the server's feedback back into the dialogue).
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { KEY } from "./logic";
import { OnboardingPage } from "./OnboardingPage";

/* ---- fetch stub over the UNCHANGED backend contract ---------------------- */
let rawSnapshot: unknown;
let proposeCalls: number;

function jsonRes(data: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => data } as unknown as Response;
}

// A fake ReadableStream body yielding the given SSE frames then EOF — enough
// for startPropose's fetch-stream pump (getReader/read).
function sseBody(frames: string[]) {
  const enc = new TextEncoder();
  const chunks = frames.map((f) => enc.encode(f));
  let i = 0;
  return {
    getReader() {
      return {
        read: async () =>
          i < chunks.length
            ? { done: false as const, value: chunks[i++] }
            : { done: true as const, value: undefined },
        cancel: async () => {},
      };
    },
  };
}

beforeEach(() => {
  localStorage.clear();
  proposeCalls = 0;
  rawSnapshot = { container: { id: "c1" }, agents: [], tasks: [], requests: [] };
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/onboarding/propose") {
      proposeCalls += 1;
      return {
        ok: true,
        status: 200,
        body: sseBody(['data:{"event":"error","code":"invalid_goal","message":"too vague"}\n\n']),
      } as unknown as Response;
    }
    if (url === "/api/models") return jsonRes({ models: [{ id: "m1", name: "Model One" }], default: "m1" });
    if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/")) return jsonRes(rawSnapshot);
    return jsonRes({ detail: "not found" }, false, 404);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderPage() {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter>
          <OnboardingPage />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

describe("OnboardingPage (vanilla onboarding.js parity)", () => {
  it("renders the welcome screen first in an empty workspace", async () => {
    renderPage();
    // boot waits on the first snapshot, then lands on welcome (no operator yet)
    expect(await screen.findByText("What should we call you?")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Your name — e.g. dario")).toHaveValue("");
    // D12: no marketing blurbs / helper paragraph — the explanation is an ⓘ tooltip
    expect(screen.queryByRole("list", { name: "How Orcha works" })).toBeNull();
    expect(screen.queryByText(/Registers you as the operator/)).toBeNull();
    expect(screen.getByRole("button", { name: /Registers you as this project's operator/ })).toBeInTheDocument();
    // V2: the same step rail shows on welcome (step 1 current) — but there is
    // nothing to skip to before an operator exists
    expect(screen.getByRole("navigation", { name: "Setup progress" })).toBeInTheDocument();
    expect(screen.getByText("Name yourself").closest("li")).toHaveAttribute("aria-current", "step");
    expect(screen.queryByText("Skip to Overview")).not.toBeInTheDocument();
    // the one dominant action is the shared primary Button
    expect(screen.getByRole("button", { name: /Continue/ })).toHaveClass("v2-btn-primary");
  });

  it("persists the goal draft to the same localStorage key as the classic page", async () => {
    // an operator exists → the flow resumes at the persisted propose-goal step
    rawSnapshot = {
      container: { id: "c1" },
      agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }],
      tasks: [], requests: [],
    };
    localStorage.setItem(KEY, JSON.stringify({ step: "propose-goal" }));
    renderPage();

    const ta = await screen.findByPlaceholderText(/Improve my app's onboarding/);
    fireEvent.change(ta, { target: { value: "Build a docs site" } });

    const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
    expect(saved.step).toBe("propose-goal");
    expect(saved._propose?.goal).toBe("Build a docs site");
  });

  it("surfaces the retry path on an invalid_goal propose failure", async () => {
    rawSnapshot = {
      container: { id: "c1" },
      agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }],
      tasks: [], requests: [],
    };
    localStorage.setItem(KEY, JSON.stringify({
      step: "propose-goal",
      _propose: { goal: "Build a docs site", dialogue: [] },
    }));
    renderPage();

    // kick off the propose stream
    fireEvent.click(await screen.findByRole("button", { name: /Propose my roster/ }));

    // the stubbed backend answers with an invalid_goal error frame → error turn
    expect(await screen.findByText("Couldn't propose a roster")).toBeInTheDocument();
    // guidance copy first, the raw server message only as secondary detail
    expect(screen.getByText(/couldn't work with that goal/)).toBeInTheDocument();
    expect(screen.getByText("too vague")).toBeInTheDocument();
    // the stream ended: no Stop / "Streaming…" footer left behind
    expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();
    expect(screen.queryByText("Streaming from the onboarding model")).toBeNull();
    const retryBtn = screen.getByRole("button", { name: /Retry/ });
    expect(retryBtn).toHaveClass("v2-btn-primary");
    expect(proposeCalls).toBe(1);

    // retry feeds the server's feedback back into the dialogue and re-streams
    fireEvent.click(retryBtn);
    await waitFor(() => expect(proposeCalls).toBe(2));
    const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
    const dialogue: { role: string; content: string }[] = saved._propose?.dialogue || [];
    expect(dialogue.some((d) =>
      d.role === "user" &&
      d.content.includes("failed validation on the server: too vague"),
    )).toBe(true);

    // the retried stream errors again → the retry path is still available
    expect(await screen.findByText("Couldn't propose a roster")).toBeInTheDocument();
  });

  it("fork greets an existing team with 'Add to your team', not 'empty workspace'", async () => {
    rawSnapshot = {
      container: { id: "c1" },
      agents: [
        { id: "h1", alias: "kedar", kind: "human", status: "idle" },
        { id: "a1", alias: "lead", kind: "ai", status: "working" },
      ],
      tasks: [{ id: "t1", title: "x", status: "ready" }], requests: [],
    };
    localStorage.setItem(KEY, JSON.stringify({ step: "fork" }));
    renderPage();
    expect(await screen.findByRole("heading", { name: "Add to your team" })).toBeInTheDocument();
    expect(screen.queryByText(/workspace is empty/)).toBeNull();
    expect(screen.getByText(/1 agent and 1 task/)).toBeInTheDocument();
    // exactly one primary action on the fork; no internal "Path X" jargon
    const primaries = document.querySelectorAll(".v2-btn-primary");
    expect(primaries).toHaveLength(1);
    expect(primaries[0]).toHaveTextContent("Propose my roster");
    expect(screen.queryByText(/Path [GAB]/)).toBeNull();
  });

  it("?new=1 is a single-agent flow: Agents › New agent, no setup stepper, Cancel back to /agents", async () => {
    rawSnapshot = {
      container: { id: "c1" },
      agents: [
        { id: "h1", alias: "kedar", kind: "human", status: "idle" },
        { id: "a1", alias: "lead", kind: "ai", status: "idle" },
      ],
      tasks: [], requests: [],
    };
    render(
      <ToastProvider>
        <SnapshotProvider>
          <MemoryRouter initialEntries={["/onboarding?new=1"]}>
            <OnboardingPage />
          </MemoryRouter>
        </SnapshotProvider>
      </ToastProvider>,
    );
    expect(await screen.findByRole("heading", { name: "New agent" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Setup progress" })).toBeNull();
    expect(screen.getAllByText("New agent").length).toBeGreaterThan(0);
    expect(screen.queryByText("Set up agents and tasks")).toBeNull();
    expect(screen.getByRole("link", { name: "Cancel" })).toHaveAttribute("href", "/agents");
    // model picker is a real radio group (sans text, grouped), not bold mono tiles
    expect(await screen.findByRole("radio", { name: "Model One" })).toBeChecked();
  });

  it("walk review shows the proposed kickoff TITLE as an editable field", async () => {
    rawSnapshot = {
      container: { id: "c1" },
      agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }],
      tasks: [], requests: [],
    };
    localStorage.setItem(KEY, JSON.stringify({
      step: "create-agent",
      _walk: { idx: 0, agents: [{ name: "Atlas", role: "r", charter: "c", model: "m1", kickoff: { title: "Map the flow", dod: "Doc approved" } }], standalone: [] },
      _agentDraft: { alias: "Atlas", role: "r", prompt: "c", model: "m1", _firstMode: "describe", _pickId: null, _desc: "Doc approved", _taskTitle: "Map the flow" },
    }));
    renderPage();
    const title = await screen.findByLabelText(/Title/);
    expect(title).toHaveValue("Map the flow");
    expect(screen.getByLabelText(/Done when/)).toHaveValue("Doc approved");
    // honest progress: the rail's current step says exactly where the walk is
    const rail = screen.getByRole("navigation", { name: "Setup progress" });
    expect(rail.querySelector('[aria-current="step"]')).toHaveTextContent("Create");
    expect(rail).toHaveTextContent("agent 1 of 1");
  });

  it("step title is the page's Display h1 and the rail lives in the panel toolbar", async () => {
    rawSnapshot = {
      container: { id: "c1" },
      agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }],
      tasks: [], requests: [],
    };
    localStorage.setItem(KEY, JSON.stringify({ step: "fork" }));
    renderPage();
    const h1 = await screen.findByRole("heading", { level: 1 });
    expect(h1).toHaveClass("v2-t-display");
    const toolbar = screen.getByRole("toolbar", { name: "Setup" });
    expect(toolbar).toContainElement(screen.getByRole("navigation", { name: "Setup progress" }));
    expect(screen.getByRole("link", { name: /Skip to Overview/ })).toHaveAttribute("href", "/");
  });

  it("agent-created shows the live status label and the model's display name, never a fake model", async () => {
    rawSnapshot = {
      container: { id: "c1" },
      agents: [
        { id: "h1", alias: "kedar", kind: "human", status: "idle" },
        { id: "a1", alias: "lead", kind: "ai", role: "Tech lead", status: "working", model: "m1" },
        { id: "a2", alias: "nomodel", kind: "ai", role: "r", status: "idle" },
      ],
      tasks: [], requests: [],
    };
    localStorage.setItem(KEY, JSON.stringify({ step: "agent-created", lastAgentAlias: "lead" }));
    renderPage();
    expect(await screen.findByRole("heading", { name: /lead is ready/ })).toBeInTheDocument();
    expect((await screen.findByText("Model One")).closest("[title]")).toHaveAttribute("title", "Model: m1");
    expect(screen.getAllByText("Working").length).toBeGreaterThan(0);
  });

  it("agent-created renders no model chip when the agent has no model", async () => {
    rawSnapshot = {
      container: { id: "c1" },
      agents: [
        { id: "h1", alias: "kedar", kind: "human", status: "idle" },
        { id: "a2", alias: "nomodel", kind: "ai", role: "r", status: "idle" },
      ],
      tasks: [], requests: [],
    };
    localStorage.setItem(KEY, JSON.stringify({ step: "agent-created", lastAgentAlias: "nomodel" }));
    renderPage();
    expect(await screen.findByRole("heading", { name: /nomodel is ready/ })).toBeInTheDocument();
    expect(document.querySelector('.agentcard [title^="Model"]')).toBeNull();
  });

  it("create-agent: an empty submit shows inline errors, sets aria-invalid and focuses the first empty field", async () => {
    rawSnapshot = {
      container: { id: "c1" },
      agents: [
        { id: "h1", alias: "kedar", kind: "human", status: "idle" },
        { id: "a1", alias: "lead", kind: "ai", status: "idle" },
      ],
      tasks: [], requests: [],
    };
    localStorage.setItem(KEY, JSON.stringify({
      step: "create-agent",
      _agentDraft: { alias: "", role: "Builder", prompt: "", model: "m1", _firstMode: "none", _pickId: null, _desc: "" },
    }));
    renderPage();
    const create = await screen.findByRole("button", { name: /^Create/ });
    const posts = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
    fireEvent.click(create);
    const name = screen.getByLabelText(/Agent name/);
    const prompt = screen.getByLabelText(/System prompt/);
    await waitFor(() => expect(name).toHaveFocus());
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(prompt).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText(/^Role/)).not.toHaveAttribute("aria-invalid");
    expect(screen.getByText("Name the agent.")).toBeInTheDocument();
    expect(name).toHaveAttribute("aria-describedby", "agErr-alias");
    // nothing was POSTed
    expect((fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBe(posts);
    // typing clears that field's error only
    fireEvent.change(name, { target: { value: "forge" } });
    expect(name).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByText("Name the agent.")).toBeNull();
    expect(prompt).toHaveAttribute("aria-invalid", "true");
  });

  it("first-task pills keep text labels (no icon-only 'Not yet' at 390)", async () => {
    rawSnapshot = {
      container: { id: "c1" },
      agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }, { id: "a1", alias: "lead", kind: "ai", status: "idle" }],
      tasks: [], requests: [],
    };
    localStorage.setItem(KEY, JSON.stringify({ step: "create-agent" }));
    renderPage();
    const group = await screen.findByRole("radiogroup", { name: "First task" });
    for (const r of Array.from(group.querySelectorAll('[role="radio"]'))) {
      expect(r.querySelector("svg")).toBeNull();
      expect(r.textContent?.trim()).not.toBe("");
    }
    expect(group).toHaveTextContent("Not yet");
  });

  it("describe mode: an empty 'Done when' blocks create with an inline error (no silent task-less agent)", async () => {
    rawSnapshot = {
      container: { id: "c1" },
      agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }, { id: "a1", alias: "lead", kind: "ai", status: "idle" }],
      tasks: [], requests: [],
    };
    localStorage.setItem(KEY, JSON.stringify({
      step: "create-agent",
      _agentDraft: { alias: "perf", role: "Perf", prompt: "p", model: "m1", _firstMode: "describe", _pickId: null, _desc: "" },
    }));
    renderPage();
    const create = await screen.findByRole("button", { name: /^Create/ });
    const posts = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
    fireEvent.click(create);
    const done = screen.getByLabelText(/Done when/);
    await waitFor(() => expect(done).toHaveFocus());
    expect(done).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(/Say when the first task is done/)).toBeInTheDocument();
    expect((fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBe(posts);
    // choosing "Not yet" clears the error
    fireEvent.click(screen.getByRole("radio", { name: "Not yet" }));
    expect(screen.queryByText(/Say when the first task is done/)).toBeNull();
  });

  it("first-task 'Pick a task' pill carries no count (it read as a step number)", async () => {
    rawSnapshot = {
      container: { id: "c1" },
      agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }, { id: "a1", alias: "lead", kind: "ai", status: "idle" }],
      tasks: [{ id: "t1", title: "Ready one", status: "ready", assignees: [] }], requests: [],
    };
    localStorage.setItem(KEY, JSON.stringify({ step: "create-agent" }));
    renderPage();
    const pick = await screen.findByRole("radio", { name: "Pick a task" });
    expect(pick.textContent?.trim()).toBe("Pick a task");
  });

  it("roster review: model dropdown shows the display name (never a raw id) and edits the model", async () => {
    rawSnapshot = {
      container: { id: "c1" },
      agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }],
      tasks: [], requests: [],
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/models") return jsonRes({ models: [{ id: "claude-opus-5", name: "Opus 5" }, "claude-sonnet-5"], default: "claude-opus-5" });
      if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
      if (url.startsWith("/api/containers/")) return jsonRes(rawSnapshot);
      return jsonRes({}, false, 404);
    }));
    localStorage.setItem(KEY, JSON.stringify({
      step: "propose-roster",
      _roster: {
        rationale: "",
        agents: [{ name: "forge", role: "Builder", charter: "c", model: "claude-opus-5" }],
        tasks: [{ title: "T", definition_of_done: "d", assignee: "forge", depends_on: [], protocol: null, is_kickoff: true }],
      },
    }));
    renderPage();
    const dd = await screen.findByRole("button", { name: "Opus 5" });
    expect(dd).toHaveAttribute("title", "Model: claude-opus-5");
    expect(screen.queryByText(/claude-opu/)).toBeNull();
    fireEvent.click(dd);
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Sonnet 5" }));
    await screen.findByRole("button", { name: "Sonnet 5" });
    const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
    expect(saved._roster.agents[0].model).toBe("claude-sonnet-5");
    // assignee is the same ghost dropdown (no native select), kickoff a real checkbox
    expect(document.querySelector("select")).toBeNull();
    expect(screen.getByRole("button", { name: /^forge$/ })).toHaveAttribute("aria-haspopup", "menu");
    expect(screen.getByRole("checkbox", { name: /First task/ })).toBeChecked();
  });

  it("roster review (r3): kickoff is a check chip, and role/charter carry the phone line clamp", async () => {
    rawSnapshot = { container: { id: "c1" }, agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }], tasks: [], requests: [] };
    localStorage.setItem(KEY, JSON.stringify({
      step: "propose-roster",
      _roster: {
        rationale: "",
        agents: [{ name: "forge", role: "Builder", charter: "line one\nline two\nline three\nline four", model: "m1" }],
        tasks: [
          { title: "T", definition_of_done: "d", assignee: "forge", depends_on: [], protocol: null, is_kickoff: false },
          { title: "U", definition_of_done: "d", assignee: null, depends_on: [], protocol: null, is_kickoff: false },
        ],
      },
    }));
    renderPage();
    const boxes = await screen.findAllByRole("checkbox", { name: "First task (kickoff)" });
    expect(boxes).toHaveLength(2);
    // a chip: short visible label, the full meaning in the accessible name + tooltip
    const chip = boxes[0].closest("label")!;
    expect(chip).toHaveClass("rt-kick");
    expect(chip.textContent).toBe("Kickoff");
    expect(chip).toHaveAttribute("title", "Make this forge's first task (kickoff)");
    fireEvent.click(boxes[0]);
    expect(boxes[0]).toBeChecked();
    expect(JSON.parse(localStorage.getItem(KEY) || "{}")._roster.tasks[0].is_kickoff).toBe(true);
    // unassigned task: the kickoff chip is disabled with the reason as tooltip
    expect(boxes[1]).toBeDisabled();
    expect(boxes[1].closest("label")).toHaveAttribute("title", "Assign the task to make it a kickoff");
    // phone clamp hooks: role 1 line, charter 2 lines (CSS caps unfocused fields)
    expect(screen.getByRole("textbox", { name: "Role" })).toHaveAttribute("data-clamp", "1");
    expect(screen.getByRole("textbox", { name: "System prompt" })).toHaveAttribute("data-clamp", "2");
  });
});
