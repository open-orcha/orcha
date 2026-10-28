/**
 * Workflows list (issue #350 §4.1 / §4.1b): the Shell toolbar (filter pills ·
 * search · owner · refresh · count) and the grouped `Row` list. Presentation
 * only: every label comes from the server row (`workflowLabel`, `completion`,
 * `progress`); nothing is inferred from the browser clock or stored status.
 */
import { forwardRef, useRef, useState, type ReactNode } from "react";
import { Icon } from "../../components/ui";
import { relTime } from "../../lib/format";
import {
  Avatar, Button, Chip, EmptyState, FilterPills, IconButton, List, ListGroup, Popover, Row, StatusIcon, Tooltip,
} from "../../components/primitives";
import { PageToolbar } from "../../shell/PageChrome";
import { RadioList } from "../tasks/TaskListView";
import { workflowLabel } from "./workflowApi";
import type { WorkflowDetail } from "./workflowContract.generated";

export type WorkflowFilter = "open" | "preparing" | "active" | "paused" | "ready" | "completed" | "cancelled" | "all" | "hidden";
export const WORKFLOW_FILTERS: { key: WorkflowFilter; label: string; title: string }[] = [
  { key: "open", label: "Open", title: "Active or paused workflows" },
  { key: "preparing", label: "Preparing", title: "Active workflows whose Start has not run" },
  { key: "active", label: "Active", title: "Started workflows" },
  { key: "paused", label: "Paused", title: "Paused workflows" },
  { key: "ready", label: "Ready to finish", title: "Every required task and objective is accepted" },
  { key: "completed", label: "Completed", title: "Finished workflows" },
  { key: "cancelled", label: "Cancelled", title: "Cancelled workflows" },
  { key: "hidden", label: "Hidden", title: "Hidden workflows — open one to restore it" },
  { key: "all", label: "All", title: "Every loaded workflow, grouped by status" },
];
/** The server receives status=active|paused|completed|cancelled; the finer pills filter loaded pages. */
export function workflowServerStatus(filter: string): string {
  return ["preparing", "active", "ready"].includes(filter) ? "active" : ["paused", "completed", "cancelled"].includes(filter) ? filter : "";
}
export function matchesWorkflowFilter(w: WorkflowDetail, filter: string): boolean {
  return filter === "hidden" ? !!w.hidden : w.hidden ? false : filter === "open" ? w.status === "active" || w.status === "paused"
    : filter === "preparing" ? w.status === "active" && !w.launch_enabled
    : filter === "ready" ? w.status === "active" && w.completion.can_finish
    : filter === "active" ? w.status === "active" && w.launch_enabled
    : filter === "all" ? true : w.status === filter;
}
/** Status glyph set from the design's table (§3): one `StatusIcon` status per workflow label. */
export function workflowStatusIcon(w: WorkflowDetail): string {
  const label = workflowLabel(w);
  return label === "Preparing" ? "pending" : label === "Ready to finish" ? "needs_verification" : label === "Active" ? "in_progress" : w.status;
}
export const MODE_LABEL: Record<WorkflowDetail["execution_mode"], { short: string; long: string }> = {
  serial: { short: "Serial", long: "One task at a time" },
  parallel: { short: "Parallel", long: "Independent tasks together; tasks with dependencies take their turn alone" },
};

/** 72 px bar with `accepted/total`; the same guards as the former WorkflowProgress sentence. */
export function WorkflowProgressBar({ accepted, total, size = "sm" }: { accepted: number | null; total: number | null; size?: "sm" | "lg" }) {
  const invalid = accepted === null || total === null || !Number.isSafeInteger(accepted) || !Number.isSafeInteger(total) || accepted < 0 || total < accepted;
  if (invalid) return <span className="wf-prog wf-muted">Task progress unavailable</span>;
  if (total === 0) return <span className="wf-prog wf-muted">No tasks yet</span>;
  const percentage = Math.floor(accepted / total * 100);
  return <span className={`wf-prog${size === "lg" ? " is-lg" : ""}`} role="img" aria-label={`${accepted} of ${total} tasks accepted · ${percentage}%`}>
    <span className="wf-prog-bar" aria-hidden="true"><i style={{ width: `${percentage}%` }} /></span>
    <span className="tnum" aria-hidden="true">{accepted}/{total}</span>
  </span>;
}

