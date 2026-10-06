/**
 * D9 — Agents board (Linear "Agent tasks", directive image 17): one column
 * per actor (AI agents first, ordered working → waiting → blocked/failed →
 * idle, then by load; then humans that have assigned or review work; then an
 * "Unassigned" column for work nobody owns), each column holding that actor's
 * tasks as cards.
 *
 * Column header: round avatar (presence dot, page-wide palette slot — D13) ·
 * name (opens the agent workspace) · ONE muted presence word only when not
 * idle (never a task-status glyph for a person — D8) · task count · ⋯
 * (workspace tabs, Tasks view) · + (New task, human only).
 * Card: muted short id · live pill + avatar(s) (only from real run/task state)
 * · status glyph + title · chip row (priority bars, Root, Plan waiting,
 * Review). The card is one link to the task; chips are not interactive.
 *
 * Filters (B1): Active / Backlog show only columns with matching cards. An
 * agent that needs attention but has no cards says why, with a link (B4).
 * Idle agents with no work at all fold into one "+N idle agents" slot.
 *
 * Authority: "+" opens the New task composer only when a human can act; the
 * composer itself stays the one place a task is created (nothing here writes).
 */
import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { Agent, Snapshot, Task } from "../../types";
import { shortId } from "../../lib/format";
import { planAwaitsHuman } from "../../state/SnapshotProvider";
import { Avatar, AvatarStack, actorKey, rosterPaletteSlots } from "../../components/primitives";
import { StatusGlyph, statusLabel } from "../../components/primitives";
import { PriorityIcon, priorityLevel } from "../../components/primitives";
import { Chip } from "../../components/primitives";
import { LivePill, LIVE_LABEL } from "../../components/primitives";
import { IconButton } from "../../components/primitives";
import { Menu, type MenuItemSpec } from "../../components/primitives/Menu";
import { Board, BoardCard, BoardColumn } from "../../components/primitives";
import { activityOf, agentRank, boardCmp, cardLiveState, columnTasks, agentPresenceWord, needsReason, presenceWord, taskInFilter, type BoardFilter, type ColumnTask } from "./agentModel";
import { useOpenCompose } from "../../shell/chrome";
import type { WorkerRun } from "../activity/runModel";
import { hasCheckout } from "./liveChanges";
import { BudgetPausedChip } from "./budget/AgentBudgetSection";
import type { AgentBudgetStatus } from "./budget/budgetModel";
import "./agentsBoard.css";
import "./liveChanges.css";

/** Cards rendered per column before a "N more in Tasks" link (a snapshot can hold hundreds). */
export const COLUMN_CAP = 20;

const PRIO_WORD: Record<string, string> = { urgent: "Urgent", high: "High", normal: "Normal", low: "Low" };
const EMPTY: Record<BoardFilter, string> = { all: "No tasks", active: "No active tasks", backlog: "Nothing in backlog" };

const agentHref = (alias: string, tab?: string) => "/agents?agent=" + encodeURIComponent(alias) + (tab ? "&tab=" + tab : "");

/** Passive presence words a budget stop explains by itself (column header). */
const QUIET_WHEN_PAUSED = new Set(["waiting", "paused", "offline", "noruntime"]);

/* ---- column ⋯ menu --------------------------------------------------------- */
/** L13: the agent has a run in flight — its live status word may lag (e.g. it reads
 *  "Waiting" on a request while a worktree run still works), so the real run state
 *  decides whether "Live changes" is offered: the snapshot's running run (the
 *  workspace's changesTarget speaks for the same run), else the leased live run.
 *  L13b: the SAME rule as the workspace — a running run with no checkout recorded
 *  (no worktree, no base checkout) has nothing on disk to show, so no entry (a
 *  backend that never sends the checkout fields keeps it, like changesTarget). A
 *  bare "working" status with no run behind it is not a run. */
