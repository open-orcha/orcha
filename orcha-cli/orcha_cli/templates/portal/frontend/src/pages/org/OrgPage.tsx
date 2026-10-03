/**
 * Org — the project's reporting lines, drawn as an org chart (roles + who
 * reports to whom). The chart is what escalations follow: an agent's untargeted
 * ask or escalation goes to its nearest manager who can act (backend
 * portal_backend/org_chart.py), before the project-wide fallback.
 *
 * URL: /org?cid=…  Data: the snapshot (`agent.reports_to`, mig 052; open tasks
 * from `tasks`) + this month's spend from the budgets API (GET
 * /api/containers/{cid}/budgets — "not metered" when unknown, never $0).
 * Edit: PUT /api/agents/{aid}/reports-to (owner or manage_agents; viewers
 * read-only, the reason shown). Three ways to edit: drag a card onto its new
 * manager (or onto the Unassigned lane to clear), the card's ⋯ → Reports to…,
 * or the detail panel's "Reports to" picker. With no reporting lines at all the
 * humans who receive escalations sit on top (display only) and a one-click,
 * confirmed "Everyone reports to <owner>" is offered.
 *
 * Pending agent suggestions are dashed "Proposed hires" cards with Approve /
 * Decline on the card — the same authorized decision Needs you makes
 * (orgActions.tsx). Agents never create agents.
 *
 * Click a card (or Enter) → the right-side detail panel (OrgPanel.tsx). Arrow
 * keys move between cards; + / − / 0 zoom and fit.
 *
 * Wide: a pannable / zoomable canvas, fit to width on load. Narrow (< 900 px, useNarrow):
 * an indented list with the same menus and panel (no drag).
 *
 * Layout adapted from Paperclip's OrgChart (MIT) — see ./orgModel.ts.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { sendJSON } from "../../api/client";
import { Icon, useToast } from "../../components/ui";
import { Avatar, EmptyState, IconButton, Menu, Skeleton, Tooltip, type MenuItemSpec } from "../../components/primitives";
import { useNarrow } from "../../hooks/useMediaQuery";
import { Shell } from "../../shell/Shell";
import { CircleIconButton, PageToolbar } from "../../shell/PageChrome";
import { useActingAuthority, useSnapshot } from "../../state/SnapshotProvider";
import type { Agent, Snapshot } from "../../types";
import { agentBudgetOf, useContainerBudgets, type AgentBudgetStatus } from "../agents/budget/budgetModel";
import { BudgetPausedChip } from "../agents/budget/AgentBudgetSection";
import { HireActions, SetupSuggestion, hireGate, hireGateFromAuth, type ApplySuggestion, type Decide, type HireGate } from "./orgActions";
import { OrgPanel, type OrgSel, type PanelEnv } from "./OrgPanel";
import { reviewLoad, reviewsTitle } from "../../lib/reviewRoute";
import {
  CARD_H, CARD_W, GHOST_H, LANE_HEAD, PAD, buildOrgForest, canReportTo, fitView, flattenForest, layoutOrg, orgStatus,
  managerCandidates, openTaskCounts, orgAuthority, reportingSuggestion, roleLine, spatialNext, spendFact, withDefaultView,
  type BudgetsLoad, type OrgAuthority, type OrgForest, type OrgGhost, type OrgLayout, type OrgSuggestion, type Placed,
} from "./orgModel";
import "./org.css";
import { agentLimitFacts } from "../../lib/agentCap";

const MIN_ZOOM = 0.35;
const MAX_ZOOM = 1.6;
const PANEL_W = 368; // the detail panel's width + gutter (the canvas keeps cards clear of it)
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

function Glyph({ d }: { d: string }) {
  return <svg className="v2-ico" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d={d} /></svg>;
}

type SetManager = (agent: Agent, managerId: string | null) => void;

/** POST the suggestion decision — the exact call Needs you makes (RequestsPage SuggestionDecision). */
export function postHireDecision(g: OrgGhost, kind: "create" | "refuse", actorId: string, reason?: string): Promise<unknown> {
  return sendJSON("POST", "/api/agent-suggestions/" + encodeURIComponent(g.requestId) + "/decide", {
    kind, reason: kind === "refuse" ? reason : undefined, actor_agent_id: actorId,
  });
}

/* ---- shared props -------------------------------------------------------------------- */

export interface OrgViewProps {
  snap: Snapshot | null;
  forest: OrgForest;
  auth: OrgAuthority;
  onSet: SetManager;
  gate?: HireGate;
  onDecide?: Decide;
  budgets?: Map<string, AgentBudgetStatus>;
  budgetsLoad?: BudgetsLoad;
  /** undefined = derive from the forest; null = none */
  suggestion?: OrgSuggestion | null;
  onApply?: ApplySuggestion;
}