export interface WorkflowRowProps {
  workflow: WorkflowDetail;
  href: string;
  state?: unknown;
  ownerName: string;
  onRestore?: () => void;
  onActivate?: (e: { preventDefault(): void }) => void;
}
/** One 36 px row: glyph · title · goal · chips · progress · owner · age. */
export const WorkflowRow = forwardRef<HTMLElement, WorkflowRowProps>(function WorkflowRow({ workflow: w, href, ownerName, onActivate, onRestore }, ref) {
  const label = workflowLabel(w);
  const blocker = w.completion.blockers[0];
  const mode = MODE_LABEL[w.execution_mode];
  return <Row ref={ref} id={w.id} href={w.hidden ? undefined : href} className="wf-row" onActivate={onActivate} title={w.goal ? `${w.title} — ${w.goal}` : w.title}>
    <span className="wf-st"><StatusIcon status={workflowStatusIcon(w)} label={label} /></span>
    <span className="wf-title">{w.title}</span>
    <span className="wf-goal">{w.hidden ? `Hidden by ${w.hidden_by_alias ?? "Name unavailable"}${w.hidden_at ? ` on ${new Date(w.hidden_at).toLocaleDateString()}` : ""}` : w.goal}</span>
    <span className="wf-chips">
      <Chip title={mode.long}>{mode.short}</Chip>
      {blocker ? <Chip dot="warn" title={blocker.message}>{blocker.code === "tasks_unaccepted" ? "Tasks pending" : "Blocked"}</Chip> : null}
      {w.hidden ? <Chip dot="neutral" title={w.hidden_reason ?? "Hidden from the usual list"}>Hidden</Chip> : null}
    </span>
    <WorkflowProgressBar accepted={w.progress.accepted} total={w.progress.total} />
    {w.hidden && onRestore && <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}><Button variant="ghost" size="sm" onClick={(e) => { e.preventDefault(); onRestore(); }}>Restore</Button></span>}
    <span className="wf-who"><Avatar alias={ownerName} kind="human" size={20} label={`Owner: ${ownerName}`} /></span>
    {w.created_at && <time className="wf-age" dateTime={w.created_at} title={`Created ${new Date(w.created_at).toLocaleString()}`}>{relTime(w.created_at)}</time>}
  </Row>;
});

export function WorkflowRows({ rows, grouped, renderRow }: { rows: WorkflowDetail[]; grouped: boolean; renderRow: (w: WorkflowDetail) => ReactNode }) {
  if (!grouped) return <List label="Workflows" className="wf-rows">{rows.map(renderRow)}</List>;
  const groups = new Map<string, WorkflowDetail[]>();
  for (const w of rows) { const k = workflowLabel(w); groups.set(k, [...(groups.get(k) ?? []), w]); }
  return <List label="Workflows" className="wf-rows" role="list">{[...groups].map(([label, items]) => (
    <ListGroup key={label} id={label.toLowerCase().replace(/\s+/g, "-")} title={label} count={items.length} storageKey="orcha:v2:workflowGroups"
      glyph={<StatusIcon status={workflowStatusIcon(items[0])} label={label} decorative />}>
      {items.map(renderRow)}
    </ListGroup>))}</List>;
}

export interface WorkflowsToolbarProps {
  filter: string; setFilter: (k: string) => void;
  counts: Record<string, number> | null;
  search: string; setSearch: (v: string) => void;
  owners: { id: string; name: string }[]; owner: string; setOwner: (id: string) => void;
  shown: number; loaded: number; hasMore: boolean;
  onRefresh: () => void; refreshing: boolean;
  hiddenCount?: number | null;
}
export function WorkflowsToolbar({ filter, setFilter, counts, search, setSearch, owners, owner, setOwner, shown, loaded, hasMore, onRefresh, refreshing }: WorkflowsToolbarProps) {
  const [ownerOpen, setOwnerOpen] = useState(false);
  const ownerAnchor = useRef<HTMLButtonElement | null>(null);
  const countTitle = hasMore ? "More workflows are available; search and owner filters apply to loaded pages." : "All available pages loaded.";
  return <PageToolbar label="Workflow filters" className="wf-toolbar"
    end={<>
      <span className="wf-search">
        <label className="v2-sr" htmlFor="workflowsQ">Search loaded workflows</label>
        <Icon name="search" cls="v2-ico" />
        <input id="workflowsQ" className="wf-search-in" type="search" placeholder="Filter workflows…" title="Filter loaded workflows by title or goal"
          value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape" && search) { e.preventDefault(); e.stopPropagation(); setSearch(""); } }} />
      </span>
      <Tooltip label={countTitle}><span className="wf-filtercount tnum" aria-label={`${shown} of ${loaded} loaded workflows shown. ${countTitle}`}>{shown} of {loaded}</span></Tooltip>
      <IconButton ref={ownerAnchor} variant="outline" icon="sliders" label="Owner filter" className={owner ? "is-on" : undefined}
        aria-haspopup="dialog" aria-expanded={ownerOpen} onClick={() => setOwnerOpen((o) => !o)} />
      <Popover anchor={ownerAnchor} open={ownerOpen} onClose={() => setOwnerOpen(false)} label="Filter by owner" role="dialog" placement="bottom-end" className="wk-pop">
        <RadioList<string> legend="Owner" name="workflowsOwner" value={owner}
          options={[{ k: "", label: "Anyone" }, ...owners.map((o) => ({ k: o.id, label: o.name, icon: <Avatar alias={o.name} kind="human" size={16} decorative /> }))]}
          onChange={(k) => { setOwner(k); setOwnerOpen(false); }} />
      </Popover>
      <IconButton variant="outline" icon="refresh" label="Refresh workflows" disabled={refreshing} onClick={onRefresh} />
    </>}>
    <FilterPills label="Workflow status" size="sm" className="wf-scopes" value={filter} onChange={setFilter}
      items={WORKFLOW_FILTERS.map((f) => ({ key: f.key, label: f.label, title: f.title, count: counts ? counts[f.key] ?? 0 : null }))} />
  </PageToolbar>;
}

export function WorkflowListEmpty({ loadedAny, action }: { loadedAny: boolean; action?: ReactNode }) {
  return loadedAny
    ? <EmptyState title="No loaded workflows match these filters" body="Search and owner filters apply to the loaded pages." />
    : <EmptyState title="No workflows yet" body="Create one to plan tasks around a shared goal." action={action} />;
}
