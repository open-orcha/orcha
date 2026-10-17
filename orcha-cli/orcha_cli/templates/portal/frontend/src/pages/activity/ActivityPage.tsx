/**
 * Activity — the addressable view of worker runs and project events (Agent E,
 * brief §5 "Agents and live work", parity A-18 / PI-04 / H-06).
 *
 * URL (docs/orcha-v2-architecture.md §2.1): /activity?cid&agent=<alias>&task=<id>
 * &run=<id>&state=running|finished|failed|all (&view=runs|events, &kind=messages|
 * requests in Events). Filter and selection changes REPLACE history; opening a
 * run at narrow widths PUSHES so Back returns to the list. Runs / Events is a
 * view toggle on the right of the toolbar (not a pill among the run-state
 * filters); switching view clears the other view's filter so no dead param
 * (e.g. ?state=failed in Events) lingers. Escape closes the open run.
 *
 * Data — existing, read-only endpoints only (no new backend):
 *   - task filter  → GET /api/tasks/{tid}/runs?limit=50
 *   - agent filter → GET /api/agents/{aid}/runs?limit=50
 *   - otherwise    → GET /api/agents/{aid}/runs?limit=10 for the most recently
 *                    active AI agents (capped, and the cap is disclosed)
 *   - live log     → the shared per-run SSE engine (hooks/useRunStream)
 *   - stop         → POST /api/runs/{rid}/stop (human, confirm) via runlog's
 *                    StopRunButton
 * Every fetched run is kept only if its agent belongs to THIS project's
 * snapshot, and responses for a superseded filter/project are discarded, so
 * nothing from another project can appear here. Refresh: on filter change,
 * whenever the snapshot's set of active runs changes, every 20 s, and on demand.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { getJSON } from "../../api/client";
import { Icon } from "../../components/ui";
import { FilesChanged } from "../../components/FilesChanged";
import { runBlobSource } from "../../components/filePreview/sources";
import {
  Avatar, Button, Chip, EmptyState, IconButton, Inspector, List, Row, Skeleton, SplitPane, StatusIcon, Tooltip,
} from "../../components/primitives";
import { ListGroup, isEditingTarget } from "../../components/primitives";
import { Property, PropertySection } from "../../components/primitives";
import { Timeline, TimelineDivider, TimelineEvent } from "../../components/primitives";
import { useNarrow } from "../../hooks/useMediaQuery";
import { clockTime, relTime, shortId } from "../../lib/format";
import { Shell } from "../../shell/Shell";
import { CircleIconButton, FilterPills, PageToolbar, type FilterPillSpec } from "../../shell/PageChrome";
import { agentByAlias, identitySelfHuman, useActingAuthority, useSnapshot } from "../../state/SnapshotProvider";
import type { Agent, Snapshot } from "../../types";
import { StopRunButton } from "../agents/runlog";
import { AgentFilter } from "./AgentFilter";
import { EVENT_KIND_LABEL, EVENT_KIND_FILTERS, answerNoun, askPhrase, collapseEvents, filterEvents, foldedSameTask, matchesEventKind, parseEventKind, projectEvents, type ProjectEvent } from "./events";
import { groupByDay } from "./feed";
import { RunLogView } from "./RunLogView";
import {
  RUN_STATE_FILTERS, killCause, matchesState, mergeRuns, parseStateFilter, rawStatusDiffers, reasonTone, runDuration, runtimeLabel, runElapsed, runId, runOutcome, runStarted, runEnded, wakeLabel,
  type WorkerRun,
} from "./runModel";
import "./activity.css";

export const FANOUT_AGENTS = 12; // agents queried in the unfiltered view
export const FANOUT_LIMIT = 10; // runs per agent in the unfiltered view
const FILTERED_LIMIT = 50;
const REFRESH_MS = 20000;
const LIST_CAP = 150;

interface RunsState {
  key: string;
  runs: WorkerRun[];
  /** time of the last load that returned data; null until one does (pills stay "unknown", never 0) */
  loadedAt: number | null;
  /** at least one load attempt finished for this key (success or failure) */
  settled: boolean;
  failed: string[]; // aliases (or "task") whose feed failed
  /**
   * the latest refresh could not reach any feed, so `runs` is the LAST-KNOWN
   * list from `loadedAt` (kept so an outage never blanks the list or tears
   * down the open run's log — e2e-scope-live-16)
   */
  refreshFailed: boolean;
  /** a failed agent's last-known runs were kept in `runs` (partial fan-out failure) */
  carried: boolean;
  scope: { mode: "task" | "agent" | "recent"; queried: number; total: number };
  loading: boolean;
}