interface Env extends PanelEnv {
  view: OrgForest;
  suggestion: OrgSuggestion | null;
  onApply: ApplySuggestion;
  reportCount: Map<string, number>;
}

function useEnv(p: OrgViewProps): Env {
  const { snap, forest, auth, onSet } = p;
  const suggestion = p.suggestion !== undefined ? p.suggestion : reportingSuggestion(snap, forest, auth.human?.id);
  const view = useMemo(() => withDefaultView(forest, suggestion), [forest, suggestion]);
  const openTasks = useMemo(() => openTaskCounts(snap), [snap]);
  const reportCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const mgr of forest.managerOf.values()) m.set(mgr, (m.get(mgr) ?? 0) + 1);
    return m;
  }, [forest]);
  const onDecide: Decide = p.onDecide ?? (async (g, kind, reason) => {
    if (!auth.human) throw new Error(auth.reason || "No acting human");
    await postHireDecision(g, kind, String(auth.human.id), reason);
  });
  const onApply: ApplySuggestion = p.onApply ?? (async (s) => {
    s.changes.forEach((a) => onSet(a, String(s.owner.id)));
    return { ok: s.changes.length, failed: [] };
  });
  return {
    snap, forest, auth, onSet, view, suggestion, onApply, reportCount, openTasks, onDecide,
    gate: p.gate ?? hireGateFromAuth(auth),
    budgets: p.budgets ?? new Map(),
    budgetsLoad: p.budgetsLoad ?? "loading",
  };
}

/* ---- card menu (⋯): open agent · Reports to… · clear -------------------------------- */

function CardMenu({ agent, snap, forest, auth, onSet }: {
  agent: Agent; snap: Snapshot | null; forest: OrgForest; auth: OrgAuthority; onSet: SetManager;
}) {
  const btn = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState<"actions" | "reports" | null>(null);
  const id = String(agent.id);
  const current = forest.managerOf.get(id) ?? null;
  const reason = auth.can ? undefined : auth.reason || undefined;
  const actions: (MenuItemSpec | "separator")[] = [
    ...(agent.kind === "ai" ? [{ label: "Open agent", icon: "agents", href: "/agents?agent=" + encodeURIComponent(agent.alias) }] : []),
    { label: "Reports to…", icon: "org", disabled: !auth.can, disabledReason: reason, onSelect: () => setTimeout(() => setOpen("reports"), 0) },
    ...(current ? [{ label: "Clear manager", icon: "x", disabled: !auth.can, disabledReason: reason, onSelect: () => onSet(agent, null) }] : []),
  ];
  const cands = managerCandidates(snap, forest, id);
  const reports: (MenuItemSpec | "separator")[] = [
    { label: "No manager", checked: current == null, onSelect: () => { if (current != null) onSet(agent, null); } },
    "separator",
    ...cands.map((m) => ({
      label: m.alias,
      hint: m.kind === "human" ? "Human" : roleLine(m),
      checked: String(m.id) === current,
      onSelect: () => { if (String(m.id) !== current) onSet(agent, String(m.id)); },
    })),
  ];
  return (
    <>
      <IconButton
        ref={btn} icon="more" size="sm" label={`Actions for ${agent.alias}`}
        className="org-card-more" aria-haspopup="menu" aria-expanded={open != null}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => (o ? null : "actions")); }}
        onPointerDown={(e) => e.stopPropagation()}
      />
      <Menu anchor={btn} open={open === "actions"} onClose={() => setOpen(null)} items={actions} label={`${agent.alias} actions`} placement="bottom-end" />
      <Menu anchor={btn} open={open === "reports"} onClose={() => setOpen(null)} items={reports} label={`${agent.alias} reports to`} placement="bottom-end" />
    </>
  );
}

/* ---- card facts ------------------------------------------------------------------------ */

function Kind({ a }: { a: Agent }) {
  return a.kind === "human"
    ? <span className="org-kind is-human">Human</span>
    : <span className="org-kind is-ai"><Icon name="spark" cls="org-kind-ico" />AI</span>;
}

function CardFacts({ agent, env }: { agent: Agent; env: Env }) {
  const id = String(agent.id);
  const open = env.openTasks.get(agent.alias) ?? 0;
  const reports = env.reportCount.get(id) ?? 0;
  const spend = agent.kind === "ai" ? spendFact(env.budgets.get(id), env.budgetsLoad) : null;
  const rv = reviewLoad(env.snap, id);
  return (
    <div className="org-card-meta">
      <span className="org-fact" title={`${open} open ${open === 1 ? "task" : "tasks"}`} aria-label={`${open} open ${open === 1 ? "task" : "tasks"}`}><Icon name="tasks" cls="org-fact-ico" />{open}</span>
      {spend ? <span className={"org-fact org-spend is-" + spend.tone} title={spend.title}>{spend.text}</span> : null}
      {/* mig 057: finished work follows the org chart — whose reviews this person holds */}
      {rv.covers.length || rv.pending.length ? (
        <span className={"org-fact org-reviews" + (rv.pending.length ? " has-pending" : "")} data-reviews-for={rv.covers.length} title={reviewsTitle(rv)}>
          <Icon name="check" cls="org-fact-ico" />{rv.pending.length ? `${rv.pending.length} to review` : rv.covers.length}
        </span>
      ) : null}
      <span className="org-fact" title={`${reports} direct ${reports === 1 ? "report" : "reports"}`}><Icon name="org" cls="org-fact-ico" />{reports}</span>
    </div>
  );
}