export function hasLiveRun(a: Agent): boolean {
  const rr = a.running_run;
  if (rr?.run_id) return hasCheckout(rr as Pick<WorkerRun, "worktree" | "base_cwd">);
  const ar = a.active_run;
  if (ar?.run_id) return hasCheckout(ar as Pick<WorkerRun, "worktree" | "base_cwd">);
  return false;
}

function ColumnMenu({ a }: { a: Agent }) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const human = a.kind === "human";
  // r2: router navigation (onSelect), never a plain <a href> — that reloaded the
  // whole SPA and aborted the view transition (PAGEERROR)
  const go = (to: string) => () => navigate(to);
  const specs: { label: string; icon: MenuItemSpec["icon"]; to: string }[] = human
    ? [
        { label: "Open " + a.alias, icon: "person", to: agentHref(a.alias) },
        { label: "Requests", icon: "requests", to: agentHref(a.alias, "requests") },
        { label: "Show in Tasks", icon: "tasks", to: "/tasks?assignee=" + encodeURIComponent(a.alias) },
      ]
    : [
        { label: "Open conversation", icon: "agents", to: agentHref(a.alias, "conversation") },
        ...(hasLiveRun(a) ? [{ label: "Live changes", icon: "git" as MenuItemSpec["icon"], to: agentHref(a.alias) + "&changes=1" }] : []),
        { label: "Runs", icon: "live", to: agentHref(a.alias, "runs") },
        { label: "Requests", icon: "requests", to: agentHref(a.alias, "requests") },
        { label: "Memory", icon: "inbox", to: agentHref(a.alias, "memory") },
        { label: "Configuration", icon: "sliders", to: agentHref(a.alias, "config") },
        { label: "Show in Tasks", icon: "tasks", to: "/tasks?assignee=" + encodeURIComponent(a.alias) },
      ];
  const items: MenuItemSpec[] = specs.map((x) => ({ label: x.label, icon: x.icon, onSelect: go(x.to) }));
  return (
    <>
      <IconButton
        ref={ref}
        icon="more"
        size="sm"
        label={"More for " + a.alias}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      />
      <Menu anchor={ref} open={open} onClose={() => setOpen(false)} items={items} label={a.alias + " actions"} placement="bottom-end" />
    </>
  );
}

/* ---- card ------------------------------------------------------------------ */
function TaskCard({ snap, ct, slots }: { snap: Snapshot; ct: ColumnTask; slots: Map<string, number> }) {
  const t = ct.task;
  // `palette`: the page-wide slot (D13), so a card avatar matches its column header
  const actors = (t.assignees || []).map((al) => {
    const x = (snap.agents || []).find((g) => g.alias === al);
    return { alias: al, kind: x?.kind ?? null, ghLogin: x?.github_login ?? null, palette: slots.get(actorKey(al)) };
  });
  const live = cardLiveState(snap, t);
  const lvl = priorityLevel(t.priority);
  // a plan only "waits" when its author runs at plan autonomy (pr/full agents post progress notes)
  const plan = planAwaitsHuman(snap, t);
  // one fact once (D12): a pending plan is told by the pill ("Waiting") + its tooltip, not a second chip
  const topRight = live ? <LivePill state={live} actors={actors} title={plan && live === "waiting" ? "Waiting — plan awaits human approval" : undefined} /> : actors.length ? <AvatarStack actors={actors} size={16} label="Assignees" /> : null;
  const prioTitle = (PRIO_WORD[lvl] || lvl) + " priority (" + String(t.priority ?? "default") + ")";
  const extraChips = [
    plan && live !== "waiting" ? <Chip key="plan" size="sm" dot="warn">Plan waiting</Chip> : null,
    ct.role === "review" ? <Chip key="review" size="sm" dot="info">Review</Chip> : null,
    t.is_root ? <Chip key="root" size="sm" dot="neutral">Root</Chip> : null,
  ].filter(Boolean);
  const label = [
    shortId(t.id),
    t.title,
    statusLabel(t.status),
    (PRIO_WORD[lvl] || lvl) + " priority",
    live ? LIVE_LABEL[live] : "",
    plan ? "Plan awaits approval" : "",
    ct.role === "review" ? "You review" : "",
    actors.length ? "Assignees: " + actors.map((x) => x.alias).join(", ") : "",
  ].filter(Boolean).join(" · ");
  return (
    <BoardCard
      // parity r2: a board card opens the task as a full view, like the Tasks board
      to={"/tasks?task=" + encodeURIComponent(t.id) + "&full=1"}
      label={label}
      id={<span className="v2-t-id">{shortId(t.id)}</span>}
      topRight={topRight}
      glyph={<StatusGlyph status={t.status} />}
      title={<span title={t.title}>{t.title}</span>}
      dim={t.status === "cancelled"}
      chips={
        // Linear (img 17): the priority bars ALWAYS lead the chip row, never
        // the id line — so the glyph sits in the same place on every card
        <>
          <Chip size="sm" icon={<PriorityIcon priority={t.priority} decorative />} title={prioTitle} className="ab-prio">
            {""}
          </Chip>
          {extraChips}
        </>
      }
    />
  );
}

