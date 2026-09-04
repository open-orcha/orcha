/**
 * The app shell — React port of app.js mountShell + SPEC-1 autonomy switch +
 * SPEC-3 notification center + theme cycling (GH #239 resolved-theme rule).
 * Emits the same class names styles.css already styles. Page routes are hash
 * links (/tasks?task=…) so the SPA serves from one static HTML file with the
 * FastAPI backend untouched.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { sendJSON, getJSON } from "../api/client";
import { relTime, trunc, esc } from "../lib/format";
import { ensureCidInLocation } from "../lib/scope";
import {
  actingHuman,
  actingIdentityHuman,
  attnCardCounts,
  attnItems,
  autLevel,
  navCounts,
  planMessageOf,
  useSnapshot,
} from "../state/SnapshotProvider";
import { Avatar, Icon, Modal, OrcaMark, useToast } from "../components/ui";
import { extensions } from "../extensions";

/* ---- theme (GH #239: cycle from the RESOLVED theme) ---------------------- */
function applyTheme(t: string) {
  document.documentElement.setAttribute("data-theme", t);
  try { localStorage.setItem("orcha:theme", t); } catch { /* private mode */ }
}
function currentTheme(): string {
  try { return localStorage.getItem("orcha:theme") || "auto"; } catch { return "auto"; }
}
function resolvedTheme(): string {
  const t = currentTheme();
  if (t === "dark" || t === "light") return t;
  try { return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"; } catch { return "dark"; }
}
export function initTheme() { applyTheme(currentTheme()); }

/* ---- collapsible sidebar (icon rail) --------------------------------- *
 * Port of the cloud vanilla contract (app-shell.js sidebarCollapsed/
 * toggleSidebar + shell.css): browser-local, persisted in localStorage
 * "orcha:sidebar" ("collapsed" | "expanded"), applied as data-sidebar=
 * "collapsed" on <html> — same key/attribute so cloud's shell.css collapse
 * rules (if any) keep applying unmodified. index.html sets the attribute
 * pre-paint from the same key; the initial useState below reads it too so
 * React's first render already agrees with the DOM (no flash either way). */
const SIDEBAR_KEY = "orcha:sidebar";
function sidebarCollapsed(): boolean {
  try { return localStorage.getItem(SIDEBAR_KEY) === "collapsed"; } catch { return false; }
}
function setSidebarCollapsed(collapsed: boolean) {
  try { localStorage.setItem(SIDEBAR_KEY, collapsed ? "collapsed" : "expanded"); } catch { /* private mode */ }
  const d = document.documentElement;
  if (collapsed) d.setAttribute("data-sidebar", "collapsed");
  else d.removeAttribute("data-sidebar");
}

/* ---- GH #148/#149: two orthogonal topbar controls ------------------------
 * NOT one fused 4-rung slider. NOTIFIER is the LIVE binary kill-switch
 * (containers.wakes_enabled via POST /api/containers/{cid}/wakes) — Paused
 * (red) vs Running (green), "does anything wake at all?". AUTONOMY is the
 * 3-level engine gearbox (containers.autonomy_level via POST
 * /api/containers/{cid}/autonomy, level ∈ plan|pr|full) — "how far may an
 * agent go once it acts?". They are orthogonal: pausing the notifier does
 * NOT change the level, so Autonomy keeps rendering (dimmed, still editable)
 * while paused, and setting the level never touches wakes_enabled. Labels,
 * tooltips, endpoints and payloads mirror the vanilla split
 * (app-autonomy.js / app-shell.js). */
const AUT_LEVELS = [
  { level: "plan", tone: "warn", label: "Plan-only",
    meaning: "Agents wake & propose, but every plan stops at the approval gate — you approve before any execution.",
    impact: "Agents resume and propose plans, but you approve every plan before any execution." },
  { level: "pr", tone: "info", label: "Build to PR",
    meaning: "Agents execute approved plans up to an open PR; you still merge.",
    impact: "Agents execute approved plans up to an open PR. You still merge." },
  { level: "full", tone: "accent", label: "Full",
    meaning: "Agents may carry approved work to its configured terminal state without further gates.",
    impact: "Agents may carry approved work to completion without further gates." },
] as const;

interface PendingAut { title: string; desc: string; primary: string; danger?: boolean; run: () => void }

function useAutonomyActions() {
  const { snap, refresh } = useSnapshot();
  const toast = useToast();
  const who = actingHuman(snap);

  const setWakes = async (enabled: boolean) => {
    const cid = snap?.container?.id;
    if (!cid) { toast("No container", "danger"); return; }
    try {
      const res = await sendJSON<{ wakes_enabled: boolean }>("POST", `/api/containers/${encodeURIComponent(cid)}/wakes`, {
        enabled, actor_agent_id: who ? who.id : null,
      });
      toast(res.wakes_enabled ? "Notifier · Running" : "Notifier · Paused", res.wakes_enabled ? "ok" : "");
      void refresh();
    } catch (e) {
      toast("Could not change the notifier: " + (e instanceof Error ? e.message : e), "danger");
    }
  };
  const setLevel = async (lvl: string, label: string) => {
    const cid = snap?.container?.id;
    if (!cid) { toast("No container", "danger"); return; }
    try {
      await sendJSON("POST", `/api/containers/${encodeURIComponent(cid)}/autonomy`, {
        level: lvl, actor_agent_id: who ? who.id : null,
      });
      toast("Autonomy · " + label, "ok");
      void refresh();
    } catch (e) {
      toast("Could not change autonomy: " + (e instanceof Error ? e.message : e), "danger");
    }
  };

  return { snap, who, setWakes, setLevel };
}

/* NOTIFIER (#notifTop): the live binary kill-switch. Always lit — Paused
 * (red) or Running (green). Running→Paused is destructive (halts all
 * wakes): danger confirm. Paused→Running is safe: light confirm. */
function NotifierSwitch() {
  const { snap, who, setWakes } = useAutonomyActions();
  const toast = useToast();
  const [pending, setPending] = useState<PendingAut | null>(null);
  const paused = !!(snap?.container && (snap.container as { wakes_enabled?: boolean }).wakes_enabled === false);
  const canAct = !!who;

  const click = () => {
    if (!canAct) { toast("Pick an acting human to change the notifier", "warn"); return; }
    setPending(paused
      ? { title: "Resume agent wakes?", desc: "Agents resume waking at the current autonomy level.", primary: "Resume", run: () => void setWakes(true) }
      : { title: "Pause all agent wakes?", desc: "Agents stop waking immediately. In-flight work finishes; nothing new starts. Humans & live terminals still work.", primary: "Pause all wakes", danger: true, run: () => void setWakes(false) });
  };

  const cls = paused ? "seg paused on" : "seg run on";
  const lab = paused ? "Paused" : "Running";
  const tip = canAct
    ? (paused ? "Notifier is OFF — click to resume all agent wakes" : "Notifier is ON — click to pause all agent wakes")
    : "Pick an acting human to change the notifier";

  return (
    <>
      <div className="ctl-group" id="notifGroup">
        <span className="aut-lab">Notifier</span>
        <div className={"aut notif" + (canAct ? "" : " locked")} id="notifTop" role="group" aria-label="Event notifier — pause or resume all agent wakes">
          <span className={cls} role="switch" aria-checked={!paused} title={tip} onClick={click}>
            <span className="d" />{lab}
          </span>
        </div>
      </div>
      {pending && (
        <Modal
          title={pending.title}
          desc={pending.desc}
          danger={pending.danger}
          primary={pending.primary}
          onPrimary={() => { const p = pending; setPending(null); p.run(); }}
          onClose={() => setPending(null)}
        />
      )}
    </>
  );
}

/* AUTONOMY (#autTop): the 3-level segmented selector (plan|pr|full). The
 * active level lights in its spec tone; orthogonal to the notifier — it
 * renders the same whether Running or Paused, just dimmed (still editable)
 * while paused so you can pre-set it before resuming. */
function AutonomyLevels() {
  const { snap, who, setLevel } = useAutonomyActions();
  const toast = useToast();
  const [pending, setPending] = useState<PendingAut | null>(null);
  const paused = !!(snap?.container && (snap.container as { wakes_enabled?: boolean }).wakes_enabled === false);
  const level = autLevel(snap);
  const canAct = !!who;

  const click = (lvl: string) => {
    if (!canAct) { toast("Pick an acting human to change autonomy", "warn"); return; }
    const rg = AUT_LEVELS.find((x) => x.level === lvl);
    if (!rg || rg.level === level) return;
    setPending({
      title: `Set autonomy to ${rg.label}?`, desc: rg.impact, primary: `Set ${rg.label}`,
      danger: rg.level === "full",
      run: () => void setLevel(rg.level, rg.label),
    });
  };

  return (
    <>
      <div className="ctl-group" id="autGroup">
        <span className="aut-lab">Autonomy</span>
        <div className={"aut" + (canAct ? "" : " locked") + (paused ? " dimmed" : "")} id="autTop" role="radiogroup" aria-label="Container autonomy level">
          {AUT_LEVELS.map((rg) => {
            const active = rg.level === level;
            const cls = "seg lvl " + rg.tone + (active ? " on" : "");
            const tip = canAct
              ? (active ? "Current autonomy: " + rg.label + (paused ? " — applies when running" : "") : `Set autonomy to ${rg.label} — ${rg.meaning}`)
              : "Pick an acting human to change autonomy";
            return (
              <span key={rg.level} className={cls} role="radio" aria-checked={active} title={tip} onClick={() => click(rg.level)}>
                <span className="d" />{rg.label}
              </span>
            );
          })}
        </div>
      </div>
      {pending && (
        <Modal
          title={pending.title}
          desc={pending.desc}
          danger={pending.danger}
          primary={pending.primary}
          onPrimary={() => { const p = pending; setPending(null); p.run(); }}
          onClose={() => setPending(null)}
        />
      )}
    </>
  );
}

function AutonomyControls() {
  return (
    <div className="ctl-wrap" id="ctlWrap">
      <NotifierSwitch />
      <span className="ctl-div" aria-hidden="true" />
      <AutonomyLevels />
    </div>
  );
}

/* ---- SPEC-3 notification center ------------------------------------------ */
const NC_PAGE = 20;
const NC_VIS: Record<string, { icon: string | null; col: string }> = {
  task_verified: { icon: "check", col: "violet" },
  request_answered: { icon: "arrow", col: "info" },
  plan_decided: { icon: "shield", col: "violet" },
  task_assigned: { icon: "tasks", col: "info" },
  task_ready: { icon: "tasks", col: "info" },
  task_message: { icon: "requests", col: "info" },
  task_unassigned: { icon: "x", col: "idle" },
  request_closed: { icon: "check", col: "idle" },
};
const NC_LABEL: Record<string, string> = {
  task_verified: "Task verified", request_answered: "Request answered",
  plan_decided: "Decision made", task_assigned: "Task assigned",
  task_ready: "Task ready", task_message: "Task update",
  task_unassigned: "Task unassigned", request_closed: "Request closed",
};
const ncHumanize = (s: string) => String(s || "notification").replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

interface NcRegRow { type: string; preview?: string; actor_alias?: string; ts?: number; read?: boolean; deeplink?: { kind?: string; id?: string } }
interface NcRow { icon: string | null; col: string; unread?: boolean; ti: string; me: string; when: string | number | null; href: string | null }

function ncDeeplinkHref(d?: { kind?: string; id?: string }): string | null {
  if (!d || !d.id) return null;
  if (d.kind === "task") return "/tasks?task=" + encodeURIComponent(d.id);
  if (d.kind === "request") return "/requests?req=" + encodeURIComponent(d.id);
  return null;
}

function NcRowView({ r }: { r: NcRow }) {
  const when = r.when != null ? relTime(typeof r.when === "number" ? new Date(r.when).toISOString() : r.when) : "";
  const inner = (
    <>
      <span className={"ic c-" + r.col}>{r.icon ? <Icon name={r.icon} cls="" /> : <span className="ncdot" />}</span>
      <div className="b">
        <div className="ti">{r.ti}</div>
        <div className="me">
          {r.me ? (<>{r.me}<span>·</span></>) : null}
          <span className="when">{when}</span>
        </div>
      </div>
      {r.href ? <span className="go"><Icon name="chev" cls="" /></span> : null}
    </>
  );
  const cls = "nrow" + (r.unread ? " unread" : "");
  return r.href ? <a className={cls} href={r.href}>{inner}</a> : <div className={cls}>{inner}</div>;
}

function NotificationCenter({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { snap, bump } = useSnapshot();
  const toast = useToast();
  const [feed, setFeed] = useState<{ rows: NcRegRow[]; more: boolean; loaded: boolean; loading: boolean; beforeTs: number | null; beforeId: string | null }>({
    rows: [], more: false, loaded: false, loading: false, beforeTs: null, beforeId: null,
  });
  const who = actingHuman(snap);
  const whoId = who?.id ?? null;
  const boxRef = useRef<HTMLDivElement | null>(null);

  const load = async (reset: boolean) => {
    if (!whoId) return;
    setFeed((f) => ({ ...f, loading: true }));
    let url = `/api/agents/${encodeURIComponent(whoId)}/notifications?zone=earlier&limit=${NC_PAGE}`;
    if (!reset && feed.beforeTs != null) {
      url += "&before_ts=" + encodeURIComponent(feed.beforeTs);
      if (feed.beforeId != null) url += "&before_id=" + encodeURIComponent(feed.beforeId);
    }
    try {
      const res = await getJSON<{ notifications?: NcRegRow[]; next_before_ts?: number | null; next_before_id?: string | null }>(url);
      const rows = res.notifications || [];
      setFeed((f) => ({
        rows: reset ? rows : f.rows.concat(rows),
        beforeTs: res.next_before_ts ?? null,
        beforeId: res.next_before_id ?? null,
        more: res.next_before_ts != null,
        loaded: true, loading: false,
      }));
    } catch (e) {
      setFeed((f) => ({ ...f, loading: false, loaded: true }));
      toast("Could not load notifications: " + (e instanceof Error ? e.message : e), "danger");
    }
  };

  useEffect(() => {
    if (open) void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, whoId]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (boxRef.current && !boxRef.current.contains(t) && !(t instanceof Element && t.closest("#attnPill"))) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("click", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("click", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open, onClose]);

  const markAllRead = async () => {
    if (!whoId) return;
    setFeed((f) => ({ ...f, rows: f.rows.map((n) => ({ ...n, read: true })) }));
    try {
      await sendJSON("POST", `/api/agents/${encodeURIComponent(whoId)}/notifications/read`, {});
    } catch (e) {
      toast("Could not mark read: " + (e instanceof Error ? e.message : e), "danger");
    }
  };

  // NEEDS-YOU zone recomputes from the snapshot each poll (`bump` dependency keeps it live).
  void bump;
  const a = attnItems(snap);
  const needs: NcRow[] = [
    ...a.plans.map((t) => {
      const pm = planMessageOf(t);
      return { icon: "shield", col: "warn", ti: "Plan approval · " + (t.title || t.id), me: t.assignee || "—", when: (pm && pm.at) || t.started_at, href: "/tasks?task=" + encodeURIComponent(t.id) };
    }),
    ...a.verifs.map((t) => ({ icon: "check", col: "warn", ti: "Verify task · " + (t.title || t.id), me: t.assignee || "—", when: t.started_at, href: "/tasks?task=" + encodeURIComponent(t.id) })),
    ...a.escs.map((r) => ({ icon: "flag", col: "danger", ti: "Escalation · " + trunc(String(r.payload ?? ""), 52), me: (r.from || "—") + " → you", when: r.created_at, href: "/requests?req=" + encodeURIComponent(r.id) })),
  ];
  const earlier: NcRow[] = feed.rows.map((n) => {
    const vis = NC_VIS[n.type] || { icon: null, col: "idle" };
    const label = NC_LABEL[n.type] || ncHumanize(n.type);
    return {
      icon: vis.icon, col: vis.col, unread: !n.read,
      ti: n.preview ? label + " · " + trunc(n.preview, 52) : label,
      me: n.actor_alias || "", when: n.ts != null ? n.ts * 1000 : null,
      href: ncDeeplinkHref(n.deeplink),
    };
  });

  return (
    <div ref={boxRef} id="ncFloat" className={"ncenter float" + (open ? " show" : "")}>
      <div className="nc-h">
        <h3>Notifications</h3>
        <span className="mark" onClick={(e) => { e.preventDefault(); e.stopPropagation(); void markAllRead(); }}>Mark all read</span>
      </div>
      <div className="nc-zlbl needs">● Needs you <span className="ct">({needs.length})</span></div>
      <div className="nc-list">
        {needs.length ? needs.map((r, i) => <NcRowView key={i} r={r} />) : <div className="nc-empty">✓ You&#39;re all caught up.</div>}
      </div>
      <div className="nc-zlbl">Earlier</div>
      <div className="nc-list">
        {!who ? (
          <div className="nc-empty">Pick an acting human to see your activity feed.</div>
        ) : !feed.loaded && feed.loading ? (
          <div className="nc-empty">Loading…</div>
        ) : !earlier.length ? (
          <div className="nc-empty">Nothing earlier.</div>
        ) : (
          earlier.map((r, i) => <NcRowView key={i} r={r} />)
        )}
      </div>
      {feed.more && (
        <div className="nc-foot" onClick={(e) => { e.preventDefault(); e.stopPropagation(); void load(false); }}>… Load earlier</div>
      )}
    </div>
  );
}

/* ---- acting-as chip (+ downstream account menu) --------------------------
 * Open default: extensions.accountMenu is unset (or returns []) and the chip
 * renders exactly as before — a passive label. When a downstream registers
 * accountMenu, the chip becomes a dropdown trigger with the notification-
 * center interaction pattern (outside-click + Escape close). Markup stays
 * classless-safe: inline styles over existing CSS custom properties only
 * (styles.css has no menu/pmenu class to reuse).
 */
const ACCT_MENU_STYLE: CSSProperties = {
  position: "absolute", right: 0, top: "calc(100% + 6px)", minWidth: 190, zIndex: 80,
  background: "var(--raised)", border: "1px solid var(--border)", borderRadius: 10,
  boxShadow: "var(--shadow)", padding: 6, display: "flex", flexDirection: "column",
};
const acctItemStyle = (danger?: boolean): CSSProperties => ({
  display: "block", width: "100%", textAlign: "left", padding: "7px 10px",
  borderRadius: 7, background: "none", border: "none", font: "inherit",
  fontSize: "12.5px", fontWeight: 500, cursor: "pointer", textDecoration: "none",
  color: danger ? "var(--danger)" : "var(--text)",
});

function ActingChip() {
  const { snap, identity } = useSnapshot();
  const who = actingIdentityHuman(snap, identity);
  const items = extensions.accountMenu ? extensions.accountMenu(identity) : [];
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("click", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("click", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  // non-member viewers (who === null) still see their own signed-in identity
  // on the chip so the account menu stays reachable.
  const label = who ? who.alias : identity ? identity.alias || identity.github_login || "account" : null;
  const ghLogin = who ? who.github_login : identity?.github_login;
  const whoSpan = (
    <span className="who" id="actingWho">
      {label
        ? (<><Avatar alias={label} kind="human" size="sm" ghLogin={ghLogin} />{label}</>)
        : <span className="muted">no human registered</span>}
    </span>
  );

  if (!items.length) {
    return (
      <div className="acting" title="You are the human authority on this container">
        <span className="lbl">acting as</span>
        {whoSpan}
      </div>
    );
  }
  return (
    <div ref={boxRef} style={{ position: "relative" }}>
      <div
        className="acting" role="button" tabIndex={0} title="Account"
        aria-haspopup="menu" aria-expanded={open} style={{ cursor: "pointer" }}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((v) => !v); } }}
      >
        <span className="lbl">acting as</span>
        {whoSpan}
        <Icon name="chev" cls="" />
      </div>
      {open && (
        <div role="menu" aria-label="Account" style={ACCT_MENU_STYLE}>
          {items.map((it, i) =>
            it.href ? (
              <a key={i} role="menuitem" href={it.href} style={acctItemStyle(it.danger)} onClick={() => setOpen(false)}>
                {it.label}
              </a>
            ) : (
              <button
                key={i} role="menuitem" type="button" style={acctItemStyle(it.danger)}
                onClick={() => { setOpen(false); it.onClick?.(); }}
              >
                {it.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/* ---- the shell ----------------------------------------------------------- */
export function Shell({ page, title, ctx, children }: { page: string; title: string; ctx?: ReactNode; children: ReactNode }) {
  const { snap, cid, multi } = useSnapshot();
  const toast = useToast();
  const location = useLocation();
  const [ncOpen, setNcOpen] = useState(false);
  const [, setThemeTick] = useState(0);
  const [collapsed, setCollapsed] = useState(sidebarCollapsed);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const toggleSidebar = () => {
    const next = !collapsed;
    setSidebarCollapsed(next);
    setCollapsed(next);
  };

  // Sync <html data-sidebar> from the persisted key on mount — normally a
  // no-op (index.html's inline pre-paint script already set it before React
  // ran), but keeps the DOM correct wherever that script didn't run first.
  useEffect(() => { setSidebarCollapsed(collapsed); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setNcOpen(false); }, [location.pathname]);

  // FEATURE 3: SPA <Link> navigations bypass the DOM-href interceptor (react-
  // router navigates from the `to` prop), so re-pin ?cid= after every route
  // change on multi-container stacks. No-op on single-container open stacks.
  useEffect(() => { ensureCidInLocation({ cid, multi }); }, [location, cid, multi]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ae = document.activeElement as HTMLElement | null;
      const editing = !!ae && (ae.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName || ""));
      if (e.key === "/" && !editing) { e.preventDefault(); searchRef.current?.focus(); }
      if (e.key === "Escape") searchRef.current?.blur();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const a = attnItems(snap);
  const agents = snap?.agents ?? [];
  const counts = navCounts(snap); // authoritative totals when present (GH count-mismatch fix)
  const attnN = attnCardCounts(snap, a);
  const paused = !!(snap?.container && (snap.container as { wakes_enabled?: boolean }).wakes_enabled === false);

  const nv = [
    { key: "home", href: "/", ico: "home", label: "Dashboard", count: null as number | null, attn: false },
    { key: "agents", href: "/agents", ico: "agents", label: "Agents", count: agents.length, attn: false },
    { key: "tasks", href: "/tasks", ico: "tasks", label: "Tasks", count: counts.tasks, attn: true },
    { key: "requests", href: "/requests", ico: "requests", label: "Requests", count: counts.requests, attn: false },
    // downstream pages (src/extensions.ts) slot between Requests and Settings
    ...extensions.nav.map((n) => ({ key: n.key, href: n.href, ico: n.ico, label: n.label, count: n.count ? n.count(snap) : null, attn: !!n.attn })),
    { key: "settings", href: "/settings", ico: "sliders", label: "Settings", count: null, attn: false },
  ];

  const cycle = () => {
    const next = resolvedTheme() === "dark" ? "light" : "dark";
    applyTheme(next);
    toast("Theme · " + next, "ok");
    setThemeTick((n) => n + 1);
  };

  return (
    <div className="app">
      <aside className="sidebar" id="sidebar">
        <div className="brand-row">
          <Link className="brand" to="/" style={{ color: "inherit" }}>
            <span className="mark"><OrcaMark /></span>
            <span className="word">Orcha<small>orchestration portal</small></span>
          </Link>
          <button
            className="sb-toggle" id="sbToggle" type="button"
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            onClick={toggleSidebar}
          >
            <Icon name="chev" cls="ico" />
          </button>
        </div>
        <nav className="nav">
          <div className="lbl">Control room</div>
          {nv.map((n) => (
            <Link
              key={n.key} to={n.href} className={n.key === page ? "active" : ""}
              title={collapsed ? n.label + (n.count != null ? " · " + n.count : "") : undefined}
            >
              <Icon name={n.ico} />
              <span className="grow">{n.label}</span>
              {n.count != null && <span className={"ncount" + (n.attn && n.count ? " attn" : "")}>{n.count}</span>}
            </Link>
          ))}
          <div className="lbl">Live</div>
          <Link to="/agents" className="" title={collapsed ? "Run feed" : undefined}>
            <Icon name="live" />
            <span className="grow">Run feed</span>
          </Link>
        </nav>
        <div className="sb-spacer" />
        <div className="attn-card">
          <div className="h"><Icon name="bell" cls="" /><span>Needs you</span></div>
          <div className="big tnum">{attnN.total}</div>
          <div className="sub">{attnN.verify} to verify · {attnN.esc} escalation{attnN.esc === 1 ? "" : "s"}</div>
          <Link className="go" to="/">Open action queue <Icon name="arrow" cls="" /></Link>
        </div>
        <Link className="attn-mini" to="/" title={`Needs you · ${attnN.total} — open action queue`}>
          <Icon name="bell" cls="" /><span className="n tnum">{attnN.total}</span>
        </Link>
        <div className="maker">
          <div className="dev">Developed by</div>
          <div className="ql-logo">
            <svg className="ql-mark" viewBox="0 0 40 40" width={23} height={23} fill="none" aria-hidden="true">
              <circle cx="19" cy="20" r="14.6" stroke="currentColor" strokeWidth={4} />
              <circle cx="27.2" cy="31.2" r="5" fill="#ffbf00" />
            </svg>
            <span className="ql-word"><b>Quantal</b> <span className="ql-labs">Labs</span></span>
            <span className="ql-ai">AI</span>
          </div>
        </div>
      </aside>
      <div className="main">
        <header className={"topbar" + (paused ? " paused" : "")} id="topbar">
          <div className="crumbs">
            <span className="page">{title}</span>
            {ctx && <span className="ctx">{ctx}</span>}
          </div>
          <div className="grow" />
          <div className="search">
            <Icon name="search" cls="" />
            <input ref={searchRef} id="globalSearch" placeholder="Search agents, tasks, requests…" spellCheck={false} autoComplete="off" />
            <span className="kbd">/</span>
          </div>
          <a
            className="attn-pill" id="attnPill" href="/"
            title="Notifications — approvals, verifications & activity" aria-haspopup="true"
            onClick={(e) => { e.preventDefault(); setNcOpen((v) => !v); }}
          >
            <Icon name="bell" cls="bell" /><span>Needs you</span><span className="n tnum">{a.count}</span>
          </a>
          {(extensions.topbarActions ?? []).map((C, i) => (
            <C key={i} />
          ))}
          <AutonomyControls />
          <ActingChip />
          <button className="iconbtn" id="themeBtn" title={`Theme: ${currentTheme()} — click to cycle`} onClick={cycle}>
            <Icon name="sun" cls="sun" /><Icon name="moon" cls="moon" />
          </button>
        </header>
        <div className={"pausebar" + (paused ? " show" : "")} id="pausebar">
          <span>⏸ Notifier paused — no agent wakes. Humans &amp; live terminals still work.</span>
        </div>
        <NotificationCenter open={ncOpen} onClose={() => setNcOpen(false)} />
        <main className="content">{children}</main>
      </div>
    </div>
  );
}

// re-export for pages that need raw esc in attribute contexts
export { esc };
