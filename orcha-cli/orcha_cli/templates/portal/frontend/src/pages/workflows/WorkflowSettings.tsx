import { useEffect, useRef } from "react";
import { Button } from "../../components/primitives/Button";
import { Dialog } from "../../components/primitives/Dialog";
import { Segmented, MenuButton } from "../../components/primitives";
import { actionReason, workflowPaths } from "./workflowApi";
import { WorkflowChange } from "./WorkflowChange";
import type { WorkflowDetail } from "./workflowContract.generated";
import type { DraftScope } from "./workflowDraft";
import { useWorkflowForm } from "./workflowFormState";
import { useWorkflowOperation } from "./workflowOperations";
import { WorkflowObjectiveEditor } from "./WorkflowObjectiveEditor";
import { useDialogOpen, type DialogControl } from "./workflowDialogs";

export function WorkflowSettings({ detail, scope, verified, stale, humans, onSaved, control, initialSection = "settings" }: {
  detail: WorkflowDetail; scope: DraftScope; verified: boolean; stale: boolean; humans: { id: string; alias: string }[]; onSaved: (detail: WorkflowDetail) => void; control?: DialogControl; initialSection?: "settings" | "ownership";
}) {
  const [open, setOpen] = useDialogOpen(control);
  const ownership = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (open && initialSection === "ownership") { ownership.current?.scrollIntoView?.({ block: "start" }); ownership.current?.focus(); } }, [open, initialSection]);
  const [draft, setDraft] = useWorkflowForm(scope, `settings:${detail.id}`, { title: detail.title, goal: detail.goal,
    mode: detail.execution_mode, taskLimit: String(detail.task_limit), roundLimit: String(detail.round_limit), turns: String(detail.turn_allowance ?? 40), reason: "", owner: "" });
  const loops = detail.semantics_version === 2;
  const op = useWorkflowOperation(scope, `workflow:${detail.id}`);
  const frozen = op?.state === "sending" || op?.state === "uncertain";
  const invalid = !draft.title.trim() || !draft.goal.trim() || !draft.reason.trim() ? "Give the workflow a name, goal and reason for the change."
    : ![draft.taskLimit, draft.roundLimit, ...(loops ? [draft.turns] : [])].every((value) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0) ? "Enter positive whole-number limits."
    : loops && Number(draft.turns) > 1000 ? "The agent-turn allowance can be at most 1000." : null;
  return <>{!control && <Button onClick={() => setOpen(true)}>Workflow settings</Button>}
    {open && <Dialog title="Workflow settings" size="lg" className="wf-page" onClose={() => { if (!frozen) setOpen(false); }} footer={<Button disabled={frozen} onClick={() => setOpen(false)}>Keep draft and close</Button>}>
      <p>Changing the goal or scope requires renewed goal acceptance. After Start, changing how work runs requires Pause and all current turns to end; changing a setting never stops a worker.</p>
      <fieldset disabled={frozen || stale || !!actionReason(detail, "patch", verified)} className="wf-form-body">
        <label>Workflow name<input maxLength={200} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label>
        <label>Goal<textarea maxLength={4000} value={draft.goal} onChange={(e) => setDraft({ ...draft, goal: e.target.value })} /></label>
        <div className="wf-field"><span>How work runs</span><Segmented label="How work runs" value={draft.mode} onChange={(mode) => setDraft({ ...draft, mode: mode as "serial" | "parallel" })} items={[{ key: "serial", label: "One task at a time" }, { key: "parallel", label: "Independent tasks together" }]} /></div>
        <p>Tasks with dependencies take their turn alone, including review and worker stopping.</p>
        <label>Task limit<input type="number" min={1} value={draft.taskLimit} onChange={(e) => setDraft({ ...draft, taskLimit: e.target.value })} /></label>
        <label>Review-round limit<input type="number" min={1} value={draft.roundLimit} onChange={(e) => setDraft({ ...draft, roundLimit: e.target.value })} /></label>
        {loops && <label>Agent-turn allowance for this run<input type="number" min={1} max={1000} value={draft.turns} onChange={(e) => setDraft({ ...draft, turns: e.target.value })} />
          <small>{detail.turns_used ?? 0} used. When it runs out, no new agent turn starts until the owner raises it.</small></label>}
        <label>Reason<textarea maxLength={4000} value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })} /></label>
      </fieldset>
      <WorkflowChange detail={detail} scope={scope} verified={verified} stale={stale} operation="patch" url={workflowPaths.detail(detail.id)} method="PATCH"
        label="Settings change" invalid={invalid || actionReason(detail, "patch", verified)} body={{ title: draft.title.trim(), goal: draft.goal.trim(), execution_mode: draft.mode,
          task_limit: Number(draft.taskLimit), round_limit: Number(draft.roundLimit), ...(loops ? { turn_allowance: Number(draft.turns) } : {}), reason: draft.reason.trim() }} onSaved={(result) => { setOpen(false); onSaved(result); }}
        check={(latest) => actionReason(latest, "patch", verified) || (latest.launch_enabled && latest.status !== "paused" && latest.execution_mode !== draft.mode ? "Pause new starts and wait for current turns before changing how work runs." : null)}>
        {(latest) => <><p>{latest.title} → {draft.title}. Goal: {draft.goal}</p><p>Task limit: {draft.taskLimit}. Review-round limit: {draft.roundLimit}.{loops ? ` Agent-turn allowance: ${draft.turns}.` : ""} No automatic start or resume follows this save.</p></>}
      </WorkflowChange>
      <h3>Objectives</h3>
      {detail.objectives.length === 0 && <p>No objectives were added to this workflow.</p>}
      {detail.objectives.map((objective) => <WorkflowObjectiveEditor key={objective.id} detail={detail} objectiveId={objective.id} scope={scope} verified={verified} stale={stale} onSaved={onSaved} />)}
      <h3 ref={ownership} tabIndex={-1}>Transfer ownership</h3><p>The new owner must be an eligible human member. Task assignees do not become workflow owners.</p>
      <div className="wf-field"><span>New owner</span><MenuButton label={`New owner: ${humans.find((h) => h.id === draft.owner)?.alias ?? "Choose a person"}`} menuLabel="Choose new owner"
        disabled={frozen || stale || !!actionReason(detail, "transfer_owner", verified)} items={humans.filter((h) => h.id !== detail.owner_human_id).map((h) => ({ label: h.alias, onSelect: () => setDraft({ ...draft, owner: h.id }) }))} /></div>
      <WorkflowChange detail={detail} scope={scope} verified={verified} stale={stale} operation="transfer_owner" url={workflowPaths.detail(detail.id) + "/transfer-owner"}
        label="Ownership transfer" invalid={!draft.owner ? "Choose a new owner." : actionReason(detail, "transfer_owner", verified)} body={{ new_owner_id: draft.owner, reason: draft.reason.trim() }}
        check={(latest) => actionReason(latest, "transfer_owner", verified)} onSaved={(result) => { setOpen(false); onSaved(result); }}>
        {() => <p>{humans.find((h) => h.id === draft.owner)?.alias ?? "The selected person"} will control this workflow. This does not transfer project ownership or change task autonomy.</p>}
      </WorkflowChange>
    </Dialog>}
  </>;
}
