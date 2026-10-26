import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowDraftEditor } from "./WorkflowDraftEditor";
import { discardDraft, type DraftScope } from "./workflowDraft";

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
function task(index: number) { return within(screen.getByRole("group", { name: `Task ${index}` })); }

describe("local workflow preparation", () => {
  it("keeps dependencies on rename, blocks cycles and refuses silent removal of referenced tasks", () => {
    render(<WorkflowDraftEditor scope={scope()} saveUnavailableReason={reason} />);
    add("Build Android"); add("Review builds");
    fireEvent.click(task(2).getByRole("checkbox", { name: "Build Android" }));
    expect(task(1).getByRole("checkbox", { name: /Review builds/ })).toBeDisabled();
    expect(task(1).getByRole("button", { name: "Remove task 1" })).toBeDisabled();
    fireEvent.change(task(1).getByLabelText("Task summary"), { target: { value: "Build both apps" } });
    expect(task(2).getByRole("checkbox", { name: "Build both apps" })).toBeChecked();
    fireEvent.click(task(2).getByRole("checkbox", { name: "Build both apps" }));
    fireEvent.click(task(1).getByRole("button", { name: "Remove task 1" }));
    expect(screen.getAllByLabelText("Task summary")).toHaveLength(1);
  });

  it("caps dependencies at three while keeping selected choices removable", () => {
    render(<WorkflowDraftEditor scope={scope()} saveUnavailableReason={reason} />);
    ["Release", "Build Android", "Build iOS", "Write guide", "Check package"].forEach(add);
    ["Build Android", "Build iOS", "Write guide"].forEach((name) => fireEvent.click(task(1).getByRole("checkbox", { name })));
    expect(task(1).getByRole("checkbox", { name: /Check package/ })).toBeDisabled();
    expect(task(1).getByRole("checkbox", { name: "Build iOS" })).toBeEnabled();
    fireEvent.click(task(1).getByRole("checkbox", { name: "Build iOS" }));
    expect(task(1).getByRole("checkbox", { name: "Check package" })).toBeEnabled();
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
    expect(screen.getByText("Draft · Unassigned · Task autonomy OFF")).toBeVisible();
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