const emptyRuns = (key: string, scope: RunsState["scope"]): RunsState => ({ key, runs: [], loadedAt: null, settled: false, failed: [], refreshFailed: false, carried: false, scope, loading: true });

function recentAgents(snap: Snapshot | null): Agent[] {
  const ai = (snap?.agents ?? []).filter((a) => a.kind !== "human");
  return ai.slice().sort((a, b) => {
    const la = a.active_run ? 1 : 0, lb = b.active_run ? 1 : 0;
    if (la !== lb) return lb - la;
    return (Date.parse(b.last_active || "") || 0) - (Date.parse(a.last_active || "") || 0);
  });
}

async function fetchRuns(url: string): Promise<WorkerRun[]> {
  const d = await getJSON<{ runs?: WorkerRun[] } | WorkerRun[]>(url);
  return Array.isArray(d) ? d : d.runs || [];
}

interface RunsJob {
  runs: WorkerRun[];
  failed: string[];
  /** agent ids whose feed failed (null = every feed of this query failed) */
  failedIds: string[] | null;
  scope: RunsState["scope"];
}

/**
 * Loads the run list for the current filters (see module docs). A failed
 * refresh never replaces data already shown: a total failure keeps the
 * last-known runs (flagged `refreshFailed`); a partial fan-out failure keeps
 * the failed agents' last-known runs next to the fresh ones. `live` flipping
 * back on (the project connection recovered) refetches at once instead of
 * waiting for the next 20 s tick.
 */
