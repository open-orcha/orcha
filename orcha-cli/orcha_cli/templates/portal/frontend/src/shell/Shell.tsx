/**
 * The V2 app shell — header + content for every in-app page, plus the
 * persistent project sidebar (./Sidebar) when no AppFrame provides it.
 *
 * Routing is react-router's BrowserRouter over clean URLs (/tasks?task=…);
 * every page URL is served by an explicit FastAPI page route returning the SPA
 * shell (portal_backend/dashboard_routes.py). (GAP-08: older comments here
 * said "hash routing" — that was never what shipped.)
 *
 * Header contract (docs/orcha-v2-architecture.md §9): breadcrumbs
 * (Project / Section / Object) · one primary action slot · compact secondary
 * slot · connection indicator (live / polling / reconnecting / offline + last
 * update) · persistent Paused indicator · "Execution controls" popover holding
 * the TWO independent controls — Notifier (wakes) and Autonomy (level), each
 * with its existing confirm copy (GH #148/#149) · notifications bell.
 * The theme toggle lives in Settings › Interface and the ⌘K palette.
 */
import { UpdateNotice } from "./UpdateNotice";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { sendJSON, getJSON } from "../api/client";
import { relTime, trunc, esc } from "../lib/format";
import { ensureCidInLocation } from "../lib/scope";
import {
  autLevel,
  identitySelfHuman,
  isAnsweredKind,
  NOT_MEMBER_REASON,
  OFFLINE_REASON,
  snapshotErrorKind,
  useActingAuthority,
  useSnapshot,
  type SnapshotErrorKind,
} from "../state/SnapshotProvider";
import { useAttention, attentionLabel } from "../state/attention";
import { refreshProjects, useProjects } from "../state/projects";
import { Avatar, Icon, Modal, useToast } from "../components/ui";
import { Breadcrumbs, type Crumb } from "../components/primitives/Layout";
import { Menu, Popover, type MenuItemSpec } from "../components/primitives/Menu";
import { PAUSE_LABEL, pauseFor, pauseText, prefsErrText, putDefaults, putProject, type PauseChoice } from "../pages/settings/notifications/notificationPrefs";
import { Button, ButtonLink, IconButton } from "../components/primitives/Button";
import { focusables, trapTab } from "../components/primitives/focus";
import { extensions, type Identity } from "../extensions";
import { ChromeProvider, useChrome } from "./chrome";
import { Sidebar } from "./Sidebar";
import { ProjectTabs, isProjectSectionPage } from "./ProjectTabs";
import { ProjectFace, useProjectPalette } from "./projectPalette";
import { notifierState } from "../lib/notifier";
import { autonomyDescFor, autonomyLabelFor, useProjectMode } from "../lib/projectMode";
import { payloadTitle as payloadSummary } from "../components/primitives/Payload";
import { HealthChip } from "../components/primitives/HealthChip";
import { projectPauseLine, useContainerBudgets } from "../pages/agents/budget/budgetModel";

/* ---- theme ----------------------------------------------------------------
 * System / Light / Dark lives in ./theme (Settings › Interface › Appearance,
 * the ⌘K palette). Re-exported here for existing importers. */
export { initTheme } from "./theme";
/** The stored preference ("auto" | "light" | "dark"), default applied. */
export { readThemePref as legacyThemePreference } from "./theme";

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
    impact: "Agents propose plans, but you approve every plan before any execution." },
  { level: "pr", tone: "info", label: "Build to PR",
    meaning: "Agents execute approved plans up to an open PR; you still merge.",
    impact: "Agents execute approved plans up to an open PR. You still merge." },
  { level: "full", tone: "accent", label: "Full",
    meaning: "Agents may carry approved work to its configured terminal state without further gates.",
    impact: "Agents may carry approved work to completion without further gates." },
] as const;

/**
 * The confirm copy for switching to `level` (pure, tested). Autonomy never
 * touches wakes, so the copy must not promise agents "resume": while wakes are
 * OFF it says the level only applies once wakes are turned back on.
 */
export function autonomyImpact(level: string, wakesPaused: boolean): string {
  const rg = AUT_LEVELS.find((x) => x.level === level);
  if (!rg) return "";
  return wakesPaused
    ? rg.impact + " Wakes are off, so this applies once wakes are turned back on — changing autonomy does not resume them."
    : rg.impact;
}

/** Label for any stored level — unknown / legacy values are named explicitly. */
export function autonomyLabel(level: string): { label: string; known: boolean } {
  const rg = AUT_LEVELS.find((x) => x.level === level);
  if (rg) return { label: rg.label, known: true };
  return { label: `Custom (${level || "unset"})`, known: false };
}

/** Compact age for a millisecond span: "45s" / "12m" / "3h" / "2d". */
function spanText(ms: number): string {
  const a = Math.max(0, ms / 1000);
  return a < 60 ? Math.floor(a) + "s" : a < 3600 ? Math.floor(a / 60) + "m" : a < 86400 ? Math.floor(a / 3600) + "h" : Math.floor(a / 86400) + "d";
}

type WakeContainer = { wakes_enabled?: boolean; last_wake_scan_at?: string | null; runtime_served?: boolean } | null | undefined;

/**
 * The header chip's word for the OBSERVED wake service (pure, tested). It is
 * the same notifierState() mapping the Overview and Settings use, so the chip
 * never says "Running" while no wake scan has happened.
 */
export function execChipState(c: WakeContainer, now = Date.now()): string {
  const ns = notifierState(c as Parameters<typeof notifierState>[0], now);
  return ns === "paused" ? "Paused" : ns === "stale" ? "Not running" : ns === "none" ? "No wake service" : ns === "running" ? "Running" : "Wakes on";
}

/**
 * One line describing what is OBSERVED about wakes (pure, tested) — shown
 * under the Wakes switch, which itself only names the config flag (On/Off).
 */
export function wakesObserved(c: WakeContainer, now = Date.now()): string {
  const ns = notifierState(c as Parameters<typeof notifierState>[0], now);
  if (ns === "paused") return "Off — no agent wakes. In-flight runs finish; nothing new starts.";
  if (ns === "none") return "On, but no wake service has run yet";
  const t = Date.parse(c?.last_wake_scan_at || "");
  if (ns === "stale") return "On, but no wake scan in " + spanText(now - t);
  if (ns === "running") return "On · wake service active (last scan " + spanText(now - t) + " ago)";
  return "On — agents wake on events";
}

/**
 * The popover's line under the Wakes switch (pure, tested): what is OBSERVED,
 * WITHOUT repeating the switch's own On/Off word (review m1: "On" twice).
 */
export function wakesDetail(c: WakeContainer, now = Date.now()): string {
  const ns = notifierState(c as Parameters<typeof notifierState>[0], now);
  if (ns === "paused") return "No agent wakes · in-flight runs finish";
  if (ns === "none") return "No wake service has run yet";
  const t = Date.parse(c?.last_wake_scan_at || "");
  if (ns === "stale") return "No wake scan in " + spanText(now - t) + " · not running";
  if (ns === "running") return "Wake service active · last scan " + spanText(now - t) + " ago";
  return "Agents wake on events";
}

interface PendingAut { title: string; desc: string; primary: string; danger?: boolean; run: () => void }

/** Why the acting human may NOT change wakes / autonomy (pure, tested), or null.
 * Mirrors the backend's owner-or-manage_autonomy gate (identity_routes.enforce_grant):
 * with a trusted identity only an owner or a `manage_autonomy` holder may act
 * (a viewer never); with trust off (no identity) the backend does not gate, so
 * neither does the affordance. The server stays the enforcer either way. */
export const EXEC_GRANT_REASON = "Changing wakes or autonomy needs the owner role or the manage_autonomy permission";
export function execControlDenial(identity: Identity | null | undefined): string | null {
  if (!identity) return null;
  if (identity.member_role === "viewer") return "Your role is viewer (read-only)";
  if (identity.member_role === "owner") return null;
  return (identity.grants || []).indexOf("manage_autonomy") >= 0 ? null : EXEC_GRANT_REASON;
}

