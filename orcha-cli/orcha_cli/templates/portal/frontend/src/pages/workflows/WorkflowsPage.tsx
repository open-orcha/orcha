import { WorkflowInput } from "./WorkflowInput";
import { WorkflowGraph } from "./WorkflowGraph";
import { useEffect, useRef, useState } from "react";
import { Icon } from "../../components/ui";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { getJSON } from "../../api/client";
import { Button } from "../../components/primitives/Button";
import { Shell } from "../../shell/Shell";
import { useActingAuthority, useSnapshot } from "../../state/SnapshotProvider";
import { WorkflowDraftEditor } from "./WorkflowDraftEditor";
import { WorkflowActions } from "./WorkflowActions";
import { WorkflowImport } from "./WorkflowImport";
import { WorkflowAddTasks } from "./WorkflowAddTasks";
import { WorkflowSettings } from "./WorkflowSettings";
import { WorkflowMove } from "./WorkflowMove";
import { WorkflowResolveReview, WorkflowReviewEditor } from "./WorkflowReviewEditor";
import { WorkflowActivity, WorkflowReviewHistory } from "./WorkflowHistory";
import { WorkflowHeader } from "./WorkflowHeader";
import { WorkflowRail } from "./WorkflowRail";
import { WorkflowLoopDecision, WorkflowOwnerBar } from "./WorkflowLoopDecision";
import { pathDecider, WorkflowRoutePanel } from "./WorkflowRouteSummary";
import { WorkflowLoopGroup, WorkflowTaskRow, WorkflowTaskRows } from "./WorkflowTaskRows";
import { WorkflowTaskInspector } from "./WorkflowTaskInspector";
import { WorkflowHide } from "./WorkflowHide";
import { TASK_ACTION_KEYS, taskActionLabel, taskReason, type TaskActionRequest } from "./WorkflowTaskActions";
import type { WorkflowActionRequest } from "./WorkflowActions";
import { useWorkflowOperation } from "./workflowOperations";
import { WorkflowListEmpty, WorkflowRow, WorkflowRows, WorkflowsToolbar, matchesWorkflowFilter, workflowServerStatus } from "./WorkflowListView";
import { Skeleton, EmptyState, SplitPane, Segmented, Tabs, type MenuItemSpec } from "../../components/primitives";
import { actionReason, hasWorkflowRoutes, WorkflowApiError, workflowPaths, workflowRequest, workflowWriteReason } from "./workflowApi";
import type { Capability, WorkflowDetail, WorkflowList, WorkflowTask } from "./workflowContract.generated";
import { workflowListReturnTarget, workflowNavigationState } from "./workflowNavigation";
import "./workflows.css";

