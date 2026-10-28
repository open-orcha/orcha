/**
 * Workflow task rows (issue #350 §4.2 callout 6, §4.8 callout 4): two-line `Row` = status glyph ·
 * title · sub-line · chips · assignee avatars · row ⋯ menu. Every word on the row is the server's
 * (`display_state`, `blockers`, `withdrawn_*`); the browser infers nothing from stored status.
 */
import { forwardRef, useRef, useState, type ReactNode } from "react";
import { Avatar, AvatarStack, Chip, IconButton, List, Menu, Row, StatusIcon, type MenuItemSpec } from "../../components/primitives";
import { Icon } from "../../components/ui";
import type { WorkflowTask } from "./workflowContract.generated";

export function formatServerTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "an unavailable time" : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "long" });
}

/** The first blocker's message, unless it only repeats the state label ("Waiting for Review" twice). */
function blockerUnlessRepeated(task: WorkflowTask): string | undefined {
  const message = task.blockers[0]?.message;
  if (!message) return undefined;
  const same = (text: string) => text.trim().replace(/\.$/, "").toLowerCase();
  return same(message) === same(task.display_state.label) ? undefined : message;
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
  /** Round of the repeat group the step belongs to (semantics version 2); the group header row
   * (`WorkflowLoopGroup`) carries the name, limit and exit rule (issue #362 x03). */
  loop?: { round: number } | null;
}

export const WorkflowTaskRow = forwardRef<HTMLElement, WorkflowTaskRowProps>(function WorkflowTaskRow({ task, selected, onSelect, assignees, actorName, menuItems, subline, loop }, ref) {
  const menuRef = useRef<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const withdrawn = !!task.withdrawn_at;
  const notSelected = task.route_state === "not_selected";
  const warning = task.display_state.list_warning ? task.display_state.warning || "Released without stop confirmation: the worker may still be running outside Orcha." : null;
  const sub = subline ?? (withdrawn ? `Withdrawn by ${task.withdrawn_by ? actorName(task.withdrawn_by) : "Name unavailable"}`
    : task.display_state.release_available_at ? `Release lost worker becomes available at ${formatServerTime(task.display_state.release_available_at)}`
    : [loop && loop.round > 0 ? `Round ${loop.round}` : null, task.display_state.label, blockerUnlessRepeated(task)].filter(Boolean).join(" · "));
  return <Row ref={(el) => { if (el) el.id = `workflow-task-${task.id}`; if (typeof ref === "function") ref(el); else if (ref) ref.current = el; }} id={`workflow-task-${task.id}`} className={`wf-row is-two${notSelected ? " wf-notsel" : ""}`} selected={selected} dim={withdrawn} onActivate={onSelect} title={task.title}>
    <span className="wf-st"><StatusIcon status={task.status} label={task.display_state.label} /></span>
    <span className="wf-title"><span>{task.title}</span><span className="wf-sub">{sub}</span></span>
    <span className="wf-chips">
      <Chip title={task.autonomy === "on" ? "Task autonomy ON: the agent approves its own plan and finished work" : "Task autonomy OFF: plan and finished work need approval"}>{task.autonomy === "on" ? "Autonomy ON" : "Autonomy OFF"}</Chip>
      {task.awaiting_loop_decision ? <Chip dot="warn" title={task.display_state.label}>Decision needed</Chip> : null}
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

const PAUSED = new Set(["limit_reached", "stalled", "awaiting_owner"]);
const GROUP_STATE: Record<string, string> = { limit_reached: "Round limit reached", stalled: "Stalled", awaiting_owner: "Waiting for the owner", exited: "Finished", stopped: "Stopped" };

/** A repeat group drawn as a bracket around its consecutive rows, with a header in words (issue #362
 * x03 callout 1): name, round of the limit, round dots, the exit rule and who decides at the limit. */
export function WorkflowLoopGroup({ group, reviewTitle, ownerName, children }: {
  group: { name: string; current_round: number; max_rounds: number; exit_outcome: string; state: string };
  reviewTitle?: string; ownerName?: string; children: ReactNode;
}) {
  // Round 0 means the loop has not opened yet (before Start, or on a path not reached): no round is lit.
  const round = group.current_round;
  const paused = PAUSED.has(group.state);
  const ended = group.state === "exited" || group.state === "stopped";
  const of = round < 1 ? `Not started · up to ${group.max_rounds} rounds` : `Round ${round} of ${group.max_rounds}`;
  return <div className="wf-loop" role="group" aria-label={`${group.name}, ${of.toLowerCase()}`}>
    <div className="wf-loop-h">
      <Icon name="refresh" cls="v2-ico wf-loop-ico" /><b>{group.name}</b><span aria-hidden="true">·</span><span>{of}</span>
      <span className="wf-rounds" role="img" aria-label={of}>{Array.from({ length: group.max_rounds }, (_, i) => i + 1).map((n) =>
        <i key={n} className={`wf-rnd${n < round || (n === round && ended) ? " is-done" : n === round ? (paused ? " is-stop" : " is-now") : ""}`} />)}</span>
      {reviewTitle && <><span aria-hidden="true">·</span><span>exits when {reviewTitle} reports {group.exit_outcome}</span></>}
      <span aria-hidden="true">·</span><span>then asks {ownerName ?? "the owner"}</span>
      {GROUP_STATE[group.state] && <Chip size="sm" dot={paused ? "warn" : undefined}>{GROUP_STATE[group.state]}</Chip>}
    </div>
    {children}
  </div>;
}

export function WorkflowTaskRows({ label, children }: { label: string; children: ReactNode }) {
  return <List label={label} className="wf-rows">{children}</List>;
}