/** A mutation error as user-facing text (pure, tested): the server's detail, or
 * "status N" — NEVER the request URL / container id sendJSON's message carries. */
export function apiErrorText(e: unknown): string {
  const err = e as { status?: number; detail?: unknown; message?: unknown } | null;
  if (err && typeof err.detail === "string" && err.detail) return err.detail;
  const msg = err && typeof err.message === "string" ? err.message : typeof e === "string" ? e : "";
  const m = /\u2192\s*(\d{3})(?::\s*([\s\S]*))?$/.exec(msg);
  if (m) return m[2] && m[2].trim() ? m[2].trim() : "status " + m[1];
  if (err && typeof err.status === "number") return "status " + err.status;
  if (/^\/api\//.test(msg)) return "request failed";
  return msg || "request failed";
}

/** Acting authority with the snapshot failure named correctly (pure, tested):
 * a 403/404 answer is not "offline", so its reason must not read "reconnect". */
export function correctAuthorityReason<T extends { reason: string | null }>(a: T, kind: SnapshotErrorKind): T {
  if (a.reason !== OFFLINE_REASON) return a;
  if (kind === "forbidden") return { ...a, reason: NOT_MEMBER_REASON };
  if (kind === "not_found") return { ...a, reason: "Project not found" };
  return a;
}
function useShellAuthority() {
  const { error } = useSnapshot();
  return correctAuthorityReason(useActingAuthority(), snapshotErrorKind(error));
}

function useAutonomyActions() {
  const { snap, refresh, identity, error } = useSnapshot();
  const toast = useToast();
  const authority = useShellAuthority();
  const grantDenied = authority.human ? execControlDenial(identity) : null;
  const who = grantDenied ? null : authority.human;

  const { connection } = useSnapshot();
  const kind = snapshotErrorKind(error);
  const offline = connection === "offline" && kind !== "forbidden" && kind !== "not_found";
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
      toast((enabled ? "Couldn't resume wakes" : "Couldn't pause wakes") + " — " + apiErrorText(e), "danger");
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
      toast("Couldn't change autonomy \u2014 " + apiErrorText(e), "danger");
    }
  };

  // Offline: the displayed state may be stale, so execution changes are held
  // until the backend answers again (the confirm would otherwise race it).
  // A 403/404 snapshot is NOT offline (the backend answered): say why instead.
  return {
    snap, who: offline ? null : who,
    reason: kind === "forbidden" ? NOT_MEMBER_REASON
      : kind === "not_found" ? "Project not found"
      : offline ? "Offline — reconnect to change execution controls"
      : grantDenied || authority.reason,
    setWakes, setLevel,
  };
}

/* NOTIFIER (#notifTop): the live binary kill-switch. Always lit — Paused
 * (red) or Running (green). Running→Paused is destructive (halts all
 * wakes): danger confirm. Paused→Running is safe: light confirm. */
