import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button } from "../../components/primitives/Button";
import "./workflows.css";
import { WorkflowTaskLink } from "./WorkflowTaskReturn";

/** Presentation inputs, not server DTOs. The adapter uses the
 * generated API contract and authoritative totals/display state. No inference
 * from stored task status, logs, partial pages or the browser clock. */
export interface WorkflowTaskView {
  id: string;
  title: string;
  assignee: string | null;
  displayLabel: string;
  reasons: string[];
  prerequisites: { id: string; title: string }[];
  dependents: { id: string; title: string }[];
  unconfirmedStopWarning: boolean;
  warning?: string | null;
  withdrawal?: { by: string; reason: string } | null;
  releaseAvailableAt: string | null;
  autonomy: boolean | null;
}

export interface WorkflowSummaryView {
  id: string;
  name: string;
  goal: string;
  owner: string;
  displayLabel: string;
  modeLabel: string;
  acceptedTasks: number | null;
  totalTasks: number | null;
  acceptedObjectives: number | null;
  totalObjectives: number | null;
  goalLabel: string;
}

export function workflowTaskHref(cid: string, id: string): string {
  return `/tasks?${new URLSearchParams({ task: id, cid })}`;
}

export function WorkflowProgress({ accepted, total }: { accepted: number | null; total: number | null }) {
  if (accepted === null || total === null || !Number.isSafeInteger(accepted) || !Number.isSafeInteger(total) || accepted < 0 || total < accepted) {
    return <p>Task progress unavailable</p>;
  }
  if (total === 0) return <p>No tasks yet</p>;
  const percentage = Math.floor(accepted / total * 100);
  return <div className="wf-progress"><p>{accepted} of {total} tasks accepted · {percentage}%</p>
    <progress value={accepted} max={total} aria-label="Accepted tasks" />
  </div>;
}

export function WorkflowSummary({ workflow, focusHeading = false }: { workflow: WorkflowSummaryView; focusHeading?: boolean }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (focusHeading) heading.current?.focus(); }, [workflow.id, focusHeading]);
  return <section className="wf-summary" aria-label="Workflow goal and progress">
    <h2 ref={heading} tabIndex={-1}>{workflow.name}</h2><p>{workflow.goal}</p>
    <dl><div><dt>Owner</dt><dd>{workflow.owner}</dd></div><div><dt>Status</dt><dd>{workflow.displayLabel}</dd></div><div><dt>How work runs</dt><dd>{workflow.modeLabel}</dd></div></dl>
    <WorkflowProgress accepted={workflow.acceptedTasks} total={workflow.totalTasks} />
    <p>{workflow.acceptedObjectives === null || workflow.totalObjectives === null ? "Objective progress unavailable" : `${workflow.acceptedObjectives} of ${workflow.totalObjectives} objectives accepted`}</p>
    <p>{workflow.goalLabel}</p>
  </section>;
}