function useActivityRuns(snap: Snapshot | null, cid: string | null, agent: Agent | null, taskId: string | null, nonce: number, live: boolean): RunsState {
  const key = (cid || "") + "|" + (agent ? agent.id : "") + "|" + (taskId || "");
  const [st, setSt] = useState<RunsState>(() => emptyRuns(key, { mode: "recent", queried: 0, total: 0 }));
  const token = useRef(0);
  const ready = !!snap;
  // active-run signature: a run starting/finishing anywhere in the project refetches promptly
  const sig = (snap?.agents ?? []).map((a) => a.id + ":" + (a.active_run ? a.active_run.run_id : "")).join("|");
  const projectAgentIds = useMemo(() => new Set((snap?.agents ?? []).map((a) => a.id)), [snap?.agents]);

  useEffect(() => {
    if (!ready) return;
    const my = ++token.current;
    setSt((prev) => (prev.key === key ? { ...prev, loading: true } : emptyRuns(key, prev.scope)));
    const own = (rs: WorkerRun[]) => rs.filter((r) => !r.agent_id || projectAgentIds.has(String(r.agent_id)));
    let job: Promise<RunsJob>;
    if (taskId) {
      job = fetchRuns("/api/tasks/" + encodeURIComponent(taskId) + "/runs?limit=" + FILTERED_LIMIT).then(
        (rs) => ({ runs: own(rs).filter((r) => !agent || String(r.agent_id) === agent.id), failed: [], failedIds: [], scope: { mode: "task", queried: 1, total: 1 } }),
        () => ({ runs: [], failed: ["task"], failedIds: null, scope: { mode: "task", queried: 1, total: 1 } }),
      );
    } else if (agent) {
      job = fetchRuns("/api/agents/" + encodeURIComponent(agent.id) + "/runs?limit=" + FILTERED_LIMIT).then(
        (rs) => ({ runs: own(rs), failed: [], failedIds: [], scope: { mode: "agent", queried: 1, total: 1 } }),
        () => ({ runs: [], failed: [agent.alias], failedIds: null, scope: { mode: "agent", queried: 1, total: 1 } }),
      );
    } else {
      const all = recentAgents(snap);
      const pick = all.slice(0, FANOUT_AGENTS);
      job = Promise.all(
        pick.map((a) =>
          fetchRuns("/api/agents/" + encodeURIComponent(a.id) + "/runs?limit=" + FANOUT_LIMIT).then(
            (rs) => ({ ok: true as const, rs, a }),
            () => ({ ok: false as const, a }),
          ),
        ),
      ).then((res) => {
        const bad = res.filter((x) => !x.ok);
        return {
          runs: own(mergeRuns(res.map((x) => (x.ok ? x.rs : [])))),
          failed: bad.map((x) => x.a.alias),
          failedIds: pick.length && bad.length === pick.length ? null : bad.map((x) => x.a.id),
          scope: { mode: "recent" as const, queried: pick.length, total: all.length },
        };
      });
    }
    void job.then((r) => {
      if (my !== token.current) return; // superseded (filter / project / refresh changed)
      setSt((prev) => {
        const had = prev.key === key && prev.loadedAt != null;
        if (r.failedIds === null) {
          // nothing answered: keep what is on screen (last-known), never blank it
          return had
            ? { ...prev, failed: r.failed, refreshFailed: true, settled: true, loading: false }
            : { key, runs: [], loadedAt: null, settled: true, failed: r.failed, refreshFailed: false, carried: false, scope: r.scope, loading: false };
        }
        const failedIds = new Set(r.failedIds);
        const carried = had && failedIds.size ? prev.runs.filter((x) => failedIds.has(String(x.agent_id || ""))) : [];
        return { key, runs: mergeRuns([r.runs, carried]), loadedAt: Date.now(), settled: true, failed: r.failed, refreshFailed: false, carried: carried.length > 0, scope: r.scope, loading: false };
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, sig, nonce, ready, live]);

  return st.key === key ? st : emptyRuns(key, st.scope);
}

export function ActivityPage() {
  const { snap, cid, connection, stale, identity, identityPending, identityTrusted, identityUnverified } = useSnapshot();
  const authority = useActingAuthority();
  // the viewer is "you" in the Events sentences (as on Needs you / Overview);
  // offline the acting authority drops to read-only, so fall back to the
  // signed-in person's own human row — the wording never flips to a name
  const meAlias =
    authority.human?.alias ??
    identitySelfHuman(snap, identity, { pending: identityPending, trusted: identityTrusted, unverified: identityUnverified })?.alias ??
    null;
  const location = useLocation();
  const navigate = useNavigate();
  const narrow = useNarrow();
  const sp = new URLSearchParams(location.search);
  const agentParam = sp.get("agent");
  const taskParam = sp.get("task");
  const runParam = sp.get("run");
  const stateF = parseStateFilter(sp.get("state"));
  const view = sp.get("view") === "events" ? "events" : "runs";
  const kindF = parseEventKind(sp.get("kind"));

  const setParams = (patch: Record<string, string | null>, push = false) => {
    const n = new URLSearchParams(location.search);
    Object.entries(patch).forEach(([k, v]) => (v == null || v === "" ? n.delete(k) : n.set(k, v)));
    const q = n.toString();
    // a pushed run (narrow) is marked so closing it pops back instead of stacking entries
    navigate({ pathname: "/activity", search: q ? "?" + q : "" }, { replace: !push, state: push ? { actRunPushed: true } : null });
  };

  const agents = snap?.agents ?? [];
  const aiAgents = agents.filter((a) => a.kind !== "human");
  const agentSel = agentParam ? agentByAlias(snap, agentParam) : null;
  const agentMissing = !!(snap && agentParam && !agentSel);
  const taskSel = taskParam ? (snap?.tasks ?? []).find((t) => t.id === taskParam) || null : null;

  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setNonce((n) => n + 1), REFRESH_MS);
    return () => clearInterval(iv);
  }, []);
  const offline = connection === "offline" || stale;
  const data = useActivityRuns(snap, cid, agentMissing ? null : agentSel, taskParam, nonce, !offline);

  // live duration clock (only ticks while something is running)
  const [now, setNow] = useState(() => Date.now());
  const anyRunning = data.runs.some((r) => r.status === "running");
  useEffect(() => {
    if (!anyRunning) return;
    const iv = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(iv);
  }, [anyRunning]);

  const byId = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const taskTitle = (id: string | null | undefined) => (id ? (snap?.tasks ?? []).find((t) => t.id === id)?.title ?? null : null);
  const shown = data.runs.filter((r) => matchesState(r, stateF));
  const listed = shown.slice(0, LIST_CAP);
  const selected = runParam ? data.runs.find((r) => runId(r) === runParam) || null : null;

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: data.runs.length, running: 0, finished: 0, failed: 0 };
    data.runs.forEach((r) => (c[runOutcome(r).bucket] += 1));
    return c;
  }, [data.runs]);

  const events = useMemo(() => (snap ? projectEvents(snap.tasks ?? [], snap.requests ?? []) : []), [snap]);
  const evScoped = filterEvents(events, agentSel ? agentSel.alias : null, taskParam);
  const evCounts = useMemo(() => {
    const c: Record<string, number> = {};
    EVENT_KIND_FILTERS.forEach((f) => (c[f.key] = evScoped.filter((e) => matchesEventKind(e, f.key)).length));
    return c;
  }, [evScoped]);
  const evShown = evScoped.filter((e) => matchesEventKind(e, kindF)).slice(0, 150);
  const partialSnap = !!snap && (((snap as Snapshot & { task_total?: number }).task_total ?? 0) > (snap.tasks ?? []).length
    || ((snap as Snapshot & { request_total?: number }).request_total ?? 0) > (snap.requests ?? []).length);

  // the run itself is titled in its inspector, never repeated in the header (D12)
  const crumbs = [
    ...(agentSel ? [{ label: agentSel.alias, href: "/agents?agent=" + encodeURIComponent(agentSel.alias) }] : []),
    ...(taskParam ? [{ label: taskSel ? taskSel.title : "Task " + shortId(taskParam), href: "/tasks?task=" + encodeURIComponent(taskParam) }] : []),
  ];
  const closeRun = () => {
    if ((location.state as { actRunPushed?: boolean } | null)?.actRunPushed) navigate(-1);
    else setParams({ run: null });
  };
  const runOpen = view === "runs" && !!runParam;

  // Escape closes the open run (as in Needs you / Requests) — never while
  // typing, and never when a dialog / popover / menu above owns Escape.
  useEffect(() => {
    if (!runOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditingTarget(document.activeElement)) return;
      if (document.querySelector(".v2-overlay, .overlay.show, .v2-popover, .v2-menu")) return;
      e.preventDefault();
      closeRun();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const scopeText =
    data.scope.mode === "task"
      ? "Runs that touched this task (newest " + FILTERED_LIMIT + ")"
      : data.scope.mode === "agent"
        ? "Newest " + FILTERED_LIMIT + " runs of " + (agentSel ? agentSel.alias : "this agent")
        : data.scope.total > data.scope.queried
          ? `Newest ${FANOUT_LIMIT} runs of each of the ${data.scope.queried} most recently active agents (of ${data.scope.total}). Filter by agent to see more.`
          : `Newest ${FANOUT_LIMIT} runs of each agent`;

  // ---- toolbar: view filters left; agent / task scope, refresh and the
  // Runs ⇄ Events view toggle right, in a fixed order (the agent chip and the
  // toggle never move when the view changes) ----
  const noAgents = !!snap && !aiAgents.length && !agentMissing;
  // run-state pills only when there is something to filter: a project with no
  // AI agents, or a loaded window with no runs at all, keeps only the toggle
  const showRunPills = !noAgents && !(data.loadedAt && !data.runs.length && !data.failed.length && stateF === "all");
  const runPills: FilterPillSpec[] = RUN_STATE_FILTERS.map((f) => ({
    key: f.key,
    label: f.key === "all" ? "All runs" : f.label,
    count: data.loadedAt && !noAgents ? counts[f.key] : null, // unknown until loaded, never "0"
    title: f.hint,
  }));
  const eventPills: FilterPillSpec[] = EVENT_KIND_FILTERS.map((f) => ({
    key: f.key,
    label: f.label,
    count: snap ? evCounts[f.key] : null,
    title: f.hint,
  }));
  const setView = (v: "runs" | "events") => {
    if (v === view) return;
    // each view's own filter is cleared on switch — no dead ?state= in Events
    if (v === "events") setParams({ view: "events", run: null, state: null });
    else setParams({ view: null, kind: null });
  };
  const eventsHelp =
    "Events — latest task messages and request activity from this project's snapshot" +
    (partialSnap ? " (first 1000 tasks / requests only)" : "") +
    ". Worker output lives in Runs.";
  const updatedAt = data.loadedAt ? clockTime(new Date(data.loadedAt).toISOString()) : null;

  const toolbar = (
    <PageToolbar
      label="Activity filters"
      className="act-toolbar"
      end={
        <>
          {view === "runs" && !noAgents ? (
            <CircleIconButton
              icon="refresh"
              label={updatedAt ? "Refresh runs · updated " + updatedAt : "Refresh runs"}
              busy={data.loading && !!data.loadedAt}
              onClick={() => setNonce((n) => n + 1)}
            />
          ) : !noAgents ? (
            // Events has nothing to refresh (it follows the live snapshot), but
            // the slot is kept so the agent chip and the toggle never jump
            <span className="act-slot" aria-hidden="true" />
          ) : null}
          {taskParam ? (
            <Chip
              className="act-taskchip"
              icon={<Icon name="tasks" cls="v2-ico" />}
              title={taskSel ? taskSel.title : "Task " + shortId(taskParam)}
              trailing={<IconButton icon="x" size="sm" className="act-chip-x" label="Clear task filter" onClick={() => setParams({ task: null, run: null })} />}
            >
              <Link to={"/tasks?task=" + encodeURIComponent(taskParam)}>{taskSel ? taskSel.title : shortId(taskParam)}</Link>
            </Chip>
          ) : null}
          {noAgents ? null : (
            <AgentFilter
              agents={aiAgents}
              value={agentSel ? agentSel.alias : agentParam || null}
              missing={agentMissing}
              onChange={(alias) => setParams({ agent: alias, run: null })}
            />
          )}
          <div className="act-viewtoggle" role="group" aria-label="View">
            <CircleIconButton glyph={<RunsGlyph />} label="Runs — worker runs and their logs" pressed={view === "runs"} onClick={() => setView("runs")} />
            <CircleIconButton glyph={<EventsGlyph />} label={eventsHelp} pressed={view === "events"} onClick={() => setView("events")} />
          </div>
        </>
      }
    >
      {view === "events" ? (
        <FilterPills label="Event kind" value={kindF} onChange={(k) => setParams({ kind: k === "all" ? null : k })} items={eventPills} />
      ) : showRunPills ? (
        <FilterPills label="Run state" value={stateF} onChange={(k) => setParams({ state: k === "all" ? null : k })} items={runPills} />
      ) : null}
    </PageToolbar>
  );

  // ---- runs: day bands (Today / Yesterday / …) of one-line rows ----
  let listBody: React.ReactNode;
  if (!snap) listBody = <Skeleton lines={6} label="Loading activity" />;
  else if (agentMissing) listBody = <EmptyState title="Agent not found" body={`No agent named “${agentParam}” in this project.`} action={<Button size="sm" onClick={() => setParams({ agent: null, run: null })}>Show all agents</Button>} />;
  else if (!aiAgents.length) listBody = <EmptyState title="No AI agents yet" body="Runs appear here once an AI agent is woken to work." action={<Link className="v2-btn v2-btn-secondary v2-btn-sm" to="/onboarding?new=1"><span className="v2-btn-label">Create agents</span></Link>} />;
  else if (!data.loadedAt && !data.settled) listBody = <Skeleton lines={6} label="Loading runs" />;
  else if (data.failed.length && !data.runs.length) listBody = <EmptyState tone="danger" title="Runs unavailable" body="The runs endpoint did not respond. Retry, or check the project connection." action={<Button size="sm" onClick={() => setNonce((n) => n + 1)}>Retry</Button>} />;
  else if (!listed.length) listBody = <EmptyState title={data.runs.length ? "No runs match this state" : "No runs yet"} body={data.runs.length ? "Try another state filter." : "Worker runs appear here when an agent wakes."} />;
  else
    listBody = groupByDay(listed, (r) => runStarted(r), now).map((g) => (
      <ListGroup key={g.key} id={g.key} title={g.label} count={g.items.length} level={2} className="act-group">
        <List label={"Worker runs · " + g.label}>
          {g.items.map((r) => {
            const id = runId(r);
            const o = runOutcome(r);
            const ag = byId.get(String(r.agent_id || ""));
            const tt = taskTitle(r.task_id);
            const dur = runDuration(r, now);
            const elapsed = runElapsed(r, now);
            const alias = ag ? ag.alias : "unknown agent";
            const what = tt || (r.task_id ? "Task " + shortId(r.task_id) : wakeLabel(r) || "Worker run");
            const when = runStarted(r) ? relTime(runEnded(r) || runStarted(r)) : "";
            return (
              <Row
                key={id}
                id={id}
                selected={id === runParam}
                className="act-row"
                title={alias + " · " + what + " — " + o.label + (o.reason ? " (" + o.reason + ")" : "")}
                onActivate={() => setParams({ run: id }, narrow && !runParam)}
              >
                <StatusIcon status={o.dot} label={o.label} className="act-row-st" />
                <Avatar alias={alias} kind={ag ? ag.kind : "system"} size={20} decorative className="act-row-av" />
                <span className="act-row-main">
                  <span className="act-row-who">{alias}</span>
                  <span className="act-row-what">{what}</span>
                  {o.bucket === "failed" && o.reason ? <span className="act-row-reason">{o.reason}</span> : null}
                </span>
                {elapsed ? (
                  // running: ONE live time fact (never "8m ago · 8m 41s", D12)
                  <span className="act-row-meta" title={runStarted(r) ? "Started " + clockTime(runStarted(r)!) : undefined}>
                    running {elapsed}
                  </span>
                ) : (
                  <span className="act-row-meta">
                    {when}
                    {when && dur ? <span aria-hidden="true" className="act-dur-sep"> · </span> : null}
                    {dur ? <span className="act-dur" title="Duration">{dur}</span> : null}
                  </span>
                )}
              </Row>
            );
          })}
        </List>
      </ListGroup>
    ));

  const runsList = (
    <div className="act-list">
      {data.refreshFailed && data.runs.length ? (
        <div className="act-warn" role="status">
          <Icon name="alert" cls="v2-ico" />
          <span>
            Couldn't refresh runs — showing the last-known list{updatedAt ? " from " + updatedAt : ""}.{" "}
            <button type="button" className="act-warn-retry" onClick={() => setNonce((n) => n + 1)}>Retry</button>
          </span>
        </div>
      ) : data.loadedAt && data.failed.length && data.runs.length ? (
        <div className="act-warn" role="status">
          <Icon name="alert" cls="v2-ico" />
          Runs unavailable for {data.failed.join(", ")}.{" "}
          {data.carried ? "Their last-known runs are kept; other agents' runs are current." : "Other agents' runs are shown."}
        </div>
      ) : null}
      {listBody}
      {data.loadedAt && aiAgents.length && !agentMissing && data.runs.length ? (
        <p className="act-scope">
          {scopeText}
          {shown.length > LIST_CAP ? ` · showing the first ${LIST_CAP} of ${shown.length}` : ""}
        </p>
      ) : null}
    </div>
  );

  let inspector: React.ReactNode = null;
  if (runParam && view === "runs") {
    if (selected) {
      inspector = <RunInspector run={selected} agent={byId.get(String(selected.agent_id || "")) || null} taskTitle={taskTitle(selected.task_id)} now={now} onClose={closeRun} />;
    } else if (data.loadedAt || data.settled) {
      inspector = (
        <Inspector title={"Run " + shortId(runParam)} onClose={closeRun}>
          <EmptyState title="Run not in the loaded window" body="It may be older than the runs loaded here, or belong to another project. Filter by its agent or task to load more." />
        </Inspector>
      );
    }
  }

  // phones with a run open: the run owns the screen — no filters above it, a
  // "← Activity" back affordance, the header keeps the page title
  const narrowRun = narrow && !!inspector;
  const noRunsShown = !inspector && (!aiAgents.length || agentMissing || ((!!data.loadedAt || data.settled) && !listed.length));

  return (
    <Shell
      page="activity"
      title="Activity"
      crumbs={crumbs}
      ctx={snap ? (snap.container?.name ?? undefined) : undefined}
      toolbar={narrowRun ? undefined : toolbar}
      flush
    >
      <div className={"act-page is-" + view + (narrowRun ? " is-narrow-run" : "")}>
        {narrowRun ? (
          <div className="act-back">
            <Button size="sm" variant="ghost" icon="arrow-left" onClick={closeRun}>Activity</Button>
          </div>
        ) : null}
        {offline ? (
          <div className="act-offline" role="status">
            <Icon name="alert" cls="v2-ico" />
            Project connection lost — agent states and the run list may be out of date. Nothing here is shown as live until it reconnects.
          </div>
        ) : null}
        {view === "runs" ? (
          <div className={"act-split" + (noRunsShown ? " is-empty" : "")} id="act-panel-runs">
            <SplitPane list={runsList} inspector={inspector} storageKey="orcha:v2:activityInspector" defaultSize={560} min={380} max={900} label="Resize run details" />
          </div>
        ) : (
          <EventsFeed events={evShown} me={meAlias} loading={!snap} filtered={!!(agentSel || taskParam) || kindF !== "all"} partial={partialSnap} byAlias={(a) => agentByAlias(snap, a)} />
        )}
      </div>
    </Shell>
  );
}

/* ---- Events: a Linear activity timeline under Today / Yesterday dividers ----
 * Every event is ONE muted line — round actor avatar · "actor verb object ·
 * time" — joined by the timeline's thin connector, with the message / request
 * text as a muted second line (max 2 lines, D12). No bordered cards: the feed
 * reads like the Activity section of a Linear issue, left-aligned to the same
 * gutter as the Runs list. */

function EventsFeed({ events, me, loading, filtered, partial, byAlias }: {
  events: ProjectEvent[]; me: string | null; loading: boolean; filtered: boolean; partial: boolean; byAlias: (alias: string) => Agent | null;
}) {
  const now = Date.now();
  // consecutive comments by one actor on one task fold into "commented N× on …" (per day)
  const days = useMemo(() => groupByDay(events, (e) => e.at, now).map((d) => ({ ...d, items: collapseEvents(d.items) })), [events, now]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const actorAv = (who: string, human: boolean) => {
    const a = byAlias(who);
    const kind = a ? a.kind : human ? "human" : who === "system" ? "system" : "ai";
    return <Avatar alias={who} kind={kind} size={16} decorative />;
  };
  return (
    <div className="act-feed">
      {loading ? (
        <Skeleton lines={6} label="Loading events" />
      ) : events.length ? (
        <Timeline label="Project events" className="act-tl">
          {days.map((d) => [
            <TimelineDivider key={"d:" + d.key}>{d.label}</TimelineDivider>,
            ...d.items.flatMap((e) => {
              const open = expanded.has(e.key);
              const list = open && e.folded ? [{ ...e, folded: undefined }, ...e.folded] : [e];
              return list.map((x, i) => (
                <TimelineEvent
                  key={x.key}
                  className={"act-tl-ev is-" + x.kind + (i > 0 ? " is-unfolded" : "")}
                  glyph={actorAv(x.who, x.kind === "decision")}
                  actor={isMe(x.who, me) ? "You" : x.who}
                  at={x.at}
                  oneLine
                  bodyLines={2}
                  body={x.text ? <Link to={x.href} className="act-tl-quote" title={x.text}>{x.text}</Link> : null}
                >
                  <span className="v2-sr">{EVENT_KIND_LABEL[x.kind]}: </span>
                  {eventSentence(x, me, i === 0 && e.folded ? () => toggle(e.key) : undefined, i === 0 && open && !!e.folded)}
                </TimelineEvent>
              ));
            }),
          ])}
        </Timeline>
      ) : (
        <EmptyState title="No events" body={filtered ? "Nothing matches these filters." : "Task messages and requests will appear here."} />
      )}
      {partial && events.length ? <p className="act-scope">From the first 1000 tasks / requests of this project.</p> : null}
    </div>
  );
}

/** The acting human reads as "you" in every event sentence (never their alias). */
function isMe(alias: string | null | undefined, me: string | null): boolean {
  return !!alias && !!me && alias.replace(/^@/, "") === me.replace(/^@/, "");
}

/** "commented on <task>", "asked <b>lead</b> a question" / "asked you for info", "answered <b>lead</b>'s" / "your question". */
function eventSentence(e: ProjectEvent, me: string | null, onToggleFold?: () => void, unfolded = false): ReactNode {
  const otherIsMe = isMe(e.other, me);
  const obj = (
    <Link to={e.href} className="act-tl-obj" title={e.subject}>
      <b>{e.subject}</b>
    </Link>
  );
  if (e.kind === "message" || e.kind === "decision") {
    const n = e.folded?.length ?? 0;
    if (n && foldedSameTask(e)) return <>commented {n + 1}× on {obj}</>;
    if (n || unfolded)
      return (
        <>
          commented on {obj}
          {n ? (
            <>
              {" and "}
              <button type="button" className="act-tl-more" aria-expanded={false} onClick={onToggleFold} title={e.folded!.map((f) => f.subject).join("\n")}>
                {n} more
              </button>
            </>
          ) : null}
          {unfolded && onToggleFold ? (
            <>
              {" · "}
              <button type="button" className="act-tl-more" aria-expanded onClick={onToggleFold}>
                Show less
              </button>
            </>
          ) : null}
        </>
      );
    return <>commented on {obj}</>;
  }
  if (e.kind === "answer")
    return (
      <>
        answered{" "}
        <Link to={e.href} className="act-tl-obj">
          {otherIsMe ? "your " : e.other ? <><b>{e.other}</b>{"'s "}</> : "a "}
          {answerNoun(e.reqType)}
        </Link>
      </>
    );
  return (
    <>
      asked {otherIsMe ? "you " : e.other ? <><b>{e.other}</b>{" "}</> : null}
      <Link to={e.href} className="act-tl-obj">
        {askPhrase(e.reqType)}
      </Link>
    </>
  );
}

/* ---- view toggle glyphs (Runs = log lines, Events = timeline) ---- */
function RunsGlyph() {
  return (
    <svg viewBox="0 0 16 16" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M2.5 4.5 5 7 2.5 9.5" />
      <path d="M7 10.5h6.5" />
    </svg>
  );
}
function EventsGlyph() {
  return (
    <svg viewBox="0 0 16 16" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" aria-hidden="true" focusable="false">
      <circle cx="4" cy="3.5" r="1.5" />
      <circle cx="4" cy="12.5" r="1.5" />
      <path d="M4 5v6" />
      <path d="M7.5 3.5h6M7.5 12.5h6" />
    </svg>
  );
}

/* ---- run inspector: compact header + property grid, the log fills the rest ---- */

const EXIT_NOTE = "A run exiting is not task completion — the task still needs its own review.";

function RunInspector({ run, agent, taskTitle, now, onClose }: { run: WorkerRun; agent: Agent | null; taskTitle: string | null; now: number; onClose: () => void }) {
  const o = runOutcome(run);
  const id = runId(run);
  const dur = runDuration(run, now);
  const started = runStarted(run);
  const ended = runEnded(run);
  // D12: the exit code is stated once — in the log's Exit line (and the row).
  // Status drops "· exit N"; the Reason row hides when it is only the
  // synthesised exit-code text. The code stays in the Status tooltip.
  const statusLabel = o.label.replace(/ · exit -?\d+$/, "");
  const exitOnlyReason = !!o.reason && /^(?:non-zero exit code |exit )-?\d+$/.test(o.reason);
  const exitTip = run.exit_code != null ? "Exit code " + run.exit_code : undefined;
  return (
    <Inspector
      title={
        <span className="act-insp-title">
          <StatusIcon status={o.dot} label={o.label} size={16} />
          <span>Run</span>
          <span className="act-insp-id">{shortId(id)}</span>
        </span>
      }
      meta={
        <span className="act-insp-meta">
          {agent ? (
            <Link to={"/agents?agent=" + encodeURIComponent(agent.alias) + "&tab=runs"} className="act-agent">
              <Avatar alias={agent.alias} kind={agent.kind} size={16} decorative />
              <span className="act-ellip">{agent.alias}</span>
            </Link>
          ) : (
            <span>Unknown agent</span>
          )}
          <span aria-hidden="true" className="act-insp-sep">/</span>
          {run.task_id ? (
            <Link to={"/tasks?task=" + encodeURIComponent(run.task_id)} className="act-ellip act-insp-task" title={taskTitle || undefined}>
              {taskTitle || "Task " + shortId(run.task_id)}
            </Link>
          ) : (
            <span className="act-muted">No task</span>
          )}
        </span>
      }
      onClose={onClose}
      actions={<StopRunButton run={run} />}
      label={"Run " + shortId(id)}
    >
      <div className="act-insp">
        <PropertySection className="act-props">
          <Property label="Status">
            <span className="act-status" title={exitTip}>
              <StatusIcon status={o.dot} label={statusLabel} showLabel />
              {rawStatusDiffers(run) ? <span className="act-muted">({run.status})</span> : null}
              {run.status === "exited" ? (
                <Tooltip label={EXIT_NOTE} placement="top">
                  <span className="act-help" tabIndex={0}>
                    <Icon name="info" cls="v2-ico" />
                    <span className="v2-sr">{EXIT_NOTE}</span>
                  </span>
                </Tooltip>
              ) : null}
            </span>
          </Property>
          {o.reason && !exitOnlyReason ? (
            <Property label={o.bucket === "failed" ? "Reason" : "Note"}>
              <span className={"act-tone-" + reasonTone(run)}>{o.reason}</span>
            </Property>
          ) : null}
          <Property label="Started" empty="Not recorded">
            {started ? (
              // running: Duration already says how long ago — clock time only (D12)
              <span title={started}>
                {clockTime(started)}
                {run.status === "running" ? null : <span className="act-muted"> · {relTime(started)}</span>}
              </span>
            ) : null}
          </Property>
          <Property label="Duration">
            {dur ?? <span className="act-muted">Unknown</span>}
            <span className="act-muted">{ended ? " · ended " + clockTime(ended) : run.status === "running" ? " · still running" : " · end not recorded"}</span>
          </Property>
          <Property label="Woken by" empty="Not recorded">{wakeLabel(run) || null}</Property>
          {run.runtime || run.lane ? (
            <Property label="Runtime">
              <span className="act-runtime">{runtimeLabel(run.runtime, run.lane)}</span>
            </Property>
          ) : null}
          {run.branch ? (
            <Property label="Branch">
              <span className="mono act-branch act-ellip" title={run.branch}>{run.branch}</span>
            </Property>
          ) : null}
        </PropertySection>
        {run.diff != null && run.diff !== "" ? (
          <details className="act-diff">
            <summary>
              <Icon name="code" cls="v2-ico" />
              Code diff
              <Icon name="chev-right" cls="v2-ico act-diff-chev" />
            </summary>
            <FilesChanged diff={run.diff} blobSource={runBlobSource(run)} />
          </details>
        ) : null}
        <RunLogView key={id} run={run} outcome={{ bucket: o.bucket, stoppedByHuman: killCause(run.kill_reason) === "human_stop" }} />
      </div>
    </Inspector>
  );
}
