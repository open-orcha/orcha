import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { getJSON } from "../../api/client";
import { Button } from "../../components/primitives/Button";
import { Shell } from "../../shell/Shell";
import { useActingAuthority, useSnapshot } from "../../state/SnapshotProvider";
import { WorkflowDraftEditor } from "./WorkflowDraftEditor";
import { WorkflowActions } from "./WorkflowActions";
import { WorkflowTaskActions } from "./WorkflowTaskActions";
import { WorkflowImport } from "./WorkflowImport";
import { WorkflowAddTasks } from "./WorkflowAddTasks";
import { WorkflowSettings } from "./WorkflowSettings";
import { WorkflowMove } from "./WorkflowMove";
import { WorkflowResolveReview, WorkflowReviewEditor } from "./WorkflowReviewEditor";
import { WorkflowActivity, WorkflowReviewHistory } from "./WorkflowHistory";
import { WorkflowDependencies, WorkflowSummary, WorkflowTaskList, type WorkflowTaskView } from "./WorkflowReadViews";
import { WorkflowListEmpty, WorkflowRow, WorkflowRows, WorkflowsToolbar, matchesWorkflowFilter, workflowServerStatus } from "./WorkflowListView";
import { Skeleton, EmptyState } from "../../components/primitives";
import { hasWorkflowRoutes, WorkflowApiError, workflowLabel, workflowPaths, workflowRequest, workflowWriteReason } from "./workflowApi";
import type { Capability, WorkflowDetail, WorkflowList } from "./workflowContract.generated";
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
  useEffect(() => {
    // A direct task link arrives before the asynchronous workflow read. Move
    // keyboard focus only once the named task actually exists on this page.
    if (!detail || tab !== "tasks") return;
    const task = detail.tasks.find((t) => location.hash === `#workflow-task-${encodeURIComponent(t.id)}`);
    const row = task && document.getElementById(`workflow-task-${task.id}`);
    if (row) { row.scrollIntoView?.({ block: "nearest" }); row.focus(); }
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
  useEffect(() => { setNext(null); setList(null); }, [serverStatus]);
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
  }, [cid, workflowId, isNew, serverStatus, next, retry, actorId]);
  const writeReason = workflowWriteReason(detail?.capability ?? capability, verified);
  const taskViews: WorkflowTaskView[] = detail?.tasks.map((t) => ({
    id: t.id, title: t.title, assignee: t.assignee_ids.map(actorName).join(", ") || null,
    displayLabel: t.display_state.label, reasons: t.blockers.map((b) => b.message),
    prerequisites: t.depends_on.map((id) => ({ id, title: detail.tasks.find((p) => p.id === id)?.title ?? "Prerequisite unavailable" })),
    dependents: detail.tasks.filter((other) => other.depends_on.includes(t.id)).map((other) => ({ id: other.id, title: other.title })),
    unconfirmedStopWarning: t.display_state.list_warning === true, releaseAvailableAt: t.display_state.release_available_at ?? null,
    warning: t.display_state.list_warning ? t.display_state.warning : null,
    withdrawal: t.withdrawn_at ? { by: t.withdrawn_by ? actorName(t.withdrawn_by) : "Name unavailable", reason: t.withdrawn_reason ?? "Reason unavailable" } : null,
    // Missing task autonomy means OFF; legacy project/agent levels never grant it.
    autonomy: t.autonomy === "on",
  })) ?? [];
  const rows = list?.workflows.filter((w) => matchesWorkflowFilter(w, filter) && (!owner || owner === w.owner_human_id) && `${w.title} ${w.goal}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  const isList = !isNew && !workflowId;
  const refresh = () => { setNext(null); setRetry((n) => n + 1); };
  const counts = list ? Object.fromEntries(["open", "preparing", "active", "paused", "ready", "completed", "cancelled", "all"].map((k) => [k, list.workflows.filter((w) => matchesWorkflowFilter(w, k)).length])) : null;
  const newWorkflow = cid && isList ? (verified
    ? <Button variant="primary" icon="plus" onClick={() => navigate(href("new"), { state: returnState() })}>New workflow</Button>
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
      {list && <div className="wf-list">
        {rows.length === 0 ? <WorkflowListEmpty loadedAny={list.workflows.length > 0} action={newWorkflow} />
          : <WorkflowRows rows={rows} grouped={filter === "all"} renderRow={(w) => <WorkflowRow key={w.id} workflow={w} href={href(w.id)} ownerName={actorName(w.owner_human_id)}
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
  return <Shell page="workflows" title="Workflows"><div className="wf-page">
    <nav className="wf-actions" aria-label="Workflow navigation"><Link to={href()} state={navigationState}>All workflows</Link><Link to={cid ? `/tasks?${new URLSearchParams({ cid })}` : "/tasks"}>Open tasks</Link>
      {cid && !isNew && (verified ? <Link to={href("new")} state={returnState()}>Create workflow</Link> : <Button disabled title={writeReason ?? undefined}>Create workflow</Button>)}
      {cid && <Button disabled={loading} onClick={() => { setNext(null); setRetry((n) => n + 1); }}>Refresh workflows</Button>}</nav>
    {!cid && <p>Choose a project to view Workflows.</p>}
    {cid && availability === "checking" && <p role="status">Checking Workflows support…</p>}
    {availability === "unsupported" && <p role="status">This Orcha server doesn’t support Workflows yet. Your existing tasks are still available.</p>}
    {error && <p role="alert" className="wf-notice">{error}</p>}
    {stale && (detail || list) && <p role="status">Showing the last loaded workflow data. Refresh before making changes.</p>}
    {availability === "ready" && writeReason && <p className="wf-notice">{writeReason}</p>}
    {loading && availability !== "checking" && <p role="status">Loading workflows…</p>}
    {isNew && cid && verified && <WorkflowDraftEditor scope={scope} saveUnavailableReason={stale || availability !== "ready" ? "Check the current connection before saving. Your draft is kept." : writeReason}
      agents={snap?.agents.filter((a) => a.kind === "ai" && a.status !== "terminated").map((a) => ({ id: a.id, alias: a.alias }))}
      initialTaskId={initialTaskId} ownerName={actorName(scope.identity)} onSaved={(result) => navigate(href(result.id), { state: navigationState })} />}
    {isNew && !verified && <p>Choose a current human member of this project before preparing a workflow draft.</p>}
    {detail && <>
      <WorkflowSummary focusHeading workflow={{ id: detail.id, name: detail.title, goal: detail.goal, owner: actorName(detail.owner_human_id), displayLabel: workflowLabel(detail),
        modeLabel: detail.execution_mode === "serial" ? "One task at a time" : "Independent tasks together; tasks with dependencies take their turn alone",
        acceptedTasks: detail.progress.accepted, totalTasks: detail.progress.total, acceptedObjectives: detail.progress.objectives_accepted, totalObjectives: detail.progress.objectives_total,
        goalLabel: detail.goal_accepted_revision === detail.goal_revision ? "Current goal accepted" : "Goal needs acceptance" }} />
      <WorkflowActions detail={detail} scope={scope} verified={verified} stale={stale} onSaved={() => { setStale(true); setRetry((n) => n + 1); }} />
      <WorkflowImport detail={detail} scope={scope} verified={verified} stale={stale} initialTaskId={initialTaskId} onSaved={() => { setStale(true); setRetry((n) => n + 1); }} />
      <WorkflowAddTasks detail={detail} scope={scope} verified={verified} stale={stale} agents={snap?.agents.filter((a) => a.kind === "ai" && a.status !== "terminated").map((a) => ({ id: a.id, alias: a.alias })) ?? []} onSaved={() => { setStale(true); setRetry((n) => n + 1); }} />
      <WorkflowSettings detail={detail} scope={scope} verified={verified} stale={stale} humans={snap?.agents.filter((a) => a.kind === "human" && a.status !== "terminated").map((a) => ({ id: a.id, alias: a.alias })) ?? []} onSaved={() => { setStale(true); setRetry((n) => n + 1); }} />
      <WorkflowMove detail={detail} scope={scope} verified={verified} stale={stale} onSaved={() => { setStale(true); setRetry((n) => n + 1); }} />
      <div className="wf-actions" aria-label="Workflow views">{["tasks", "dependencies", "review", "activity"].map((t) => <Button key={t} aria-pressed={tab === t} onClick={() => query("tab", t)}>{t === "review" ? "Review history" : t[0].toUpperCase() + t.slice(1)}</Button>)}</div>
      {tab === "dependencies" ? <WorkflowDependencies cid={cid!} tasks={taskViews} total={detail.tasks.length} />
        : tab === "review" ? <><WorkflowReviewHistory detail={detail} renderActions={(reviewTaskId) => <WorkflowResolveReview detail={detail} scope={scope} verified={verified} stale={stale} reviewTaskId={reviewTaskId} onSaved={() => { setStale(true); setRetry((n) => n + 1); }} />} />
          <WorkflowReviewEditor detail={detail} scope={scope} verified={verified} stale={stale} agents={snap?.agents.filter((a) => a.kind === "ai" && a.status !== "terminated").map((a) => ({ id: a.id, alias: a.alias })) ?? []} onSaved={() => { setStale(true); setRetry((n) => n + 1); }} /></>
        : tab === "activity" ? <WorkflowActivity key={detail.id} detail={detail} />
        : <WorkflowTaskList cid={cid!} tasks={taskViews} total={detail.tasks.length} renderActions={(id) => <WorkflowTaskActions
          detail={detail} task={detail.tasks.find((task) => task.id === id)!} scope={scope} verified={verified} stale={stale}
          agents={snap?.agents.filter((a) => a.kind === "ai" && a.status !== "terminated").map((a) => ({ id: a.id, alias: a.alias })) ?? []}
          onSaved={() => { setStale(true); setRetry((n) => n + 1); }} />} />}
      {detail.progress.withdrawn > 0 && <p>{detail.progress.withdrawn} tasks withdrawn from scope. Withdrawn tasks do not count as accepted.</p>}
    </>}
  </div></Shell>;
}
