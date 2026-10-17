/**
 * Tasks list + board (Linear "My issues" / "Agent tasks", directives D5/D8/D12).
 *
 *  - `TaskRow`      one 36 px line: priority bars · muted short id · status glyph ·
 *                   title (ellipsis) · ≤ 2 chips · live pill or assignee avatar(s) ·
 *                   relative time. The latest-activity text moved to the row
 *                   tooltip (and the detail's Activity tab) — never two lines.
 *  - `TaskGroups`   D8 band headers (caret collapses, glyph, name, count; the
 *                   collapse state persists per group). ↑/↓ j/k Home/End move
 *                   across every visible row of every group; Enter opens.
 *  - `TaskBoard`    read-only status columns of Linear cards (status is backend
 *                   managed — cards are never draggable).
 *  - `TasksToolbar` the filter-pill row under the header: scope pills, search,
 *                   circular Filter / Display / Board-view buttons.
 *
 * Truthfulness: "Working…" is shown only when a run for THIS task is running
 * (runs_summary) or the assignee's active run points at this task; priority is
 * the backend number bucketed (exact value in the tooltip); a reviewer chip
 * only when the backend supports reviewers; no PR / label chips because the
 * task payload carries none.
 */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { Snapshot, Task } from "../../types";
import { relTime, shortId } from "../../lib/format";
import { reviewerName, reviewerRef, reviewerTitle } from "../../lib/reviewer";
import { agentByAlias, planAwaitsHuman, useSnapshot } from "../../state/SnapshotProvider";
import { Icon } from "../../components/ui";
import { Button, Menu, MenuButton, Popover, Row, isEditingTarget, moveRowFocus, type MenuItemSpec } from "../../components/primitives";
import { Avatar, AvatarStack, type AvatarActor } from "../../components/primitives";
import { StatusGlyph, StatusIcon } from "../../components/primitives";
import { PriorityGlyph, PriorityIcon, priorityLevel } from "../../components/primitives";
import { Chip } from "../../components/primitives";
import { LivePill } from "../../components/primitives";
import { IconButton } from "../../components/primitives";
import { GroupHeader } from "../../components/primitives";
import { Board, BoardCard, BoardColumn } from "../../components/primitives";
import { FilterPills } from "../../components/primitives";
import { PageToolbar } from "../../shell/PageChrome";
import {
  SCOPES,
  SORT_KEYS,
  groupTasks,
  latestActivity,
  scopeCount,
  scopeOf,
  shortAgo,
  statusFilterOptions,
  type SortKey,
  type TaskGroup,
  type TaskQuery,
} from "./taskQuery";

/* ---- local glyphs (not in the shared Icon set) ---------------------------- */
const FilterGlyph = () => (
  <svg className="v2-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden="true">
    <path d="M2.5 4.5h11M4.5 8h7M6.5 11.5h3" />
  </svg>
);
const BoardGlyph = () => (
  <svg className="v2-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="2.5" width="3.4" height="11" rx="1" />
    <rect x="6.3" y="2.5" width="3.4" height="7.5" rx="1" />
    <rect x="10.6" y="2.5" width="3.4" height="9.5" rx="1" />
  </svg>
);

/* ---- hooks ------------------------------------------------------------------ */
function useMedia(q: string): boolean {
  const get = () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(q).matches : false);
  const [m, setM] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mm = window.matchMedia(q);
    const on = () => setM(mm.matches);
    mm.addEventListener?.("change", on);
    return () => mm.removeEventListener?.("change", on);
  }, [q]);
  return m;
}
export const usePhone = () => useMedia("(max-width: 560px)");

export type Density = "comfortable" | "compact";
const DENSITY_KEY = "orcha:v2:tasks:density";
export function useDensity(): [Density, (d: Density) => void] {
  const [d, setD] = useState<Density>(() => {
    try {
      return localStorage.getItem(DENSITY_KEY) === "compact" ? "compact" : "comfortable";
    } catch {
      return "comfortable";
    }
  });
  const set = (v: Density) => {
    setD(v);
    try {
      localStorage.setItem(DENSITY_KEY, v);
    } catch {
      /* private mode */
    }
  };
  return [d, set];
}

