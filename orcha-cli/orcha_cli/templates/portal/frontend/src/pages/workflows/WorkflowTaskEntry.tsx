import { useDialogOpen, type DialogControl } from "./workflowDialogs";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "../../components/primitives/Button";
import { Dialog } from "../../components/primitives/Dialog";
import { useActingAuthority, useSnapshot } from "../../state/SnapshotProvider";
import { actionReason, workflowPaths, workflowRequest } from "./workflowApi";
import { useTaskWorkflow } from "./WorkflowTaskContext";
import type { WorkflowDetail } from "./workflowContract.generated";

/** Explicit, read-only discovery from the existing task inspector. Navigation
 * only seeds a retained draft; importing still requires the full group preview. */
export function WorkflowTaskEntry({ taskId, control }: { taskId: string; control?: DialogControl }) {
  const { cid, identityTrusted, identityPending } = useSnapshot();
  const authority = useActingAuthority();
  const { index, member } = useTaskWorkflow(taskId);
  if (member || (index && !["ready", "unsupported"].includes(index.state))) return null;
  const actorId = !identityPending ? authority.human?.id ?? null : null;
  return <TaskEntry key={JSON.stringify([cid, taskId, actorId, identityTrusted])} cid={cid} taskId={taskId} actorId={actorId} control={control} />;
}
function TaskEntry({ cid, taskId, actorId, control }: { cid: string | null; taskId: string; actorId: string | null; control?: DialogControl }) {
  const [open, setOpen] = useDialogOpen(control);
  useEffect(() => { if (open && control) void load(); }, [open]);
  const [workflows, setWorkflows] = useState<WorkflowDetail[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const member = workflows.find((w) => w.tasks.some((t) => t.id === taskId));
  async function load(next: string | null = null) {
    if (!cid || busy) return;
    setBusy(true); setError("");
    try {
      const q = new URLSearchParams({ limit: "50", visibility: "all" }); if (next) q.set("cursor", next);
      const page = await workflowRequest("WorkflowList", workflowPaths.collection(cid) + `?${q}`, { actorId });
      if (page.workflows.some((w) => w.container_id !== cid) || (next && page.next_cursor === next)) throw new Error("The workflow list changed. Retry before continuing.");
      setWorkflows((old) => [...new Map([...(next ? old : []), ...page.workflows].map((w) => [w.id, w])).values()]);
      setCursor(page.next_cursor ?? null); setLoaded(true);
    } catch { setError("Workflows could not be loaded on this connection. Your task is unchanged."); }
    finally { setBusy(false); }
  }
  const href = (id: string, adding = true) => `/workflows/${encodeURIComponent(id)}?${new URLSearchParams({ cid: cid ?? "", ...(adding ? { addTask: taskId } : {}) })}`;
  return <>{!control && <Button onClick={() => { setOpen(true); void load(); }}>Workflow membership</Button>}
    {open && <Dialog title="Workflow membership" size="lg" onClose={() => setOpen(false)} footer={<Button onClick={() => setOpen(false)}>Close</Button>}>
      {busy && <p role="status">Checking task membership…</p>}{error && <p role="alert">{error} <Button onClick={() => void load(cursor)}>Retry workflows</Button></p>}
      {member ? <p>This task already belongs to <Link to={href(member.id, false)}>{member.title}</Link>. It cannot be added to a second workflow.</p> : <>
        <p>A task can belong to one workflow. Adding it requires reviewing the whole related task group; opening a draft does not change or start this task.</p>
        {!actorId && <p>Choose a current human member of this project to add this task to a workflow.</p>}
        {loaded && !cursor && !busy && !error && actorId && <p><Link to={href("new")}>Create workflow with this task</Link></p>}
        {loaded && !cursor && !busy && !error && <ul>{workflows.filter((w) => w.status === "active").map((w) => <li key={w.id}>
          {actionReason(w, "import", !!actorId) ? <span>{w.title} — {actionReason(w, "import", !!actorId)}</span> : <Link to={href(w.id)}>Add to {w.title}</Link>}
        </li>)}</ul>}
        {cursor && <><p>More workflows remain to be checked before adding this task.</p><Button disabled={busy} onClick={() => void load(cursor)}>Check more workflows</Button></>}
      </>}
    </Dialog>}
  </>;
}