export function WorkflowTaskList({ cid, tasks, total, renderActions }: { cid: string; tasks: WorkflowTaskView[]; total: number | null; renderActions?: (id: string) => ReactNode }) {
  return <div>
    <p>{total === null ? `${tasks.length} tasks shown; total unavailable` : `${tasks.length} of ${total} tasks shown`}</p>
    <ul className="wf-task-list">{tasks.map((task) => <li key={task.id} id={`workflow-task-${task.id}`} tabIndex={-1}>
      <WorkflowTaskLink cid={cid} taskId={task.id}>{task.title}</WorkflowTaskLink>
      <p>{task.displayLabel} · {task.assignee || "Unassigned"}</p>
      {task.withdrawal && <p>Withdrawn by {task.withdrawal.by}: {task.withdrawal.reason}</p>}
      <p>Task autonomy {task.autonomy === null ? "unavailable" : task.autonomy ? "ON" : "OFF"}</p>
      {task.reasons.length > 0 && <ul>{task.reasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul>}
      <p>Depends on: {task.prerequisites.length === 0 ? "None" : task.prerequisites.map((t, i) => <span key={t.id}>{i > 0 && ", "}<WorkflowTaskLink cid={cid} taskId={t.id}>{t.title}</WorkflowTaskLink></span>)}</p>
      <p>Needed by: {task.dependents.length === 0 ? "None" : task.dependents.map((t, i) => <span key={t.id}>{i > 0 && ", "}<WorkflowTaskLink cid={cid} taskId={t.id}>{t.title}</WorkflowTaskLink></span>)}</p>
      {task.releaseAvailableAt && <p>If the worker stays silent, Release lost worker becomes available at <time dateTime={task.releaseAvailableAt}>{formatServerTime(task.releaseAvailableAt)}</time>. Refresh to check availability.</p>}
      {task.unconfirmedStopWarning && <p className="wf-warning">{task.warning || "Released without stop confirmation: the worker may still be running outside Orcha."}</p>}
      {renderActions?.(task.id)}
    </li>)}</ul>
  </div>;
}

function formatServerTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "an unavailable time" : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "long" });
}

export interface SavedEvidenceView {
  state: "pending" | "saved" | "missing" | "superseded";
  workRevisionLabel: string;
  sourceLabel: string;
  missingReason?: string;
  items: { name: string; version: number; href: string; readable: boolean }[];
}

/** Evidence links must address immutable versions, never a mutable latest file
 * or a worker log. The API adapter also verifies storage state and hashes. */