function NotifierSwitch() {
  const { snap, who, reason, setWakes } = useAutonomyActions();
  const toast = useToast();
  const [pending, setPending] = useState<PendingAut | null>(null);
  const paused = !!(snap?.container && (snap.container as { wakes_enabled?: boolean }).wakes_enabled === false);
  const canAct = !!who;
  const denied = reason || "Pick an acting human to change the notifier";

  const click = () => {
    if (!canAct) { toast(denied, "warn"); return; }
    setPending(paused
      ? { title: "Resume agent wakes?", desc: "Agents resume waking at the current autonomy level.", primary: "Resume", run: () => void setWakes(true) }
      : { title: "Pause all agent wakes?", desc: "Agents stop waking immediately. In-flight work finishes; nothing new starts. Humans & live terminals still work.", primary: "Pause all wakes", danger: true, run: () => void setWakes(false) });
  };

  const cls = paused ? "seg paused on" : "seg run on";
  // the switch names the CONFIG flag (wakes_enabled) — never the observed
  // service state, which lives on its own line below (review blocker: the
  // switch said "Running" while the header chip said "Not running").
  const lab = paused ? "Off" : "On";
  const tip = canAct
    ? (paused ? "Wakes are off — click to resume all agent wakes" : "Wakes are on — click to pause all agent wakes")
    : denied;

  const consequence = wakesDetail(snap?.container);

  return (
    <>
      <div className="ctl-group v2-exec-row" id="notifGroup">
        <div className="v2-exec-row-t">
          <span className="aut-lab" id="notifLab">Wakes</span>
          <span className="v2-exec-row-d" id="notifDesc">{consequence}</span>
        </div>
        <div className={"aut notif" + (canAct ? "" : " locked")} id="notifTop" role="group" aria-label="Event notifier — pause or resume all agent wakes">
          <button
            type="button" className={cls + " v2-switch"} role="switch" aria-checked={!paused} title={tip}
            aria-label={"Agent wakes: " + lab} aria-describedby="notifDesc" aria-disabled={canAct ? undefined : true}
            onClick={click}
          >
            <span className="v2-switch-lbl">{lab}</span>
            <span className="v2-switch-track" aria-hidden="true"><span className="v2-switch-thumb" /></span>
          </button>
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
  const { snap, who, reason, setLevel } = useAutonomyActions();
  const { cid } = useSnapshot();
  // General (non-code) projects word "Build to PR" as "Execute" (presentation only)
  const mode = useProjectMode(cid).mode;
  const labelOf = (rg: (typeof AUT_LEVELS)[number]) => autonomyLabelFor(rg.level, rg.label, mode);
  const meaningOf = (rg: (typeof AUT_LEVELS)[number]) => autonomyDescFor(rg.level, rg.meaning, mode);
  const toast = useToast();
  const [pending, setPending] = useState<PendingAut | null>(null);
  const paused = !!(snap?.container && (snap.container as { wakes_enabled?: boolean }).wakes_enabled === false);
  const level = autLevel(snap);
  const canAct = !!who;
  const denied = reason || "Pick an acting human to change autonomy";
  const groupRef = useRef<HTMLDivElement | null>(null);
  const known = autonomyLabel(level);
  const activeIdx = Math.max(0, AUT_LEVELS.findIndex((x) => x.level === level));
  const [focusIdx, setFocusIdx] = useState(activeIdx);
  useEffect(() => { setFocusIdx(activeIdx); }, [activeIdx]);

  // roving tabindex (ARIA radiogroup): arrows/Home/End MOVE focus only; Enter/
  // Space (native button activation) opens the same confirm as a click, so a
  // level never changes without the confirm.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const n = AUT_LEVELS.length;
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (focusIdx + 1) % n;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (focusIdx - 1 + n) % n;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    if (next == null) return;
    e.preventDefault();
    setFocusIdx(next);
    groupRef.current?.querySelectorAll<HTMLButtonElement>("button[role=radio]")[next]?.focus();
  };

  const click = (lvl: string) => {
    if (!canAct) { toast(denied, "warn"); return; }
    const rg = AUT_LEVELS.find((x) => x.level === lvl);
    if (!rg || rg.level === level) return;
    setPending({
      title: `Set autonomy to ${labelOf(rg)}?`, desc: mode === "general" ? meaningOf(rg) : autonomyImpact(rg.level, paused), primary: `Set ${labelOf(rg)}`,
      danger: rg.level === "full",
      run: () => void setLevel(rg.level, labelOf(rg)),
    });
  };

  return (
    <>
      <div className="ctl-group" id="autGroup">
        <span className="aut-lab">Autonomy</span>
        <div
          ref={groupRef}
          className={"aut" + (canAct ? "" : " locked") + (paused ? " dimmed" : "")} id="autTop" role="radiogroup"
          aria-label="Container autonomy level" onKeyDown={onKeyDown}
        >
          {!known.known ? (
            // a legacy / server-set level: shown SELECTED so the control never
            // reads as broken, but not clickable — picking a preset replaces it
            <span className="seg lvl custom on" role="radio" aria-checked="true" aria-disabled="true"
              title={"Level set on server: " + (level || "unset") + " — pick a preset to replace it"}>
              <span className="d" aria-hidden="true" />Custom
            </span>
          ) : null}
          {AUT_LEVELS.map((rg, i) => {
            const active = rg.level === level;
            const cls = "seg lvl " + rg.tone + (active ? " on" : "");
            const tip = canAct
              ? (active ? "Current autonomy: " + labelOf(rg) + (paused ? " — applies when running" : "") : `Set autonomy to ${labelOf(rg)} — ${meaningOf(rg)}`)
              : denied;
            return (
              <button
                key={rg.level} type="button" className={cls} role="radio" aria-checked={active} title={tip}
                tabIndex={i === focusIdx ? 0 : -1} aria-disabled={canAct ? undefined : true}
                onFocus={() => setFocusIdx(i)} onClick={() => click(rg.level)}
              >
                {/* no leading dot: the selected fill already marks the level (Linear segmented control) */}
                {labelOf(rg)}
              </button>
            );
          })}
        </div>
        <p className="v2-exec-lvl-d" aria-live="polite">
          {known.known
            ? meaningOf(AUT_LEVELS.find((x) => x.level === level)!)
            : <span title="Not one of the three presets — picking a level above replaces it.">Level set on server: {level || "unset"}</span>}
        </p>
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
/** Label for a notification type the portal does not know (pure, tested):
 * the type HUMANIZED ("some_unknown_type" → "Some unknown type", as the old
 * UI showed it — never the raw snake_case string), else a generic label keyed
 * on what it links to. */
export function ncFallbackLabel(kind?: string, type?: string): string {
  const t = (type || "").trim();
  if (/^[a-z][a-z0-9]*(?:[_.-][a-z0-9]+)*$/i.test(t)) {
    const words = t.replace(/[_.-]+/g, " ").toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  if (kind === "task") return "Task update";
  if (kind === "request") return "Request update";
  return "Notification";
}

export interface NcRegRow { type: string; preview?: string; actor_alias?: string; actor_kind?: string | null; ts?: number; read?: boolean; deeplink?: { kind?: string; id?: string } }
/** One Linear-Inbox row: round actor avatar + type badge · bold title · muted "what happened" · age. */
export interface NcRow { icon: string | null; col: string; unread?: boolean; ti: string; me: string; actor?: string | null; actorKind?: string | null; when: string | number | null; href: string | null; tip?: string }

/** Event kinds whose line 2 already names the event (and actor): their title
 *  is the OBJECT's title only, never "<title> — verified by X" (D12: once). */
const NC_OBJECT_TITLE = new Set(["task_verified", "plan_decided", "task_assigned", "task_ready", "task_unassigned"]);
/** "Refactor X — verified by hussein after …" → "Refactor X" (pure, tested). */
export function ncStripEventSuffix(text: string): string {
  const out = text.replace(/\s+[—–-]\s+(?:verified|approved|rejected|decided|assigned|unassigned|ready|re-?opened)\b.*$/i, "").trim();
  return out || text;
}

/** Unread count of a loaded feed page ("20+" when the whole page is unread and more exist). Pure, tested. */
export function ncUnreadCount(rows: { read?: boolean }[], more: boolean): { n: number; label: string } {
  const n = rows.filter((r) => !r.read).length;
  return { n, label: n && more && n === rows.length ? n + "+" : String(n) };
}

/** Oldest first; undated items last (pure). */
function bySinceAsc(a: { since?: string | null }, b: { since?: string | null }): number {
  const ta = Date.parse(a.since || ""), tb = Date.parse(b.since || "");
  return (Number.isNaN(ta) ? Infinity : ta) - (Number.isNaN(tb) ? Infinity : tb);
}

/**
 * One "Earlier" row (pure, tested). A bare notification (no preview) never
 * renders as a lone "Notification": it names its kind as the title and the
 * actor / project as the muted line (review m3).
 */
export function ncEarlierRow(n: NcRegRow, projectName: string | null, objectTitle?: (d: { kind?: string; id?: string }) => string | null | undefined): NcRow {
  const vis = NC_VIS[n.type] || { icon: null, col: "idle" };
  const label = NC_LABEL[n.type] || ncFallbackLabel(n.deeplink?.kind, n.type);
  const who = n.actor_alias || null;
  let preview = payloadSummary(n.preview);
  let tip: string | undefined;
  if (NC_OBJECT_TITLE.has(n.type)) {
    // title = the object itself (its live title when the snapshot has it);
    // anything else the preview said moves to the tooltip, not a 3rd line
    const obj = (n.deeplink && objectTitle?.(n.deeplink)) || null;
    const stripped = preview ? ncStripEventSuffix(preview) : "";
    if (preview && preview !== (obj || stripped)) tip = preview;
    preview = obj || stripped;
  }
  return {
    icon: vis.icon ?? (who ? null : "bell"), col: vis.col, unread: !n.read,
    ti: preview ? trunc(preview, 140) : label,
    me: preview
      ? label + (who ? " · " + who : "")
      : [who ? "by " + who : null, projectName].filter(Boolean).join(" · "),
    tip,
    actor: who, actorKind: n.actor_kind ?? null,
    when: n.ts != null ? n.ts * 1000 : null,
    href: ncDeeplinkHref(n.deeplink),
  };
}

function ncDeeplinkHref(d?: { kind?: string; id?: string }): string | null {
  if (!d || !d.id) return null;
  if (d.kind === "task") return "/tasks?task=" + encodeURIComponent(d.id);
  if (d.kind === "request") return "/requests?req=" + encodeURIComponent(d.id);
  return null;
}

/** "12m ago" → "12m" (the Inbox shows bare ages). */
function shortAge(when: string | number | null): string {
  if (when == null) return "";
  const t = relTime(typeof when === "number" ? new Date(when).toISOString() : when);
  return t === "—" ? "" : t.replace(/ ago$/, "");
}

function NcRowView({ r, onNavigate }: { r: NcRow; onNavigate: (href: string) => void }) {
  const age = shortAge(r.when);
  const inner = (
    <>
      <span className="nc-av" aria-hidden="true">
        {r.actor
          ? <Avatar alias={r.actor} kind={r.actorKind ?? undefined} size={24} decorative />
          : <span className="nc-sys"><Icon name="bell" cls="" /></span>}
        {r.icon ? <span className={"nc-badge c-" + r.col}><Icon name={r.icon} cls="" /></span> : null}
      </span>
      <div className="b">
        <div className="ti" title={r.tip ?? r.ti}>
          {/* Linear Inbox: the unread dot leads the title (not under the age) */}
          {r.unread ? <span className="nc-unread" title="Unread"><span className="v2-sr">Unread: </span></span> : null}
          <span className="ti-t">{r.ti}</span>
        </div>
        {r.me ? <div className="me" title={r.me}>{r.me}</div> : null}
      </div>
      <div className="nc-r">
        {age ? <span className="when">{age}</span> : null}
      </div>
    </>
  );
  const cls = "nrow" + (r.unread ? " unread" : "");
  if (!r.href) return <div className={cls}>{inner}</div>;
  const href = r.href;
  // SPA navigation (QA): a full document load here dropped in-memory drafts
  // and state. Modified clicks (new tab/window) keep the browser default.
  const onClick = (e: ReactMouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onNavigate(href);
  };
  return <a className={cls} href={href} onClick={onClick}>{inner}</a>;
}

/** The feed's mig-063 prefs_state (null on older backends / AI feeds). */
export interface NcPrefsState { paused: boolean; paused_until: number | null; muted: boolean }

/** The bell menu's items (pure, tested): settings link, pause/resume, mute toggle. */
export function ncMenuItems(ps: NcPrefsState | null, can: boolean, act: { pause: () => void; resume: () => void; mute: (on: boolean) => void }): (MenuItemSpec | "separator")[] {
  const why = "Notification settings belong to members of this project";
  return [
    { label: "Notification settings", icon: "gear", href: "/settings#tab=notifications" },
    "separator",
    ps?.paused
      ? { label: "Resume notifications", icon: "bell", onSelect: act.resume, disabled: !can, disabledReason: why }
      : { label: "Pause notifications…", icon: "pause", onSelect: act.pause, disabled: !can, disabledReason: why },
    { label: "Mute this project", icon: "bell-off", checked: !!ps?.muted, onSelect: () => act.mute(!ps?.muted), disabled: !can, disabledReason: why },
  ];
}

function NotificationCenter({ open, onClose, onUnread, onPaused }: { open: boolean; onClose: () => void; onUnread?: (u: { n: number; label: string }) => void; onPaused?: (paused: boolean) => void }) {
  const { snap, bump, recoveredAt, cid } = useSnapshot();
  const toast = useToast();
  const [feed, setFeed] = useState<{ rows: NcRegRow[]; more: boolean; loaded: boolean; loading: boolean; beforeTs: number | null; beforeId: string | null }>({
    rows: [], more: false, loaded: false, loading: false, beforeTs: null, beforeId: null,
  });
  const { identity } = useSnapshot();
  const authority = useShellAuthority();
  // Your OWN notification feed (read-scoped) — a viewer still reads theirs.
  const who = identitySelfHuman(snap, identity);
  const whoId = who?.id ?? null;
  const boxRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();
  const go = (href: string) => { onClose(); navigate(href); };
  // mig 063: the bell's quick menu — settings, pause/snooze, mute this project
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const [menu, setMenu] = useState<null | "main" | "pause">(null);
  const [prefsState, setPrefsState] = useState<NcPrefsState | null>(null);
  useEffect(() => { onPaused?.(!!prefsState?.paused); }, [prefsState?.paused, onPaused]);

  const load = async (reset: boolean) => {
    if (!whoId) return;
    setFeed((f) => ({ ...f, loading: true }));
    let url = `/api/agents/${encodeURIComponent(whoId)}/notifications?zone=earlier&limit=${NC_PAGE}`;
    if (!reset && feed.beforeTs != null) {
      url += "&before_ts=" + encodeURIComponent(feed.beforeTs);
      if (feed.beforeId != null) url += "&before_id=" + encodeURIComponent(feed.beforeId);
    }
    try {
      const res = await getJSON<{ notifications?: NcRegRow[]; next_before_ts?: number | null; next_before_id?: string | null; prefs_state?: NcPrefsState | null }>(url);
      const rows = res.notifications || [];
      if (reset) setPrefsState(res.prefs_state ?? null);
      setFeed((f) => ({
        rows: reset ? rows : f.rows.concat(rows),
        beforeTs: res.next_before_ts ?? null,
        beforeId: res.next_before_id ?? null,
        more: res.next_before_ts != null,
        loaded: true, loading: false,
      }));
    } catch (e) {
      setFeed((f) => ({ ...f, loading: false, loaded: true }));
      toast("Couldn't load notifications — " + apiErrorText(e), "danger");
    }
  };

  // page 1 loads on mount too (not only on open): the bell badge counts
  // UNREAD notifications, so it needs the feed before the panel is opened.
  // While closed it refreshes at most once a minute.
  useEffect(() => {
    if (!whoId) return;
    void load(true);
    if (open) return;
    const iv = setInterval(() => { void load(true); }, 60_000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, whoId]);
  // SH-130: an outage just ended — re-load page 1 now (a failed load would
  // otherwise sit behind "Couldn't load notifications" until the 60 s tick)
  useEffect(() => {
    if (recoveredAt == null || !whoId) return;
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recoveredAt]);
  const unread = ncUnreadCount(feed.rows, feed.more);
  useEffect(() => { onUnread?.(unread); }, [unread.n, unread.label, onUnread]); // eslint-disable-line react-hooks/exhaustive-deps

  // a11y (review M1): opening the dialog moves focus INTO it (first row, else
  // "Mark all read", else the panel) and Tab stays inside until Esc / close
  const wasOpen = useRef(false);
  useEffect(() => {
    if (!open) { wasOpen.current = false; return; }
    if (wasOpen.current) return;
    wasOpen.current = true;
    const box = boxRef.current;
    if (!box) return;
    const first = box.querySelector<HTMLElement>(".nc-body a.nrow") ?? focusables(box)[0] ?? box;
    first.focus({ preventScroll: true });
  }, [open, feed.loaded]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      // the bell menu is portaled: a click in it must not close the panel
      if (boxRef.current && !boxRef.current.contains(t) && !(t instanceof Element && (t.closest("#attnPill") || t.closest("#ncMenu, #ncPauseMenu")))) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Tab") {
        const box = boxRef.current;
        if (box && box.contains(document.activeElement)) trapTab(e, box);
        return;
      }
      if (e.key !== "Escape") return;
      onClose();
      document.getElementById("attnPill")?.focus(); // return focus to the bell
    };
    document.addEventListener("click", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("click", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open, onClose]);

  const canPrefs = !!(cid && whoId);
  const writePrefs = async (optimistic: NcPrefsState, send: () => Promise<unknown>, done: string, fail: string) => {
    const prev = prefsState;
    setPrefsState(optimistic);
    try {
      await send();
      toast(done, "ok");
      void load(true);
    } catch (e) {
      setPrefsState(prev);
      toast(fail + " — " + prefsErrText(e) + ".", "danger");
    }
  };
  const base: NcPrefsState = prefsState ?? { paused: false, paused_until: null, muted: false };
  const pauseNow = (choice: PauseChoice) => {
    if (!cid) return;
    const p = pauseFor(choice);
    void writePrefs({ ...base, paused: true, paused_until: p.until }, () => putDefaults(cid, whoId, { pause: p }),
      "Notifications paused — " + PAUSE_LABEL[choice].toLowerCase() + ".", "Couldn't pause notifications");
  };
  const resume = () => {
    if (!cid) return;
    void writePrefs({ ...base, paused: false, paused_until: null }, () => putDefaults(cid, whoId, { pause: null }),
      "Notifications are back on.", "Couldn't resume notifications");
  };
  const mute = (on: boolean) => {
    if (!cid) return;
    void writePrefs({ ...base, muted: on }, () => putProject(cid, whoId, { muted: on }),
      on ? "This project is muted." : "This project is unmuted.", on ? "Couldn't mute this project" : "Couldn't unmute this project");
  };
  const pausedLine = prefsState?.paused ? pauseText({ until: prefsState.paused_until }) : null;

  const markAllRead = async () => {
    if (!whoId) return;
    setFeed((f) => ({ ...f, rows: f.rows.map((n) => ({ ...n, read: true })) }));
    try {
      await sendJSON("POST", `/api/agents/${encodeURIComponent(whoId)}/notifications/read`, {});
    } catch (e) {
      toast("Couldn't mark read — " + apiErrorText(e), "danger");
    }
  };

  // NEEDS-YOU zone: the shared attention selector (state/attention.ts — ONE
  // definition for sidebar, header and queue). It recomputes on every snapshot
  // bump. Items assigned to someone else are listed (de-emphasized in the
  // queue) but only "yours" appear here. Opening this panel never marks
  // anything read and never resolves a decision.
  void bump;
  const attention = useAttention();
  // oldest first — the same order as the Overview's Needs-you band (review N7)
  const needs: NcRow[] = attention.items.filter((i) => !i.assignedToOther).slice().sort(bySinceAsc).map((i) => {
    const by = i.agentAlias || null;
    if (i.kind === "plan") return { icon: "shield", col: "warn", ti: i.title, me: "Plan waiting for approval" + (by ? " · " + by : ""), actor: by, when: i.since, href: i.href };
    if (i.kind === "verify") return { icon: "check", col: "warn", ti: i.title, me: "Ready to verify" + (by ? " · " + by : ""), actor: by, when: i.since, href: i.href };
    const esc = i.request?.status === "escalated";
    const title = payloadSummary(i.title) || "Request";
    const from = i.request?.from || null;
    return { icon: "flag", col: "danger", ti: title, me: (esc ? "Escalated" : "Asked") + (from ? " by " + from : "") + " · waiting on you", actor: from, when: i.since, href: i.href };
  });
  const taskTitle = (d: { kind?: string; id?: string }) =>
    d.kind === "task" && d.id ? (snap?.tasks ?? []).find((t) => t.id === d.id)?.title ?? null : null;
  const earlier: NcRow[] = feed.rows.map((n) => ncEarlierRow(n, snap?.container?.name || null, taskTitle));

  return (
    <div
      ref={boxRef} id="ncFloat" className={"ncenter float" + (open ? " show" : "")}
      role="dialog" aria-label="Notifications" aria-hidden={open ? undefined : true} tabIndex={-1}
    >
      <div className="nc-h">
        <h3>Notifications</h3>
        {whoId ? (
          <Button variant="ghost" size="sm" icon="check" className="mark" tabIndex={open ? 0 : -1}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); void markAllRead(); }}>Mark all read</Button>
        ) : null}
        <IconButton
          ref={moreRef} icon="more" size="sm" variant="ghost" label="Notification options" className="nc-more" id="ncMore"
          aria-haspopup="menu" aria-expanded={menu != null} tabIndex={open ? 0 : -1}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setMenu((m) => (m ? null : "main")); }}
        />
        <Menu
          anchor={moreRef} open={menu === "main"} onClose={() => setMenu((m) => (m === "main" ? null : m))}
          label="Notification options" placement="bottom-end" id="ncMenu"
          items={ncMenuItems(prefsState, canPrefs, {
            pause: () => setTimeout(() => setMenu("pause"), 0),
            resume, mute,
          }).map((it) => (it !== "separator" && it.href ? { ...it, onSelect: onClose } : it))}
        />
        <Menu
          anchor={moreRef} open={menu === "pause"} onClose={() => setMenu((m) => (m === "pause" ? null : m))}
          label="Pause notifications" placement="bottom-end" id="ncPauseMenu"
          items={(Object.keys(PAUSE_LABEL) as PauseChoice[]).map((k) => ({ label: PAUSE_LABEL[k], onSelect: () => pauseNow(k) }))}
        />
      </div>
      {pausedLine || prefsState?.muted ? (
        <div className="nc-paused" role="status" id="ncPaused">
          <Icon name="bell-off" cls="v2-ico" />
          <span>{pausedLine || "This project is muted"}{pausedLine && prefsState?.muted ? " · project muted" : ""}</span>
          {canPrefs ? (
            <Button variant="ghost" size="sm" tabIndex={open ? 0 : -1}
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (pausedLine) resume(); else mute(false); }}>
              {pausedLine ? "Resume" : "Unmute"}
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="nc-body">
      <div className="nc-zlbl needs">Needs you <span className="ct">{needs.length}</span></div>
      <div className="nc-list">
        {needs.length
          ? needs.map((r, i) => <NcRowView key={i} r={r} onNavigate={go} />)
          : authority.readOnly
            ? <div className="nc-empty">{authority.reason} — nothing here is yours to decide.</div>
            : authority.pending
              ? <div className="nc-empty">Resolving your identity…</div>
              : <div className="nc-empty">✓ You&#39;re all caught up.</div>}
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
          earlier.map((r, i) => <NcRowView key={i} r={r} onNavigate={go} />)
        )}
      </div>
      {feed.more && (
        <Button variant="ghost" className="nc-foot" tabIndex={open ? 0 : -1} busy={feed.loading}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); void load(false); }}>{feed.loading ? "Loading…" : "Load earlier"}</Button>
      )}
      </div>
    </div>
  );
}

