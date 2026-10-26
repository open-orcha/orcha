import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { getJSON } from "../../api/client";
import { Button } from "../../components/primitives/Button";
import { Shell } from "../../shell/Shell";
import { useSnapshot } from "../../state/SnapshotProvider";
import { WorkflowDraftEditor } from "./WorkflowDraftEditor";
import { WorkflowActions } from "./WorkflowActions";
import { WorkflowTaskActions } from "./WorkflowTaskActions";
import { WorkflowImport } from "./WorkflowImport";
import { WorkflowAddTasks } from "./WorkflowAddTasks";
import { WorkflowSettings } from "./WorkflowSettings";
import { WorkflowMove } from "./WorkflowMove";
import { WorkflowResolveReview, WorkflowReviewEditor } from "./WorkflowReviewEditor";
import { WorkflowActivity, WorkflowReviewHistory } from "./WorkflowHistory";
import { WorkflowDependencies, WorkflowSummary, WorkflowTaskList, WorkflowProgress, type WorkflowTaskView } from "./WorkflowReadViews";
import { WorkflowApiError, workflowLabel, workflowPaths, workflowRequest, workflowWriteReason } from "./workflowApi";
import type { Capability, WorkflowDetail, WorkflowList } from "./workflowContract.generated";
import { workflowListReturnTarget, workflowNavigationState } from "./workflowNavigation";
import "./workflows.css";