function StatusLine({ agent, gone, env }: { agent: Agent; gone: boolean; env: Env }) {
  const task = agent.kind === "ai" ? agent.current_task?.title || null : null;
  const st = orgStatus(agent, env.snap);
  // B25: a budget-paused agent says so on its card, like the roster / board / header
  const budget = agent.kind === "ai" ? env.budgets.get(String(agent.id)) : undefined;
  return (
    <div className={"org-card-status s-" + st.cls}>
      <span className="org-dot" aria-hidden="true" />
      <span className="org-card-st" title={gone ? undefined : st.title}>{gone ? "Manager retired" : st.text}</span>
      <BudgetPausedChip status={budget} />
      {task ? <span className="org-card-task" title={task}>{task}</span> : null}
    </div>
  );
}

/* ---- one agent card ---------------------------------------------------------------- */

type DragApi = { dragId: string | null; overId: string | null; start: (id: string) => void; end: () => void; over: (id: string | null) => void; drop: (managerId: string | null) => void };

function AgentCard({ agent, env, managerName, drag, style, selected, onOpen, onNav }: {
  agent: Agent; env: Env; managerName: string | null; drag: DragApi; style?: React.CSSProperties;
  selected: boolean; onOpen: () => void; onNav: (dir: "up" | "down" | "left" | "right") => void;
}) {
  const { forest, auth } = env;
  const id = String(agent.id);
  const dragging = drag.dragId === id;
  const dropOk = drag.dragId != null && drag.dragId !== id && canReportTo(forest, drag.dragId, id);
  const dropState = drag.dragId == null || drag.dragId === id ? "" : dropOk ? " is-drop-ok" : " is-drop-no";
  const over = drag.overId === id && dropOk;
  const gone = forest.managerGone.has(id);
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); return; }
    const dir = ({ ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" } as const)[e.key as "ArrowUp"];
    if (dir) { e.preventDefault(); onNav(dir); }
  };
  return (
    <div
      className={"org-card" + (dragging ? " is-dragging" : "") + dropState + (over ? " is-over" : "") + (selected ? " is-selected" : "")}
      style={style}
      data-agent={agent.alias}
      data-org-card=""
      data-org-id={id}
      tabIndex={0}
      draggable={auth.can}
      aria-label={`${agent.alias}, ${agent.kind === "human" ? "human" : "AI"}, ${roleLine(agent)}${managerName ? ", reports to " + managerName : ""}. Enter for details`}
      aria-current={selected ? "true" : undefined}
      role="group"
      onClick={onOpen}
      onKeyDown={onKeyDown}
      onDragStart={(e: ReactDragEvent) => {
        if (!auth.can) { e.preventDefault(); return; }
        e.dataTransfer.setData("text/plain", id);
        e.dataTransfer.effectAllowed = "move";
        drag.start(id);
      }}
      onDragEnd={drag.end}
      onDragOver={(e) => { if (dropOk) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (drag.overId !== id) drag.over(id); } }}
      onDragLeave={() => { if (drag.overId === id) drag.over(null); }}
      onDrop={(e) => { e.preventDefault(); if (dropOk) drag.drop(id); }}
    >
      <div className="org-card-top">
        <Avatar alias={agent.alias} kind={agent.kind} ghLogin={agent.github_login} status={agent.kind === "ai" ? agent.status : undefined} size={32} decorative />
        <div className="org-card-id">
          <div className="org-card-name"><span className="org-card-alias" title={agent.alias}>{agent.alias}</span><Kind a={agent} /></div>
          <div className="org-card-role" title={roleLine(agent)}>{roleLine(agent)}</div>
        </div>
      </div>
      <StatusLine agent={agent} gone={gone} env={env} />
      <CardFacts agent={agent} env={env} />
      <CardMenu agent={agent} snap={env.snap} forest={forest} auth={auth} onSet={env.onSet} />
    </div>
  );
}