/* ---- board ----------------------------------------------------------------- */
export interface BoardCol {
  /** null = the trailing "Unassigned" column (open work nobody owns yet). */
  agent: Agent | null;
  tasks: ColumnTask[];
}

const unassigned = (t: Task) => !(t.assignees || []).length && !t.assignee;

export function boardColumns(snap: Snapshot | null): BoardCol[] {
  const ags = snap?.agents ?? [];
  // AI agents first, ordered by live state (working → waiting → trouble → idle), then by load
  const ai = ags
    .filter((a) => a.kind !== "human")
    .map((agent) => ({ agent, tasks: columnTasks(snap, agent) }))
    .sort((x, y) => agentRank(x.agent) - agentRank(y.agent) || y.tasks.length - x.tasks.length);
  const cols: BoardCol[] = ai;
  // humans appear with their assigned / review work (a human with none adds an empty column of noise)
  for (const agent of ags.filter((a) => a.kind === "human")) {
    const tasks = columnTasks(snap, agent);
    if (tasks.length) cols.push({ agent, tasks });
  }
  // B6: work nobody owns is still work — it gets a trailing column instead of vanishing
  const none = (snap?.tasks ?? []).filter((t) => unassigned(t) && !t.is_root).map((task) => ({ task, role: "assignee" as const }));
  if (none.length) cols.push({ agent: null, tasks: none });
  return cols;
}

/** Pill counts: distinct tasks on the board (a task with two assignees counts once). */
export function filterCounts(snap: Snapshot | null): Record<BoardFilter, number> {
  const seen = new Map<string, Task>();
  for (const c of boardColumns(snap)) for (const ct of c.tasks) seen.set(ct.task.id, ct.task);
  const on = Array.from(seen.values());
  return {
    all: on.length,
    active: on.filter((t) => taskInFilter(t, "active")).length,
    backlog: on.filter((t) => taskInFilter(t, "backlog")).length,
  };
}

/**
 * B4: an agent that needs attention but has no cards says WHY, with a link to
 * where the answer lives. Derived only from its real status + open requests.
 */