/* ---- Execution controls (header popover) --------------------------------- */
function ExecutionControls() {
  const { snap, connection, cid } = useSnapshot();
  const pmode = useProjectMode(cid).mode;
  const chrome = useChrome();
  const [localOpen, setLocalOpen] = useState(false);
  const open = chrome ? chrome.execOpen : localOpen;
  const setOpen = chrome ? chrome.setExecOpen : setLocalOpen;
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const paused = !!(snap?.container && snap.container.wakes_enabled === false);
  if (!snap?.container) return null;
  const lvl = autonomyLabel(autLevel(snap));
  const offline = connection === "offline";
  // same honest states as the Overview: wakes_enabled alone doesn't mean
  // anything is actually waking agents
  const ns = notifierState(snap.container);
  const idle = ns === "stale" || ns === "none";
  const state = execChipState(snap.container);
  // the chip shows ONE state word; the autonomy level (and, for a legacy
  // level, its raw server value) lives in the tooltip and the popover
  const level = lvl.known ? autonomyLabelFor(autLevel(snap), lvl.label, pmode) : "set on server (" + (autLevel(snap) || "unset") + ")";
  const title = "Execution — " + wakesObserved(snap.container) + " · Autonomy: " + level
    + (offline ? " (as last seen — offline)" : "");
  const note = "Two independent controls: pausing wakes never changes the autonomy level and does not stop runs already in flight; changing autonomy never resumes wakes.";
  return (
    <>
      <button
        ref={btnRef} type="button" id="execBtn"
        className={"v2-exec-btn" + (paused ? " is-paused" : "") + (idle ? " is-idle" : "") + (offline ? " is-stale" : "")}
        aria-haspopup="dialog" aria-expanded={open} aria-label={title} title={title}
        onClick={() => setOpen(!open)}
      >
        {/* compact densities: a power glyph with the dot as its state badge (CSS) */}
        <Icon name="power" cls="v2-ico v2-exec-glyph" />
        <span className={"v2-exec-dot" + (paused ? " is-paused" : idle ? " is-idle" : "")} aria-hidden="true" />
        <span className="v2-exec-state">{state}</span>
        <Icon name="chev" cls="v2-ico v2-chev" />
      </button>
      <Popover anchor={btnRef} open={open} onClose={() => setOpen(false)} role="dialog" label="Execution controls" placement="bottom-end" className="v2-exec-pop" trap>
        <div className="v2-exec-h">
          <span>Execution controls</span>
          <span className="v2-exec-info" aria-hidden="true" title={note}><Icon name="info" cls="v2-ico" /></span>
          <span className="v2-sr">{note}</span>
        </div>
        {offline ? <p className="v2-exec-offline" role="note">Offline — changes are disabled until Embodent reconnects.</p> : null}
        <AutonomyControls />
      </Popover>
    </>
  );
}