type Availability = "checking" | "unsupported" | "ready" | "unavailable" | "forbidden";
export function hasWorkflowRoutes(spec: unknown): boolean {
  if (!spec || typeof spec !== "object" || !("paths" in spec) || !spec.paths || typeof spec.paths !== "object") throw new Error("OpenAPI paths unavailable");
  return Object.entries(spec.paths).some(([path, operations]) => /^\/api\/containers\/\{[^}]+\}\/workflows$/.test(path)
    && operations !== null && typeof operations === "object" && "get" in operations);
}
export function WorkflowsPage() {
  const context = useSnapshot();
  const { pathname } = useLocation();
  // Never carry an old actor's reads or confirmations across identity/project changes.
  const key = JSON.stringify([context.cid, context.identity?.agent_id, context.identityTrusted, context.identityPending, pathname]);
  return <Shell page="workflows" title="Workflows"><WorkflowScreen key={key} /></Shell>;
}
function WorkflowScreen() {
  const { cid, snap, identity, identityTrusted, identityPending } = useSnapshot();
  const location = useLocation();
  const { pathname } = location;
  const navigationState = workflowNavigationState(location.state);
  const restoredFocus = useRef(false);
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const isNew = pathname === "/workflows/new";
  const workflowId = !isNew && pathname.startsWith("/workflows/") ? decodeURIComponent(pathname.slice("/workflows/".length)) : null;
  const verified = !identityPending && identityTrusted && !!identity?.agent_id;
  const scope = { origin: window.location.origin, project: cid ?? "", identity: verified ? identity!.agent_id! : "unverified" };
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
  const initialTaskId = snap?.tasks?.find((task) => task.id === params.get("addTask"))?.id;
  const serverStatus = ["preparing", "active", "ready"].includes(filter) ? "active" : ["paused", "completed", "cancelled"].includes(filter) ? filter : "";
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
      const cap = await workflowRequest("Capability", workflowPaths.collection(cid!) + "/capability", { signal: controller.signal });
      if (cap.workflow_read !== true) throw new WorkflowApiError("You do not have access to read workflows on this connection.", 403);
      if (!active) return;
      setCapability(cap);
      if (workflowId) {
        const current = await workflowRequest("WorkflowDetail", workflowPaths.detail(workflowId), { signal: controller.signal });
        if (current.container_id !== cid || current.id !== workflowId) throw new Error("This workflow belongs to a different project. Open it from its project’s Workflows list.");
        if (active) setDetail(current);
      } else if (!isNew) {
        const q = new URLSearchParams({ limit: "50" });
        if (serverStatus) q.set("status", serverStatus);
        if (next) q.set("cursor", next);
        const page = await workflowRequest("WorkflowList", workflowPaths.collection(cid!) + `?${q}`, { signal: controller.signal });
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
  }, [cid, workflowId, isNew, serverStatus, next, retry]);
  const writeReason = workflowWriteReason(detail?.capability ?? capability, verified);
  const taskViews: WorkflowTaskView[] = detail?.tasks.map((t) => ({
    id: t.id, title: t.title, assignee: t.assignee_ids.map(actorName).join(", ") || null,
    displayLabel: t.display_state.label, reasons: t.blockers.map((b) => b.message),
    prerequisites: t.depends_on.map((id) => ({ id, title: detail.tasks.find((p) => p.id === id)?.title ?? "Prerequisite unavailable" })),
    dependents: detail.tasks.filter((other) => other.depends_on.includes(t.id)).map((other) => ({ id: other.id, title: other.title })),
    unconfirmedStopWarning: !!t.display_state.warning, releaseAvailableAt: t.display_state.release_available_at ?? null,
    warning: t.display_state.warning,
    // Missing task autonomy means OFF; legacy project/agent levels never grant it.
    autonomy: t.autonomy === "on",
  })) ?? [];
  const rows = list?.workflows.filter((w) => {
    const matchesStatus = filter === "open" ? w.status === "active" || w.status === "paused"
      : filter === "preparing" ? w.status === "active" && !w.launch_enabled
      : filter === "ready" ? w.status === "active" && w.completion.can_finish
      : filter === "active" ? w.status === "active" && w.launch_enabled : true;
    return matchesStatus && (!owner || owner === w.owner_human_id) && `${w.title} ${w.goal}`.toLowerCase().includes(search.toLowerCase());
  }) ?? [];
  return <div className="wf-page">
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
      existingTasks={snap?.tasks ?? []} initialTaskId={initialTaskId}
      ownerName={actorName(scope.identity)} onSaved={(result) => navigate(href(result.id), { state: navigationState })} />}
    {isNew && !verified && <p>Verified sign-in is required before preparing a workflow draft. Selecting a human name does not verify sign-in.</p>}
    {!isNew && !workflowId && list && <>
      <div className="wf-filters"><label>Status<select value={filter} onChange={(e) => query("status", e.target.value)}>
        <option value="open">Open workflows</option><option value="preparing">Preparing</option><option value="active">Active</option><option value="paused">Paused</option><option value="ready">Ready to finish</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option><option value="all">All</option>
      </select></label><label>Search loaded workflows<input type="search" value={search} onChange={(e) => query("search", e.target.value)} /></label>
      <label>Owner<select value={owner} onChange={(e) => query("owner", e.target.value)}><option value="">Anyone</option>{[...new Set(list.workflows.map((w) => w.owner_human_id))].map((id) => <option key={id} value={id}>{actorName(id)}</option>)}</select></label></div>
      <p>{rows.length} matching workflows shown from {list.workflows.length} loaded. {list.next_cursor ? "More workflows are available; search and owner filters apply to loaded pages." : "All available pages loaded."}</p>
      {rows.length === 0 && <p>{list.workflows.length ? "No loaded workflows match these filters." : "No workflows yet. Create one to plan tasks around a shared goal."}</p>}
      <ul className="wf-task-list">{rows.map((w) => <li key={w.id}><h2><Link to={href(w.id)} state={returnState(w.id)} ref={(element) => {
        if (element && !restoredFocus.current && navigationState.workflowListFocus === w.id && workflowListReturnTarget(navigationState.workflowListReturn, cid!)) {
          restoredFocus.current = true; element.focus();
        }
      }}>{w.title}</Link></h2><p>{w.goal}</p>
        <p>Owner: {actorName(w.owner_human_id)} · {workflowLabel(w)}</p><WorkflowProgress accepted={w.progress.accepted} total={w.progress.total} />
        {w.completion.blockers.length > 0 && <p>{w.completion.blockers[0].message}</p>}
      </li>)}</ul>
      {list.next_cursor && <Button disabled={loading} onClick={() => setNext(list.next_cursor ?? null)}>Load more workflows</Button>}
    </>}
    {detail && <>
      <WorkflowSummary focusHeading workflow={{ id: detail.id, name: detail.title, goal: detail.goal, owner: actorName(detail.owner_human_id), displayLabel: workflowLabel(detail),
        modeLabel: detail.execution_mode === "serial" ? "One task at a time" : "Independent tasks together; tasks with dependencies take their turn alone",
        acceptedTasks: detail.progress.accepted, totalTasks: detail.progress.total, acceptedObjectives: detail.progress.objectives_accepted, totalObjectives: detail.progress.objectives_total,
        goalLabel: detail.goal_accepted_revision === detail.goal_revision ? "Current goal accepted" : "Goal needs acceptance" }} />
      <WorkflowActions detail={detail} scope={scope} verified={verified} stale={stale} onSaved={() => { setStale(true); setRetry((n) => n + 1); }} />
      <WorkflowImport detail={detail} scope={scope} verified={verified} stale={stale} tasks={snap?.tasks ?? []} initialTaskId={initialTaskId} onSaved={() => { setStale(true); setRetry((n) => n + 1); }} />
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
  </div>;
}
