/**
 * Workflow detail header (issue #350 §4.2 callouts 1–4, 8): display title (focus target on
 * arrival), meta row, two-line goal, ONE primary action, the ⋯ menu and the refresh icon.
 * Every enabled/disabled decision comes from the server's `available_actions` through
 * `actionReason`; the header never infers permissions from local state.
 */
import { useEffect, useRef, useState } from "react";
import { Avatar, Chip, IconButton, Menu, StatusIcon, Tooltip, type MenuItemSpec } from "../../components/primitives";
import { Button } from "../../components/primitives/Button";
import { actionReason, workflowLabel } from "./workflowApi";
import type { WorkflowDetail } from "./workflowContract.generated";
import { MODE_LABEL, WorkflowProgressBar, workflowStatusIcon } from "./WorkflowListView";

/** Workflow-level actions in the menu's fixed order (§4.2 callout 4). `hide` is §4.14. */
export type WorkflowMenuAction = "start" | "pause" | "resume" | "add_tasks" | "import" | "move" | "review_round" | "settings" | "transfer_owner" | "hide" | "cancel" | "finish";
export const WORKFLOW_ACTION_LABEL: Record<WorkflowMenuAction, string> = {
  start: "Review start", pause: "Pause new starts", resume: "Resume workflow", add_tasks: "Add new tasks…", import: "Add existing tasks…",
  move: "Move or remove tasks…", review_round: "Record review outcome…", settings: "Workflow settings…", transfer_owner: "Transfer ownership…",
  hide: "Hide workflow…", cancel: "Cancel workflow…", finish: "Finish checklist",
};
const MENU_ORDER: (WorkflowMenuAction | "separator")[] = ["start", "pause", "resume", "separator", "add_tasks", "import", "move", "review_round", "separator", "settings", "transfer_owner", "separator", "hide", "cancel"];

/** Settings has no single server action: it is enabled whenever any of its sub-actions is. */
export function workflowMenuReason(detail: WorkflowDetail, action: WorkflowMenuAction, verified: boolean): string | null {
  if (action === "settings") {
    const reasons = ["patch", "transfer_owner"].map((a) => actionReason(detail, a, verified));
    return reasons.some((r) => !r) ? null : reasons[0];
  }
  if (action === "finish") return null; // the checklist stays discoverable for readers
  if (action === "hide") return detail.available_actions?.some((a) => a.action === (detail.hidden ? "restore" : "hide")) ? actionReason(detail, detail.hidden ? "restore" : "hide", verified) : "Hiding workflows is not available on this server.";
  return actionReason(detail, action, verified);
}

/** The single primary button: the first enabled of start → resume → finish, else finish. */
export function workflowPrimaryAction(detail: WorkflowDetail, verified: boolean): WorkflowMenuAction {
  for (const a of ["start", "resume"] as const) if (!workflowMenuReason(detail, a, verified)) return a;
  return "finish";
}

export function WorkflowHeader({ detail, ownerName, verified, stale, frozen, onAction, onRefresh, refreshing, primaryHidden, railToggle }: {
  detail: WorkflowDetail; ownerName: string; verified: boolean; stale: boolean;
  /** An operation is sending or uncertain: every action is disabled and the notice shows (§4.2 callout 4). */
  frozen: boolean;
  onAction: (action: WorkflowMenuAction) => void; onRefresh: () => void; refreshing: boolean;
  /** While an editor owns the primary slot (§4.12/§4.13), the workflow primary moves behind More. */
  primaryHidden?: boolean;
  railToggle?: { open: boolean; onToggle: () => void };
}) {
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  // Focus target on arrival (replaces the former focused <h2>), once per workflow.
  useEffect(() => { titleRef.current?.focus(); }, [detail.id]);
  const label = workflowLabel(detail);
  const mode = MODE_LABEL[detail.execution_mode];
  const goalAccepted = detail.goal_accepted_revision === detail.goal_revision;
  const primary = workflowPrimaryAction(detail, verified);
  const reasonFor = (a: WorkflowMenuAction) => workflowMenuReason(detail, a, verified);
  const blockedBy = (a: WorkflowMenuAction) => frozen ? "Wait for the current save to finish." : a !== "finish" && stale ? "Refresh before making changes." : reasonFor(a);
  const items: (MenuItemSpec | "separator")[] = MENU_ORDER.flatMap<MenuItemSpec | "separator">((a) => {
    if (a === "separator") return ["separator" as const];
    if (a === primary && !primaryHidden) return [];
    const reason = blockedBy(a);
    const label = a === "hide" && detail.hidden ? "Restore workflow…" : WORKFLOW_ACTION_LABEL[a];
    return [{ label, danger: a === "cancel", disabled: !!reason, disabledReason: reason ?? undefined, onSelect: () => onAction(a) }];
  });
  if (primaryHidden) items.unshift({ label: WORKFLOW_ACTION_LABEL.finish, disabled: frozen, disabledReason: frozen ? "Wait for the current save to finish." : undefined, onSelect: () => onAction("finish") }, "separator");
  const progressTitle = `${detail.progress.accepted} of ${detail.progress.total} tasks accepted · ${detail.progress.objectives_accepted} of ${detail.progress.objectives_total} objectives accepted`;
  return <header className="wf-head">
    <h1 ref={titleRef} tabIndex={-1} className="wf-head-title">{detail.title}</h1>
    <div className="wf-head-meta">
      <StatusIcon status={workflowStatusIcon(detail)} label={label} showLabel />
      <span aria-hidden="true">·</span>
      <span className="wf-owner"><Avatar alias={ownerName} kind="human" size={16} decorative />{ownerName}</span>
      <span aria-hidden="true">·</span>
      <Chip title={mode.long}>{mode.short}</Chip>
      <Tooltip label={progressTitle}><span><WorkflowProgressBar accepted={detail.progress.accepted} total={detail.progress.total} size="lg" />
        <span className="wf-muted tnum"> · {detail.progress.objectives_accepted}/{detail.progress.objectives_total} objectives</span></span></Tooltip>
      <Chip dot={goalAccepted ? "ok" : "warn"} title={goalAccepted ? "The current goal is accepted" : "The current goal still needs acceptance with saved evidence"}>{goalAccepted ? "Goal accepted" : "Goal needs acceptance"}</Chip>
      {detail.hidden ? <Chip dot="neutral" title={detail.hidden_reason ?? "Hidden from the usual list"}>Hidden</Chip> : null}
    </div>
    <p className="wf-head-goal" title={detail.goal}>{detail.goal}</p>
    <div className="wf-head-actions">
      {!primaryHidden && <Button variant="primary" disabled={!!blockedBy(primary)} title={primary === "finish" ? "Review requirements before finishing" : blockedBy(primary) ?? undefined}
        onClick={() => onAction(primary)}>{WORKFLOW_ACTION_LABEL[primary]}</Button>}
      <IconButton variant="outline" icon="refresh" label="Refresh workflow" disabled={refreshing} onClick={onRefresh} />
      {railToggle && <IconButton variant="outline" icon="info" label="Details" className={`wf-rail-toggle${railToggle.open ? " is-on" : ""}`} aria-pressed={railToggle.open} onClick={railToggle.onToggle} />}
      <IconButton ref={moreRef} variant="outline" icon="more" label="More workflow actions" aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)} />
      <Menu anchor={moreRef} open={moreOpen} onClose={() => setMoreOpen(false)} items={items} label="More workflow actions" placement="bottom-end" />
    </div>
  </header>;
}