/* ---- VD-10: project budget stop, visible where the owner looks first ------
 * Only when the PROJECT cap is what pauses new runs (a per-agent stop lives on
 * that agent's row). One compact chip; the reason is its tooltip; it links to
 * the project's budget controls (Metrics → Monthly budgets). */
export function ProjectBudgetChip({ iconOnly = false }: { iconOnly?: boolean } = {}) {
  const { snap, cid } = useSnapshot();
  const projectId = snap?.container?.id ?? cid ?? null;
  const { data } = useContainerBudgets(projectId);
  const line = projectPauseLine(data);
  const navigate = useNavigate();
  if (!line) return null;
  const href = "/metrics" + (projectId ? "?cid=" + encodeURIComponent(projectId) : "") + "#mxBudgets";
  return (
    <a
      // VD-40: in overflow density (phone) the chip is glyph-only — the words
      // pushed the navigation button and project crumb off-screen at 390 px.
      // The reason stays in the tooltip and the accessible name.
      className={"v2-budget-chip" + (iconOnly ? " is-icon" : "")} href={href} data-testid="project-budget-chip"
      title={line} aria-label={"Budget paused — " + line}
      onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); navigate(href); }}
    >
      <HealthChip health="off_track" label="Budget paused" title={line} />
    </a>
  );
}

/* ---- connection indicator (GAP-03 / PI-09) -------------------------------
 * D12 / review M3: while LIVE nothing is drawn (a second green dot beside the
 * Execution chip's "● Running" said "healthy" twice) — only a visually hidden
 * status keeps the fact for assistive tech. Any other state is ONE muted
 * signal glyph (never a dot, so it can't be confused with the exec dot) with
 * the sentence as its tooltip; the offline sentence also lives in the stale
 * bar. Not a button: clicking it did nothing useful (Retry is in the bar). */