export function columnReason(snap: Snapshot | null, a: Agent): { text: string; link: string; href: string } | null {
  if (!needsReason(a)) return null;
  const open = (snap?.requests ?? []).filter(
    (r) => (r.from === a.alias || (!!r.requester_id && r.requester_id === a.id)) && (r.status === "open" || r.status === "escalated"),
  );
  if (open.length) {
    const to = Array.from(new Set(open.map((r) => r.to).filter(Boolean)));
    return {
      text: to.length === 1 ? "Waiting on " + to[0] : "Waiting on replies",
      link: open.length + (open.length === 1 ? " request" : " requests"),
      href: agentHref(a.alias, "requests"),
    };
  }
  switch (a.status) {
    case "awaiting_human":
      return { text: "Waiting on a human", link: "Open conversation", href: agentHref(a.alias, "conversation") };
    case "awaiting_request":
      return { text: "Waiting on a request", link: "Requests", href: agentHref(a.alias, "requests") };
    case "blocked":
      return { text: "Blocked", link: "Open agent", href: agentHref(a.alias) };
    case "failed":
    case "terminated":
      return { text: presenceWord(a.status) || "Failed", link: "View runs", href: agentHref(a.alias, "runs") };
    default:
      return null;
  }
}

function Reason({ r }: { r: { text: string; link: string; href: string } }) {
  return (
    <span className="ab-reason">
      <span>{r.text}</span>
      <span aria-hidden="true"> · </span>
      <Link to={r.href}>{r.link} →</Link>
    </span>
  );
}

function UnassignedGlyph() {
  return <span className="ab-unassigned-av" aria-hidden="true" />;
}

