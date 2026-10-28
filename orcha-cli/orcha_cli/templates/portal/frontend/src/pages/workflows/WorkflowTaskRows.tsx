/**
 * Workflow task rows (issue #350 §4.2 callout 6, §4.8 callout 4): two-line `Row` = status glyph ·
 * title · sub-line · chips · assignee avatars · row ⋯ menu. Every word on the row is the server's
 * (`display_state`, `blockers`, `withdrawn_*`); the browser infers nothing from stored status.
 */
import { forwardRef, useRef, useState, type ReactNode } from "react";
import { Avatar, AvatarStack, Chip, IconButton, List, Menu, Row, StatusIcon, type MenuItemSpec } from "../../components/primitives";
import type { WorkflowTask } from "./workflowContract.generated";

export function formatServerTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "an unavailable time" : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "long" });
}

export interface WorkflowTaskRowProps {
  task: WorkflowTask;
  selected: boolean;
  onSelect: () => void;
  assignees: { id: string; alias: string; kind: string }[];
  actorName: (id: string) => string;
  /** Row ⋯ menu: the task's enabled `available_actions` (empty = no menu button). */
  menuItems: (MenuItemSpec | "separator")[];
  /** Dependencies list: "Depends on · Needed by" replaces the state sub-line. */
  subline?: ReactNode;
}

export const WorkflowTaskRow = forwardRef<HTMLElement, WorkflowTaskRowProps>(function WorkflowTaskRow({ task, selected, onSelect, assignees, actorName, menuItems, subline }, ref) {
  const menuRef = useRef<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const withdrawn = !!task.withdrawn_at;
  const warning = task.display_state.list_warning ? task.display_state.warning || "Released without stop confirmation: the worker may still be running outside Orcha." : null;
  const sub = subline ?? (withdrawn ? `Withdrawn by ${task.withdrawn_by ? actorName(task.withdrawn_by) : "Name unavailable"}`
    : task.display_state.release_available_at ? `Release lost worker becomes available at ${formatServerTime(task.display_state.release_available_at)}`
    : [task.display_state.label, task.blockers[0]?.message].filter(Boolean).join(" · "));
  return <Row ref={(el) => { if (el) el.id = `workflow-task-${task.id}`; if (typeof ref === "function") ref(el); else if (ref) ref.current = el; }} id={`workflow-task-${task.id}`} className="wf-row is-two" selected={selected} dim={withdrawn} onActivate={onSelect} title={task.title}>
    <span className="wf-st"><StatusIcon status={task.status} label={task.display_state.label} /></span>
    <span className="wf-title"><span>{task.title}</span><span className="wf-sub">{sub}</span></span>
    <span className="wf-chips">
      <Chip title={task.autonomy === "on" ? "Task autonomy ON: the agent approves its own plan and finished work" : "Task autonomy OFF: plan and finished work need approval"}>{task.autonomy === "on" ? "Autonomy ON" : "Autonomy OFF"}</Chip>
      {warning ? <Chip dot="warn" title={warning}>Warning</Chip> : null}
    </span>
    <span className="wf-who">{assignees.length === 0 ? <span className="wf-noone" role="img" aria-label="Unassigned" title="Unassigned" />
      : assignees.length === 1 ? <Avatar alias={assignees[0].alias} kind={assignees[0].kind} size={20} label={`Assigned to ${assignees[0].alias}`} />
      : <AvatarStack actors={assignees} size={20} label="Assigned to" />}</span>
    {menuItems.length > 0 && <span className="wf-rowmenu" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <IconButton ref={menuRef} icon="more" size="sm" label={`Actions for ${task.title}`} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)} />
      <Menu anchor={menuRef} open={menuOpen} onClose={() => setMenuOpen(false)} items={menuItems} label={`Actions for ${task.title}`} placement="bottom-end" />
    </span>}
  </Row>;
});

export function WorkflowTaskRows({ label, children }: { label: string; children: ReactNode }) {
  return <List label={label} className="wf-rows">{children}</List>;
}