export function connectionText(connection: string, hasSnap: boolean): string {
  return connection === "live" ? "Live"
    : connection === "polling" ? (hasSnap ? "Polling" : "Connecting…")
    : connection === "reconnecting" ? "Reconnecting…"
    : "Offline";
}

/** What the header says instead of the offline glyph when the backend DID
 *  answer (pure, tested): a 403/404, or a 5xx for a project the (loaded)
 *  project list names — Orcha is reachable, only that project is down. Null
 *  when the failure really is connectivity. */
export function answeredConnectionText(kind: SnapshotErrorKind, listedName: string | null): string | null {
  if (kind === "forbidden") return "Connected — you are not a member of this project";
  if (kind === "not_found") return "Connected — project not found";
  if (kind === "server" && listedName) return `Connected — ${listedName} is unreachable`;
  return null;
}

function ConnectionIndicator() {
  const { connection: rawConn, lastOkAt, snap, error, cid } = useSnapshot();
  const kind = snapshotErrorKind(error);
  const listed = useListedProject(cid);
  // the backend answered: never the Wi-Fi-off glyph (the stale bar names the
  // real reason, once — D12)
  const answered = rawConn === "offline" ? answeredConnectionText(kind, listed?.name ?? null) : null;
  if (answered) return <span className="v2-sr" role="status">{answered}</span>;
  const connection = rawConn;
  const last = lastOkAt ? relTime(new Date(lastOkAt).toISOString()) : null;
  const title =
    connection === "live" ? "Live updates connected" + (last ? " · last update " + last : "")
    : connection === "polling" ? (snap ? "Live stream unavailable — refreshing every 3 s" : "Connecting to Embodent…") + (last ? " · last update " + last : "")
    : connection === "reconnecting" ? "Reconnecting… lost contact with the Embodent backend" + (last ? " · showing data from " + last : "")
    : last ? "Offline — showing data from " + last + " (not live)" : "Offline — no data loaded";
  if (connection === "live") return <span className="v2-sr" role="status">{title}</span>;
  return (
    <span className={"v2-conn is-" + connection} role="status" aria-live="polite" tabIndex={0} title={title} aria-label={title}>
      <svg className="v2-conn-ico" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <path d="M2 6.2a8.5 8.5 0 0 1 12 0" /><path d="M4.3 8.6a5.2 5.2 0 0 1 7.4 0" /><path d="M6.6 11a2 2 0 0 1 2.8 0" />
        {connection === "offline" ? <path d="M2.5 2.5l11 11" /> : null}
      </svg>
    </span>
  );
}

/** The user-facing offline sentence (pure, tested): no URLs / status codes. */
export function staleMessage(hasData: boolean, when: string | null): string {
  return hasData && when ? `Can't reach Embodent · showing data from ${when}` : "Can't reach Embodent · no project data loaded";
}

// One classifier for the whole app: the provider records the failure kind
// (with the HTTP status when the fetch carried one). Re-exported here for the
// pages that already import it from the shell.
export { NOT_MEMBER_REASON, snapshotErrorKind };
export type { SnapshotErrorKind };

/** The Details line: the status in words, never the raw endpoint / container id (pure, tested). */
export function staleDetail(error: string | null | undefined): string | null {
  if (!error) return null;
  const m = /\u2192\s*(\d{3})\b(?::\s*([\s\S]*))?/.exec(error);
  if (m) return "The server answered " + m[1] + (m[2] && m[2].trim() ? ": " + m[2].trim() : "");
  return error.replace(/\/api\/\S*/g, "").trim() || null;
}

/**
 * The banner sentence for a failed snapshot (pure, tested). Returns null when
 * nothing should show. `listed` is the project's name from the (successfully
 * loaded) project list — proof Orcha itself is reachable.
 */
export function staleBanner(
  kind: SnapshotErrorKind, hasData: boolean, when: string | null, listed: string | null,
): { msg: string; retry: boolean; toProjects: boolean } {
  if (kind === "forbidden") return { msg: "You're not a member of this project — ask an owner for an invite", retry: false, toProjects: true };
  if (kind === "not_found") return { msg: "Project not found — it may have been removed, or the link is wrong", retry: false, toProjects: true };
  if (kind === "server" && listed) {
    return { msg: hasData && when ? `${listed} is unreachable · showing data from ${when}` : `${listed} is unreachable · no project data loaded`, retry: true, toProjects: false };
  }
  return { msg: staleMessage(hasData, when), retry: true, toProjects: false };
}

/**
 * The listed project's name for the current cid, as proof Orcha itself answers
 * (pure, tested). SH-130: the list is only proof when it was fetched AFTER the
 * current failure streak began — a list cached up to a minute before the
 * outage says nothing about now, so a whole-backend outage would otherwise
 * read "<project> is unreachable" instead of "Can't reach Orcha".
 */
export function listedProjectName(
  cid: string | null | undefined,
  projects: { list: { id: string; name?: string | null }[] | null; error: string | null; fetchedAt: number | null },
  errorSince: number | null | undefined,
): string | null {
  if (!cid || projects.error) return null;
  if (errorSince != null && (projects.fetchedAt == null || projects.fetchedAt < errorSince)) return null;
  const row = (projects.list || []).find((p) => p.id === cid);
  return row && row.name ? row.name : null;
}

/** The listed project row for the current cid (name only; never invented). */
function useListedProject(cid: string | null | undefined): { name: string } | null {
  const projects = useProjects();
  const { errorSince } = useSnapshot();
  const name = listedProjectName(cid, projects, errorSince);
  return name ? { name } : null;
}