function GhostCard({ g, env, style, selected, onOpen, onNav }: {
  g: OrgGhost; env: Env; style?: React.CSSProperties; selected: boolean; onOpen: () => void;
  onNav: (dir: "up" | "down" | "left" | "right") => void;
}) {
  const full = [g.role, g.rationale].filter(Boolean).join("\n\n");
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); return; }
    const dir = ({ ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" } as const)[e.key as "ArrowUp"];
    if (dir) { e.preventDefault(); onNav(dir); }
  };
  return (
    <div
      className={"org-card org-ghost" + (selected ? " is-selected" : "")} style={style} data-ghost={g.alias}
      data-org-card="" data-org-id={"hire:" + g.requestId} role="group" tabIndex={0}
      aria-label={`Proposed hire ${g.alias}${g.role ? ", " + g.role : ""}. Enter for the full proposal`}
      aria-current={selected ? "true" : undefined}
      onClick={onOpen} onKeyDown={onKeyDown}
      onPointerDown={(e) => e.stopPropagation()}
      title={full || undefined}
    >
      <div className="org-card-top">
        <Avatar alias={g.alias} kind="ai" size={32} decorative />
        <div className="org-card-id">
          <div className="org-card-name"><span className="org-card-alias" title={g.alias}>{g.alias}</span><span className="org-kind is-proposed">Proposed</span></div>
          <div className="org-ghost-by">Suggested by {g.proposedBy}</div>
        </div>
      </div>
      <div className="org-ghost-role">{g.role || "New agent"}</div>
      {g.rationale ? <div className="org-ghost-why">{g.rationale}</div> : null}
      <div className="org-ghost-foot">
        <HireActions g={g} gate={env.gate} onDecide={env.onDecide} limit={agentLimitFacts(env.snap)} />
      </div>
    </div>
  );
}

/* ---- selection + keyboard focus ---------------------------------------------------------- */

