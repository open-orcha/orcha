import { useEffect, useState } from "react";
import { Button } from "../../components/primitives/Button";
import { Dialog } from "../../components/primitives/Dialog";
import { actionReason, availableActionReason, workflowPaths, workflowRequest } from "./workflowApi";
import type { WorkflowDetail } from "./workflowContract.generated";
import type { DraftScope } from "./workflowDraft";
import { useWorkflowForm } from "./workflowFormState";
import { sendWorkflowOperation, useWorkflowOperation } from "./workflowOperations";
import { WorkflowOperationNotice } from "./WorkflowOperationNotice";
import { useDialogOpen, type DialogControl } from "./workflowDialogs";

// Display the full connected group in both directions. This only explains the
// selection; the server rechecks membership, history, closure and both revisions.
export function connectedTasks(detail: WorkflowDetail, selected: string[]): string[] {
  const group = new Set(selected);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of detail.tasks) for (const dependency of task.depends_on) {
      if (group.has(task.id) || group.has(dependency)) {
        for (const id of [task.id, dependency]) if (!group.has(id)) { group.add(id); changed = true; }
      }
    }
  }
  return [...group];
}

export function WorkflowMove({ detail, scope, verified, stale, onSaved, control }: {
  detail: WorkflowDetail; scope: DraftScope; verified: boolean; stale: boolean; onSaved: (detail: WorkflowDetail) => void; control?: DialogControl;
}) {
  const [open, setOpen] = useDialogOpen(control);
  // A menu-opened dialog loads its destinations the same way the trigger button did.
  useEffect(() => { if (control?.open) void loadDestinations(); }, [control?.open]);
  const [draft, setDraft] = useWorkflowForm(scope, `move:${detail.id}`, { tasks: [] as string[], destination: "", reason: "" });
  const [destinations, setDestinations] = useState<WorkflowDetail[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ basis: string; source: WorkflowDetail; destination: WorkflowDetail | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const slot = `workflow:${detail.id}`;
  const op = useWorkflowOperation(scope, slot);
  const frozen = busy || op?.state === "sending" || op?.state === "uncertain";
  const basis = JSON.stringify(draft);
  const current = preview?.basis === basis ? preview : null;
  const group = connectedTasks(current?.source ?? detail, draft.tasks);
  const missing = group.filter((id) => !draft.tasks.includes(id));
  const taskReason = (source: WorkflowDetail, id: string) => availableActionReason(source.capability, source.tasks.find((t) => t.id === id)?.available_actions, "move", verified);
  async function loadDestinations(next: string | null = null) {
    setBusy(true); setError("");
    try {
      const query = new URLSearchParams({ status: "active", limit: "50" }); if (next) query.set("cursor", next);
      const page = await workflowRequest("WorkflowList", workflowPaths.collection(scope.project) + `?${query}`, { actorId: scope.identity });
      if (page.workflows.some((w) => w.container_id !== scope.project) || (next && page.next_cursor === next)) throw new Error("The workflow list changed. Close this form and try again.");
      setDestinations((old) => [...new Map([...(next ? old : []), ...page.workflows].filter((w) => w.id !== detail.id).map((w) => [w.id, w])).values()]);
      setCursor(page.next_cursor ?? null);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load destination workflows."); }
    finally { setBusy(false); }
  }
  async function review() {
    if (frozen || stale || !draft.tasks.length || !draft.reason.trim()) return;
    setBusy(true); setPreview(null); setError("");
    try {
      const source = await workflowRequest("WorkflowDetail", workflowPaths.detail(detail.id), { actorId: scope.identity });
      if (source.id !== detail.id || source.container_id !== scope.project) throw new Error("The source workflow changed. Open it again.");
      const denied = actionReason(source, "move", verified) || draft.tasks.map((id) => taskReason(source, id)).find(Boolean);
      if (denied) throw new Error(denied);
      const destination = draft.destination ? await workflowRequest("WorkflowDetail", workflowPaths.detail(draft.destination), { actorId: scope.identity }) : null;
      if (destination && (destination.id !== draft.destination || destination.container_id !== scope.project || destination.status !== "active" || actionReason(destination, "import", verified))) throw new Error("The destination is no longer available for these tasks. Choose another active workflow.");
      setPreview({ basis, source, destination });
    } catch (e) { setError(e instanceof Error ? e.message : "Could not review this move. Your choices are kept."); }
    finally { setBusy(false); }
  }
  const invalid = frozen || stale || !current || !!missing.length || !draft.tasks.length || !draft.reason.trim();
  const saved = (result: WorkflowDetail) => { setDraft({ tasks: [], destination: "", reason: "" }); setPreview(null); setOpen(false); onSaved(result); };
  async function confirm() {
    if (invalid || !current) return;
    const result = await sendWorkflowOperation(scope, slot, { operation: "move", url: workflowPaths.detail(detail.id) + "/move", expectedWorkflowId: detail.id,
      body: { expected_revision: current.source.revision, destination_workflow_id: current.destination?.id ?? null, destination_revision: current.destination?.revision ?? null, task_ids: draft.tasks, reason: draft.reason.trim() } });
    if (result.state === "saved" && result.result) saved(result.result);
    else if (result.state === "refused") setPreview(null);
  }
  return <>{!control && <Button disabled={stale || !!actionReason(detail, "move", verified)} onClick={() => { setOpen(true); void loadDestinations(); }}>Move or remove tasks</Button>}
    {open && <Dialog title="Move or remove tasks" size="lg" className="wf-page" onClose={() => { if (!frozen) setOpen(false); }}
      footer={<><Button disabled={frozen} onClick={() => setOpen(false)}>Keep draft and close</Button><Button disabled={invalid} onClick={() => void confirm()} variant="primary">Confirm task move</Button></>}>
      <p>Only tasks without work or review history may move. Their entire connected dependency group must move together. Accepted results stay in their original workflow.</p>
      <fieldset className="wf-form-body" disabled={frozen}>
        <fieldset><legend>Tasks to move</legend>{detail.tasks.map((task) => <label className="wf-choice" key={task.id}>
          <input type="checkbox" checked={draft.tasks.includes(task.id)} disabled={!!taskReason(detail, task.id) && !draft.tasks.includes(task.id)}
            onChange={(e) => setDraft({ ...draft, tasks: e.target.checked ? [...draft.tasks, task.id] : draft.tasks.filter((id) => id !== task.id) })} />
          <span>{task.title}{taskReason(detail, task.id) && <small>{taskReason(detail, task.id)}</small>}</span>
        </label>)}</fieldset>
        <label>Destination<select value={draft.destination} onChange={(e) => setDraft({ ...draft, destination: e.target.value })}>
          <option value="">Remove from workflow — keep as standalone tasks</option>
          {destinations.map((w) => <option key={w.id} value={w.id} disabled={w.status !== "active" || !!actionReason(w, "import", verified)}>{w.title}{w.status !== "active" || actionReason(w, "import", verified) ? " — unavailable" : ""}</option>)}
        </select></label>
        {cursor && <Button onClick={() => void loadDestinations(cursor)}>Load more destinations</Button>}
        <label>Reason for moving tasks<textarea maxLength={4000} value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })} /></label>
        {missing.length > 0 && <><p>The whole dependency group includes {group.length} tasks. Nothing moves until you include and review all of them.</p>
          <Button onClick={() => setDraft({ ...draft, tasks: group })}>Include the whole group</Button></>}
        <Button disabled={stale || !draft.tasks.length || !draft.reason.trim()} onClick={() => void review()}>Review task move</Button>
      </fieldset>
      {busy && <p role="status">Checking workflows…</p>}{error && <p role="alert">{error}</p>}
      {current && <section aria-label="Move impact"><h3>Review this move</h3><ul>{draft.tasks.map((id) => <li key={id}>{current.source.tasks.find((t) => t.id === id)?.title ?? "Unavailable task"}</li>)}</ul>
        <p>{draft.tasks.length} tasks leave {current.source.title}. Its required task count and goal acceptance will change; no task is marked accepted.</p>
        <p>{current.destination ? `Destination: ${current.destination.title}. Tasks arrive held; existing human holds remain. ${current.destination.launch_enabled ? "That Workflow has already started, so a task that still needs preparing is released when you prepare it; one that arrives prepared needs Release." : "Prepare and release them there."}` : "These become standalone tasks. Workflow preparation, start holds and human holds are removed. Review their readiness before assigning or starting work."}</p>
      </section>}
      <WorkflowOperationNotice scope={scope} slot={slot} onSaved={saved} canRetry={async () => {
        if (op?.operation !== "move" || op.url !== workflowPaths.detail(detail.id) + "/move") return false;
        const latest = await workflowRequest("WorkflowDetail", workflowPaths.detail(detail.id), { actorId: scope.identity });
        return latest.id === detail.id && latest.container_id === scope.project && !actionReason(latest, "move", verified);
      }} />
    </Dialog>}
  </>;
}