function StaleBar() {
  const { connection, lastOkAt, snap, error, refresh, cid } = useSnapshot();
  const listed = useListedProject(cid);
  const [busy, setBusy] = useState(false);
  const kind = snapshotErrorKind(error);
  const answered = kind === "forbidden" || kind === "not_found";
  if (!answered) {
    if (connection !== "offline" && connection !== "reconnecting") return null;
    if (connection === "reconnecting" && snap) return null; // brief blips: header indicator only
  }
  const when = lastOkAt ? new Date(lastOkAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
  // Retry asks both: the snapshot AND the project list (which decides the copy)
  const retry = async () => { setBusy(true); try { await Promise.all([refresh(), refreshProjects()]); } finally { setBusy(false); } };
  const b = staleBanner(kind, !!snap, when, listed?.name ?? null);
  const detail = staleDetail(error);
  return (
    <div className={"v2-stalebar" + (answered ? " is-" + kind : "")} role="alert">
      <Icon name={kind === "forbidden" ? "shield" : kind === "not_found" ? "info" : "alert"} cls="v2-ico v2-stalebar-ico" />
      <span className="v2-stalebar-msg">{b.msg}</span>
      {detail && !answered ? (
        <details className="v2-stalebar-det">
          <summary>Details</summary>
          <code className="v2-stalebar-err">{detail}</code>
        </details>
      ) : null}
      {b.toProjects ? <ButtonLink variant="secondary" size="sm" to="/projects" className="v2-stalebar-retry">All projects</ButtonLink> : null}
      {b.retry ? <Button variant="secondary" size="sm" icon="refresh" busy={busy} className="v2-stalebar-retry" onClick={() => void retry()}>Retry</Button> : null}
    </div>
  );
}

/* ---- compact acting chip (embedded mode: the host sidebar has no per-project identity)
 * VD-15: calm — just the avatar (name + role in the tooltip / accessible name),
 * no uppercase "ACTING AS" label taking room from the project tabs. A read-only
 * identity adds one short lowercase "view-only" word. */
export function ActingChip() {
  const { identity } = useSnapshot();
  const authority = useShellAuthority();
  const who = authority.human;
  if (authority.pending) {
    const tip = "Resolving your identity — actions stay disabled until it answers";
    return (
      <div className="v2-acting acting" title={tip} aria-label={tip} role="img" data-testid="acting-chip">
        <span className="who muted" id="actingWho"><span className="v2-acting-dot" aria-hidden="true" /></span>
      </div>
    );
  }
  const label = who ? who.alias : identity ? identity.alias || identity.github_login || "account" : null;
  const tip = label
    ? (authority.readOnly ? `Viewing as ${label} — ${authority.reason ?? "view-only"}` : `Acting as ${label}`)
    : (authority.readOnly ? (authority.reason ?? "View-only") : "No human registered");
  return (
    <div className="v2-acting acting" title={tip} aria-label={tip} role="img" data-testid="acting-chip">
      <span className="who" id="actingWho">
        {label ? <Avatar alias={label} kind="human" size="sm" ghLogin={who ? who.github_login : identity?.github_login} /> : null}
        {authority.readOnly ? <span className="muted v2-acting-ro">view-only</span> : null}
      </span>
    </div>
  );
}

/* ---- the shell ----------------------------------------------------------- */
export interface ShellProps {
  /** section key (home | tasks | agents | requests | code | github | metrics | settings | members | needs | activity) */
  page: string;
  /** section title (legacy; also the breadcrumb section label) */
  title: string;
  /** legacy context line (project name or counts) — shown as compact meta */
  ctx?: ReactNode;
  /** V2: extra crumbs after Project / Section (e.g. the selected task) */
  crumbs?: Crumb[];
  /** V2: the ONE dominant action for this view */
  primaryAction?: ReactNode;
  /** V2: compact secondary controls (prefer `CircleIconButton`s) */
  secondaryActions?: ReactNode;
  /** D5: the filter-pill row under the header (`<PageToolbar>`); a fixed slot that never scrolls away */
  toolbar?: ReactNode;
  /** D5: drop the content padding so lists/boards run edge-to-edge inside the panel */
  flush?: boolean;
  children: ReactNode;
}

const SECTION_HREF: Record<string, string> = {
  home: "/", tasks: "/tasks", routines: "/routines", agents: "/agents", org: "/org", requests: "/requests", code: "/code", github: "/github",
  metrics: "/metrics", settings: "/settings", members: "/members", needs: "/needs", activity: "/activity",
};

/**
 * D12: ONE header row that never wraps. As the panel narrows the right
 * cluster sheds weight in steps instead of stacking a second row:
 *   full     — everything (primary with its label, "● Running ⌄" chip)
 *   compact  — the primary collapses to a 28 px circular icon
 *   tight    — the Execution chip is dot-only (state in its tooltip)
 *   overflow — primary / secondary / search / connection move into a ⋯ menu;
 *              the project crumb is its avatar only (tabs keep the room and
 *              scroll horizontally with an edge fade).
 */
export type HeaderDensity = "full" | "compact" | "tight" | "overflow";
export const HEADER_DENSITY_STEPS: Record<"tabbed" | "plain", [number, number, number]> = {
  // [full ≥, compact ≥, tight ≥]; below the last → overflow
  tabbed: [1100, 900, 640],
  plain: [760, 600, 480],
};
/** Density for a measured panel width (pure, tested). Unknown width → "full". */
export function headerDensity(panelWidth: number | null, tabbed: boolean): HeaderDensity {
  if (panelWidth == null) return "full";
  const [full, compact, tight] = HEADER_DENSITY_STEPS[tabbed ? "tabbed" : "plain"];
  return panelWidth >= full ? "full" : panelWidth >= compact ? "compact" : panelWidth >= tight ? "tight" : "overflow";
}

/**
 * Track the panel width (header density) and publish the header block height
 * as `--v2-chrome-h` on <html> so page CSS can size fill-height regions
 * (`--v2-content-h`) and sticky offsets (`--v2-sticky-top`).
 */
function useFrameMetrics(tabbed: boolean) {
  const mainRef = useRef<HTMLDivElement | null>(null);
  const topRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState<number | null>(() => {
    if (typeof window === "undefined" || !window.innerWidth) return null;
    return window.innerWidth <= 900 ? window.innerWidth : window.innerWidth - 272;
  });
  useEffect(() => {
    const main = mainRef.current, top = topRef.current;
    if (!main || typeof ResizeObserver === "undefined") return;
    const d = document.documentElement;
    const measure = () => {
      const w = main.getBoundingClientRect().width;
      if (w > 0) setWidth(Math.round(w));
      if (top) d.style.setProperty("--v2-chrome-h", Math.round(top.getBoundingClientRect().height) + "px");
    };
    const ro = new ResizeObserver(measure);
    ro.observe(main);
    if (top) ro.observe(top);
    measure();
    return () => { ro.disconnect(); };
  }, []);
  return { mainRef, topRef, density: headerDensity(width, tabbed) };
}

/** Overflow density: the right cluster's less-used controls behind one ⋯ circle. */
function HeaderOverflowMenu({ primaryAction, secondaryActions, onSearch }: { primaryAction?: ReactNode; secondaryActions?: ReactNode; onSearch: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement | null>(null);
  const { connection, lastOkAt, refresh, error, cid } = useSnapshot();
  const location = useLocation();
  const listed = useListedProject(cid);
  useEffect(() => { setOpen(false); }, [location.pathname, location.search]);
  const last = lastOkAt ? relTime(new Date(lastOkAt).toISOString()) : null;
  const answered = connection === "offline" ? answeredConnectionText(snapshotErrorKind(error), listed?.name ?? null) : null;
  const conn = answered ? answered.replace(/^Connected \u2014 /, "Connected \u00b7 ")
    : connection === "live" ? "Live updates" : connection === "polling" ? "Polling every 3 s" : connection === "reconnecting" ? "Reconnecting…" : "Offline";
  return (
    <>
      <button ref={ref} type="button" className="v2-circbtn v2-hdr-more" id="hdrMore" aria-label="More header actions" title="More"
        aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name="more" cls="v2-ico" />
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} role="dialog" label="More header actions" placement="bottom-end" className="v2-hdr-more-pop">
        {/* every entry is ONE menu row (icon · label · hint); the page's own
            primary / secondary controls are re-skinned as rows by v2-shell.css */}
        {primaryAction ? <div className="v2-hdr-more-primary" onClick={() => setOpen(false)}>{primaryAction}</div> : null}
        {secondaryActions ? <div className="v2-hdr-more-secondary">{secondaryActions}</div> : null}
        {primaryAction || secondaryActions ? <div className="v2-hdr-more-sep" role="separator" /> : null}
        <button type="button" className="v2-hdr-more-row" onClick={() => { setOpen(false); onSearch(); }}>
          <Icon name="search" cls="v2-ico" /><span>Search</span><span className="v2-hdr-more-kbd is-key">⌘K</span>
        </button>
        {/* NOT .v2-conn (the header glyph's 28 px circle + touch hit area) */}
        <button type="button" className={"v2-hdr-more-row v2-hdr-more-conn is-" + (answered ? "answered" : connection)} onClick={() => void refresh()} title="Refresh now">
          <span className="v2-conn-dot" aria-hidden="true" /><span>{conn}</span>{last ? <span className="v2-hdr-more-kbd">{last}</span> : null}
        </button>
      </Popover>
    </>
  );
}

/** The bell's accessible name (pure, tested): unread feed count + the Needs-you
 *  decisions, with correct agreement ("1 decision needs you", "9 decisions need you"). */
export function bellAriaLabel(unread: { n: number; label: string }, decisions: number | null, decisionsLabel: string): string {
  return "Notifications"
    + (unread.n ? ` — ${unread.label} unread` : "")
    + (decisions ? ` · ${decisionsLabel} ${decisionsLabel === "1" ? "decision needs" : "decisions need"} you` : "");
}

/** Shell pages that belong to a project section without being one of its tabs:
 *  project setup (/onboarding) is part of the project Overview. */
const PAGE_TAB_ALIAS: Record<string, string> = { onboarding: "home" };
/** The project tab a Shell `page` lights (pure, tested), or null for a page
 *  outside the project tab bar (Settings, All projects, Needs you…). */
export function headerTabPage(page: string): string | null {
  const key = PAGE_TAB_ALIAS[page] ?? page;
  return isProjectSectionPage(key) ? key : null;
}

function ShellBody({ page, title, ctx, crumbs, primaryAction, secondaryActions, toolbar, flush, children }: ShellProps) {
  const { snap, cid, multi, connection: rawConn, error: snapError } = useSnapshot();
  const errKind = snapshotErrorKind(snapError);
  const connection = rawConn === "offline" && (errKind === "forbidden" || errKind === "not_found") ? "answered" : rawConn;
  const listed = useListedProject(cid);
  const chrome = useChrome();
  const location = useLocation();
  const attention = useAttention();
  const [ncOpen, setNcOpen] = useState(false);
  const [unread, setUnread] = useState<{ n: number; label: string }>({ n: 0, label: "0" });
  const [ncPaused, setNcPaused] = useState(false);
  const embedded = !!chrome?.embedded;
  const tabPage = headerTabPage(page);
  // a 403/404 snapshot is an ANSWER: there is no project to name or tab
  // through, so the header drops the tab bar and its empty project placeholder
  // (the stale bar says why and links to All projects)
  const tabbed = !!tabPage && !isAnsweredKind(errKind);
  const { mainRef, topRef, density } = useFrameMetrics(tabbed);
  const palette = useProjectPalette();
  const overflow = density === "overflow";

  useEffect(() => { setNcOpen(false); }, [location.pathname]);
  // SPA <Link> navigations bypass the DOM-href interceptor (react-router
  // navigates from the `to` prop), so re-pin ?cid= after every route change on
  // multi-container stacks. No-op on single-container open stacks.
  useEffect(() => { ensureCidInLocation({ cid, multi }); }, [location, cid, multi]);

  const paused = !!(snap?.container && snap.container.wakes_enabled === false);
  // the project list names the project when its snapshot did not load (5xx):
  // the header keeps its name instead of an empty circle — never invented
  const projectName = snap?.container?.name || listed?.name || null;
  const sectionTitle = title === "Dashboard" ? "Overview" : title;
  const objects = (crumbs ?? []).filter((c) => c.label != null && c.label !== "");
  const trail: Crumb[] = [
    ...(projectName ? [{
      label: <><ProjectFace name={projectName} id={cid} palette={cid ? palette.get(cid) : undefined} className="v2-header-pav" /><span className="v2-header-pname">{projectName}</span></>,
      href: "/", title: projectName + " · project overview",
    }] : tabbed ? [{
      // still connecting: a neutral placeholder keeps the row's shape — the
      // section name must not stand in for the project (the tab already names it)
      label: <span className="v2-header-pav is-pending" aria-hidden="true" />, title: "Loading project…",
    }] : []),
    { label: sectionTitle, href: SECTION_HREF[page] },
    ...objects,
  ];
  const ctxText = typeof ctx === "string" && ctx === projectName ? null : ctx;
  const attnLbl = attentionLabel(attention);
  // the badge is an UNREAD dot (review: it used to count Needs-you — the same
  // number as the sidebar — and stayed lit after "Mark all read")
  const bellLabel = bellAriaLabel(unread, attention.count, attnLbl) + (ncPaused ? " (notifications paused)" : "");

  // <html data-conn>: lets live markers anywhere (sidebar agents, status
  // pulses) render as static "as of" state while the backend is unreachable.
  useEffect(() => {
    const d = document.documentElement;
    if (connection === "offline") d.setAttribute("data-conn", "offline");
    else d.removeAttribute("data-conn");
  }, [connection]);
  useEffect(() => () => document.documentElement.removeAttribute("data-conn"), []);

  useEffect(() => {
    const parts = [sectionTitle, projectName, "Embodent"].filter(Boolean);
    document.title = parts.join(" · ");
  }, [sectionTitle, projectName]);

  // paused is carried by the Execution chip alone (danger dot + "Paused");
  // no header stripe, no extra chip, no full-width bar (review: 4× the same fact)
  const headerCls = "v2-header topbar is-d-" + density
    + (paused ? " is-paused" : "")
    + (tabbed ? " has-tabs" : "");

  return (
    <div className="v2-main main" ref={mainRef} data-v2-surface="panel">
      <div className="v2-panel-top" ref={topRef}>
        <header className={headerCls} id="topbar">
          {!embedded && chrome && (
            <IconButton
              icon="menu" label="Open navigation" className="v2-hamburger" id="v2Hamburger"
              aria-expanded={chrome.drawerOpen} aria-controls="sidebar"
              onClick={() => chrome.setDrawerOpen(true)}
            />
          )}
          <div className="v2-header-crumbs crumbs">
            <Breadcrumbs items={trail} />
          </div>
          {tabbed && tabPage ? <ProjectTabs page={tabPage} /> : null}
          {ctxText && !tabbed && density === "full" ? <span className="v2-header-ctx ctx"><span className="v2-header-ctx-sep" aria-hidden="true" />{ctxText}</span> : null}
          <div className="v2-grow" />
          <div className="v2-header-tools">
            {!overflow && primaryAction ? <div className="v2-header-primary">{primaryAction}</div> : null}
            {!overflow && secondaryActions ? <div className="v2-header-secondary">{secondaryActions}</div> : null}
            {(extensions.topbarActions ?? []).map((C, i) => <C key={i} />)}
            {!overflow ? <IconButton icon="search" label="Search (⌘K)" className="v2-header-search v2-circbtn" onClick={() => chrome?.openPalette()} /> : null}
            <ConnectionIndicator />
            <ProjectBudgetChip iconOnly={overflow} />
            <ExecutionControls />
            {overflow ? <HeaderOverflowMenu primaryAction={primaryAction} secondaryActions={secondaryActions} onSearch={() => chrome?.openPalette()} /> : null}
            <button
              type="button" className="v2-bell attn-pill" id="attnPill"
              title={bellLabel} aria-label={bellLabel} aria-haspopup="dialog" aria-expanded={ncOpen} aria-controls="ncFloat"
              onClick={(e) => { e.preventDefault(); setNcOpen((v) => !v); }}
            >
              <Icon name={ncPaused ? "bell-off" : "bell"} cls="v2-ico bell" />
              {unread.n ? <span className="n" aria-hidden="true" /> : null}
            </button>
            {embedded ? <ActingChip /> : null}
          </div>
        </header>
        <StaleBar />
        <UpdateNotice />
        {toolbar ? <div className="v2-toolbar-slot">{toolbar}</div> : null}
      </div>
      <NotificationCenter open={ncOpen} onClose={() => setNcOpen(false)} onUnread={setUnread} onPaused={setNcPaused} />
      <main className={"v2-content content" + (flush ? " is-flush" : "")} id="main" tabIndex={-1}>{children}</main>
    </div>
  );
}

export function Shell(props: ShellProps) {
  const chrome = useChrome();
  if (chrome) return <ShellBody {...props} />; // AppFrame (or a standalone layout) already renders the sidebar
  // No AppFrame above (a page mounted on its own, e.g. in unit tests): provide
  // the same chrome and render the sidebar here.
  return (
    <ChromeProvider framed={false}>
      <StandaloneLayout {...props} />
    </ChromeProvider>
  );
}

function StandaloneLayout(props: ShellProps) {
  const chrome = useChrome();
  return (
    <div className="v2-app app">
      {chrome?.embedded ? null : <Sidebar />}
      <ShellBody {...props} />
    </div>
  );
}

// re-export for pages that need raw esc in attribute contexts
export { esc };
// D5 page chrome (filter-pill row, circular icon buttons, detail header, pager)
export { PageToolbar, FilterPills, CircleIconButton, PageHeader, Pager, scrollMainTo, mainScrollTop } from "./PageChrome";
export type { FilterPillSpec, CircleIconButtonProps } from "./PageChrome";
