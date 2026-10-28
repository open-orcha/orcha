import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowDraftEditor } from "./WorkflowDraftEditor";
import { discardDraft, draftProblems, readDraft, type DraftScope } from "./workflowDraft";
import { toWireDraft } from "./WorkflowDraftSave";

const scopes: DraftScope[] = [];
afterEach(() => { cleanup(); scopes.forEach(discardDraft); scopes.length = 0; vi.restoreAllMocks(); });
function scope(identity = "Kedar"): DraftScope {
  const s = { origin: "https://orcha.example", project: "project", identity };
  scopes.push(s); return s;
}
const reason = "Saving is unavailable until this connection supports workflow changes.";
function add(title: string) {
  fireEvent.click(screen.getByRole("button", { name: "Add task summary" }));
  const inputs = screen.getAllByLabelText("Task summary");
  fireEvent.change(inputs.at(-1)!, { target: { value: title } });
}
function pick(index: number, name: string) { fireEvent.click(task(index).getByRole("button", { name: "Add prerequisite" })); fireEvent.click(screen.getByRole("menuitem", { name })); }
function task(index: number) { return within(screen.getByRole("group", { name: `Task ${index}` })); }

describe("local workflow preparation", () => {
  it("keeps dependencies on rename, blocks cycles and refuses silent removal of referenced tasks", () => {
    render(<WorkflowDraftEditor scope={scope()} saveUnavailableReason={reason} />);
    add("Build Android"); add("Review builds");
    pick(2, "Build Android");
    fireEvent.click(task(1).getByRole("button", { name: "Add prerequisite" }));
    expect(screen.getByRole("menuitem", { name: /Review builds/ })).toHaveAttribute("aria-disabled", "true");
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(task(1).getByRole("button", { name: "Remove task 1" })).toBeDisabled();
    fireEvent.change(task(1).getByLabelText("Task summary"), { target: { value: "Build both apps" } });
    expect(task(2).getByRole("button", { name: "Remove prerequisite Build both apps" })).toBeVisible();
    fireEvent.click(task(2).getByRole("button", { name: "Remove prerequisite Build both apps" }));
    fireEvent.click(task(1).getByRole("button", { name: "Remove task 1" }));
    expect(screen.getAllByLabelText("Task summary")).toHaveLength(1);
  });

  it("caps dependencies at three while keeping selected choices removable", () => {
    render(<WorkflowDraftEditor scope={scope()} saveUnavailableReason={reason} />);
    ["Release", "Build Android", "Build iOS", "Write guide", "Check package"].forEach(add);
    ["Build Android", "Build iOS", "Write guide"].forEach((name) => pick(1, name));
    fireEvent.click(task(1).getByRole("button", { name: "Add prerequisite" }));
    expect(screen.getByRole("menuitem", { name: /Check package/ })).toHaveAttribute("aria-disabled", "true");
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    fireEvent.click(task(1).getByRole("button", { name: "Remove prerequisite Build iOS" }));
    fireEvent.click(task(1).getByRole("button", { name: "Add prerequisite" }));
    expect(screen.getByRole("menuitem", { name: "Check package" })).not.toHaveAttribute("aria-disabled", "true");

  });

  it("retains a draft across navigation but separates identities and projects", () => {
    const original = scope();
    const other = { ...scope(), project: "another-project" }; scopes.push(other);
    const member = scope("Maya");
    const view = render(<WorkflowDraftEditor scope={original} saveUnavailableReason={reason} />);
    fireEvent.change(screen.getByLabelText("Workflow name"), { target: { value: "Mobile release" } });
    add("Build iOS");
    view.rerender(<WorkflowDraftEditor scope={member} saveUnavailableReason={reason} />);
    expect(screen.getByLabelText("Workflow name")).toHaveValue("");
    view.rerender(<WorkflowDraftEditor scope={other} saveUnavailableReason={reason} />);
    expect(screen.getByLabelText("Workflow name")).toHaveValue("");
    view.unmount();
    render(<WorkflowDraftEditor scope={original} saveUnavailableReason={reason} />);
    expect(screen.getByLabelText("Workflow name")).toHaveValue("Mobile release");
    expect(screen.getByLabelText("Task summary")).toHaveValue("Build iOS");
  });

  it("does not stage tasks through the API and requires explicit draft discard", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    render(<WorkflowDraftEditor scope={scope()} saveUnavailableReason={reason} />);
    add("Build iOS");
    expect(screen.getByText("Draft · Autonomy OFF · Not saved")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save workflow" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Task summary")).toHaveValue("Build iOS");
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Discard draft" }));
    expect(screen.queryByLabelText("Task summary")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses five-result server search in creation drafts and retains selected tasks", async () => {
    const available = Array.from({ length: 6 }, (_, index) => ({ id: `build-${index}`, title: `Build target ${index}`, status: "ready", is_root: false, workflow_id: null }));
    const docs = { id: "docs", title: "Write release guide", status: "ready", is_root: false, workflow_id: null };
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      const params = new URL(url, "https://orcha.example").searchParams;
      const selected = params.getAll("selected");
      const matches = params.get("query") === "docs" ? [docs] : available;
      return { ok: true, status: 200, json: async () => ({
        results: matches.filter((candidate) => !selected.includes(candidate.id)).slice(0, 5),
        selected: selected.map((id) => [...available, docs].find((candidate) => candidate.id === id)).filter(Boolean),
      }) } as Response;
    }));
    render(<WorkflowDraftEditor scope={scope()} saveUnavailableReason={reason} />);
    fireEvent.click(screen.getByRole("button", { name: "Add existing tasks…" }));
    expect(screen.getByText("Enter a task name to search.")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Find an existing task"), { target: { value: "build" } });
    const results = await screen.findByRole("group", { name: "Task search results" });
    expect(results.querySelectorAll('input[type="checkbox"]')).toHaveLength(5);
    fireEvent.click(screen.getByRole("checkbox", { name: /Build target 0/ }));
    fireEvent.change(screen.getByLabelText("Find an existing task"), { target: { value: "docs" } });
    expect(await screen.findByRole("checkbox", { name: /Write release guide/ })).toBeVisible();
    expect(within(screen.getByRole("group", { name: "Selected existing tasks" })).getByRole("checkbox", { name: /Build target 0/ })).toBeChecked();
    await waitFor(() => expect(urls.length).toBeGreaterThanOrEqual(2));
    expect(urls.every((url) => url.includes("workflow-task-search") && new URL(url, "https://orcha.example").searchParams.get("limit") === "5")).toBe(true);
  });
});