function evidenceHref(href: string, version: number): string | null {
  const match = /^\/api\/tasks\/[^/?#]+\/deliverables\/[^/?#]+\/versions\/(\d+)\/raw$/.exec(href);
  return match && Number(match[1]) === version && version > 0 && !/[\\\s]/.test(href) ? href : null;
}

export function SavedEvidence({ evidence }: { evidence: SavedEvidenceView }) {
  const title = evidence.state === "pending" ? "Saving evidence…" : evidence.state === "missing" ? "Evidence missing — add it before accepting" : evidence.state === "superseded" ? "Earlier saved evidence" : "Saved evidence";
  return <section aria-label="Saved evidence" className="wf-evidence">
    <h3>{title}</h3><p>{evidence.workRevisionLabel} · {evidence.sourceLabel}</p>
    {evidence.state === "pending" && <p>Evidence is still being saved. Acceptance is unavailable.</p>}
    {evidence.missingReason && <p>{evidence.missingReason}</p>}
    <ul>{evidence.items.map((item, index) => <li key={index}>
      {item.readable && evidenceHref(item.href, item.version) ? <a href={evidenceHref(item.href, item.version)!}>{item.name} — version {item.version}</a> : <span>{item.name} — version {item.version}: unavailable</span>}
    </li>)}</ul>
  </section>;
}

export function WorkerDetailsNotice({ state }: { state: "not_loaded" | "pruned" | "unavailable" }) {
  return <p>{state === "not_loaded" ? "Worker details not loaded." : state === "pruned" ? "Older worker details are no longer available. Use the saved results and review evidence above." : "Worker details are unavailable."}</p>;
}

/** An explanatory diagram; all interaction and equivalent relationships stay
 * in the keyboard-operable list. No drag editing or execution simulation. */
export function WorkflowDependencies({ cid, tasks, total }: { cid: string; tasks: WorkflowTaskView[]; total: number | null }) {
  const [graph, setGraph] = useState(false);
  const [scale, setScale] = useState(1);
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState("");
  const region = useRef<HTMLDivElement>(null);
  const marker = useId().replace(/:/g, "");
  const selected = tasks.find((task) => task.id === selection);
  const neighborhood = selected ? new Set([selected.id, ...selected.prerequisites.map((t) => t.id), ...selected.dependents.map((t) => t.id)]) : null;
  const matches = tasks.filter((t) => t.title.toLowerCase().includes(search.toLowerCase()));
  const shown = tasks.filter((t) => neighborhood ? neighborhood.has(t.id) : matches.includes(t)).slice(0, 30);
  return <section aria-label="Dependencies">
    <div className="wf-actions"><Button aria-pressed={!graph} onClick={() => setGraph(false)}>List</Button><Button aria-pressed={graph} onClick={() => setGraph(true)}>Graph and list</Button></div>
    <label>Find a workflow task<input type="search" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
    <label>Selected task<select value={selection} onChange={(e) => setSelection(e.target.value)}><option value="">No selection</option>{matches.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label>
    {selected && <div className="wf-notice"><h3>{selected.title}</h3><p>{selected.displayLabel} · {selected.assignee || "Unassigned"}</p>
      {selected.unconfirmedStopWarning && <p>{selected.warning || "Released without stop confirmation: the worker may still be running outside Orcha."}</p>}
      {selected.reasons.map((reason, i) => <p key={i}>{reason}</p>)}<WorkflowTaskLink cid={cid} taskId={selected.id}>Open selected task</WorkflowTaskLink>
      <Button onClick={() => setSelection("")}>Reset selection</Button></div>}
    <p>Arrows point from a prerequisite to the task that needs its acceptance. They do not show workers running or promise simultaneous starts.</p>
    {graph && <>
      <p>{shown.length} {shown.length === 1 ? "task" : "tasks"} in the graph{total === null ? "; total unavailable" : ` of ${total}`}. {selected ? "Showing the selected task and its direct prerequisites and dependents, up to 30 tasks." : "Showing up to 30 matching tasks."} Relationships to tasks outside this graph remain in the list.</p>
      <div className="wf-actions"><Button onClick={() => setScale((s) => Math.min(2, s + .25))}>Zoom in</Button><Button onClick={() => setScale((s) => Math.max(.25, s - .25))}>Zoom out</Button><Button onClick={() => setScale(Math.max(.25, Math.min(1, (region.current?.clientWidth ?? 600) / 600)))}>Fit graph</Button><Button onClick={() => setScale(1)}>Reset zoom</Button></div>
      <div ref={region} className="wf-graph" tabIndex={0} role="region" aria-label="Dependency diagram; scroll to explore. Use the task list for links and full relationships.">
        <svg width={600 * scale} height={Math.max(80, shown.length * 92) * scale} viewBox={`0 0 600 ${Math.max(80, shown.length * 92)}`} role="group" aria-label="Workflow dependency graph">
          <defs><marker id={marker} markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L6,3 z" fill="currentColor" /></marker></defs>
          {shown.flatMap((task, i) => task.prerequisites.map((p) => {
            const j = shown.findIndex((t) => t.id === p.id);
            if (j < 0) return null;
            return <path key={`${task.id}-${p.id}`} d={`M 460 ${j * 92 + 36} C 560 ${j * 92 + 36}, 560 ${i * 92 + 36}, 460 ${i * 92 + 36}`} fill="none" stroke="currentColor" markerEnd={`url(#${marker})`} />;
          }))}
          {shown.map((task, i) => <g key={task.id} transform={`translate(12 ${i * 92 + 4})`} role="button" tabIndex={0}
            aria-label={`Select ${task.title}: ${task.displayLabel}${task.unconfirmedStopWarning ? ` · ${task.warning || "Released without stop confirmation: the worker may still be running outside Orcha."}` : ""}`} aria-pressed={selection === task.id}
            onClick={() => setSelection(task.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelection(task.id); } }}>
            <rect width="448" height="70" rx="6" /><text x="12" y="24">{task.title.length > 50 ? `${task.title.slice(0, 47)}…` : task.title}</text>{task.unconfirmedStopWarning && <text x="420" y="24" aria-hidden="true">⚠</text>}<text x="12" y="49">{task.displayLabel.slice(0, 60)}</text></g>)}
        </svg>
      </div>
    </>}
    <WorkflowTaskList cid={cid} tasks={matches} total={total} />
  </section>;
}