export function AgentsBoard({ snap, filter, canAct, paused }: {
  snap: Snapshot;
  filter: BoardFilter;
  canAct: boolean;
  /** KG-6/B25: budget-paused agents by id (pausedById) — their column header says so */
  paused?: Record<string, AgentBudgetStatus>;
}) {
  const openCompose = useOpenCompose();
  const [showIdle, setShowIdle] = useState(false);
  const all = boardColumns(snap);
  // D13: one colour per actor for the whole page, collision-free across everyone shown
  // (the same memoised roster map the sidebar, needs popover and every Avatar read)
  const slots = rosterPaletteSlots(snap.agents) ?? new Map<string, number>();

  const shaped = all.map((c) => ({ ...c, shown: c.tasks.filter((x) => taskInFilter(x.task, filter)).sort((x, y) => boardCmp(x.task, y.task)) }));
  // B1: a filtered board shows only columns with matching cards (plus, under Active,
  // agents whose attention state has no card and needs a reason)
  const visible = shaped.filter((c) => {
    if (c.shown.length) return true;
    if (!c.agent) return false;
    if (filter === "backlog") return false;
    if (needsReason(c.agent)) return true;
    return filter === "all";
  });
  // idle AI agents with no work at all fold into one "+N idle agents" slot (All only)
  const idle = visible.filter((c) => c.agent && c.agent.kind !== "human" && !c.tasks.length && !needsReason(c.agent));
  const cols = showIdle ? visible : visible.filter((c) => !idle.includes(c));
  const idleSlot = idle.length && !showIdle;

  if (!cols.length && !idleSlot) {
    return (
      <div className="ab-none v2-t-meta" role="status">
        {EMPTY[filter]}
        {filter !== "all" ? (
          <>
            {" · "}
            <Link to="/agents?view=board">Show all tasks</Link>
          </>
        ) : null}
      </div>
    );
  }

  return (
    <div className="ab-wrap" style={{ ["--ab-cols" as string]: cols.length }} data-idle-slot={idleSlot ? "true" : undefined}>
      <Board label="Agent tasks" className="ab-board">
        {cols.map(({ agent: a, shown, tasks }) => {
          const more = shown.length - COLUMN_CAP;
          const cards = shown.length
            ? [
                ...shown.slice(0, COLUMN_CAP).map((ct) => <TaskCard key={ct.task.id} snap={snap} ct={ct} slots={slots} />),
                more > 0 ? (
                  <li key="__more" className="ab-more">
                    <Link to={"/tasks?assignee=" + encodeURIComponent(a ? a.alias : "none")}>
                      {more} more in Tasks
                    </Link>
                  </li>
                ) : null,
              ]
            : null;
          if (!a) {
            return (
              <BoardColumn
                key="__unassigned"
                id="__unassigned"
                className="ab-col is-unassigned"
                icon={<UnassignedGlyph />}
                title={
                  <Link className="ab-col-name" to="/tasks?assignee=none" title="Tasks with no assignee">
                    Unassigned
                  </Link>
                }
                count={shown.length}
                onAdd={canAct ? () => openCompose() : undefined}
                addLabel="New task"
              >
                {cards}
              </BoardColumn>
            );
          }
          const human = a.kind === "human";
          // Live changes: a WORKING agent's column leads with the entry into its run's
          // changed files (the workspace resolves the running run; nothing is counted here)
          const liveChanges = !human && hasLiveRun(a) && shown.length ? (
            <li key="__changes" className="ab-changes">
              <Link
                className="v2-btn v2-btn-secondary v2-btn-sm lc-btn is-live"
                to={agentHref(a.alias) + "&changes=1"}
                title={"See the files " + a.alias + "'s run is changing, as it works"}
              >
                <span className="lc-dot" aria-hidden="true" />
                <span className="v2-btn-label">Live changes</span>
              </Link>
            </li>
          ) : null;
          const act = human ? null : activityOf(a);
          const pres = human ? null : agentPresenceWord(a, snap);
          const word = pres ? pres.label : null;
          const reason = !tasks.length || !shown.length ? columnReason(snap, a) : null;
          // KG-6/B25: why its queued work stalls — the budget stop, told on the column
          const stop = human ? null : paused?.[a.id] ?? null;
          // the header is narrow: while a budget stop is WHY it waits, the chip says it once
          // (a passive "Waiting"/"Paused" word beside it truncated both); live or trouble
          // words (Working, Needs you, Blocked, Failed) still show next to the chip
          const colWord = stop && pres && QUIET_WHEN_PAUSED.has(pres.k) ? null : word;
          return (
            <BoardColumn
              key={a.id}
              id={a.alias}
              className={"ab-col" + (human ? " is-human" : "")}
              icon={<Avatar alias={a.alias} kind={a.kind} ghLogin={a.github_login} status={human ? null : a.status} size={20} decorative palette={slots.get(actorKey(a.alias))} />}
              title={
                <Link className="ab-col-name" to={agentHref(a.alias)} title={[a.alias, a.role, human ? "" : word || "Idle", act ? "Now: " + act : ""].filter(Boolean).join("\n")}>
                  {a.alias}
                </Link>
              }
              status={
                colWord || stop ? (
                  <>
                    {colWord ? <span className="ab-col-word" data-status={a.status} data-presence={pres!.k} title={pres!.reason}>{word}</span> : null}
                    <BudgetPausedChip status={stop} />
                  </>
                ) : undefined
              }
              count={reason && !shown.length ? null : shown.length /* the reason line says it; "0" adds nothing */}
              menu={<ColumnMenu a={a} />}
              onAdd={canAct ? () => openCompose({ assignee: human ? null : a.alias }) : undefined}
              addLabel={human ? "New task" : `New task for ${a.alias}`}
              empty={reason ? <Reason r={reason} /> : EMPTY[filter]}
            >
              {liveChanges}
              {cards}
            </BoardColumn>
          );
        })}
        {idleSlot ? (
          <section className="ab-idle" aria-label="Idle agents">
            <button
              type="button"
              className="ab-idle-btn"
              title={"Idle, no tasks: " + idle.map((c) => c.agent!.alias).join(", ")}
              onClick={() => setShowIdle(true)}
            >
              <AvatarStack
                actors={idle.map((c) => ({ alias: c.agent!.alias, kind: c.agent!.kind, ghLogin: c.agent!.github_login ?? null, palette: slots.get(actorKey(c.agent!.alias)) }))}
                size={16}
                max={3}
              />
              <span>
                +{idle.length} idle {idle.length === 1 ? "agent" : "agents"}
              </span>
            </button>
          </section>
        ) : null}
      </Board>
    </div>
  );
}