const GROUP_KEY = "orcha:v2:tasks:grp";
function readCollapsed(): Record<string, boolean> {
  try {
    const v = JSON.parse(localStorage.getItem(GROUP_KEY) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/* ---- per-task facts ------------------------------------------------------- */
function assigneesOf(t: Task): string[] {
  return (t.assignees || []).length ? t.assignees : t.assignee ? [t.assignee] : [];
}
function actorsOf(snap: Snapshot | null, t: Task): AvatarActor[] {
  return assigneesOf(t).map((al) => {
    const a = agentByAlias(snap, al);
    return { alias: al, kind: a ? a.kind : "ai", ghLogin: a?.github_login ?? null };
  });
}
/** True only when there is real evidence a run is working on THIS task. */
export function taskIsWorking(snap: Snapshot | null, t: Task): boolean {
  const run = t.runs_summary?.latest?.status;
  if (run === "running") return true;
  return assigneesOf(t).some((al) => {
    const a = agentByAlias(snap, al);
    return !!a?.active_run?.task_id && String(a.active_run.task_id) === String(t.id);
  });
}

/** ≤ 2 metadata chips, most decision-relevant first. */
function taskChips(snap: Snapshot | null, t: Task, opts: { reviewOn: boolean; level: string }): ReactNode[] {
  const out: ReactNode[] = [];
  // "Plan waiting" only when the plan is really gated on a human: the plan
  // author's (else the assignee's) EFFECTIVE autonomy is "plan" — the same
  // rule as Needs you / Overview (planAwaitsHuman). An agent at pr/full posts
  // progress notes, not plans awaiting approval.
  if (planAwaitsHuman(snap, t)) {
    out.push(
      <Chip key="plan" dot="warn" size="sm" title="Plan awaiting your approval">
        Plan waiting
      </Chip>,
    );
  }
  if (opts.reviewOn && t.status === "needs_verification") {
    const rr = reviewerRef(t);
    const rev = reviewerName(rr);
    if (rev) {
      out.push(
        <Chip key="rev" size="sm" className="tl-revchip" icon={<Icon name="shield" cls="v2-ico" />} title={reviewerTitle(rr)}>
          {rev}
        </Chip>,
      );
    }
  }
  if (t.is_root) out.push(<Chip key="root" size="sm" title="Root task of this project">Root</Chip>);
  return out.slice(0, 2);
}

function Who({ snap, t, hide }: { snap: Snapshot | null; t: Task; hide?: boolean }) {
  const actors = actorsOf(snap, t);
  if (taskIsWorking(snap, t)) return <LivePill state="working" actors={actors} />;
  if (hide) return null;
  if (!actors.length) {
    return (
      <span className="tl-noone" title="Unassigned">
        <span className="v2-sr">Unassigned</span>
      </span>
    );
  }
  return <AvatarStack actors={actors} size={20} max={3} label={"Assigned to " + actors.map((a) => a.alias).join(", ")} />;
}

function When({ t }: { t: Task }) {
  const act = latestActivity(t);
  const txt = shortAgo(relTime(act.at));
  if (!act.at || !txt) return <span className="tl-time" />;
  return (
    <time className="tl-time" dateTime={act.at} title={"Updated " + new Date(act.at).toLocaleString()}>
      {txt}
    </time>
  );
}

/* ---- row ⋯ menu (hover / focus, Linear) ---------------------------------------- */
export type RowMenuItems = (MenuItemSpec | "separator")[];
function RowMenu({ t, items }: { t: Task; items: RowMenuItems }) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  // the menu renders in a popover, but React events still bubble through the row —
  // stop them here so picking an item never also opens the task
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return (
    <span className="tl-rowmenu" onClick={stop} onKeyDown={stop}>
      <IconButton ref={ref} size="sm" icon="more" label={"Actions for " + t.title} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((o) => !o)} />
      <Menu anchor={ref} open={open} onClose={() => setOpen(false)} items={items} label="Task actions" placement="bottom-end" />
    </span>
  );
}

/* ---- row -------------------------------------------------------------------- */
export function TaskRow({ t, snap, selected, onSelect, compact, groupedBy, reviewOn, level, phone, menu }: {
  t: Task; snap: Snapshot | null; selected: boolean; onSelect: (id: string) => void; compact: boolean;
  groupedBy: TaskQuery["group"]; reviewOn: boolean; level: string; phone: boolean;
  /** row ⋯ menu items (e.g. "Make recurring…"); no button when absent/empty */
  menu?: RowMenuItems | null;
}) {
  const act = latestActivity(t);
  const chips = taskChips(snap, t, { reviewOn, level }).slice(0, phone ? 1 : 2);
  const hideWho = groupedBy === "assignee" && assigneesOf(t).length <= 1;
  return (
    <Row
      id={t.id}
      className={"trow tl-row" + (compact ? " is-compact" : "")}
      selected={selected}
      onActivate={() => onSelect(t.id)}
      title={act.text ? t.title + "\n" + act.text + (act.at ? " · " + relTime(act.at) : "") : t.title}
    >
      <PriorityIcon priority={t.priority} className="tl-prio" />
      <span className="tl-id">{shortId(t.id)}</span>
      <StatusIcon status={t.status} className="tl-st" />
      <span className="tl-title">{t.title}</span>
      {chips.length ? <span className="tl-chips">{chips}</span> : null}
      <span className="tl-who">
        <Who snap={snap} t={t} hide={hideWho} />
      </span>
      <When t={t} />
      {menu && menu.length ? <RowMenu t={t} items={menu} /> : null}
    </Row>
  );
}

/* ---- grouped list ------------------------------------------------------------ */
export function TaskGroups({ groups, groupBy, snap, renderRow, onAdd, addLabel, onMove }: {
  groups: TaskGroup[]; groupBy: TaskQuery["group"]; snap: Snapshot | null; renderRow: (t: Task) => ReactNode;
  onAdd?: () => void; addLabel?: string;
  /** Set while the inspector is open: ↑/↓ j/k SELECT the row they land on
   *  (Linear — the preview follows), instead of only moving focus. */
  onMove?: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(readCollapsed);
  const toggle = (k: string) =>
    setCollapsed((c) => {
      const next = { ...c, [groupBy + ":" + k]: !c[groupBy + ":" + k] };
      try {
        localStorage.setItem(GROUP_KEY, JSON.stringify(next));
      } catch {
        /* private mode */
      }
      return next;
    });
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tg = e.target as HTMLElement;
    if (!tg.hasAttribute("data-v2-row") && isEditingTarget(tg)) return;
    if (!tg.hasAttribute("data-v2-row")) return; // band buttons keep their own keys
    if (moveRowFocus(e.currentTarget, e.key, true)) {
      e.preventDefault();
      const id = (document.activeElement as HTMLElement | null)?.getAttribute("data-id");
      if (onMove && id && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "j" || e.key === "k" || e.key === "Home" || e.key === "End")) onMove(id);
    }
  };
  return (
    <div className="tl-list" onKeyDown={onKeyDown}>
      {groups.map((g) => {
        const open = !collapsed[groupBy + ":" + g.k];
        const bodyId = "tl-grp-" + g.k.replace(/[^\w-]/g, "_");
        const glyph =
          groupBy === "status" ? (
            <StatusGlyph status={g.k === "other" ? "unknown" : g.k} />
          ) : groupBy === "assignee" && g.k !== "__none" ? (
            <Avatar alias={g.label} kind={agentByAlias(snap, g.label)?.kind ?? "ai"} size={16} decorative />
          ) : undefined;
        return (
          <section key={g.k} className="tl-group" data-group={g.k}>
            <GroupHeader
              className="tl-grp"
              title={g.label}
              count={g.items.length}
              glyph={glyph}
              open={open}
              onToggle={() => toggle(g.k)}
              controls={bodyId}
              onAdd={onAdd && g.k === "ready" ? onAdd : undefined}
              addLabel={addLabel}
            />
            {open ? (
              <div id={bodyId} role="listbox" aria-label={g.label + " (" + g.items.length + ")"} className="tl-rows">
                {g.items.map(renderRow)}
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

/* ---- board ------------------------------------------------------------------ */
const BOARD_COL_CAP = 30;
export const BOARD_NOTE = "Status follows the workflow (assign, plan approval, verification, cancel) — cards can't be dragged between columns.";

/* Hidden board columns (Linear "Hidden columns"). An explicit choice per status
   is persisted; with no status filter the finished columns (Completed,
   Cancelled) start hidden so the open work fits the panel — they stay one
   click away in the trailing "Hidden columns" strip, never dropped. A status
   filter that asks for a column (e.g. the Done scope) shows it. */
const BOARD_HIDDEN_KEY = "orcha:v2:tasks:boardHidden";
const DONE_COLS = new Set(["completed", "cancelled"]);
function readBoardHidden(): Record<string, boolean> {
  try {
    const v = JSON.parse(localStorage.getItem(BOARD_HIDDEN_KEY) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
export function boardColumnHidden(k: string, pref: Record<string, boolean>, statusFilter: string[]): boolean {
  if (statusFilter.length) return statusFilter.includes(k) ? false : !!pref[k];
  return pref[k] ?? DONE_COLS.has(k);
}

function ColumnMenu({ title, onHide }: { title: string; onHide: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <IconButton ref={ref} size="sm" icon="more" label={title + " column options"} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} />
      <Menu anchor={ref} open={open} onClose={() => setOpen(false)} label={title + " column"} placement="bottom-end" items={[{ label: "Hide column", icon: "eye-off", onSelect: onHide }]} />
    </>
  );
}

export function TaskBoard({ tasks, selected, onSelect, snap, reviewOn, level, statusFilter = [], onAdd }: {
  tasks: Task[]; selected: string | null; onSelect: (id: string) => void; snap: Snapshot | null; reviewOn: boolean; level: string;
  /** the active `status=` filter (drives which columns are hidden by default) */
  statusFilter?: string[];
  /** New task (shown as the Ready column's "+"; new tasks start there) */
  onAdd?: () => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const narrowBoard = useMedia("(max-width: 700px)");
  const [pref, setPref] = useState<Record<string, boolean>>(readBoardHidden);
  const setHidden = (k: string, hide: boolean) =>
    setPref((p) => {
      const next = { ...p, [k]: hide };
      try {
        localStorage.setItem(BOARD_HIDDEN_KEY, JSON.stringify(next));
      } catch {
        /* private mode */
      }
      return next;
    });
  // the project's root task is the whole project, not a card of work — the
  // board leaves it out (as the old kanban did); the list keeps it with its Root chip
  const all = groupTasks(tasks.filter((x) => !x.is_root), "status");
  if (!all.length) return <div className="wk-empty-list">No tasks match these filters.</div>;
  const cols = all.filter((c) => !boardColumnHidden(c.k, pref, statusFilter));
  const hidden = all.filter((c) => boardColumnHidden(c.k, pref, statusFilter));
  const hiddenRail = (
    <section className="tl-hiddencols" aria-labelledby="tl-hiddencols-h" data-column="__hidden">
      <h3 id="tl-hiddencols-h" className="tl-hiddencols-h">Hidden columns</h3>
      <ul role="list" className="tl-hiddencols-list">
        {hidden.map((c) => (
          <li key={c.k}>
            <button type="button" className="tl-hiddencol" onClick={() => setHidden(c.k, false)} title={"Show the " + c.label + " column"} data-show-column={c.k}>
              <StatusGlyph status={c.k === "other" ? "unknown" : c.k} />
              <span className="tl-hiddencol-name">{c.label}</span>
              <span className="tl-hiddencol-n">{c.items.length}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
  return (
    <div className="tl-boardview">
      <p className="v2-sr" id="tl-board-note">{BOARD_NOTE}</p>
      {/* narrow: no room for a side rail — the hidden columns become one quiet line above the board */}
      {hidden.length && narrowBoard ? <div className="tl-hiddencols-top">{hiddenRail}</div> : null}
      <div className="tl-boardrow">
      <Board label="Task board" className="tl-board">
        {cols.map((c) => {
          const allShown = expanded[c.k];
          const shown = allShown ? c.items : c.items.slice(0, BOARD_COL_CAP);
          return (
            <BoardColumn
              key={c.k}
              id={c.k}
              title={c.label}
              icon={<StatusGlyph status={c.k === "other" ? "unknown" : c.k} />}
              count={c.items.length}
              menu={<ColumnMenu title={c.label} onHide={() => setHidden(c.k, true)} />}
              onAdd={onAdd && c.k === "ready" ? onAdd : undefined}
              addLabel="New task"
            >
              {shown.map((x) => {
                const lv = priorityLevel(x.priority);
                const actors = actorsOf(snap, x);
                const working = taskIsWorking(snap, x);
                const chips = taskChips(snap, x, { reviewOn, level });
                return (
                  <BoardCard
                    key={x.id}
                    // Linear "Agent tasks": the priority bars ALWAYS lead the chip
                    // row (never jump up beside the id on chip-less cards)
                    id={<span className="tl-id">{shortId(x.id)}</span>}
                    topRight={
                      working ? (
                        <LivePill state="working" actors={actors} />
                      ) : actors.length ? (
                        <AvatarStack actors={actors} size={16} max={3} label={"Assigned to " + actors.map((a) => a.alias).join(", ")} />
                      ) : (
                        <span className="tl-noone is-sm" title="Unassigned"><span className="v2-sr">Unassigned</span></span>
                      )
                    }
                    glyph={<StatusGlyph status={x.status} />}
                    title={x.title}
                    label={x.title}
                    chips={
                      <>
                        <Chip size="sm" className="tl-pchip" icon={<PriorityGlyph level={lv} size={12} />} title={"Priority: " + lv + " (" + String(x.priority ?? 100) + ", lower = higher)"}>
                          <span className="v2-sr">{lv} priority</span>
                        </Chip>
                        {chips}
                      </>
                    }
                    selected={x.id === selected}
                    onClick={() => onSelect(x.id)}
                  />
                );
              })}
              {c.items.length > BOARD_COL_CAP ? (
                <li className="tl-bmore">
                  <Button variant="ghost" size="sm" onClick={() => setExpanded((e) => ({ ...e, [c.k]: !allShown }))}>
                    {allShown ? "Show fewer" : `Show all ${c.items.length}`}
                  </Button>
                </li>
              ) : null}
            </BoardColumn>
          );
        })}
      </Board>
      {/* Linear "Hidden columns": a fixed 200 px rail BESIDE the scrolling board
          (not a sticky item inside it) — columns end at the rail, never slide
          under it, and it stays visible at any scroll position */}
      {hidden.length && !narrowBoard ? <aside className="tl-hiddenrail" aria-label="Hidden columns">{hiddenRail}</aside> : null}
      </div>
    </div>
  );
}

/* ---- filter / display popovers ------------------------------------------------ */
/* Linear menus: no visible checkbox/radio box — the native input stays in the
   label (visually hidden, still focusable and announced as checkbox/radio) and
   a trailing check marks the chosen item. */
function PopCheck({ on }: { on: boolean }) {
  return <span className="wk-pop-check" aria-hidden="true">{on ? <Icon name="check" cls="v2-ico" /> : null}</span>;
}
export function StatusChecks({ value, onChange, counts }: { value: string[]; onChange: (v: string[]) => void; counts: Record<string, number> }) {
  const opts = statusFilterOptions(counts, value);
  const toggle = (k: string) => onChange(value.includes(k) ? value.filter((x) => x !== k) : value.concat(k));
  return (
    <fieldset className="wk-pop-sec">
      <legend className="wk-pop-h">Status</legend>
      {opts.map((o) => (
        <label key={o.k} className="v2-menu-item wk-pop-opt">
          <input className="wk-pop-in" type="checkbox" checked={value.includes(o.k)} onChange={() => toggle(o.k)} />
          <StatusGlyph status={o.k === "other" ? "unknown" : o.k} />
          <span className="v2-menu-label">{o.label}</span>
          <span className="v2-menu-hint">{counts[o.k] ?? 0}</span>
          <PopCheck on={value.includes(o.k)} />
        </label>
      ))}
      {value.length ? (
        <Button variant="link" size="sm" onClick={() => onChange([])}>
          Clear status filter
        </Button>
      ) : null}
    </fieldset>
  );
}

export function RadioList<T extends string>({ legend, name, value, options, onChange }: {
  legend: string; name: string; value: T | null; options: { k: T; label: ReactNode; hint?: ReactNode; icon?: ReactNode }[]; onChange: (k: T) => void;
}) {
  return (
    <fieldset className="wk-pop-sec">
      <legend className="wk-pop-h">{legend}</legend>
      {options.map((o) => (
        <label key={o.k} className="v2-menu-item wk-pop-opt">
          <input className="wk-pop-in" type="radio" name={name} checked={value === o.k} onChange={() => onChange(o.k)} />
          {o.icon ? <span className="wk-pop-av" aria-hidden="true">{o.icon}</span> : null}
          <span className="v2-menu-label">{o.label}</span>
          {o.hint != null ? <span className="v2-menu-hint">{o.hint}</span> : null}
          <PopCheck on={value === o.k} />
        </label>
      ))}
    </fieldset>
  );
}

/** Circular outline icon button that opens a popover (D5 toolbar circles). */
function PopIconButton({ label, icon, glyph, badge, active, dataAttr, popLabel, children }: {
  label: string; icon?: string; glyph?: ReactNode; badge?: ReactNode; active?: boolean; dataAttr: string; popLabel: string; children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <IconButton
        ref={anchor}
        variant="outline"
        icon={icon}
        glyph={glyph}
        label={label}
        badge={badge}
        className={active ? "is-on" : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        {...{ [dataAttr]: "true" }}
        onClick={() => setOpen((o) => !o)}
      />
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} label={popLabel} role="dialog" placement="bottom-end" className="wk-pop">
        {children}
      </Popover>
    </>
  );
}

/* ---- toolbar -------------------------------------------------------------------- */
export function TasksToolbar({
  query, qDraft, setQDraft, statusCounts, loaded = true, assignees, setStatus, setAssignee, setView, setGroup, sortKey, setSort,
  density, setDensity, nFilters, shown, total, clearFilters,
}: {
  query: TaskQuery; qDraft: string; setQDraft: (v: string) => void; statusCounts: Record<string, number>;
  /** false until the project snapshot has landed: scope counts are unknown, never "0" */
  loaded?: boolean;
  assignees: string[];
  setStatus: (v: string[]) => void; setAssignee: (v: string | null) => void; setView: (v: "list" | "board") => void;
  setGroup: (g: string) => void; sortKey: SortKey; setSort: (k: SortKey) => void; density: Density; setDensity: (d: Density) => void;
  nFilters: number; shown: number; total: number; clearFilters: () => void;
}) {
  const { snap } = useSnapshot();
  const phone = usePhone();
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const showSearch = !phone || searchOpen || !!qDraft;
  useEffect(() => {
    if (phone && searchOpen) searchRef.current?.focus();
  }, [phone, searchOpen]);

  const scope = scopeOf(query.status);
  const scopeSpec = SCOPES.find((s) => s.k === scope);
  // Phone (≤ 560 px): four pills can't fit beside the icon buttons without
  // clipping ("Bac…") — collapse them into one "All tasks ▾" menu (same scopes,
  // same counts, the current one checked).
  const pills = phone ? (
    <MenuButton
      className="tl-scopemenu"
      variant="ghost"
      size="sm"
      menuLabel="Task scope"
      title="Task scope"
      value={
        <>
          {scopeSpec ? scopeSpec.label : "Custom filter"}{" "}
          <span className="tl-scopemenu-n tnum">{scopeSpec && loaded ? scopeCount(statusCounts, scopeSpec.k) : ""}</span>
        </>
      }
      items={SCOPES.map((s) => ({
        label: s.label,
        hint: loaded ? String(scopeCount(statusCounts, s.k)) : undefined,
        checked: s.k === scope,
        onSelect: () => setStatus(s.statuses),
      }))}
    />
  ) : (
    <FilterPills
      label="Task scope"
      size="sm"
      className="tl-scopes"
      value={scope ?? ""}
      onChange={(k) => setStatus(SCOPES.find((s) => s.k === k)?.statuses ?? [])}
      items={SCOPES.map((s) => ({ key: s.k, label: s.label, count: loaded ? scopeCount(statusCounts, s.k) : null, title: s.hint }))}
    />
  );
  const search = (
    <span className="tl-search">
      <label className="v2-sr" htmlFor="tasksQ">Filter tasks</label>
      <Icon name="search" cls="v2-ico" />
      <input
        ref={searchRef}
        id="tasksQ"
        className="tl-search-in"
        type="search"
        placeholder="Filter tasks…"
        title="Filter by title, #id or assignee"
        value={qDraft}
        onChange={(e) => setQDraft(e.target.value)}
        onBlur={() => !qDraft && setSearchOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            if (qDraft) {
              e.preventDefault();
              e.stopPropagation();
              setQDraft("");
            } else if (phone) setSearchOpen(false);
          }
        }}
      />
    </span>
  );
  const assigneeOpts = [
    { k: "", label: "Any assignee" },
    { k: "none", label: "Unassigned", icon: <span className="tl-noone is-sm" /> },
    ...assignees.map((a) => ({ k: a, label: a, icon: <Avatar alias={a} kind={agentByAlias(snap, a)?.kind ?? "ai"} size={16} decorative /> })),
  ];
  const customStatus = query.status.length > 0 && scope == null;
  const filterBadge = (customStatus ? 1 : 0) + (query.assignee ? 1 : 0) || null;
  const sortLabel = SORT_KEYS.find((x) => x.k === sortKey)?.label || "";
  const board = query.view === "board";

  const end = (
    <>
      {phone && !showSearch ? <IconButton variant="outline" icon="search" label="Filter tasks" onClick={() => setSearchOpen(true)} /> : null}
      {!phone ? search : null}
      <PopIconButton label="Filter" glyph={<FilterGlyph />} badge={filterBadge} active={!!filterBadge} dataAttr="data-filter-btn" popLabel="Filter by status and assignee">
        <StatusChecks value={query.status} counts={statusCounts} onChange={setStatus} />
        <RadioList<string> legend="Assignee" name="tasksAssignee" value={query.assignee || ""} options={assigneeOpts} onChange={(k) => setAssignee(k || null)} />
      </PopIconButton>
      <PopIconButton label={"Display options — " + (board ? "" : "grouping: " + query.group + " · ") + "ordering: " + sortLabel} icon="sliders" dataAttr="data-display-btn" popLabel="Display options">
        {!board ? (
          <RadioList<string>
            legend="Grouping"
            name="tasksGroup"
            value={query.group}
            options={[
              { k: "status", label: "Status" },
              { k: "assignee", label: "Assignee" },
              { k: "none", label: "No grouping" },
            ]}
            onChange={setGroup}
          />
        ) : null}
        <RadioList<SortKey> legend="Ordering" name="tasksSort" value={sortKey} options={SORT_KEYS.map((x) => ({ k: x.k, label: x.label }))} onChange={setSort} />
        {!board ? (
          <RadioList<string>
            legend="Density"
            name="tasksDensity"
            value={density}
            options={[
              { k: "comfortable", label: "Comfortable", hint: "36 px" },
              { k: "compact", label: "Compact", hint: "32 px" },
            ]}
            onChange={(k) => setDensity(k as Density)}
          />
        ) : null}
      </PopIconButton>
      <IconButton
        variant="outline"
        glyph={<BoardGlyph />}
        label="Board view"
        title={board ? "Board view (on) — switch to list" : "Board view"}
        pressed={board}
        data-view-toggle="true"
        onClick={() => setView(board ? "list" : "board")}
      />
    </>
  );

  return (
    <PageToolbar label="Task filters" className="tl-toolbar" end={end}>
      {phone && showSearch ? (
        <>
          {search}
          <IconButton size="sm" icon="x" label="Close search" onClick={() => { setQDraft(""); setSearchOpen(false); }} />
        </>
      ) : (
        pills
      )}
      {nFilters && shown > 0 && !(scope && nFilters === 1 && !query.q.trim()) ? (
        <span className="tl-filtercount" aria-live="polite">
          <span className="tnum">{shown} of {total}</span>
          <Button variant="link" size="sm" onClick={clearFilters}>
            clear
          </Button>
        </span>
      ) : null}
    </PageToolbar>
  );
}