function useSelection(env: Env) {
  const [sel, setSel] = useState<OrgSel | null>(null);
  const lastFocus = useRef<string | null>(null);
  // a selection that no longer exists (hire decided, agent retired) closes the panel
  useEffect(() => {
    if (!sel) return;
    const alive = sel.kind === "hire"
      ? env.forest.ghosts.some((g) => g.requestId === sel.id)
      : (env.snap?.agents ?? []).some((a) => String(a.id) === sel.id);
    if (!alive) setSel(null);
  }, [sel, env.forest, env.snap]);
  const open = useCallback((s: OrgSel) => { lastFocus.current = s.kind === "hire" ? "hire:" + s.id : s.id; setSel(s); }, []);
  const close = useCallback(() => {
    setSel(null);
    const id = lastFocus.current;
    if (id) setTimeout(() => document.querySelector<HTMLElement>(`[data-org-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true }), 0);
  }, []);
  return { sel, open, close };
}

/* ---- the canvas (wide) ---------------------------------------------------------------- */

export function OrgCanvas(props: OrgViewProps) {
  const env = useEnv(props);
  const { snap, auth, onSet } = env;
  const forest = env.view; // what is drawn (with the empty-state default view)
  const vp = useRef<HTMLDivElement | null>(null);
  const [vw, setVw] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const moved = useRef(false); // the viewer zoomed / panned: stop auto-fitting
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [overLane, setOverLane] = useState(false);
  const { sel, open, close } = useSelection(env);
  // the empty-state setup banner floats over the canvas: the chart starts below it
  const setupRef = useRef<HTMLDivElement | null>(null);
  const [setupH, setSetupH] = useState(0);
  useLayoutEffect(() => {
    const el = setupRef.current;
    if (!el) { setSetupH(0); return; }
    const measure = () => setSetupH(el.offsetHeight ? el.offsetHeight + 8 : 0);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [env.suggestion != null]);
  const topInset = env.suggestion ? setupH : 0;

  useLayoutEffect(() => {
    const el = vp.current;
    if (!el) return;
    setVw(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setVw(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const layout: OrgLayout = useMemo(() => layoutOrg(forest, vw ? vw / Math.max(zoom, MIN_ZOOM) : 0), [forest, vw, zoom]);
  const byId = useMemo(() => new Map((snap?.agents ?? []).map((a) => [String(a.id), a])), [snap]);
  const ghostById = useMemo(() => new Map(forest.ghosts.map((g) => [g.requestId, g])), [forest]);
  const navItems: Placed[] = useMemo(() => [...layout.cards, ...layout.ghosts.map((p) => ({ ...p, id: "hire:" + p.id }))], [layout]);

  const fit = useCallback(() => {
    const el = vp.current;
    if (!el) return;
    // VD-04: centre the layout that actually renders (lanes wrapped to the viewport)
    const v = fitView(forest, el.clientWidth, MIN_ZOOM);
    setZoom(v.zoom);
    setPan({ x: v.panX, y: topInset });
  }, [forest, topInset]);

  // Fit on load, and again whenever the tree's size changes (an edit, a new
  // agent, a resize) — until the viewer zooms or pans themselves.
  const treeKey = useMemo(() => { const t = layoutOrg(forest, 0); return `${t.width}x${t.height}`; }, [forest]);
  useEffect(() => {
    if (!vw || moved.current) return;
    fit();
  }, [vw, treeKey, fit]);

  const zoomAt = useCallback((next: number, px: number, py: number) => {
    moved.current = true;
    setZoom((z) => {
      const nz = clampZoom(next);
      setPan((p) => ({ x: px - (px - p.x) * (nz / z), y: py - (py - p.y) * (nz / z) }));
      return nz;
    });
  }, []);

  // wheel: pan; ⌘/ctrl + wheel (or a trackpad pinch) zooms toward the pointer
  useEffect(() => {
    const el = vp.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest?.(".org-panel, .org-setup")) return; // the panel scrolls itself
      e.preventDefault();
      moved.current = true;
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect();
        setZoom((z) => {
          const nz = clampZoom(z * Math.exp(-e.deltaY * 0.01));
          const px = e.clientX - r.left, py = e.clientY - r.top;
          setPan((p) => ({ x: px - (px - p.x) * (nz / z), y: py - (py - p.y) * (nz / z) }));
          return nz;
        });
      } else {
        setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // drag the background to pan (cards keep their own drag-to-reassign)
  const panning = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // portaled menus bubble React events through here too: only the canvas's own background pans
    const t = e.target as HTMLElement;
    if (e.button !== 0 || !e.currentTarget.contains(t) || t.closest("[data-org-card], button, a, select, .org-panel, .org-setup-slot")) return;
    panning.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
    moved.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = panning.current;
    if (p) setPan({ x: p.px + e.clientX - p.x, y: p.py + e.clientY - p.y });
  };
  const onPointerUp = () => { panning.current = null; };

  const drag: DragApi = {
    dragId, overId,
    start: (id: string) => setDragId(id),
    end: () => { setDragId(null); setOverId(null); setOverLane(false); },
    over: (id: string | null) => setOverId(id),
    drop: (managerId: string | null) => {
      const a = dragId ? byId.get(dragId) : null;
      setDragId(null); setOverId(null); setOverLane(false);
      if (a && (forest.managerOf.get(String(a.id)) ?? null) !== managerId) onSet(a, managerId);
    },
  };
  const dragHasManager = dragId != null && forest.managerOf.has(dragId);
  const vpRect = vp.current;
  const centre = () => ({ x: (vpRect?.clientWidth ?? 0) / 2, y: (vpRect?.clientHeight ?? 0) / 2 });

  /** Pan just enough that a card is fully visible (clear of the panel and the setup banner). */
  const reveal = useCallback((navId: string, withPanel: boolean) => {
    const el = vp.current;
    const p = navItems.find((x) => x.id === navId);
    if (!el || !p) return;
    const h = navId.startsWith("hire:") ? GHOST_H : CARD_H;
    const right = el.clientWidth - (withPanel ? PANEL_W : 0) - 16;
    const bottom = el.clientHeight - 56; // the zoom pill
    setPan((pn) => {
      const x0 = p.x * zoom + pn.x, x1 = (p.x + CARD_W) * zoom + pn.x;
      const y0 = p.y * zoom + pn.y, y1 = (p.y + h) * zoom + pn.y;
      let dx = 0, dy = 0;
      if (x1 > right) dx = right - x1;
      if (x0 + dx < 16) dx = 16 - x0;
      if (y1 > bottom) dy = bottom - y1;
      if (y0 + dy < topInset + 8) dy = topInset + 8 - y0;
      if (!dx && !dy) return pn;
      moved.current = true;
      return { x: pn.x + dx, y: pn.y + dy };
    });
  }, [navItems, zoom, topInset]);

  const nav = (fromId: string) => (dir: "up" | "down" | "left" | "right") => {
    const to = spatialNext(navItems, fromId, dir);
    if (!to) return;
    reveal(to, !!sel);
    document.querySelector<HTMLElement>(`[data-org-id="${CSS.escape(to)}"]`)?.focus({ preventScroll: true });
  };
  const select = (s: OrgSel) => { open(s); reveal(s.kind === "hire" ? "hire:" + s.id : s.id, true); };

  // + / − / 0 on the canvas zoom and fit (not while typing in the panel)
  const onKeyDown = (e: ReactKeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (e.metaKey || e.ctrlKey || e.altKey || t.closest(".org-panel, input, textarea, select, .v2-overlay")) return;
    const c = centre();
    if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomAt(zoom * 1.2, c.x, c.y); }
    else if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomAt(zoom / 1.2, c.x, c.y); }
    else if (e.key === "0") { e.preventDefault(); moved.current = false; fit(); }
  };

  const selKey = sel ? (sel.kind === "hire" ? "hire:" + sel.id : sel.id) : null;

  return (
    <div className={"org-canvas-wrap" + (sel ? " has-panel" : "")} onKeyDown={onKeyDown}>
      <div
        ref={vp} className={"org-viewport" + (panning.current ? " is-panning" : "")}
        data-testid="org-viewport"
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      >
        {env.suggestion ? <div className="org-setup-slot" ref={setupRef}><SetupSuggestion s={env.suggestion} auth={auth} onApply={env.onApply} /></div> : null}
        <div className="org-zoom" role="group" aria-label="Zoom">
          <CircleIconButton glyph={<Glyph d="M5 10h10" />} label="Zoom out" onClick={() => { const c = centre(); zoomAt(zoom / 1.2, c.x, c.y); }} />
          <span className="org-zoom-pct" aria-live="polite">{Math.round(zoom * 100)}%</span>
          <CircleIconButton glyph={<Glyph d="M10 5v10M5 10h10" />} label="Zoom in" onClick={() => { const c = centre(); zoomAt(zoom * 1.2, c.x, c.y); }} />
          <CircleIconButton icon="maximize" label="Fit to width" onClick={() => { moved.current = false; fit(); }} />
        </div>
        <div className="org-stage" style={{ width: layout.width, height: layout.height, transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
          {!forest.roots.length ? (
            <p className="org-empty-tree" style={{ left: PAD, top: PAD - 4 }}>No reporting lines yet{auth.can ? " — drag an agent onto its manager, or use ⋯ → Reports to…" : "."}</p>
          ) : null}
          <svg className="org-edges" width={layout.width} height={layout.height} aria-hidden="true">
            {layout.edges.map((e) => (
              <path
                key={e.from + ">" + e.to} d={e.d} className={e.preview ? "is-preview" : undefined}
                data-edge={`${byId.get(e.from)?.alias}>${byId.get(e.to)?.alias}`} data-preview={e.preview ? "" : undefined}
              />
            ))}
          </svg>
          {layout.lanes.map((l) => {
            const unassigned = l.key === "unassigned";
            const dropClear = unassigned && dragHasManager;
            return (
              <div
                key={l.key}
                className={"org-lane" + (unassigned ? "" : " is-ghosts") + (dropClear ? " is-drop-ok" : "") + (dropClear && overLane ? " is-over" : "")}
                style={{ left: l.x - 12, top: l.y - 8, width: l.w + 24, height: l.h + 20 }}
                onDragOver={(e) => { if (dropClear) { e.preventDefault(); setOverLane(true); } }}
                onDragLeave={() => setOverLane(false)}
                onDrop={(e) => { e.preventDefault(); if (dropClear) drag.drop(null); }}
              >
                <div className="org-lane-head" style={{ height: LANE_HEAD }}>
                  <span className="org-lane-title">{unassigned ? "Unassigned" : "Proposed hires"}</span>
                  <span className="org-lane-count">{l.count}</span>
                  <span className="org-lane-hint">
                    {unassigned
                      ? (dropClear ? "Drop here to clear the manager" : "No manager and no reports")
                      : "Agents can't create agents — a human approves or declines"}
                  </span>
                </div>
              </div>
            );
          })}
          {layout.cards.map((p) => {
            const a = byId.get(p.id);
            if (!a) return null;
            const m = forest.managerOf.get(p.id);
            return (
              <AgentCard
                key={p.id} agent={a} env={env}
                managerName={m ? byId.get(m)?.alias ?? null : null} drag={drag}
                style={{ left: p.x, top: p.y, width: CARD_W, height: CARD_H }}
                selected={selKey === p.id}
                onOpen={() => select({ kind: "agent", id: p.id })}
                onNav={nav(p.id)}
              />
            );
          })}
          {layout.ghosts.map((p) => {
            const g = ghostById.get(p.id);
            return g ? (
              <GhostCard
                key={p.id} g={g} env={env} style={{ left: p.x, top: p.y, width: CARD_W, height: GHOST_H }}
                selected={selKey === "hire:" + p.id}
                onOpen={() => select({ kind: "hire", id: p.id })}
                onNav={nav("hire:" + p.id)}
              />
            ) : null;
          })}
        </div>
      </div>
      {sel ? <OrgPanel env={env} sel={sel} onSelect={select} onClose={close} /> : null}
    </div>
  );
}

/* ---- the indented list (narrow) -------------------------------------------------------- */

export function OrgList(props: OrgViewProps) {
  const env = useEnv(props);
  const { snap, auth, onSet } = env;
  const forest = env.view;
  const { sel, open, close } = useSelection(env);
  const rows = flattenForest(forest);
  const row = (a: Agent, depth: number) => {
    const id = String(a.id);
    const preview = forest.preview?.has(id);
    const task = a.kind === "ai" ? a.current_task?.title : null;
    return (
      <li key={a.id} className={"org-li" + (preview ? " is-preview" : "")} style={{ paddingLeft: 12 + depth * 16 }} data-agent={a.alias} data-depth={depth}>
        {depth > 0 ? <span className="org-li-guide" style={{ left: 12 + (depth - 1) * 16 + 11 }} aria-hidden="true" /> : null}
        <button type="button" className="org-li-main" data-org-id={id} onClick={() => open({ kind: "agent", id })} aria-label={`${a.alias}, ${roleLine(a)} — details`}>
          <Avatar alias={a.alias} kind={a.kind} ghLogin={a.github_login} status={a.kind === "ai" ? a.status : undefined} size={24} decorative />
          <span className="org-li-body">
            <span className="org-li-name">
              <span className="org-li-alias">{a.alias}</span>
              <span className="org-li-role">{roleLine(a)}</span>
              {preview ? <span className="org-kind is-proposed">Suggested</span> : null}
            </span>
            <span className="org-li-work">
              {orgStatus(a, snap).text}{env.budgets.get(id)?.paused ? " · Budget paused" : null}{task ? <> · {task}</> : null}
              {" · "}{env.openTasks.get(a.alias) ?? 0} open
            </span>
          </span>
        </button>
        <CardMenu agent={a} snap={snap} forest={forest} auth={auth} onSet={onSet} />
      </li>
    );
  };
  return (
    <div className="org-list" data-testid="org-list">
      {env.suggestion ? <SetupSuggestion s={env.suggestion} auth={auth} onApply={env.onApply} compact /> : null}
      {rows.length ? <ul className="org-ul" aria-label="Reporting lines">{rows.map((r) => row(r.agent, r.depth))}</ul> : null}
      {forest.unassigned.length ? (
        <section aria-label="Unassigned">
          <h3 className="org-list-h">Unassigned <span className="org-lane-count">{forest.unassigned.length}</span></h3>
          <ul className="org-ul">{forest.unassigned.map((a) => row(a, 0))}</ul>
        </section>
      ) : null}
      {forest.ghosts.length ? (
        <section aria-label="Proposed hires">
          <h3 className="org-list-h">Proposed hires <span className="org-lane-count">{forest.ghosts.length}</span></h3>
          <ul className="org-ul">
            {forest.ghosts.map((g) => (
              <li key={g.requestId} className="org-li org-li-ghost" data-ghost={g.alias}>
                <button type="button" className="org-li-main" data-org-id={"hire:" + g.requestId} onClick={() => open({ kind: "hire", id: g.requestId })} aria-label={`Proposed hire ${g.alias} — full proposal`}>
                  <Avatar alias={g.alias} kind="ai" size={24} decorative />
                  <span className="org-li-body">
                    <span className="org-li-name"><span className="org-li-alias">{g.alias}</span><span className="org-kind is-proposed">Proposed</span></span>
                    <span className="org-ghost-role">{g.role || "New agent"}</span>
                    {g.rationale ? <span className="org-ghost-why">{g.rationale}</span> : null}
                    <span className="org-ghost-by">Suggested by {g.proposedBy}</span>
                  </span>
                </button>
                <HireActions g={g} gate={env.gate} onDecide={env.onDecide} limit={agentLimitFacts(env.snap)} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {sel ? <div className="org-sheet" onClick={(e) => { if (e.target === e.currentTarget) close(); }}><OrgPanel env={env} sel={sel} onSelect={open} onClose={close} /></div> : null}
    </div>
  );
}

/* ---- page -------------------------------------------------------------------------- */

export function OrgPage() {
  const { snap, identity, refresh, cid } = useSnapshot();
  const authority = useActingAuthority();
  const auth = orgAuthority(authority, identity);
  const gate = hireGate(snap, identity, authority);
  const narrow = useNarrow();
  const toast = useToast();
  const [overrides, setOverrides] = useState<Record<string, string | null>>({});
  const forest = useMemo(() => buildOrgForest(snap, overrides), [snap, overrides]);
  const suggestion = useMemo(() => reportingSuggestion(snap, forest, auth.human?.id), [snap, forest, auth.human?.id]);

  // this month's spend per agent (budgets API; refreshed every 60 s, not on the 3 s tick)
  const projectId = snap?.container?.id ?? cid ?? null;
  const budgetsQ = useContainerBudgets(projectId);
  const budgetsLoad: BudgetsLoad = budgetsQ.unsupported || budgetsQ.error ? "unsupported" : budgetsQ.data ? "ready" : "loading";
  const budgets = useMemo(() => {
    const m = new Map<string, AgentBudgetStatus>();
    for (const a of snap?.agents ?? []) { const b = agentBudgetOf(budgetsQ.data, String(a.id)); if (b) m.set(String(a.id), b); }
    return m;
  }, [snap, budgetsQ.data]);

  // an override is dropped as soon as the snapshot agrees with it
  useEffect(() => {
    if (!snap) return;
    setOverrides((o) => {
      const keys = Object.keys(o);
      if (!keys.length) return o;
      const next = { ...o };
      for (const k of keys) {
        const a = snap.agents.find((x) => String(x.id) === k);
        if (!a || (a.reports_to ?? null) === o[k]) delete next[k];
      }
      return Object.keys(next).length === keys.length ? o : next;
    });
  }, [snap]);

  const onSet: SetManager = useCallback((agent, managerId) => {
    if (!auth.can || !auth.human) { toast(auth.reason || "You can't change reporting lines", "warn"); return; }
    const id = String(agent.id);
    const mgr = managerId ? snap?.agents.find((a) => String(a.id) === managerId) : null;
    setOverrides((o) => ({ ...o, [id]: managerId }));
    sendJSON("PUT", `/api/agents/${encodeURIComponent(id)}/reports-to`, { reports_to_agent_id: managerId, actor_agent_id: auth.human.id })
      .then(() => { toast(mgr ? `${agent.alias} now reports to ${mgr.alias}` : `${agent.alias} has no manager`, "ok"); return refresh(); })
      .catch((e: Error) => {
        setOverrides((o) => { const n = { ...o }; delete n[id]; return n; });
        const detail = (e.message || "").split(": ").slice(1).join(": ");
        toast("Couldn't change the manager" + (detail ? " — " + detail : ""), "danger", { sticky: true });
      });
  }, [auth.can, auth.human, auth.reason, snap, refresh, toast]);

  /** "Everyone reports to <owner>": one authorized PUT per change, after the human confirmed. */
  const onApply: ApplySuggestion = useCallback(async (s) => {
    if (!auth.can || !auth.human) throw new Error(auth.reason || "You can't change reporting lines");
    const actor = auth.human.id;
    const owner = String(s.owner.id);
    const failed: { alias: string; message: string }[] = [];
    let ok = 0;
    for (const a of s.changes) {
      const id = String(a.id);
      setOverrides((o) => ({ ...o, [id]: owner }));
      try {
        await sendJSON("PUT", `/api/agents/${encodeURIComponent(id)}/reports-to`, { reports_to_agent_id: owner, actor_agent_id: actor });
        ok++;
      } catch (e) {
        setOverrides((o) => { const n = { ...o }; delete n[id]; return n; });
        const detail = ((e as Error).message || "").split(": ").slice(1).join(": ");
        failed.push({ alias: a.alias, message: detail || "Not saved" });
      }
    }
    if (ok) toast(`${ok} ${ok === 1 ? "agent now reports" : "agents now report"} to ${s.owner.alias}` + (failed.length ? ` · ${failed.length} not saved` : ""), failed.length ? "warn" : "ok");
    void refresh();
    return { ok, failed };
  }, [auth.can, auth.human, auth.reason, refresh, toast]);

  const onDecide: Decide = useCallback(async (g, kind, reason) => {
    if (!authority.human) throw new Error(authority.reason || "No acting human");
    await postHireDecision(g, kind, String(authority.human.id), reason);
    toast(kind === "create" ? `Agent ${g.alias} created` : "Suggestion refused", "ok");
    void refresh();
  }, [authority.human, authority.reason, refresh, toast]);

  const people = snap?.agents.length ?? 0;
  const toolbar = (
    <PageToolbar
      label="Org chart"
      end={auth.can || auth.pending ? null : (
        <Tooltip label={auth.reason || "View only"}>
          <span className="org-viewonly" tabIndex={0} aria-label={"View only — " + (auth.reason || "")}><Icon name="eye" cls="v2-ico" />View only</span>
        </Tooltip>
      )}
    >
      <span className="org-summary">
        {snap ? <>{people} {people === 1 ? "person" : "people"} · {forest.lines} reporting {forest.lines === 1 ? "line" : "lines"}{forest.ghosts.length ? <> · {forest.ghosts.length} proposed {forest.ghosts.length === 1 ? "hire" : "hires"}</> : null}</> : null}
      </span>
      {snap && auth.can && !narrow ? <span className="org-hint">Drag a card onto its manager</span> : null}
    </PageToolbar>
  );

  const viewProps: OrgViewProps = { snap, forest, auth, onSet, gate, onDecide, budgets, budgetsLoad, suggestion, onApply };
  let body;
  if (!snap) body = <div className="v2-content"><Skeleton lines={6} label="Loading org chart" /></div>;
  else if (!snap.agents.length) body = <EmptyState title="No one here yet" body="Agents and members appear here once they join the project." />;
  else if (narrow) body = <OrgList {...viewProps} />;
  else body = <OrgCanvas {...viewProps} />;

  return (
    <Shell page="org" title="Org" toolbar={toolbar} flush>
      {body}
    </Shell>
  );
}