describe("flexible workflow authoring", () => {
  it("adds outcomes, next-step rules and a feedback loop to the saved draft", () => {
    const s = scope();
    render(<WorkflowDraftEditor scope={s} saveUnavailableReason={reason} flexible />);
    add("Write the post"); add("Review the post"); pick(2, "Write the post");
    fireEvent.click(task(2).getByRole("button", { name: "Add outcome" }));
    fireEvent.click(task(2).getByRole("button", { name: "Add outcome" }));
    const [first, second] = task(2).getAllByLabelText("Outcome name");
    fireEvent.change(first, { target: { value: "Approved" } }); fireEvent.change(second, { target: { value: "Changes requested" } });
    const [thenFirst, thenSecond] = task(2).getAllByLabelText("Then");
    fireEvent.change(thenFirst, { target: { value: "exit_group" } });
    const back = within(thenSecond as HTMLElement).getByRole("option", { name: "Send back to Write the post (loop)" }) as HTMLOptionElement;
    fireEvent.change(thenSecond, { target: { value: back.value } });
    expect(task(1).queryByRole("option", { name: /Send back to/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add feedback loop" }));
    const loop = within(screen.getByRole("group", { name: "Loop 1" }));
    fireEvent.change(loop.getByLabelText("Loop name"), { target: { value: "Draft and review" } });
    fireEvent.click(loop.getByRole("checkbox", { name: "Write the post" })); fireEvent.click(loop.getByRole("checkbox", { name: "Review the post" }));
    fireEvent.change(loop.getByLabelText("Review point"), { target: { value: (loop.getByRole("option", { name: "Review the post" }) as HTMLOptionElement).value } });
    fireEvent.change(loop.getByLabelText("Leave the group when"), { target: { value: "Approved" } });
    const draft = readDraft(s);
    expect(draftProblems(draft).filter((p) => p.key !== "name" && p.key !== "goal")).toEqual([]);
    const [write, review] = draft.tasks;
    expect(toWireDraft(draft)).toMatchObject({
      tasks: [{ client_key: write.key }, { client_key: review.key, outcomes: [{ name: "Approved", kind: "success" }, { name: "Changes requested", kind: "changes" }],
        routes: [{ outcome: "Approved", destination: "exit_group", destination_task: null }, { outcome: "Changes requested", destination: "return", destination_task: write.key }] }],
      repeat_groups: [{ name: "Draft and review", member_tasks: [write.key, review.key], review_task: review.key, exit_outcome: "Approved", max_rounds: 5 }],
    });
    expect(toWireDraft(draft).tasks?.[0]).not.toHaveProperty("outcomes");
  });

  it("flags a loop that ends on an outcome its review step lacks, and hides authoring when the server lacks it", () => {
    const s = scope();
    render(<WorkflowDraftEditor scope={s} saveUnavailableReason={reason} flexible />);
    add("Write"); add("Review"); pick(2, "Write");
    fireEvent.click(screen.getByRole("button", { name: "Add feedback loop" }));
    const loop = within(screen.getByRole("group", { name: "Loop 1" }));
    fireEvent.change(loop.getByLabelText("Loop name"), { target: { value: "Edit loop" } });
    fireEvent.click(loop.getByRole("checkbox", { name: "Write" })); fireEvent.click(loop.getByRole("checkbox", { name: "Review" }));
    fireEvent.change(loop.getByLabelText("Review point"), { target: { value: (loop.getByRole("option", { name: "Review" }) as HTMLOptionElement).value } });
    expect(loop.getByText("Add outcomes to Review first.")).toBeVisible();
    expect(draftProblems(readDraft(s)).map((p) => p.message)).toContain("Edit loop ends on an outcome its review step does not have.");
    cleanup();
    render(<WorkflowDraftEditor scope={scope("Other")} saveUnavailableReason={reason} />);
    add("Write");
    expect(screen.queryByRole("button", { name: "Add outcome" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add feedback loop" })).toBeNull();
  });
});