type Availability = "checking" | "unsupported" | "ready" | "unavailable" | "forbidden";
export { hasWorkflowRoutes } from "./workflowApi";
export function WorkflowsPage() {
  const context = useSnapshot();
  const authority = useActingAuthority();
  const { pathname } = useLocation();
  // Never carry an old actor's reads or confirmations across identity/project changes.
  const key = JSON.stringify([context.cid, authority.human?.id, context.identityTrusted, context.identityPending, pathname]);
  return <WorkflowScreen key={key} />;
}
function WorkflowScreen() {
  const { cid, snap, identityPending } = useSnapshot();
  const authority = useActingAuthority();
  const location = useLocation();
  const { pathname } = location;
  const navigationState = workflowNavigationState(location.state);
  const restoredFocus = useRef(false);
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const isNew = pathname === "/workflows/new";
  const workflowId = !isNew && pathname.startsWith("/workflows/") ? decodeURIComponent(pathname.slice("/workflows/".length)) : null;
  const actorId = !identityPending ? authority.human?.id ?? null : null;
  const verified = !!actorId;
  const scope = { origin: window.location.origin, project: cid ?? "", identity: actorId ?? "unverified" };
  const [availability, setAvailability] = useState<Availability>("checking");
  const [capability, setCapability] = useState<Capability | null>(null);
  const [list, setList] = useState<WorkflowList | null>(null);
  const [detail, setDetail] = useState<WorkflowDetail | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [stale, setStale] = useState(false);
  const [retry, setRetry] = useState(0);
  const [next, setNext] = useState<string | null>(null);
  const filter = params.get("status") ?? "open";
  const search = params.get("search") ?? "";
  const owner = params.get("owner") ?? "";
  const tab = params.get("tab") ?? "tasks";
  // Detail-page UI state (issue #350 §4.2/§4.3): selected task (inspector), header-menu dialogs,
  // action requests and the folded property rail. Selection is presentation only.
  const [restoreId, setRestoreId] = useState<string | null>(null);
  const [inputOpen, setInputOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [decideId, setDecideId] = useState<string | null>(null);
  const [menuDialog, setMenuDialog] = useState<"import" | "add_tasks" | "move" | "review_round" | "settings" | "transfer_owner" | "hide" | null>(params.get("addTask") ? "import" : null);
  const [actionRequest, setActionRequest] = useState<WorkflowActionRequest | null>(null);
  const [taskRequest, setTaskRequest] = useState<{ taskId: string; action: TaskActionRequest["action"] | "review"; seq: number } | null>(null);
  const requestSeq = useRef(0);
  const [railOpen, setRailOpen] = useState(false);
  const [addSeed, setAddSeed] = useState<{ after: string | null; seq: number } | null>(null);
  const [graphMode, setGraphMode] = useState(false);
  const [taskSearch, setTaskSearch] = useState("");
  const operation = useWorkflowOperation(scope, `workflow:${workflowId ?? ""}`);
  const unresolved = operation?.state === "sending" || operation?.state === "uncertain";
  useEffect(() => {
    // A direct task link arrives before the asynchronous workflow read. Move
    // keyboard focus only once the named task actually exists on this page.
    if (!detail || tab !== "tasks") return;
    const task = detail.tasks.find((t) => location.hash === `#workflow-task-${encodeURIComponent(t.id)}`);
    const row = task && document.getElementById(`workflow-task-${task.id}`);
    if (row) { row.scrollIntoView?.({ block: "nearest" }); row.focus(); }
    if (task) setSelectedId(task.id);
  }, [detail?.id, location.hash]);
  const initialTaskId = params.get("addTask") ?? undefined;
  const serverStatus = workflowServerStatus(filter);
  const query = (key: string, value: string) => setParams((previous) => { const p = new URLSearchParams(previous); value ? p.set(key, value) : p.delete(key); return p; });
  const actorName = (id: string) => snap?.agents.find((a) => a.id === id)?.alias ?? "Name unavailable";
  const href = (id?: string) => !id && cid && workflowListReturnTarget(navigationState.workflowListReturn, cid)
    || `${id ? `/workflows/${encodeURIComponent(id)}` : "/workflows"}?${new URLSearchParams({ cid: cid ?? "" })}`;
  const returnState = (focus?: string) => {
    if (pathname !== "/workflows") return navigationState;
    const query = new URLSearchParams(location.search);
    query.set("cid", cid ?? "");
    return { workflowListReturn: `${pathname}?${query}`, workflowListFocus: focus };
  };
  useEffect(() => { setNext(null); setList(null); }, [serverStatus, filter === "hidden"]);
  useEffect(() => {
    if (!cid) return;
    const controller = new AbortController();
    let active = true;
    setLoading(true); setError(""); setStale(true);
    const timer = setTimeout(() => controller.abort(), 15_000);
    async function load() {
      const spec = await getJSON<unknown>("/openapi.json", controller.signal);
      if (!hasWorkflowRoutes(spec)) { if (active) { setAvailability("unsupported"); setList(null); setDetail(null); } return; }
      const cap = await workflowRequest("Capability", workflowPaths.collection(cid!) + "/capability", { signal: controller.signal, actorId });
      if (cap.workflow_read !== true) throw new WorkflowApiError("You do not have access to read workflows on this connection.", 403);
      if (!active) return;
      setCapability(cap);
      if (workflowId) {
        const current = await workflowRequest("WorkflowDetail", workflowPaths.detail(workflowId), { signal: controller.signal, actorId });
        if (current.container_id !== cid || current.id !== workflowId) throw new Error("This workflow belongs to a different project. Open it from its project’s Workflows list.");
        if (active) setDetail(current);
      } else if (!isNew) {
        const q = new URLSearchParams({ limit: "50" });
        if (serverStatus) q.set("status", serverStatus);
        if (filter === "hidden") q.set("visibility", "hidden");
        if (next) q.set("cursor", next);
        const page = await workflowRequest("WorkflowList", workflowPaths.collection(cid!) + `?${q}`, { signal: controller.signal, actorId });
        if (page.capability.workflow_read !== true || page.workflows.some((w) => w.container_id !== cid)) throw new WorkflowApiError("This response cannot be shown for the current project.", 403);
        if (next && page.next_cursor === next) throw new Error("Orcha returned the same page again. Refresh the list before loading more.");
        if (active) {
          setCapability(page.capability);
          setList((previous) => ({ ...page, workflows: next && previous ? [...new Map([...previous.workflows, ...page.workflows].map((w) => [w.id, w])).values()] : page.workflows }));
        }
      }
      if (active) { setAvailability("ready"); setStale(false); }
    }
    void load().catch((e: unknown) => {
      if (!active) return;
      const forbidden = e instanceof WorkflowApiError && (e.status === 401 || e.status === 403);
      setAvailability(forbidden ? "forbidden" : "unavailable");
      setError(forbidden ? "You do not have access to these workflows. Check your sign-in and project membership."
        : e instanceof Error && e.name !== "AbortError" ? e.message : "Could not reach Orcha. Your draft is kept; check the connection and try again.");
      if (forbidden) { setDetail(null); setList(null); setCapability(null); }
    }).finally(() => { clearTimeout(timer); if (active) setLoading(false); });
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [cid, workflowId, isNew, serverStatus, filter === "hidden", next, retry, actorId]);
  const writeReason = workflowWriteReason(detail?.capability ?? capability, verified);
  const aiAgents = snap?.agents.filter((a) => a.kind === "ai" && a.status !== "terminated").map((a) => ({ id: a.id, alias: a.alias })) ?? [];
  const humans = snap?.agents.filter((a) => a.kind === "human" && a.status !== "terminated").map((a) => ({ id: a.id, alias: a.alias })) ?? [];
  const rows = list?.workflows.filter((w) => matchesWorkflowFilter(w, filter) && (!owner || owner === w.owner_human_id) && `${w.title} ${w.goal}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  const isList = !isNew && !workflowId;
  const refresh = () => { setNext(null); setRetry((n) => n + 1); };
  const counts = list ? Object.fromEntries(["open", "preparing", "active", "paused", "ready", "completed", "cancelled", "hidden", "all"].map((k) => [k, list.workflows.filter((w) => matchesWorkflowFilter(w, k)).length])) : null;
  const newWorkflow = cid && isList ? (verified
    ? <Button variant="primary" icon="plus" disabled={stale || !!writeReason} title={stale ? "Refresh before making changes." : writeReason ?? undefined} onClick={() => navigate(href("new"), { state: returnState() })}>New workflow</Button>
    : <Button variant="primary" icon="plus" disabled title={writeReason ?? undefined}>New workflow</Button>) : undefined;
  const toolbar = cid && isList ? <WorkflowsToolbar filter={filter} setFilter={(k) => query("status", k === "open" ? "" : k)} counts={counts}
    search={search} setSearch={(v) => query("search", v)} owner={owner} setOwner={(id) => query("owner", id)}
    owners={[...new Set(list?.workflows.map((w) => w.owner_human_id) ?? [])].map((id) => ({ id, name: actorName(id) }))}
    shown={rows.length} loaded={list?.workflows.length ?? 0} hasMore={!!list?.next_cursor} onRefresh={refresh} refreshing={loading} /> : undefined;
  if (isList) {
    return <Shell page="workflows" title="Workflows" primaryAction={newWorkflow} toolbar={toolbar} flush><div className="wf-page wf-flush">
      {!cid && <div className="wf-states"><EmptyState title="Choose a project to view Workflows" /></div>}
      {cid && availability === "checking" && <div className="wf-states"><Skeleton lines={5} label="Checking Workflows support" /></div>}
      {availability === "unsupported" && <div className="wf-states"><EmptyState title="This Orcha server doesn’t support Workflows yet." body="Your existing tasks are still available."
        action={<Button variant="secondary" onClick={() => navigate(cid ? `/tasks?${new URLSearchParams({ cid })}` : "/tasks")}>Open tasks</Button>} /></div>}
      {error && !list && <div className="wf-states"><EmptyState tone="danger" icon="alert" title={availability === "forbidden" ? "You do not have access to these workflows" : "Could not load workflows"} body={error}
        action={availability === "forbidden" ? undefined : <Button variant="secondary" icon="refresh" onClick={refresh}>Retry</Button>} /></div>}
      {error && list && <p role="alert" className="wf-notice">{error}</p>}
      {stale && list && <p role="status" className="wf-notice">Showing the last loaded workflow data. Refresh before making changes.</p>}
      {availability === "ready" && writeReason && <p className="wf-notice">{writeReason}</p>}
      {params.get("hiddenNotice") && <p role="status" className="wf-bar">Workflow hidden. Its tasks, messages and evidence are kept. <Button variant="ghost" onClick={() => setRestoreId(params.get("hiddenNotice"))}>Restore workflow</Button></p>}
      {list?.workflows.find((w) => w.id === restoreId) && <WorkflowHide detail={list.workflows.find((w) => w.id === restoreId)!} scope={scope} verified={verified} stale={stale} mode="restore" control={{ open: true, onOpenChange: (value) => { if (!value) setRestoreId(null); } }} onSaved={() => { setRestoreId(null); query("hiddenNotice", ""); refresh(); }} />}
      {list && <div className="wf-list">
        {rows.length === 0 ? <WorkflowListEmpty loadedAny={list.workflows.length > 0} action={newWorkflow} />
          : <WorkflowRows rows={rows} grouped={filter === "all"} renderRow={(w) => <WorkflowRow key={w.id} workflow={w} href={href(w.id)} ownerName={actorName(w.owner_human_id)} onRestore={w.hidden && !stale && !actionReason(w, "restore", verified) ? () => setRestoreId(w.id) : undefined}
            onActivate={(e) => { e.preventDefault(); navigate(href(w.id), { state: returnState(w.id) }); }}
            ref={(element) => {
              if (element && !restoredFocus.current && navigationState.workflowListFocus === w.id && workflowListReturnTarget(navigationState.workflowListReturn, cid!)) {
                restoredFocus.current = true; element.focus();
              }
            }} />} />}
        {list.next_cursor && <Button variant="ghost" className="wf-more" disabled={loading} onClick={() => setNext(list.next_cursor ?? null)}>Load more workflows</Button>}
      </div>}
    </div></Shell>;
  }
  if (isNew) {
    return <Shell page="workflows" title="Workflows"><div className="wf-page">
      <nav className="wf-actions" aria-label="Workflow navigation"><Link to={href()} state={navigationState}>All workflows</Link><Link to={cid ? `/tasks?${new URLSearchParams({ cid })}` : "/tasks"}>Open tasks</Link></nav>
      {!cid && <p>Choose a project to view Workflows.</p>}
      {cid && availability === "checking" && <p role="status">Checking Workflows support…</p>}
      {availability === "unsupported" && <p role="status">This Orcha server doesn’t support Workflows yet. Your existing tasks are still available.</p>}
      {error && <p role="alert" className="wf-notice">{error}</p>}
      {availability === "ready" && writeReason && <p className="wf-notice">{writeReason}</p>}
      {cid && verified && <WorkflowDraftEditor scope={scope} flexible={capability?.flexible_workflows === true} saveUnavailableReason={stale || availability !== "ready" ? "Check the current connection before saving. Your draft is kept." : writeReason}
        agents={aiAgents} initialTaskId={initialTaskId} ownerName={actorName(scope.identity)} onSaved={(result) => navigate(href(result.id), { state: navigationState })} />}
      {!verified && <p>Choose a current human member of this project before preparing a workflow draft.</p>}
    </div></Shell>;
  }
  const selectedTask = detail?.tasks.find((t) => t.id === selectedId) ?? null;
  const flexible = detail?.semantics_version === 2;
  // A step left off the chosen path says which step's outcome chose it (#362 x07).
  const notSelectedLine = (t: WorkflowTask) => {
    if (!detail || t.route_state !== "not_selected") return undefined;
    const by = pathDecider(detail, t);
    return by?.reported_outcome ? `Not selected · not run because ${by.title} reported ${by.reported_outcome.outcome}` : "Not selected · not run on the chosen path";
  };
  const decideTask = detail?.tasks.find((t) => t.id === decideId && t.awaiting_loop_decision) ?? null;
  const saved = () => { setStale(true); setRetry((n) => n + 1); };
  const openTask = (id: string) => navigate(`/tasks?${new URLSearchParams({ task: id, cid: cid ?? "", workflowReturn: `${pathname}${location.search}` })}`, { state: navigationState });
  const rowMenu = (task: WorkflowDetail["tasks"][number]): (MenuItemSpec | "separator")[] => [
    { label: "Open task page", onSelect: () => openTask(task.id) },
    ...(task.status === "needs_verification" ? [{ label: "Review result…", onSelect: () => { setSelectedId(task.id); setTaskRequest({ taskId: task.id, action: "review" as const, seq: ++requestSeq.current }); } }] : []),
    "separator" as const,
    ...TASK_ACTION_KEYS.filter((key) => !taskReason(detail!, task, key, verified)).map((key) => ({
      label: taskActionLabel(task, key), disabled: unresolved || stale, disabledReason: unresolved ? "Wait for the current save to finish." : stale ? "Refresh before making changes." : undefined,
      onSelect: () => { setSelectedId(task.id); setTaskRequest({ taskId: task.id, action: key, seq: ++requestSeq.current }); },
    })),
  ];
  const taskRows = (dependencies: boolean) => {
    const shown = detail!.tasks.filter((t) => !dependencies || !taskSearch || t.title.toLowerCase().includes(taskSearch.toLowerCase()));
    const row = (t: WorkflowDetail["tasks"][number]) => {
      const names = (ids: string[]) => ids.map((id) => detail!.tasks.find((p) => p.id === id)?.title ?? "Prerequisite unavailable").join(", ");
      const dependents = detail!.tasks.filter((other) => other.depends_on.includes(t.id)).map((o) => o.id);
      const group = t.repeat_group_id ? detail!.repeat_groups?.find((g) => g.id === t.repeat_group_id) : undefined;
      return <WorkflowTaskRow key={t.id} loop={group ? { round: t.round ?? group.current_round } : null} task={t} selected={selectedId === t.id} onSelect={() => { setSelectedId(t.id); setTaskRequest(null); }} actorName={actorName}
        assignees={t.assignee_ids.map((id) => ({ id, alias: actorName(id), kind: snap?.agents.find((a) => a.id === id)?.kind ?? "ai" }))} menuItems={rowMenu(t)}
        subline={dependencies ? `Depends on: ${t.depends_on.length ? names(t.depends_on) : "none"} · Needed by: ${dependents.length ? names(dependents) : "none"}` : notSelectedLine(t)} />;
    };
    // Consecutive members of one repeat group share a bracket (issue #362 x03); everything else is a plain row.
    const runs: { group?: NonNullable<WorkflowDetail["repeat_groups"]>[number]; tasks: typeof shown }[] = [];
    for (const t of shown) {
      const group = t.repeat_group_id ? detail!.repeat_groups?.find((g) => g.id === t.repeat_group_id) : undefined;
      const last = runs[runs.length - 1];
      if (group && last?.group?.id === group.id) last.tasks.push(t); else runs.push({ group, tasks: [t] });
    }
    return <WorkflowTaskRows label={dependencies ? "Workflow tasks and dependencies" : "Workflow tasks"}>
      {runs.map((run, i) => run.group
        ? <WorkflowLoopGroup key={`${run.group.id}-${i}`} group={run.group} reviewTitle={detail!.tasks.find((r) => r.id === run.group!.review_task)?.title}
          ownerName={actorName(run.group.escalation_owner_id ?? detail!.owner_human_id)}>{run.tasks.map(row)}</WorkflowLoopGroup>
        : run.tasks.map(row))}
    </WorkflowTaskRows>;
  };
  const inspector = detail && selectedTask && cid ? <WorkflowTaskInspector key={selectedTask.id} detail={detail} task={selectedTask} cid={cid} scope={scope} verified={verified} stale={stale}
    agents={aiAgents} actorName={actorName} onSaved={saved} onExpand={() => openTask(selectedTask.id)} request={taskRequest?.taskId === selectedTask.id && taskRequest.action !== "review" ? { action: taskRequest.action, seq: taskRequest.seq } : null}
    reviewRequest={taskRequest?.taskId === selectedTask.id && taskRequest.action === "review" ? taskRequest.seq : null} onRequest={(action) => setTaskRequest({ taskId: selectedTask.id, action, seq: ++requestSeq.current })}
    onClose={() => { const row = document.getElementById(`workflow-task-${selectedTask.id}`); setSelectedId(null); setTaskRequest(null); row?.focus(); }} /> : null;
  return <Shell page="workflows" title="Workflows" flush><div className="wf-page wf-flush wf-detail">
    {!cid && <div className="wf-states"><EmptyState title="Choose a project to view Workflows" /></div>}
    {cid && availability === "checking" && <div className="wf-states"><Skeleton lines={6} label="Checking Workflows support" /></div>}
    {availability === "unsupported" && <div className="wf-states"><EmptyState title="This Orcha server doesn’t support Workflows yet." body="Your existing tasks are still available."
      action={<Button variant="secondary" onClick={() => navigate(cid ? `/tasks?${new URLSearchParams({ cid })}` : "/tasks")}>Open tasks</Button>} /></div>}
    {error && !detail && availability !== "checking" && <div className="wf-states"><EmptyState tone="danger" icon="alert" title={availability === "forbidden" ? "You do not have access to this workflow" : "Could not load this workflow"} body={error}
      action={<span className="wf-actionsgrid"><Button variant="secondary" onClick={() => navigate(href(), { state: navigationState })}>All workflows</Button>{availability !== "forbidden" && <Button variant="secondary" icon="refresh" onClick={refresh}>Retry</Button>}</span>} /></div>}
    {cid && loading && !detail && availability === "ready" && <div className="wf-states"><Skeleton lines={6} label="Loading workflow" /></div>}
    {detail && cid && <>
      <nav className="wf-crumb" aria-label="Workflow navigation"><Link to={href()} state={navigationState}><Icon name="chevron-left" cls="v2-ico" />All workflows</Link></nav>
      <WorkflowHeader detail={detail} ownerName={actorName(detail.owner_human_id)} verified={verified} stale={stale} frozen={unresolved} refreshing={loading} onRefresh={refresh} primaryHidden={!!menuDialog || inputOpen}
        railToggle={{ open: railOpen, onToggle: () => setRailOpen((o) => !o) }}
        onAction={(a) => {
          if (a === "start" || a === "pause" || a === "resume" || a === "cancel" || a === "finish") setActionRequest({ action: a, seq: ++requestSeq.current });
          else { if (a === "add_tasks") setAddSeed(null); setMenuDialog(a); }
        }} />
      {(error || stale || writeReason) && <div className="wf-bars">
        {error && <p role="alert" className="wf-bar is-danger">{error}</p>}
        {stale && !error && <p role="status" className="wf-bar">Showing the last loaded workflow data. Refresh before making changes.</p>}
        {availability === "ready" && writeReason && <p className="wf-bar">{writeReason}</p>}
      </div>}
      {detail.hidden && <p role="status" className="wf-bar">This workflow is hidden. Its tasks, messages and evidence are kept. Restore it from the workflow menu; restoring never starts work.</p>}
      <WorkflowOwnerBar detail={detail} viewer={scope.identity} ownerName={actorName(detail.owner_human_id)} onDecide={setDecideId} />
      {decideTask && <WorkflowLoopDecision detail={detail} task={decideTask} scope={scope} stale={stale} agents={aiAgents} onSaved={saved} onClose={() => setDecideId(null)} />}
      <WorkflowActions detail={detail} scope={scope} verified={verified} stale={stale} onSaved={saved} request={actionRequest} />
      <WorkflowInput detail={detail} scope={scope} stale={stale} open={inputOpen} onOpen={() => setInputOpen(true)} onClose={() => setInputOpen(false)} onSaved={saved} onChecklist={() => setActionRequest({ action: "finish", seq: ++requestSeq.current })} />
      {!inputOpen && <><div className="wf-tabs-row">
        <Tabs label="Workflow views" value={tab} onChange={(t) => { query("tab", t); setTaskSearch(""); }} tabs={[
          { key: "tasks", label: flexible ? "Steps" : "Tasks", count: detail.tasks.length }, { key: "dependencies", label: flexible ? "Route" : "Dependencies" },
          { key: "review", label: "Review history", count: detail.review_rounds?.length ?? null }, { key: "activity", label: "Activity" },
        ]} />
        {tab === "dependencies" && <div className="wf-tab-actions">
          <Segmented label="Dependency view" size="sm" value={graphMode ? "graph" : "list"} onChange={(k) => setGraphMode(k === "graph")} items={[{ key: "list", label: "List" }, { key: "graph", label: "Graph and list" }]} />
          <span className="wf-search"><label className="v2-sr" htmlFor="workflowTaskQ">Find a workflow task</label><Icon name="search" cls="v2-ico" />
            <input id="workflowTaskQ" className="wf-search-in" type="search" placeholder="Find a workflow task…" value={taskSearch} onChange={(e) => setTaskSearch(e.target.value)} /></span>
        </div>}
      </div>
      <div className="wf-body">
        <div className="wf-main">
          {tab === "tasks" && <SplitPane storageKey="orcha:v2:workflowInspector" list={<div className="wf-list">{detail.tasks.length === 0
            ? <EmptyState title="No tasks yet" body="Add new tasks or add existing tasks from the workflow menu." /> : taskRows(false)}
            {detail.progress.withdrawn > 0 && <p className="wf-muted wf-foot">{detail.progress.withdrawn} {detail.progress.withdrawn === 1 ? "task" : "tasks"} withdrawn from scope. Withdrawn tasks do not count as accepted.</p>}</div>} inspector={inspector} />}
          {tab === "dependencies" && <SplitPane storageKey="orcha:v2:workflowInspector" list={<div className="wf-list">
            {flexible && <div className="wf-route-summary wf-tab-pad"><WorkflowRoutePanel detail={detail} heading="Outcome routes" /></div>}
            {graphMode && <WorkflowGraph tasks={detail.tasks.filter((t) => !taskSearch || t.title.toLowerCase().includes(taskSearch.toLowerCase())).map((t) => ({ id: t.id, title: t.title, status: t.status, label: t.display_state.label, assignee: t.assignee_ids.map(actorName).join(", "), dependsOn: t.depends_on }))}
              selected={selectedId} onSelect={(id) => { setSelectedId(id || null); setTaskRequest(null); }}
              disabledReason={stale ? "Refresh before making changes." : unresolved ? "Wait for the current save to finish." : actionReason(detail, "add_tasks", verified)}
              onAdd={() => { setAddSeed({ after: null, seq: ++requestSeq.current }); setMenuDialog("add_tasks"); }}
              onAfter={(id) => { setAddSeed({ after: id, seq: ++requestSeq.current }); setMenuDialog("add_tasks"); }}
              editDisabledReason={stale ? "Refresh before making changes." : unresolved ? "Wait for the current save to finish." : selectedTask ? taskReason(detail, selectedTask, "dependencies", verified) : null}
              onEdit={(id) => { setSelectedId(id); setTaskRequest({ taskId: id, action: "dependencies", seq: ++requestSeq.current }); }} />}
            {taskRows(true)}</div>} inspector={inspector} />}
          {tab === "review" && <div className="wf-tab-scroll wf-tab-pad">
            <WorkflowReviewHistory detail={detail} renderActions={(reviewTaskId) => <WorkflowResolveReview detail={detail} scope={scope} verified={verified} stale={stale} reviewTaskId={reviewTaskId} onSaved={saved} />} />
            <Button variant="secondary" disabled={stale || unresolved || !!actionReason(detail, "review_round", verified)} title={actionReason(detail, "review_round", verified) ?? undefined} onClick={() => setMenuDialog("review_round")}>Record review outcome…</Button>
          </div>}
          {tab === "activity" && <div className="wf-tab-scroll"><WorkflowActivity key={detail.id} detail={detail} /></div>}
        </div>
        <WorkflowRail detail={detail} ownerName={actorName(detail.owner_human_id)} cid={cid} className={railOpen ? "is-open" : undefined} />
      </div>
      </>}
      <WorkflowImport detail={detail} scope={scope} verified={verified} stale={stale} initialTaskId={initialTaskId} onSaved={saved} control={{ open: menuDialog === "import", onOpenChange: (o) => setMenuDialog(o ? "import" : null) }} />
      <WorkflowAddTasks seed={addSeed} detail={detail} scope={scope} verified={verified} stale={stale} agents={aiAgents} onSaved={(result) => { setDetail(result); saved(); const id = Object.values(result.created_task_ids ?? {})[0]; if (id) { setSelectedId(id); setTaskRequest(null); requestAnimationFrame(() => document.getElementById(`workflow-task-${id}`)?.focus()); } }} control={{ open: menuDialog === "add_tasks", onOpenChange: (o) => setMenuDialog(o ? "add_tasks" : null) }} />
      <WorkflowSettings initialSection={menuDialog === "transfer_owner" ? "ownership" : "settings"} detail={detail} scope={scope} verified={verified} stale={stale} humans={humans} onSaved={saved} control={{ open: menuDialog === "settings" || menuDialog === "transfer_owner", onOpenChange: (o) => setMenuDialog(o ? "settings" : null) }} />
      <WorkflowMove detail={detail} scope={scope} verified={verified} stale={stale} onSaved={saved} control={{ open: menuDialog === "move", onOpenChange: (o) => setMenuDialog(o ? "move" : null) }} />
      <WorkflowReviewEditor detail={detail} scope={scope} verified={verified} stale={stale} agents={aiAgents} onSaved={saved} control={{ open: menuDialog === "review_round", onOpenChange: (o) => setMenuDialog(o ? "review_round" : null) }} />
      <WorkflowHide detail={detail} scope={scope} verified={verified} stale={stale} mode={detail.hidden ? "restore" : "hide"} onSaved={(result) => { if (result.hidden) navigate(`/workflows?${new URLSearchParams({ cid, status: "hidden", hiddenNotice: result.id })}`); else saved(); }} control={{ open: menuDialog === "hide", onOpenChange: (o) => setMenuDialog(o ? "hide" : null) }} />
    </>}
  </div></Shell>;
}
